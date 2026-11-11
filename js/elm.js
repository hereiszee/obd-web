// Elm327: strict one-at-a-time command queue on top of a Transport (BLE or simulated).

import { logger as defaultLogger } from './log.js?v=1.2.0';

var MESSAGES = {
  nodata: 'The car did not answer this request. This usually means it is not supported by this car.',
  unknown: 'The adapter did not understand this command.',
  unable: 'The adapter could not talk to the car. Make sure the ignition is ON (or the car is in READY mode) and the adapter is pushed fully into the port.',
  canerror: 'The adapter had trouble reading the car network (CAN error). Check the adapter is seated firmly and the ignition is ON, then try again.',
  buserror: 'There was a communication error on the car network. Check the adapter is seated firmly and try again.',
  stopped: 'The request was stopped before the car answered.',
  busy: 'The car network was too busy to answer. Try again in a moment.',
  timeout: 'The adapter did not reply in time. It may be busy or the connection may be weak. Try again.',
  lowvoltage: 'The adapter reset because the car voltage dropped too low. Check the battery and try again.',
  bufferfull: 'The adapter received more data than it could hold. Some of the answer may be missing.'
};

// After a timeout the ELM327 may still be busy (searching, slow ECU). We send a lone CR to
// interrupt it, then throw away everything up to its '>' prompt (and any straggling prompt
// that follows within RESYNC_QUIET_MS) before the next command is written.
var RESYNC_DEADLINE_MS = 2000;
var RESYNC_QUIET_MS = 250;

function norm(s) {
  return String(s).replace(/\s+/g, '').toUpperCase();
}

function isAtCommand(cmd) {
  return /^AT/i.test(String(cmd).trim());
}

// Classify one cleaned line. Returns a status string or null if it is a normal data line.
function classifyLine(line) {
  var u = line.toUpperCase().trim();
  var c = u.replace(/\s+/g, '');
  if (u === '?') return 'unknown';
  if (c === 'NODATA') return 'nodata';
  if (c.indexOf('UNABLETOCONNECT') >= 0) return 'unable';
  if (c.indexOf('CANERROR') >= 0) return 'canerror';
  if (c.indexOf('BUSBUSY') >= 0) return 'busy';
  if (c.indexOf('BUSERROR') >= 0) return 'buserror';
  if (c.indexOf('FBERROR') >= 0) return 'buserror';
  if (c.indexOf('DATAERROR') >= 0) return 'buserror';
  if (c.indexOf('RXERROR') >= 0) return 'buserror';
  if (/^ERR\d+/.test(c)) return 'buserror';
  if (c === 'STOPPED') return 'stopped';
  if (c.indexOf('LVRESET') >= 0) return 'lowvoltage';
  if (c.indexOf('LPALERT') >= 0 || c.indexOf('ACTALERT') >= 0) return 'lowvoltage';
  if (c.indexOf('BUFFERFULL') >= 0) return 'bufferfull';
  return null;
}

// Turn a raw reply (everything before '>') into {lines, status}.
export function parseReply(cmd, raw) {
  var text = String(raw || '')
    // keep printable ASCII plus CR/LF, drop NULs and garbage bytes some clones send after ATZ
    .replace(/[^\x20-\x7E\r\n]/g, '')
    .replace('>', '');
  var parts = text.split(/[\r\n]+/);
  var lines = [];
  var statuses = [];
  var echo = norm(cmd);
  var echoRemoved = false;
  for (var i = 0; i < parts.length; i++) {
    var line = parts[i].trim();
    if (!line) continue;
    // echo of the command (only the first matching line, before any data)
    if (!echoRemoved && lines.length === 0 && echo && norm(line) === echo) {
      echoRemoved = true;
      continue;
    }
    // SEARCHING... may sit alone or in front of data
    var u = line.toUpperCase();
    if (u.indexOf('SEARCHING') === 0) {
      line = line.replace(/^SEARCHING\.*\s*/i, '').trim();
      if (!line) continue;
      u = line.toUpperCase();
    }
    // BUS INIT: ...OK / BUS INIT: ...ERROR
    if (u.indexOf('BUS INIT') === 0) {
      var rest = line.replace(/^BUS\s*INIT\s*:?\s*\.*\s*/i, '').trim();
      if (/ERROR/i.test(rest)) { statuses.push('buserror'); continue; }
      if (!rest || /^OK$/i.test(rest)) continue;
      line = rest;
    }
    var st = classifyLine(line);
    if (st) { statuses.push(st); continue; }
    lines.push(line);
  }

  var status = 'ok';
  if (statuses.length) {
    // pick the most meaningful status. Order: hard failures first.
    var priority = ['lowvoltage', 'unable', 'canerror', 'buserror', 'busy', 'bufferfull', 'stopped', 'unknown', 'nodata'];
    for (var p = 0; p < priority.length; p++) {
      if (statuses.indexOf(priority[p]) >= 0) { status = priority[p]; break; }
    }
    // A NO DATA alongside real data from another ECU: data wins.
    if (status === 'nodata' && lines.length > 0) status = 'ok';
  } else if (lines.length === 0 && !isAtCommand(cmd)) {
    status = 'nodata';
  }
  return { lines: lines, status: status };
}

