// Reads the adapter's Device Information (firmware version and so on) at most once per page
// session, and keeps the result for the Connect card, the report and the Probe table.
//
// Rules:
// - Only armed on the first user-started connection. Never on automatic reconnects.
// - Waits until the link has been healthy and quiet for quietMs (5 s), counted after the car
//   conversation is set up. Any unhealthy moment, user action or live data restarts the wait.
// - Never reads while live data runs. If live data starts first, the read waits until it stops.
// - A drop before the read cancels it for that link.

export class AdapterInfoGate {
  constructor(opts) {
    opts = opts || {};
    this.quietMs = opts.quietMs != null ? opts.quietMs : 5000;
    this.checkMs = opts.checkMs != null ? opts.checkMs : 500;
    this._logger = opts.logger || null;
    this._cache = null;        // {deviceName, info}
    this._attempted = false;
    this._reading = null;      // promise while a read runs
    this._ctx = null;
    this._timer = null;
    this._quietSince = null;
    this._postponedLogged = false;
  }

  _log(kind, text) { if (this._logger) this._logger.log(kind, text); }

  // Cached info for this adapter name, or null.
  get(deviceName) {
    if (!this._cache) return null;
    if (deviceName != null && this._cache.deviceName != null && this._cache.deviceName !== deviceName) return null;
    return this._cache.info;
  }

  isReading() { return !!this._reading; }

  // ctx: {transport, deviceName, reconnect, isHealthy(), isLive(), readyToRead(), beforeRead(), afterRead(), onDone(info)}
  // Returns true when a read was scheduled.
  arm(ctx) {
    if (!ctx || ctx.reconnect || this._cache || this._attempted || this._reading) return false;
    if (!ctx.transport || typeof ctx.transport.readDeviceInfo !== 'function') return false;
    this.cancel();
    this._ctx = ctx;
    this._quietSince = null;
    this._postponedLogged = false;
    var self = this;
    this._timer = setInterval(function () { self._check(); }, this.checkMs);
    if (this._timer && typeof this._timer === 'object' && typeof this._timer.unref === 'function') this._timer.unref();
    this._log('info', 'Adapter info will be read once, after the link has been quiet and healthy for ' + Math.round(this.quietMs / 1000) + ' s.');
    return true;
  }

  // Stops a scheduled read (for example on a drop). A read already running finishes on its own.
  cancel() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._ctx = null;
    this._quietSince = null;
  }

  _check() {
    var ctx = this._ctx;
    if (!ctx) return;
    var now = Date.now();
    if (!ctx.isHealthy()) { this._quietSince = null; return; }
    if (ctx.isLive()) {
      this._quietSince = null;
      if (!this._postponedLogged) {
        this._postponedLogged = true;
        this._log('info', 'Adapter info read postponed until live data stops.');
      }
      return;
    }
    if (this._quietSince === null) { this._quietSince = now; return; }
    if (now - this._quietSince < this.quietMs) return;
    // Window reached. Read only at a moment when no command is in flight.
    if (typeof ctx.readyToRead === 'function' && !ctx.readyToRead()) return;
    this._start(ctx);
  }

  _start(ctx) {
    this.cancel();
    this._attempted = true;
    var self = this;
    var t = ctx.transport;
    this._log('info', 'Reading adapter info (once per session)...');
    try { if (ctx.beforeRead) ctx.beforeRead(); } catch (e) { /* ignore */ }
    var p = Promise.resolve().then(function () { return t.readDeviceInfo(); }).then(function (info) {
      self._cache = { deviceName: ctx.deviceName != null ? ctx.deviceName : null, info: info || null };
      return info || null;
    }, function () { return null; });
    this._reading = p.then(function (info) {
      self._reading = null;
      try { if (ctx.afterRead) ctx.afterRead(); } catch (e) { /* ignore */ }
      try { if (ctx.onDone) ctx.onDone(info); } catch (e) { /* ignore */ }
      return info;
    });
    return this._reading;
  }

  // Probe button: returns the cached info, joins a running read, or reads now (counts as the
  // one read of the session) when nothing was read yet.
  readNow(ctx) {
    var cached = this.get(ctx && ctx.deviceName);
    if (cached || (this._cache && this._attempted)) return Promise.resolve(cached);
    if (this._reading) return this._reading;
    if (this._attempted || !ctx || !ctx.transport || typeof ctx.transport.readDeviceInfo !== 'function') return Promise.resolve(null);
    return this._start(ctx);
  }
}
