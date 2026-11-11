// Reads the adapter's Device Information (firmware version and so on) once per page session,
// and keeps the result for the Connect card, the report and the Probe table.
//
// Rules (1.3.0):
// - Read on the first link that has stayed up for linkUpMs (8 s), at a moment when no command
//   is pending and live data is not running.
// - If a drop interrupts the read, try again on a later link. At most one successful read per
//   page session.

export class AdapterInfoGate {
  constructor(opts) {
    opts = opts || {};
    this.linkUpMs = opts.linkUpMs != null ? opts.linkUpMs : 8000;
    this.checkMs = opts.checkMs != null ? opts.checkMs : 500;
    this._logger = opts.logger || null;
    this._cache = null;        // {deviceName, info}
    this._reading = null;      // promise while a read runs
    this._ctx = null;
    this._timer = null;
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

  isDone() { return !!this._cache; }

  // ctx: {transport, deviceName, linkAgeMs(), isHealthy(), isLive(), readyToRead(), sameLink(),
  //       beforeRead(), afterRead(), onDone(info)}. Call on every new link. Returns true when armed.
  arm(ctx) {
    if (!ctx || this._cache || this._reading) return false;
    if (!ctx.transport || typeof ctx.transport.readDeviceInfo !== 'function') return false;
    this.cancel();
    this._ctx = ctx;
    var self = this;
    this._timer = setInterval(function () { self._check(); }, this.checkMs);
    if (this._timer && typeof this._timer === 'object' && typeof this._timer.unref === 'function') this._timer.unref();
    return true;
  }

  // Stops a scheduled read (for example on a drop). A read already running finishes on its own.
  cancel() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._ctx = null;
  }

  _check() {
    var ctx = this._ctx;
    if (!ctx) return;
    if (ctx.isHealthy && !ctx.isHealthy()) return;
    if (ctx.linkAgeMs() < this.linkUpMs) return;
    if (ctx.isLive()) {
      if (!this._postponedLogged) {
        this._postponedLogged = true;
        this._log('info', 'Adapter info read postponed until live data stops.');
      }
      return;
    }
    if (typeof ctx.readyToRead === 'function' && !ctx.readyToRead()) return;
    this._start(ctx);
  }

  _start(ctx) {
    this.cancel();
    var self = this;
    var t = ctx.transport;
    this._log('info', 'Reading adapter info (once per session)...');
    try { if (ctx.beforeRead) ctx.beforeRead(); } catch (e) { /* ignore */ }
    var p = Promise.resolve().then(function () { return t.readDeviceInfo(); }).then(function (info) {
      // A drop during the read gives an incomplete answer. Keep nothing and try on a later link.
      if (typeof ctx.sameLink === 'function' && !ctx.sameLink()) {
        self._log('info', 'Adapter info read was interrupted by a drop. Will try again on a later link.');
        return null;
      }
      self._cache = { deviceName: ctx.deviceName != null ? ctx.deviceName : null, info: info || null };
      return info || null;
    }, function () { return null; });
    this._reading = p.then(function (info) {
      self._reading = null;
      try { if (ctx.afterRead) ctx.afterRead(); } catch (e) { /* ignore */ }
      if (info) { try { if (ctx.onDone) ctx.onDone(info); } catch (e) { /* ignore */ } }
      return info;
    });
    return this._reading;
  }

  // Probe button: returns the cached info, joins a running read, or reads now when nothing
  // was read successfully yet.
  readNow(ctx) {
    var cached = this.get(ctx && ctx.deviceName);
    if (cached || this._cache) return Promise.resolve(cached);
    if (this._reading) return this._reading;
    if (!ctx || !ctx.transport || typeof ctx.transport.readDeviceInfo !== 'function') return Promise.resolve(null);
    return this._start(ctx);
  }
}