export class Elm327 {
  constructor(transport, logger) {
    this.transport = transport;
    this.logger = logger || defaultLogger;
    this._queue = [];
    this._busy = false;
    this._current = null;
    this._headersOn = false;
    this._afterProtocolSet = false;
    this.elmVersion = null;
    this.protocol = null;
    this.protocolNumber = null;
    this._lastActivity = Date.now();
    this._keepAliveTimer = null;
    this.stallMs = 1000;   // a pending command with no bytes for longer than this is logged as a stall
    var self = this;
    if (transport) {
      transport.onData = function (chunk) { self._onData(chunk); };
    }
  }

  get headersOn() {
    return this._headersOn;
  }

  send(cmd, opts) {
    var self = this;
    opts = opts || {};
    var c = String(cmd).trim();
    var timeout = opts.timeout;
    if (timeout == null) {
      timeout = /^ATZ$/i.test(c.replace(/\s+/g, '')) ? 5000 : 4000;
    }
    if (this._closed) {
      // This queue belongs to a link that has dropped. Never send on its behalf again.
      return Promise.resolve(this._result(c, '', [], 'stopped'));
    }
    return new Promise(function (resolve) {
      self._queue.push({ cmd: c, timeout: timeout, resolve: resolve });
      self._pump();
    });
  }

  _pump() {
    if (this._busy || this._queue.length === 0) return;
    this._busy = true;
    var job = this._queue.shift();
    var self = this;
    this._lastActivity = Date.now();
    this._run(job).then(function (res) {
      return res;
    }, function (e) {
      self.logger.log('error', 'Command ' + job.cmd + ' failed: ' + (e && e.message ? e.message : String(e)));
      return self._result(job.cmd, '', [], 'stopped');
    }).then(function (res) {
      job.resolve(res);
      return res.status === 'timeout' ? self._resync() : null;
    }).then(null, function () { /* resync errors are logged inside */ }).then(function () {
      self._lastActivity = Date.now();
      self._busy = false;
      self._pump();
    });
  }

  _result(cmd, raw, lines, status, extraMessage) {
    var message = status === 'ok' ? '' : (MESSAGES[status] || 'Something went wrong.');
    if (extraMessage) message = extraMessage;
    return { cmd: cmd, raw: raw, lines: lines, status: status, message: message };
  }

