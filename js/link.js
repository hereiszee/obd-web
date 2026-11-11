// LinkKeeper: rides through Bluetooth drops. When the link drops by itself, it holds the
// command queue, reconnects to the same adapter at once, lets the link settle briefly, resends
// the interrupted command and lets the queue carry on. Callers only see a slower reply.
// Works with BleTransport and SimTransport (anything with reconnect() and isConnected()).

export var SETTLE_FIRST_MS = 2000;      // pause after the first, user-started connection
export var SETTLE_RECONNECT_MS = 300;   // pause after notifications start on an automatic reconnect
export var HOLD_MS = 12000;             // longest time commands wait for the link to come back, in total
export var RECONNECT_DELAYS = [0, 1500, 2500, 4000, 6000, 8000]; // wait before each try

function norm(s) { return String(s || '').replace(/\s+/g, '').toUpperCase(); }

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Checks that the adapter still has our settings (echo off, spaces off, headers on), judging
// from the first reply after a reconnect. Returns null when it looks right, or the reason.
export function replyLooksResumed(cmd, res, protocolNumber) {
  if (!res) return 'no reply';
  var c = norm(cmd);
  var parts = String(res.raw || '').split(/[\r\n]+/);
  for (var i = 0; i < parts.length; i++) {
    var line = parts[i].trim();
    if (!line) continue;
    if (norm(line) === c) return 'the command was echoed back';
    break;
  }
  if (/^AT/.test(c)) return null;
  var lines = res.lines || [];
  for (var j = 0; j < lines.length; j++) {
    if (/\s/.test(lines[j])) return 'the reply has spaces';
  }
  var p = String(protocolNumber || '').toUpperCase().replace(/^A/, '');
  if (p === '6' || p === '8') {
    for (var k = 0; k < lines.length; k++) {
      // 11-bit CAN with headers on: a 3 digit id such as 7E8, then an even number of digits.
      if (!/^7[0-9A-F]{2}([0-9A-F]{2})+$/i.test(lines[k])) return 'the reply has no header';
    }
  }
  return null;
}

export class LinkKeeper {
  // o: {transport, elm, obd, logger, hooks: {onState(name), onRecovered(info), onGiveUp(), isAborted()},
  //     delays, settleMs, holdMs}
  constructor(o) {
    this.transport = o.transport;
    this.elm = o.elm;
    this.obd = o.obd || null;
    this.logger = o.logger;
    this.hooks = o.hooks || {};
    this.delays = o.delays || RECONNECT_DELAYS;
    this.settleMs = o.settleMs != null ? o.settleMs : SETTLE_RECONNECT_MS;
    this.holdMs = o.holdMs || HOLD_MS;
    this.reconnecting = false;
    this.aborted = false;
    this.links = 1;
    this.drops = 0;
    this.linkUpAt = Date.now();
    this.endedLinkMs = 0;
    this.recoveries = 0;
    this.recoverMsTotal = 0;
    this.lastRecoverMs = null;
    this._lastByteAt = null;
  }

  abort() { this.aborted = true; }

  _stop() { return this.aborted || (typeof this.hooks.isAborted === 'function' && this.hooks.isAborted()); }

  // How long the current link has been up, 0 while reconnecting.
  linkAgeMs() { return this.reconnecting ? 0 : Date.now() - this.linkUpAt; }

  averageRecoverS() { return this.recoveries ? this.recoverMsTotal / this.recoveries / 1000 : null; }

  averageLinkLifeS() { return this.drops ? this.endedLinkMs / this.drops / 1000 : null; }

  // Called for a drop the user did not ask for. details: text for the log line.
  handleDrop(details) {
    if (this._stop()) return false;
    this.elm.hold(this.holdMs);
    if (this.reconnecting) return true; // the running try notices and tries again
    this.reconnecting = true;
    var now = Date.now();
    this._lastByteAt = this.elm.lastByteAt || now;
    this.drops++;
    this.endedLinkMs += now - this.linkUpAt;
    this.logger.log('warn', 'Link dropped' + (details ? ' (' + details + ')' : '') + '. Reconnecting.');
    if (this.hooks.onState) this.hooks.onState('reconnecting');
    var self = this;
    this._run().catch(function (e) {
      self.logger.log('error', 'Reconnect failed: ' + (e && e.message ? e.message : String(e)));
    });
    return true;
  }

