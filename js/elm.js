// Elm327: strict one-at-a-time command queue on top of a Transport (BLE or simulated).

import { logger as defaultLogger } from './log.js';

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

var POST_TIMEOUT_DRAIN_MS = 300;

function norm(s) {
  return String(s).replace(/\s+/g, '').toUpperCase();
}

function isAtCommand(cmd) {
  return /^AT/i.test(String(cmd).trim());
}

function delay(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
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
    this._run(job).then(function (res) {
      return res;
    }, function (e) {
      self.logger.log('error', 'Command ' + job.cmd + ' failed: ' + (e && e.message ? e.message : String(e)));
      return self._result(job.cmd, '', [], 'stopped');
    }).then(function (res) {
      var after = res.status === 'timeout' ? delay(POST_TIMEOUT_DRAIN_MS) : Promise.resolve();
      job.resolve(res);
      return after;
    }).then(function () {
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
      var current = {
        cmd: cmd,
        buffer: '',
        finish: function (res) {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          if (self._current === current) self._current = null;
          resolve(res);
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
      Promise.resolve().then(function () {
        return self.transport.write(cmd + '\r');
      }).then(null, function (e) {
        self.logger.log('error', 'Write failed for ' + cmd + ': ' + (e && e.message ? e.message : String(e)));
        current.finish(self._result(cmd, '', [], 'stopped', 'Could not send to the adapter. It may have disconnected.'));
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

    var z = await this.send('ATZ', { timeout: 5000 });
    if (z.status === 'timeout') {
      this.logger.log('warn', 'No reply to ATZ, trying once more.');
      z = await this.send('ATZ', { timeout: 5000 });
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
      'Also check the adapter is pushed fully into the port under the dashboard. Then tap Connect again.';
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