  _run(job) {
    var self = this;
    var cmd = job.cmd;
    var timeout = job.timeout;
    var obd = !isAtCommand(cmd);
    if (obd && this._afterProtocolSet) {
      if (timeout < 10000) timeout = 10000;
    }

    if (!this.transport || (typeof this.transport.isConnected === 'function' && !this.transport.isConnected())) {
      return Promise.resolve(this._result(cmd, '', [], 'stopped', 'Not connected to the adapter.'));
    }

    return new Promise(function (resolve) {
      var done = false;
      var timer = null;
      // Stall watch: warn once when a pending command gets no bytes for more than stallMs.
      var lastByteAt = Date.now();
      var stalledSince = null;
      var stallTimer = null;
      function armStall() {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(function () {
          stallTimer = null;
          if (done || stalledSince !== null) return;
          stalledSince = lastByteAt;
          self.logger.log('warn', 'Adapter stalled for ' + ((Date.now() - lastByteAt) / 1000).toFixed(1) +
            ' s (no data while waiting for the reply to ' + cmd + ').');
        }, self.stallMs + 1);
        if (stallTimer && typeof stallTimer === 'object' && typeof stallTimer.unref === 'function') stallTimer.unref();
      }
      var current = {
        cmd: cmd,
        buffer: '',
        finish: function (res) {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          if (stallTimer) clearTimeout(stallTimer);
          if (self._current === current) self._current = null;
          resolve(res);
        },
        onChunk: function () {
          var now = Date.now();
          if (stalledSince !== null) {
            self.logger.log('info', 'Adapter data resumed after a stall of ' + ((now - stalledSince) / 1000).toFixed(1) +
              ' s (reply to ' + cmd + ').');
            stalledSince = null;
          }
          lastByteAt = now;
          if (!done) armStall();
        },
        onPrompt: function (raw) {
          self.logger.log('rx', raw + '>');
          var parsed = parseReply(cmd, raw);
          self._noteState(cmd, parsed);
          current.finish(self._result(cmd, raw, parsed.lines, parsed.status));
        }
      };
      self._current = current;

      timer = setTimeout(function () {
        var partial = current.buffer;
        current.buffer = '';
        self.logger.log('warn', 'Timeout after ' + timeout + ' ms waiting for reply to ' + cmd +
          (partial ? '. Partial data: ' + JSON.stringify(partial) : '. No data received.'));
        current.finish(self._result(cmd, partial, [], 'timeout'));
      }, timeout);

      self.logger.log('tx', cmd);
      lastByteAt = Date.now();
      armStall();
      Promise.resolve().then(function () {
        return self.transport.write(cmd + '\r');
      }).then(null, function (e) {
        self.logger.log('error', 'Write failed for ' + cmd + ': ' + (e && e.message ? e.message : String(e)));
        current.finish(self._result(cmd, '', [], 'stopped', 'Could not send to the adapter. It may have disconnected.'));
      });
    });
  }