  async _run() {
    var n = this.delays.length;
    for (var i = 0; i < n; i++) {
      if (this._stop()) { this.reconnecting = false; return; }
      if (this.delays[i]) await sleep(this.delays[i]);
      if (this._stop()) { this.reconnecting = false; return; }
      try {
        await this.transport.reconnect();
        if (this._stop()) { this.reconnecting = false; return; }
        if (this.settleMs) await sleep(this.settleMs);
        if (!this.transport.isConnected()) throw new Error('The link dropped again while settling');
        this.elm.linkReset();
        var out = await this._resume();
        if (this._stop()) { this.reconnecting = false; return; }
        var now = Date.now();
        this.lastRecoverMs = now - this._lastByteAt;
        this.recoveries++;
        this.recoverMsTotal += this.lastRecoverMs;
        this.links++;
        this.linkUpAt = now;
        this.reconnecting = false;
        this.elm.resume();
        var avg = this.averageLinkLifeS();
        this.logger.log('info', 'Reconnected in ' + (this.lastRecoverMs / 1000).toFixed(1) + ' s (link ' + this.links +
          ', drop ' + this.drops + '). Average link life ' + (avg == null ? '?' : avg.toFixed(1)) + ' s.' +
          (out && out.writeNote ? ' ' + out.writeNote : ''));
        if (this.hooks.onRecovered) this.hooks.onRecovered({ recoverMs: this.lastRecoverMs, reinit: !!(out && out.reinit) });
        return;
      } catch (e) {
        if (this._stop()) { this.reconnecting = false; return; }
        this.elm.hold(this.holdMs);
        this.logger.log('warn', 'Reconnect try ' + (i + 1) + ' of ' + n + ' failed: ' + (e && e.message ? e.message : String(e)));
      }
    }
    this.reconnecting = false;
    this.logger.log('error', 'Could not reconnect after ' + n + ' tries.');
    if (this.hooks.onGiveUp) this.hooks.onGiveUp();
  }

  // Sends the interrupted command first (or ATRV) and checks the adapter kept its settings.
  // If not, sets the adapter up again and then sends the command.
  async _resume() {
    var elm = this.elm;
    var obd = this.obd;
    var self = this;
    // The header rule from obd.js: after any reconnect the header is unknown until confirmed.
    var prevHeader = obd ? obd._header : null;
    if (obd) obd._header = 'unknown';
    var targeted = !!prevHeader && prevHeader !== '7DF' && prevHeader !== 'unknown';
    var job = elm.takeInterrupted();
    var delivered = false;
    var sentJob = false;
    var reinit = false;
    function proto() { return (obd && obd.protocolNumber) || elm.protocolNumber; }
    async function sendChecked(cmd, opts) {
      var r = await elm.send(cmd, opts);
      if (r.status === 'stopped' || r.status === 'timeout') throw new Error('No reply after reconnecting (' + cmd + ', ' + r.status + ')');
      return r;
    }
    try {
      await elm.priority(async function () {
        var first = job ? (targeted ? 'ATSH ' + prevHeader : job.cmd) : 'ATRV';
        if (job && !targeted) sentJob = true;
        var r = await sendChecked(first, job && !targeted ? { timeout: job.timeout } : { timeout: 2500 });
        var bad = replyLooksResumed(first, r, proto());
        if (bad) {
          reinit = true;
          self.logger.log('info', 'The adapter lost its settings during the drop (' + bad + '). Setting it up again.');
          var init = await elm.init();
          if (!init || !init.ok) throw new Error('Setting the adapter up again failed: ' + ((init && init.message) || 'no answer'));
          if (obd && init.protocolNumber) obd.protocolNumber = init.protocolNumber;
          r = null;
          if (!job) return;
          if (!targeted) {
            sentJob = true;
            r = await sendChecked(job.cmd, { timeout: job.timeout });
          }
        }
        if (!job) return;
        if (targeted) {
          // The interrupted request was addressed to one module: address it again first.
          if (!r) r = await sendChecked('ATSH ' + prevHeader);
          if (r.status !== 'ok') {
            delivered = true;
            elm.deliver(job, { cmd: job.cmd, raw: '', lines: [], status: 'stopped', message: 'The adapter did not accept the module address again after the reconnect.' });
            return;
          }
          obd._header = prevHeader;
          sentJob = true;
          r = await sendChecked(job.cmd, { timeout: job.timeout });
        }
        delivered = true;
        elm.deliver(job, r);
      });
    } catch (e) {
      if (job && !delivered) {
        if (sentJob) elm.requeue(job); else elm.restoreInterrupted(job);
      }
      throw e;
    }
    var note = null;
    var t = this.transport;
    var wm = t && typeof t.writeModeText === 'function' ? t.writeModeText() : '';
    if (/switched off/.test(wm)) note = 'Write mode ' + wm + '.';
    return { reinit: reinit, writeNote: note };
  }
}