  // Bring the adapter back to a known idle state after a timed-out command.
  _resync() {
    var self = this;
    var t = this.transport;
    if (!t || (typeof t.isConnected === 'function' && !t.isConnected())) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      var quiet = null;
      var deadline = null;
      var sink = {
        cmd: '(resync)',
        buffer: '',
        finish: function () {
          if (done) return;
          done = true;
          if (quiet) clearTimeout(quiet);
          if (deadline) clearTimeout(deadline);
          if (self._current === sink) self._current = null;
          resolve();
        },
        onChunk: function () {
          // After the first prompt, keep swallowing data until the line goes quiet.
          if (quiet) { clearTimeout(quiet); quiet = setTimeout(sink.finish, RESYNC_QUIET_MS); }
        },
        onPrompt: function (raw) {
          self.logger.log('rx', raw + '> (discarded after timeout)');
          if (quiet) clearTimeout(quiet);
          quiet = setTimeout(sink.finish, RESYNC_QUIET_MS);
        }
      };
      self._current = sink;
      deadline = setTimeout(function () {
        self.logger.log('warn', 'The adapter did not return to its prompt after a timeout. Continuing anyway.');
        sink.finish();
      }, RESYNC_DEADLINE_MS);
      self.logger.log('info', 'Resynchronising with the adapter after a timeout.');
      self.logger.log('tx', '(CR to interrupt the adapter)');
      Promise.resolve().then(function () {
        return t.write('\r');
      }).then(null, function (e) {
        self.logger.log('warn', 'Resync write failed: ' + (e && e.message ? e.message : String(e)));
        sink.finish();
      });
    });
  }

  _noteState(cmd, parsed) {
    var c = norm(cmd);
    if (parsed.status !== 'ok') return;
    if (c === 'ATH1') this._headersOn = true;
    else if (c === 'ATH0') this._headersOn = false;
    else if (c === 'ATZ' || c === 'ATD' || c === 'ATWS') this._headersOn = false;
    if (/^ATSP/.test(c) || /^ATTP/.test(c)) this._afterProtocolSet = true;
    else if (!/^AT/.test(c)) this._afterProtocolSet = false;
  }

  _onData(chunk) {
    var cur = this._current;
    if (!cur) {
      if (chunk && chunk.replace(/[\s>]/g, '')) {
        this.logger.log('warn', 'Ignored data with no command waiting: ' + JSON.stringify(chunk));
      }
      return;
    }
    cur.buffer += chunk;
    if (typeof cur.onChunk === 'function') cur.onChunk(chunk);
    var idx = cur.buffer.indexOf('>');
    if (idx >= 0) {
      var raw = cur.buffer.slice(0, idx);
      var extra = cur.buffer.slice(idx + 1);
      cur.buffer = '';
      if (extra.replace(/\s/g, '')) {
        this.logger.log('warn', 'Ignored data after prompt: ' + JSON.stringify(extra));
      }
      cur.onPrompt(raw);
    }
  }

  // After a Bluetooth drop the adapter keeps its settings (it never lost power). Take over
  // what the previous session learned so the app can carry on without a full setup.
  resumeFrom(prev) {
    this._headersOn = true;
    this._afterProtocolSet = false;
    this.elmVersion = prev.elmVersion;
    this.protocol = prev.protocol;
    this.protocolNumber = prev.protocolNumber;
  }

  // Shuts this queue down for good. Used when the Bluetooth link drops, so code still
  // holding this object (for example a live data loop that is winding down) cannot send
  // stray commands once a new link is up.
  close() {
    this._closed = true;
    this.stopKeepAlive();
    this.cancelAll();
  }

  // Milliseconds since the adapter last had a command in flight.
  idleMs() {
    return (this._busy || this._queue.length) ? 0 : Date.now() - this._lastActivity;
  }

  // Some BLE adapters drop the link after a few seconds without traffic. When the queue
  // has been idle for `everyMs`, send a harmless ATRV (battery voltage) to keep it awake.
  startKeepAlive(everyMs) {
    var self = this;
    var ms = everyMs || 4000;
    this.stopKeepAlive();
    this._keepAliveTimer = setInterval(function () {
      var t = self.transport;
      if (!t || (t.isConnected && !t.isConnected())) return;
      if (self.idleMs() < ms) return;
      self.send('ATRV', { timeout: 2000 });
    }, 500);
  }

  stopKeepAlive() {
    if (this._keepAliveTimer) clearInterval(this._keepAliveTimer);
    this._keepAliveTimer = null;
  }

  cancelAll() {
    var queued = this._queue;
    this._queue = [];
    for (var i = 0; i < queued.length; i++) {
      queued[i].resolve(this._result(queued[i].cmd, '', [], 'stopped'));
    }
    var cur = this._current;
    if (cur) {
      this._current = null;
      cur.finish(this._result(cur.cmd, cur.buffer, [], 'stopped'));
    }
    if (queued.length || cur) {
      this.logger.log('info', 'Cancelled ' + (queued.length + (cur ? 1 : 0)) + ' pending command(s).');
    }
  }

  async init() {
    var result = { ok: false, elmVersion: null, protocol: null, protocolNumber: null, voltage: null, message: '' };
    this._headersOn = false;
    this.logger.log('info', 'Initialising adapter...');

    // ATWS (warm start) resets the ELM settings like ATZ but skips the full hardware reset.
    // A full ATZ once coincided with the vLinker dropping the Bluetooth link. Fall back to ATZ
    // on adapters that do not know ATWS.
    var z = await this.send('ATWS', { timeout: 5000 });
    if (z.status !== 'ok' || !findVersion(z.lines)) {
      if (z.status === 'stopped') { result.message = 'Lost connection to the adapter while setting it up.'; return result; }
      this.logger.log('info', 'ATWS not accepted (' + z.status + '), using ATZ.');
      z = await this.send('ATZ', { timeout: 5000 });
      if (z.status === 'timeout') {
        this.logger.log('warn', 'No reply to ATZ, trying once more.');
        z = await this.send('ATZ', { timeout: 5000 });
      }
    }
    result.elmVersion = findVersion(z.lines);

    var steps = ['ATE0', 'ATL0', 'ATS0', 'ATH1', 'ATAT1', 'ATSP0'];
    for (var i = 0; i < steps.length; i++) {
      var r = await this.send(steps[i]);
      if (r.status === 'stopped' && /not connected|could not send/i.test(r.message)) {
        result.message = 'Lost connection to the adapter while setting it up. Tap Connect to try again.';
        return result;
      }
      if (r.status === 'timeout' && i === 0) {
        // try again once, ATZ might still have been finishing
        r = await this.send(steps[i]);
        if (r.status === 'timeout') {
          result.message = 'The adapter is not responding. Unplug it for a few seconds, plug it back in, and connect again.';
          return result;
        }
      }
      if (r.status !== 'ok') {
        this.logger.log('warn', steps[i] + ' returned ' + r.status + ', continuing.');
      }
    }

    var v = await this.send('ATRV');
    if (v.status === 'ok' && v.lines.length) result.voltage = parseVoltage(v.lines[0]);

    var first = await this.send('0100', { timeout: 12000 });
    var dpn = await this.send('ATDPN');
    if (dpn.status === 'ok' && dpn.lines.length) {
      var pn = dpn.lines[0].trim().toUpperCase();
      result.protocolNumber = pn.replace(/^A/, '');
    }
    var dp = await this.send('ATDP');
    if (dp.status === 'ok' && dp.lines.length) result.protocol = dp.lines[0].trim();

    this.elmVersion = result.elmVersion;
    this.protocol = result.protocol;
    this.protocolNumber = result.protocolNumber;

    if (first.status === 'ok' && first.lines.length) {
      result.ok = true;
      result.message = 'Connected to the car' + (result.protocol ? ' (' + result.protocol.replace(/^AUTO,\s*/i, '') + ')' : '') + '.';
      this.logger.log('info', 'Init done. ELM ' + (result.elmVersion || '?') + ', protocol ' +
        (result.protocol || '?') + ' (' + (result.protocolNumber || '?') + ')');
      return result;
    }

    var ignitionHelp = 'The adapter is working but the car did not answer. Turn the ignition ON or press the start button until READY shows ' +
      '(on a hybrid, press start with your foot on the brake until the READY light comes on). ' +
      'Also check the adapter is pushed fully into the port under the dashboard.';
    if (first.status === 'unable' || first.status === 'nodata') {
      result.message = ignitionHelp;
    } else if (first.status === 'timeout') {
      result.message = 'The car took too long to answer. ' + ignitionHelp;
    } else if (first.status === 'lowvoltage') {
      result.message = MESSAGES.lowvoltage;
    } else if (first.status === 'stopped') {
      result.message = first.message || MESSAGES.stopped;
    } else {
      result.message = (first.message || 'The car did not answer.') + ' ' + ignitionHelp;
    }
    this.logger.log('warn', 'Init: car did not answer 0100 (' + first.status + ').');
    return result;
  }

  async probe() {
    var cmds = ['ATI', 'AT@1', 'ATDP', 'ATDPN', 'ATRV', '0100'];
    var out = [];
    this.logger.log('info', 'Probing adapter...');
    for (var i = 0; i < cmds.length; i++) {
      out.push(await this.send(cmds[i], cmds[i] === '0100' ? { timeout: 10000 } : undefined));
    }
    // Addressing tests, 11-bit CAN only (protocol 6 or 8). They show whether this adapter and
    // car accept requests to one module (ATSH) and reply filtering (ATCRA). Read-only requests.
    var pn = '';
    for (var k = 0; k < out.length; k++) {
      if (out[k].cmd === 'ATDPN' && out[k].status === 'ok' && out[k].lines.length) pn = out[k].lines[0].trim().toUpperCase().replace(/^A/, '');
    }
    var last = out[out.length - 1];
    if ((pn === '6' || pn === '8') && last && last.status === 'ok') {
      this.logger.log('info', 'Addressing tests...');
      var tests = ['ATSH 7E0', '0100', 'ATSH 7E2', '0100', 'ATSH 7DF', 'ATCRA 7E8', '0100', 'ATCRA 7EA', '0100'];
      var lost = false;
      for (var t = 0; t < tests.length && !lost; t++) {
        var r = await this.send(tests[t]);
        out.push(r);
        if (r.status === 'stopped') lost = true;
      }
      if (!lost) {
        // Always put the adapter back: all replies accepted, requests to all modules.
        out.push(await this.send('ATAR'));
        out.push(await this.send('ATSH 7DF'));
        out.push(await this.send('0100'));
      }
    }
    return out;
  }
}

function findVersion(lines) {
  for (var i = 0; i < lines.length; i++) {
    var m = /ELM327\s*v?\s*([\d.]+\w*)/i.exec(lines[i]);
    if (m) return 'v' + m[1];
  }
  for (var j = 0; j < lines.length; j++) {
    if (/ELM/i.test(lines[j])) return lines[j].trim();
  }
  return null;
}

function parseVoltage(line) {
  var m = /(\d+(?:\.\d+)?)\s*V?/i.exec(line);
  return m ? parseFloat(m[1]) : null;
}
