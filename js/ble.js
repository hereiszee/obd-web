// BleTransport: talks to a BLE ELM327 adapter (for example Vgate vLinker MC+) over Web Bluetooth.
// Connection happens entirely in this page. No pairing in phone settings is needed.
//
// Default profile (1.2.0), the one used by every mature open-source app for this adapter:
// service 18F0, notify 2AF0, write 2AF1, write WITH response, one write in flight at a time,
// at most 20 bytes per write, and nothing else touched on the GATT server while a session runs.

import { logger as defaultLogger } from './log.js?v=1.2.0';

function uuid16(n) {
  var h = n.toString(16);
  while (h.length < 4) h = '0' + h;
  return '0000' + h + '-0000-1000-8000-00805f9b34fb';
}

// Services used by ELM327 style BLE adapters. They must be listed here or the browser hides them.
export const CANDIDATE_SERVICES = [
  uuid16(0xfff0),                           // most common clone UART service (FFF1 notify, FFF2 write)
  uuid16(0xffe0),                           // HM-10 style UART (FFE1 notify + write)
  uuid16(0x18f0),                           // vLinker / some OBDLink (2AF0 notify, 2AF1 write)
  uuid16(0xffb0),                           // seen on a few clones
  uuid16(0xfee7),                           // seen on a few clones
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',   // "ELM327 BLE" service (bef8d6c9 char)
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',   // Nordic UART
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',   // Microchip / ISSC transparent UART
  uuid16(0x180a)                            // standard Device Information (firmware version etc.)
];

// Device Information fields we read. Serial number (2A25), system ID (2A23), PnP ID (2A50)
// and regulatory data (2A2A) are deliberately skipped: they identify the individual adapter.
export const DEVICE_INFO_FIELDS = [
  { key: 'manufacturer', label: 'Manufacturer', uuid: uuid16(0x2a29) },
  { key: 'model', label: 'Model', uuid: uuid16(0x2a24) },
  { key: 'hardware', label: 'Hardware revision', uuid: uuid16(0x2a27) },
  { key: 'firmware', label: 'Firmware revision', uuid: uuid16(0x2a26) },
  { key: 'software', label: 'Software revision', uuid: uuid16(0x2a28) }
];

function cleanText(dataView) {
  var s = '';
  for (var i = 0; i < dataView.byteLength; i++) {
    var b = dataView.getUint8(i);
    if (b === 0) break;
    s += b >= 32 && b < 127 ? String.fromCharCode(b) : '';
  }
  return s.trim();
}

var SVC_18F0 = uuid16(0x18f0);
var SVC_E781 = 'e7810a71-73ae-499d-8c15-faa9aef0c3f2';

// Known notify/write pairs, in order of preference for the "auto" channel.
export const KNOWN_PAIRS = [
  // The profile used by AndrOBD, Deep OBD, SwiftOBD2, LTSupportAutomotive and esphome-obd2-ble.
  { service: SVC_18F0, notify: uuid16(0x2af0), write: uuid16(0x2af1) },
  // Also present on the vLinker MC-IOS. Default before 1.2.0.
  { service: SVC_E781, notify: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', write: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f' },
  { service: uuid16(0xfff0), notify: uuid16(0xfff1), write: uuid16(0xfff2) },
  { service: uuid16(0xffe0), notify: uuid16(0xffe1), write: uuid16(0xffe1) },
  { service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e' },
  { service: '49535343-fe7d-4ae5-8fa9-9fafd205e455', notify: '49535343-1e4d-4bd9-ba61-23c647249616', write: '49535343-8841-43f4-a8d4-ecbe34729bb3' }
];

export var CHUNK = 20;
var WRITE_TIMEOUT_MS = 3000;      // a write not confirmed by then is reported as a send error
var WRITE_RELEASE_MS = 10000;     // a write that never settles stops blocking the queue after this
var POLL_MS = 250;                // how often the GATT connected flag is checked
var EVENT_WAIT_MS = 2000;         // how long to wait for the browser's disconnect event after polling saw a drop
var RING_SIZE = 40;               // raw notifications kept for the drop report
var RING_DUMP = 12;               // how many of them are logged on a drop
var REJECT_CHECK_MS = 300;        // a refused acknowledged write only downgrades if the link is still up after this
var STRIKE_WAIT_MS = 2000;        // a timed-out write counts as a strike only if the link survives this long

function propsOf(ch) {
  var p = ch.properties || {};
  return {
    read: !!p.read,
    write: !!p.write,
    writeWithoutResponse: !!p.writeWithoutResponse,
    notify: !!p.notify,
    indicate: !!p.indicate
  };
}

function propsText(pr) {
  var out = [];
  if (pr.read) out.push('read');
  if (pr.write) out.push('write');
  if (pr.writeWithoutResponse) out.push('writeWithoutResponse');
  if (pr.notify) out.push('notify');
  if (pr.indicate) out.push('indicate');
  return out.length ? out.join(', ') : 'none';
}

function canNotify(c) { return c.props.notify || c.props.indicate; }
function canWrite(c) { return c.props.write || c.props.writeWithoutResponse; }

function decodeBytes(dataView) {
  var s = '';
  for (var i = 0; i < dataView.byteLength; i++) {
    var b = dataView.getUint8(i);
    if (b === 0) continue; // some adapters pad with NUL bytes
    s += String.fromCharCode(b);
  }
  return s;
}

function encodeAscii(text) {
  var arr = new Uint8Array(text.length);
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    arr[i] = c < 128 ? c : 63; // '?' for anything non ASCII
  }
  return arr;
}

// Same look as RX lines in the debug log: line breaks become the return symbol.
// Other control bytes are shown as <xx> so nothing invisible hides in the dump.
export function visibleText(s) {
  return String(s)
    .replace(/\r\n|\r|\n/g, '⏎')
    .replace(/[\x00-\x1F\x7F]/g, function (c) {
      var h = c.charCodeAt(0).toString(16).toUpperCase();
      return '<' + (h.length < 2 ? '0' + h : h) + '>';
    });
}

// Bluefy reports 16-bit UUIDs in short form ('18f0'). Expand so comparisons work everywhere.
export function normUuid(u) {
  var x = String(u || '').toLowerCase();
  if (/^[0-9a-f]{4}$/.test(x)) return '0000' + x + '-0000-1000-8000-00805f9b34fb';
  if (/^[0-9a-f]{8}$/.test(x)) return x + '-0000-1000-8000-00805f9b34fb';
  return x;
}

export function shortUuid(u) {
  var m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(normUuid(u));
  return m ? m[1] : normUuid(u);
}

// Decides how to write to the adapter.
// requested: 'auto' | 'withResponse' | 'withoutResponse'. props: characteristic properties. ch: the characteristic.
// downgraded: true once acknowledged writes failed earlier in this page session (auto mode only).
// Returns 'withResponse' | 'withoutResponse' | 'legacy' (plain writeValue, acknowledged when the
// characteristic has the write property).
// Bluefy versions differ in which methods exist, so every choice checks the method is there.
export function chooseWriteMode(requested, props, ch, downgraded) {
  var p = props || {};
  var hasWith = !!ch && typeof ch.writeValueWithResponse === 'function';
  var hasWithout = !!ch && typeof ch.writeValueWithoutResponse === 'function';
  var hasLegacy = !!ch && typeof ch.writeValue === 'function';
  function acknowledged() {
    if (hasWith) return 'withResponse';
    if (hasLegacy) return 'legacy';
    return hasWithout ? 'withoutResponse' : 'legacy';
  }
  if (requested === 'withoutResponse' || (requested !== 'withResponse' && downgraded)) {
    if (p.writeWithoutResponse && hasWithout) return 'withoutResponse';
    return acknowledged();
  }
  if (requested === 'withResponse') return acknowledged();
  // auto
  if (p.write) return acknowledged();
  if (p.writeWithoutResponse && hasWithout) return 'withoutResponse';
  return hasLegacy ? 'legacy' : (hasWith ? 'withResponse' : 'withoutResponse');
}

export function writeModeLabel(m) {
  if (m === 'withResponse') return 'with response';
  if (m === 'withoutResponse') return 'without response';
  if (m === 'legacy') return 'browser default (writeValue)';
  return 'unknown';
}

export function writeMethodName(m) {
  if (m === 'withResponse') return 'writeValueWithResponse';
  if (m === 'withoutResponse') return 'writeValueWithoutResponse';
  return 'writeValue';
}

// Bluefy can reject with a bare number. Turn anything into an Error with a readable message.
function asError(e, what) {
  if (e instanceof Error) return e;
  if (e === null || e === undefined) return new Error(what + ' failed (unknown error)');
  if (typeof e !== 'object') return new Error(what + ' failed (Bluetooth error code ' + String(e) + ')');
  var err = new Error(what + ' failed (' + (e.name ? e.name + ': ' : '') + (e.message || String(e)) + ')');
  if (e.name) err.name = e.name;
  return err;
}

function nowMs() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function secs(ms) { return (Math.round(ms / 100) / 10).toFixed(1); }

// Node keeps running while a timer is pending. Browsers return a number and ignore this.
function unref(t) {
  if (t && typeof t === 'object' && typeof t.unref === 'function') t.unref();
  return t;
}

// Bluefy sometimes never settles a GATT promise when the link drops mid-call. Give every
// setup step a deadline so a reconnect attempt can fail and the next one can start.
function withTimeout(p, ms, what) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var t = setTimeout(function () {
      if (done) return;
      done = true;
      reject(new Error(what + ' took longer than ' + Math.round(ms / 1000) + ' s'));
    }, ms);
    Promise.resolve(p).then(function (v) {
      if (done) return;
      done = true; clearTimeout(t); resolve(v);
    }, function (e) {
      if (done) return;
      done = true; clearTimeout(t); reject(e);
    });
  });
}

function errText(e) {
  if (e === null || e === undefined) return 'unknown error';
  if (typeof e !== 'object') return 'code ' + String(e);
  return (e.name ? e.name + ': ' : '') + (e.message || String(e));
}

function noop() {}

export class BleTransport {
  constructor(opts) {
    opts = opts || {};
    this.name = 'ble';
    this.onData = null;
    this.onDisconnect = null;
    this.info = { deviceName: null, serviceUuid: null, writeUuid: null, notifyUuid: null, allServices: [] };
    this.lastDrop = null;            // stats of the link that ended last (see _linkStats)
    this._logger = opts.logger || defaultLogger;
    this._prefer = opts.prefer || 'auto';   // 'auto' | 'e781' | '18f0'
    this._requestedWrite = opts.writeMode === 'withResponse' || opts.writeMode === 'withoutResponse' ? opts.writeMode : 'auto';
    this._writeTimeoutMs = opts.writeTimeoutMs || WRITE_TIMEOUT_MS;
    this._writeReleaseMs = opts.writeReleaseMs || WRITE_RELEASE_MS;
    this._pollMs = opts.pollMs || POLL_MS;
    this._eventWaitMs = opts.eventWaitMs || EVENT_WAIT_MS;
    this._strikeWaitMs = opts.strikeWaitMs || STRIKE_WAIT_MS;
    this._ackStrikes = 0;            // "write not confirmed but the adapter answered", per page session
    this._ackWaiter = null;
    this._device = null;
    this._server = null;
    this._notifyChar = null;
    this._notifyHandler = null;
    this._writeChar = null;
    this._writeProps = null;
    this._writeMode = null;
    this._downgraded = false;        // auto mode: acknowledged writes failed earlier in this page session
    this._lastPair = null;           // the pair that worked last time, used directly on reconnect
    this._connected = false;
    this._userDisconnect = false;
    this._disconnectReported = false;
    this._writeChain = Promise.resolve();
    this._linkSeq = 0;
    this._link = null;               // per-link state and counters, null while no link is up
    this._pollTimer = null;
    this._lateEvent = null;          // set when polling handled a drop before the browser's event
    this._ring = [];
    this._partial = '';
    this._session = { links: 0, drops: 0, connectedMs: 0 };
    this._onGattDisconnect = this._handleGattDisconnect.bind(this);
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth &&
      typeof navigator.bluetooth.requestDevice === 'function';
  }

  isConnected() {
    return this._connected && !!this._server && !!this._server.connected;
  }

  // Must be called straight from a tap handler. requestDevice is the first await so the
  // browser still sees the user gesture.
  async connect() {
    if (!BleTransport.isSupported()) {
      throw new Error('This browser cannot use Bluetooth. On iPhone, open this page in the Bluefy browser. On a computer, use Chrome or Edge.');
    }
    var device;
    try {
      device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: CANDIDATE_SERVICES
      });
    } catch (e) {
      this._logger.log('warn', 'Device picker closed or failed: ' + errText(e));
      // Bluefy rejects with a bare number (not an Error) when the list is closed without a choice.
      if (e === null || e === undefined || typeof e !== 'object') {
        throw new Error('The device list closed without a choice. Tap Connect again and pick your adapter (for example "vLinker").');
      }
      // Chrome and Bluefy also use NotFoundError when the Bluetooth radio is off or missing.
      if (e && /adapter not available|bluetooth.*(off|unavailable|not available|disabled)|radio/i.test(String(e.message || ''))) {
        throw new Error('Bluetooth is turned off. Turn it on, then tap Connect again.');
      }
      if (e && e.name === 'NotFoundError') {
        throw new Error('No adapter was chosen. Tap Connect again and pick your adapter from the list.');
      }
      if (e && e.name === 'SecurityError') {
        throw new Error('The browser blocked Bluetooth. Tap the Connect button directly and allow Bluetooth when asked.');
      }
      throw new Error('Could not open the Bluetooth device list. Make sure Bluetooth is on and try again.');
    }

    this._device = device;
    this._userDisconnect = false;
    this._disconnectReported = false;
    this._lastPair = null;
    this.info = { deviceName: device.name || '(no name)', serviceUuid: null, writeUuid: null, notifyUuid: null, allServices: [] };
    this._logger.log('info', 'Selected device: ' + this.info.deviceName + (device.id ? ' (id ' + device.id + ')' : ''));
    device.addEventListener('gattserverdisconnected', this._onGattDisconnect);

    try {
      await this._setupWithRetry(device, false);
    } catch (e) {
      this._logger.log('error', 'BLE setup failed: ' + errText(e));
      if (e && e.stack) this._logger.log('error', e.stack);
      this._teardown();
      try { if (device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch (e2) { /* ignore */ }
      device.removeEventListener('gattserverdisconnected', this._onGattDisconnect);
      if (e && e.userMessage) throw new Error(e.userMessage);
      throw new Error('Could not talk to the adapter. Make sure it is plugged in, the ignition is on, and no other app is connected to it. Then try again.');
    }
    return this.info;
  }

  // Runs _setup, retrying once if the link drops (the vLinker sometimes drops during discovery).
  async _setupWithRetry(device, reconnecting) {
    try {
      await this._setup(device, reconnecting);
    } catch (first) {
      if (this._userDisconnect) throw first;
      this._logger.log('warn', 'Setup failed (' + errText(first) + '). Retrying once...');
      this._teardown();
      try { if (device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch (e3) { /* ignore */ }
      await new Promise(function (r) { setTimeout(r, 800); });
      await this._setup(device, reconnecting);
    }
    // A drop during setup marks the disconnect as reported. Reset so later drops reach the app.
    this._disconnectReported = false;
  }

  // Reconnects to the same adapter after an unexpected drop. No device list, no tap needed.
  async reconnect() {
    var device = this._device;
    if (!device) throw new Error('No adapter to reconnect to.');
    this._userDisconnect = false;
    this._disconnectReported = false;
    this._teardown();
    try { device.removeEventListener('gattserverdisconnected', this._onGattDisconnect); } catch (e) { /* ignore */ }
    device.addEventListener('gattserverdisconnected', this._onGattDisconnect);
    this._logger.log('info', 'Reconnecting to ' + (device.name || 'adapter') + '...');
    try {
      await this._setupWithRetry(device, true);
    } catch (e) {
      this._teardown();
      try { if (device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch (e2) { /* ignore */ }
      this._disconnectReported = false;
      throw e;
    }
    this._logger.log('info', 'Reconnected.');
    this._logTally();
    return this.info;
  }

  // Pairs to try, most wanted first.
  _pairOrder() {
    var pairs = KNOWN_PAIRS.slice();
    var want = this._prefer === 'e781' ? SVC_E781 : SVC_18F0;
    pairs.sort(function (a, b) { return (a.service === want ? 0 : 1) - (b.service === want ? 0 : 1); });
    return pairs;
  }

  async _setup(device, reconnecting) {
    this._logger.log('info', 'Connecting to GATT server...');
    var server = null;
    var lastErr = null;
    for (var attempt = 1; attempt <= 3 && !server; attempt++) {
      try {
        server = await withTimeout(device.gatt.connect(), 10000, 'Bluetooth connect');
      } catch (e) {
        lastErr = e;
        this._logger.log('warn', 'GATT connect attempt ' + attempt + ' failed: ' + errText(e));
        await new Promise(function (r) { setTimeout(r, 400 * attempt); });
      }
    }
    if (!server) throw lastErr || new Error('GATT connect failed');
    var gattAt = nowMs();
    if (this._userDisconnect) {
      // The user tapped Disconnect while we were connecting. Do not leave a link nobody owns.
      try { device.gatt.disconnect(); } catch (e) { /* ignore */ }
      throw new Error('Connection cancelled');
    }
    this._server = server;

    // Fast path: open the known service and its two characteristics by UUID. On a reconnect
    // only the pair that worked last time is tried. The full walk is the fallback.
    var pairs = reconnecting && this._lastPair ? [this._lastPair] : this._pairOrder();
    this._logger.log('info', 'GATT connected. Opening ' + (reconnecting && this._lastPair ? 'the channel that worked last time' : 'the preferred channel') + ' directly...');
    var pick = await this._directPick(server, pairs);
    if (!pick) {
      if (!server.connected) throw new Error('The adapter dropped the Bluetooth link during setup');
      this._logger.log('warn', 'Direct path did not find a usable channel. Discovering all services...');
      pick = await this._walk(server, this._pairOrder());
    }
    if (!server.connected) {
      throw new Error('The adapter dropped the Bluetooth link during setup');
    }

    if (!pick) {
      var err = new Error('No usable notify and write characteristics found');
      err.userMessage = 'Connected, but this device does not look like an OBD adapter. Check you picked the right device (for example "vLinker") and try again.';
      throw err;
    }
    this._notifyChar = pick.notify.ch;
    this._writeChar = pick.write.ch;
    this.info.serviceUuid = pick.write.service;
    this.info.notifyUuid = pick.notify.uuid;
    this.info.writeUuid = pick.write.uuid;
    this._writeProps = pick.write.props;
    this._writeMode = chooseWriteMode(this._requestedWrite, pick.write.props, this._writeChar, this._downgraded);
    if (pick.pair) this._lastPair = pick.pair;
    this._logger.log('info', 'Using notify ' + pick.notify.uuid + ' and write ' + pick.write.uuid +
      ' in service ' + pick.write.service + ' (' + pick.reason + ', write mode ' + writeModeLabel(this._writeMode) + ')');
    this._logger.log('info', 'Write method ' + writeMethodName(this._writeMode) + ' (write mode setting: ' + this._requestedWrite +
      (this._downgraded && this._requestedWrite === 'auto' ? ', acknowledged writes switched off earlier this session' : '') + ').');

    // Exactly one notify subscription per link. The handler is tied to this link, so a late
    // event from an old characteristic can never reach the app.
    var linkId = ++this._linkSeq;
    var self = this;
    var handler = function (ev) { self._handleNotify(ev, linkId); };
    this._notifyHandler = handler;
    this._notifyChar.addEventListener('characteristicvaluechanged', handler);
    this._partial = '';
    this._link = {
      id: linkId, gattAt: gattAt, upAt: null, commands: 0, rxBytes: 0, lastRxAt: null,
      dropHandled: false, pollClosedAt: null, pollWait: null, ackConfirmed: false
    };
    await withTimeout(this._notifyChar.startNotifications(), 6000, 'Starting notifications');
    this._logger.log('info', 'Notifications started.');
    if (this._userDisconnect) {
      try { device.gatt.disconnect(); } catch (e) { /* ignore */ }
      throw new Error('Connection cancelled');
    }
    if (!this._link || this._link.id !== linkId || !server.connected) {
      throw new Error('The adapter dropped the Bluetooth link during setup');
    }
    this._link.upAt = nowMs();
    this._session.links++;
    this._lateEvent = null;
    this._connected = true;
    this._startPolling();
  }

  // Opens known pairs by UUID, without listing anything. Returns a pick or null.
  async _directPick(server, pairs) {
    for (var k = 0; k < pairs.length; k++) {
      if (!server.connected) return null;
      var pair = pairs[k];
      var svc;
      try {
        svc = await withTimeout(server.getPrimaryService(pair.service), 3000, 'Opening service ' + shortUuid(pair.service));
      } catch (e) {
        this._logger.log('info', 'Service ' + shortUuid(pair.service) + ' not available (' + errText(e) + ').');
        continue;
      }
      try {
        var n = await withTimeout(svc.getCharacteristic(pair.notify), 3000, 'Opening characteristic ' + shortUuid(pair.notify));
        var w = pair.write === pair.notify ? n
          : await withTimeout(svc.getCharacteristic(pair.write), 3000, 'Opening characteristic ' + shortUuid(pair.write));
        var nc = { service: pair.service, uuid: pair.notify, ch: n, props: propsOf(n) };
        var wc = { service: pair.service, uuid: pair.write, ch: w, props: propsOf(w) };
        this._logger.log('info', 'Opened service ' + shortUuid(pair.service) + ' directly: notify ' + shortUuid(pair.notify) +
          ' [' + propsText(nc.props) + '], write ' + shortUuid(pair.write) + ' [' + propsText(wc.props) + ']');
        if (canNotify(nc) && canWrite(wc)) return { notify: nc, write: wc, reason: 'known pair', pair: pair };
        this._logger.log('warn', 'Service ' + shortUuid(pair.service) + ' is missing notify or write. Trying the next one.');
      } catch (e) {
        this._logger.log('warn', 'Service ' + shortUuid(pair.service) + ': ' + errText(e));
      }
    }
    return null;
  }

  // Full discovery walk with logging. Lists the given pairs' services first and stops at the
  // first usable pair, unless listAll is set (used by the Probe button).
  async _walk(server, pairs, listAll) {
    this._logger.log('info', 'Discovering services...');
    var services = [];
    try {
      services = await withTimeout(server.getPrimaryServices(), 6000, 'Listing services');
    } catch (e) {
      this._logger.log('warn', 'getPrimaryServices() failed (' + errText(e) + '). Trying known services one by one.');
      services = [];
    }
    if (!services || services.length === 0) {
      services = [];
      for (var i = 0; i < CANDIDATE_SERVICES.length; i++) {
        try {
          if (!server.connected) break;
          services.push(await withTimeout(server.getPrimaryService(CANDIDATE_SERVICES[i]), 3000, 'Opening a service'));
        } catch (e) { /* not present */ }
      }
    }
    var svcByUuid = {};
    var svcNames = [];
    for (var si = 0; si < services.length; si++) {
      var nu = normUuid(services[si].uuid);
      svcByUuid[nu] = services[si];
      svcNames.push(shortUuid(nu));
    }
    this._logger.log('info', 'Found ' + services.length + ' accessible service(s): ' + svcNames.join(', '));

    var chars = [];
    var all = [];
    var self = this;
    var listed = {};
    async function listService(svcUuid) {
      if (listed[svcUuid]) return true;
      listed[svcUuid] = true;
      var entry = { uuid: svcUuid, characteristics: [] };
      all.push(entry);
      self._logger.log('info', 'Service ' + shortUuid(svcUuid));
      var list;
      try {
        list = await withTimeout(svcByUuid[svcUuid].getCharacteristics(), 6000, 'Listing characteristics');
      } catch (e) {
        self._logger.log('warn', '  could not list characteristics: ' + errText(e));
        return false;
      }
      for (var c = 0; c < list.length; c++) {
        var ch = list[c];
        var pr = propsOf(ch);
        var cu = normUuid(ch.uuid);
        entry.characteristics.push({ uuid: cu, properties: propsText(pr) });
        self._logger.log('info', '  Characteristic ' + shortUuid(cu) + ' [' + propsText(pr) + ']');
        chars.push({ service: svcUuid, uuid: cu, ch: ch, props: pr });
      }
      return true;
    }

    var pick = null;
    if (!listAll) {
      for (var k = 0; k < pairs.length && !pick; k++) {
        if (!svcByUuid[pairs[k].service]) continue;
        await listService(pairs[k].service);
        pick = this._choose(chars, pairs);
      }
    }
    if (!pick) {
      for (var u in svcByUuid) {
        if (!server.connected) break;
        await listService(u);
      }
      if (!listAll) pick = this._choose(chars, pairs);
    }
    this.info.allServices = all;
    return pick;
  }

  // Probe button: lists every service and characteristic (no reads, no notifications).
  async listServices() {
    var server = this._server;
    if (!server || !server.connected) return this.info.allServices || [];
    this._logger.log('info', 'Probe: listing the adapter Bluetooth services (nothing is read or changed).');
    await this._walk(server, [], true);
    return this.info.allServices;
  }

  _choose(chars, pairsInOrder) {
    function find(service, uuid) {
      for (var i = 0; i < chars.length; i++) {
        if (chars[i].service === service && chars[i].uuid === uuid) return chars[i];
      }
      return null;
    }
    // 1. Known pairs.
    var kps = pairsInOrder || KNOWN_PAIRS;
    for (var k = 0; k < kps.length; k++) {
      var kp = kps[k];
      var n = find(kp.service, kp.notify);
      var w = find(kp.service, kp.write);
      if (n && w && canNotify(n) && canWrite(w)) return { notify: n, write: w, reason: 'known pair', pair: kp };
    }
    // 2. Any service having both a notify and a write characteristic. Prefer candidate services,
    //    then a characteristic with plain (acknowledged) write.
    var bySvc = {};
    var order = [];
    for (var i = 0; i < chars.length; i++) {
      var sv = chars[i].service;
      if (!bySvc[sv]) { bySvc[sv] = []; order.push(sv); }
      bySvc[sv].push(chars[i]);
    }
    order.sort(function (a, b) {
      var ia = CANDIDATE_SERVICES.indexOf(a); if (ia < 0) ia = 99;
      var ib = CANDIDATE_SERVICES.indexOf(b); if (ib < 0) ib = 99;
      return ia - ib;
    });
    function bestWrite(list) {
      var best = null;
      for (var j = 0; j < list.length; j++) {
        if (!canWrite(list[j])) continue;
        if (!best || (list[j].props.write && !best.props.write)) best = list[j];
      }
      return best;
    }
    function firstNotify(list) {
      for (var j = 0; j < list.length; j++) if (canNotify(list[j])) return list[j];
      return null;
    }
    for (var o = 0; o < order.length; o++) {
      var list = bySvc[order[o]];
      // skip standard GAP/GATT/device info services
      if (/^0000(1800|1801|180a)-/.test(order[o])) continue;
      var nn = firstNotify(list);
      var ww = bestWrite(list);
      if (nn && ww) return { notify: nn, write: ww, reason: 'same service' };
    }
    // 3. Across services.
    var filtered = chars.filter(function (c) { return !/^0000(1800|1801|180a)-/.test(c.service); });
    var n2 = firstNotify(filtered);
    var w2 = bestWrite(filtered);
    if (n2 && w2) return { notify: n2, write: w2, reason: 'different services' };
    return null;
  }

  _handleNotify(event, linkId) {
    var link = this._link;
    if (!link || link.id !== linkId) return; // an old link's characteristic: ignore
    var dv = event && event.target && event.target.value;
    if (!dv) return;
    var now = nowMs();
    var raw = '';
    for (var i = 0; i < dv.byteLength; i++) raw += String.fromCharCode(dv.getUint8(i));
    this._ring.push({ t: now / 1000, n: dv.byteLength, text: raw });
    if (this._ring.length > RING_SIZE) this._ring.splice(0, this._ring.length - RING_SIZE);
    link.rxBytes += dv.byteLength;
    link.lastRxAt = now;
    var text = decodeBytes(dv);
    if (!text) return;
    this._ackSawData(text);
    // Track the reply that has not reached its '>' prompt yet, for the drop report.
    var p = this._partial + text;
    var gt = p.lastIndexOf('>');
    this._partial = gt >= 0 ? p.slice(gt + 1) : p;
    if (this._partial.length > 400) this._partial = this._partial.slice(-400);
    if (typeof this.onData === 'function') {
      try { this.onData(text); } catch (e) {
        this._logger.log('error', 'onData handler failed: ' + errText(e));
      }
    }
  }

  _startPolling() {
    this._stopPolling();
    var self = this;
    this._pollTimer = unref(setInterval(function () { self._poll(); }, this._pollMs));
  }

  _stopPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  _poll() {
    var link = this._link;
    if (!link || link.dropHandled || this._userDisconnect || link.pollClosedAt) return;
    var server = this._server;
    if (server && server.connected) return;
    link.pollClosedAt = nowMs();
    var self = this;
    link.pollWait = unref(setTimeout(function () {
      link.pollWait = null;
      if (link.dropHandled) return;
      self._logger.log('warn', 'Link reported closed by polling. The browser\'s disconnect event did not come within ' +
        secs(self._eventWaitMs) + ' s.');
      self._lateEvent = { at: link.pollClosedAt };
      self._dropOnce(link);
    }, this._eventWaitMs));
  }

  _handleGattDisconnect() {
    var link = this._link;
    if (link && link.upAt != null && !link.dropHandled) {
      if (link.pollClosedAt) {
        if (link.pollWait) { clearTimeout(link.pollWait); link.pollWait = null; }
        this._logger.log('info', 'Link reported closed by polling, ' + Math.round(nowMs() - link.pollClosedAt) +
          ' ms before the browser\'s disconnect event.');
      }
      this._dropOnce(link);
      return;
    }
    if (link && link.dropHandled) return;
    if (this._lateEvent) {
      // The drop was already handled after polling saw it. This is the browser catching up.
      var late = this._lateEvent;
      this._lateEvent = null;
      this._logger.log('info', 'The browser\'s disconnect event arrived ' + Math.round(nowMs() - late.at) +
        ' ms after polling saw the link close (already handled).');
      return;
    }
    // No link is up yet: the drop happened during setup.
    var wasUser = this._userDisconnect;
    this._teardown();
    this._logger.log(wasUser ? 'info' : 'warn', wasUser ? 'Disconnected from adapter.' : 'Adapter connection lost.');
    this._reportDisconnect(wasUser
      ? 'Disconnected.'
      : 'The adapter disconnected. It may have lost power, gone out of range, or the car went to sleep. Tap Connect to try again.');
  }

  // Runs the drop handling for one link, exactly once.
  _dropOnce(link) {
    if (!link || link.dropHandled) return;
    link.dropHandled = true;
    if (link.pollWait) { clearTimeout(link.pollWait); link.pollWait = null; }
    var wasUser = this._userDisconnect;
    this.lastDrop = this._linkStats(link, !wasUser);
    if (!wasUser) {
      this._session.drops++;
      this._dumpRing();
    }
    this._teardown();
    this._logger.log(wasUser ? 'info' : 'warn', wasUser ? 'Disconnected from adapter.' : 'Adapter connection lost.');
    this._reportDisconnect(wasUser
      ? 'Disconnected.'
      : 'The adapter disconnected. It may have lost power, gone out of range, or the car went to sleep. Tap Connect to try again.');
  }

  _linkStats(link, unexpected) {
    var now = nowMs();
    return {
      unexpected: !!unexpected,
      secondsSinceConnect: (now - link.gattAt) / 1000,
      channel: this.info.serviceUuid ? shortUuid(this.info.serviceUuid) : '?',
      writeMode: this._writeMode,
      writeModeText: writeModeLabel(this._writeMode) + (this._downgraded ? ' (acknowledged writes switched off this session)' : ''),
      commands: link.commands,
      rxBytes: link.rxBytes,
      secondsSinceLastRx: link.lastRxAt == null ? null : (now - link.lastRxAt) / 1000
    };
  }

  _dumpRing() {
    var last = this._ring.slice(-RING_DUMP);
    if (!last.length) {
      this._logger.log('warn', 'Last data before the drop: nothing was received.');
    }
    for (var i = 0; i < last.length; i++) {
      var r = last[i];
      this._logger.log('warn', 'Last data before the drop: at ' + r.t.toFixed(3) + ' s, ' + r.n + ' byte' + (r.n === 1 ? '' : 's') +
        ', "' + visibleText(r.text) + '"');
    }
    if (this._partial && this._partial.replace(/\s/g, '')) {
      this._logger.log('warn', 'Partial reply at the drop: "' + visibleText(this._partial) + '"');
    }
  }

  _logTally() {
    var s = this._session;
    var t = s.connectedMs + (this._link && this._link.upAt != null ? nowMs() - this._link.gattAt : 0);
    this._logger.log('info', 'Links so far: ' + s.links + ', drops: ' + s.drops + ', connected time: ' + secs(t) +
      ' s, average ' + (s.drops ? secs(t / s.drops) + ' s per drop' : 'not available yet (no drops)') +
      ', write mode ' + writeModeLabel(this._writeMode) + (this._downgraded ? ' (acknowledged writes switched off this session)' : ''));
  }

  // Session counters, also used by tests.
  sessionStats() {
    return { links: this._session.links, drops: this._session.drops, connectedMs: this._session.connectedMs };
  }

  _reportDisconnect(reason) {
    if (this._disconnectReported) return;
    this._disconnectReported = true;
    if (typeof this.onDisconnect === 'function') {
      try { this.onDisconnect(reason); } catch (e) {
        this._logger.log('error', 'onDisconnect handler failed: ' + errText(e));
      }
    }
  }

  _teardown() {
    this._connected = false;
    this._stopPolling();
    var link = this._link;
    if (link) {
      if (link.pollWait) { clearTimeout(link.pollWait); link.pollWait = null; }
      if (link.upAt != null) this._session.connectedMs += nowMs() - link.gattAt;
    }
    this._link = null;
    if (this._notifyChar && this._notifyHandler) {
      try { this._notifyChar.removeEventListener('characteristicvaluechanged', this._notifyHandler); } catch (e) { /* ignore */ }
    }
    this._notifyHandler = null;
    this._notifyChar = null;
    this._writeChar = null;
    this._server = null;
    this._ackWaiter = null;
    // Writes queued for the old link fail on their own (they check the link). A new link
    // starts with an empty queue.
    this._writeChain = Promise.resolve();
  }

  // Reads the standard Device Information fields (firmware version and so on).
  // Returns {manufacturer, model, hardware, firmware, software} with null for missing fields.
  // Never throws: a missing service or a failed read just gives nulls.
  // The app calls this at most once per page session (see js/adapter-info.js).
  async readDeviceInfo() {
    var out = {};
    DEVICE_INFO_FIELDS.forEach(function (f) { out[f.key] = null; });
    var server = this._server;
    if (!server || !server.connected) return out;
    var svc;
    try {
      svc = await withTimeout(server.getPrimaryService(uuid16(0x180a)), 4000, 'Opening device information');
    } catch (e) {
      this._logger.log('info', 'Device information not available: ' + errText(e));
      return out;
    }
    for (var i = 0; i < DEVICE_INFO_FIELDS.length; i++) {
      var f = DEVICE_INFO_FIELDS[i];
      if (!server.connected) break;
      try {
        var ch = await withTimeout(svc.getCharacteristic(f.uuid), 3000, 'Opening ' + f.label);
        var v = await withTimeout(ch.readValue(), 3000, 'Reading ' + f.label);
        var text = cleanText(v);
        out[f.key] = text || null;
      } catch (e) { /* field not present or not readable */ }
    }
    this.info.deviceInfo = out;
    return out;
  }

  async disconnect() {
    this._userDisconnect = true;
    this._stopPolling();
    var device = this._device;
    var notifyChar = this._notifyChar;
    if (notifyChar && this.isConnected()) {
      try { await notifyChar.stopNotifications(); } catch (e) { /* ignore */ }
    }
    if (device && device.gatt && device.gatt.connected) {
      try { device.gatt.disconnect(); } catch (e) { /* ignore */ }
      // gattserverdisconnected normally fires. Make sure we report even if it does not.
      await new Promise(function (r) { setTimeout(r, 300); });
    }
    if (!this._disconnectReported) {
      if (this._link && this._link.upAt != null && !this._link.dropHandled) {
        this._dropOnce(this._link);
      } else {
        this._teardown();
        this._logger.log('info', 'Disconnected from adapter.');
        this._reportDisconnect('Disconnected.');
      }
    }
    if (device) {
      try { device.removeEventListener('gattserverdisconnected', this._onGattDisconnect); } catch (e) { /* ignore */ }
    }
    this._device = null;
  }

  // Queues one message. Writes are strictly one at a time: a write starts only after the
  // previous one has settled. The returned promise rejects on a failed or unconfirmed write.
  write(text) {
    var self = this;
    var link = this._link;
    if (link) link.commands++;
    return new Promise(function (resolve, reject) {
      var job = self._writeChain.then(function () { return self._writeNow(text, link, reject); });
      // The queue moves on only once this job has fully settled.
      self._writeChain = job.then(noop, noop);
      job.then(resolve, reject);
    });
  }

  async _writeNow(text, link, failEarly) {
    if (!link || this._link !== link || !this.isConnected() || !this._writeChar) {
      throw new Error('Not connected to the adapter.');
    }
    var ch = this._writeChar;
    var bytes = encodeAscii(text);
    for (var off = 0; off < bytes.length; off += CHUNK) {
      if (this._link !== link || !this._writeChar) throw new Error('Not connected to the adapter.');
      // slice() makes an exact-size copy with its own buffer. Bluefy sends a view's whole
      // underlying buffer, so a subarray or a view must never be passed to a write.
      var chunk = bytes.slice(off, Math.min(off + CHUNK, bytes.length));
      var mode = this._writeMode;
      var acked = mode !== 'withoutResponse';
      try {
        await this._writeOne(ch, chunk, failEarly, mode, link);
        if (acked) link.ackConfirmed = true;
      } catch (e) {
        // Auto mode only: a quick refusal of the first acknowledged write on a link, with the
        // link still up 300 ms later, means this browser cannot do acknowledged writes.
        // A timeout never downgrades here (a dying link looks the same). See _noteTimeout.
        var candidate = e && e.quickReject && acked && this._requestedWrite === 'auto' &&
          !link.ackConfirmed && !this._downgraded && this._canDowngrade();
        if (!candidate) throw e;
        await new Promise(function (r) { setTimeout(r, REJECT_CHECK_MS); });
        if (this._link !== link || link.dropHandled || !this.isConnected()) throw e;
        this._downgrade('Acknowledged writes failed on this browser (' + (e.message || errText(e)) +
          '). Switching to writes without acknowledgement for this session.');
        await this._writeOne(ch, chunk, failEarly, this._writeMode, link);
      }
    }
  }

  _canDowngrade() {
    var ch = this._writeChar;
    var wp = this._writeProps || {};
    return !!ch && !!wp.writeWithoutResponse && typeof ch.writeValueWithoutResponse === 'function';
  }

  _downgrade(warnText) {
    this._logger.log('warn', warnText);
    this._downgraded = true;
    this._writeMode = 'withoutResponse';
    this._logger.log('info', 'Write method ' + writeMethodName(this._writeMode) + ' (after the switch).');
  }

  // A write that timed out counts as one strike against the browser's acknowledgements when
  // the adapter sent data after the write was issued and the link is still up strikeWaitMs
  // after the timeout. Two strikes in a page session switch auto mode to writes without
  // acknowledgement. A drop in that window means the link was the problem, not the browser.
  _noteTimeout(link, rxAtIssue) {
    var self = this;
    unref(setTimeout(function () {
      if (self._link !== link || link.dropHandled || !self.isConnected()) return;
      if (link.rxBytes <= rxAtIssue) return;
      self._ackStrikes++;
      self._logger.log('info', 'Write not confirmed although the adapter answered (' + self._ackStrikes + ' of 2 before acknowledged writes are switched off).');
      if (self._ackStrikes >= 2 && self._requestedWrite === 'auto' && !self._downgraded &&
          self._writeMode !== 'withoutResponse' && self._canDowngrade()) {
        self._downgrade('The browser did not confirm writes that the adapter clearly received. Switching to writes without acknowledgement for this session.');
      }
    }, this._strikeWaitMs));
  }

  // Called for every notification while a write is pending. A '>' prompt after the write was
  // issued proves the adapter got the bytes, so the queue moves on without waiting for a late
  // acknowledgement.
  _ackSawData(text) {
    var w = this._ackWaiter;
    if (w && text.indexOf('>') >= 0) w.release();
  }

  // One chunk. Resolves when the browser settles the write, or when the adapter's '>' prompt
  // arrives after the write was issued (the late acknowledgement then settles in the
  // background). If neither happens within the write timeout, the caller is told at once
  // (failEarly) but the queue still waits for the write to settle, so the next write cannot
  // overlap it. A write that never settles releases the queue after WRITE_RELEASE_MS.
  // Rejections carry quickReject = true when the browser refused before the timeout.
  _writeOne(ch, chunk, failEarly, mode, link) {
    var self = this;
    var issuedAt = Date.now();
    var rxAtIssue = link ? link.rxBytes : 0;
    var raw;
    try { raw = Promise.resolve(this._writeChunk(ch, chunk, mode)); } catch (e) { raw = Promise.reject(e); }
    return new Promise(function (resolve, reject) {
      var settled = false;     // the queue has been released (resolve or reject called)
      var acked = false;       // the browser settled the write itself
      var timedOut = null;
      var waiter = {
        release: function () {
          if (settled) return;
          settled = true;
          clearTimeout(t2);
          if (self._ackWaiter === waiter) self._ackWaiter = null;
          if (link && !link.lateAckLogged) {
            link.lateAckLogged = true;
            self._logger.log('info', 'The adapter replied before the browser confirmed the write. Moving on without waiting (shown once per link).');
          }
          resolve();
        }
      };
      self._ackWaiter = waiter;
      function done() { if (self._ackWaiter === waiter) self._ackWaiter = null; clearTimeout(t1); clearTimeout(t2); }
      var t1 = setTimeout(function () {
        if (acked) return;
        timedOut = new Error('Bluetooth write was not confirmed within ' + secs(self._writeTimeoutMs) + ' s');
        timedOut.timedOut = true;
        if (link && mode !== 'withoutResponse') self._noteTimeout(link, rxAtIssue);
        if (settled) return; // the adapter already answered, nothing to report
        self._logger.log('warn', timedOut.message + '. Reporting it as a send error.');
        if (typeof failEarly === 'function') failEarly(timedOut);
      }, self._writeTimeoutMs);
      var t2 = unref(setTimeout(function () {
        if (settled) return;
        settled = true;
        done();
        self._logger.log('warn', 'Bluetooth write still not settled after ' + secs(self._writeReleaseMs) + ' s. Releasing the write queue.');
        reject(timedOut || new Error('Bluetooth write never settled'));
      }, self._writeReleaseMs));
      raw.then(function () {
        acked = true;
        if (settled) { clearTimeout(t1); return; }
        settled = true;
        done();
        if (timedOut) reject(timedOut); else resolve();
      }, function (e) {
        acked = true;
        if (settled) { clearTimeout(t1); return; } // late failure after the adapter answered: ignore
        settled = true;
        done();
        if (timedOut) { reject(timedOut); return; }
        var err = asError(e, 'Bluetooth write');
        err.quickReject = Date.now() - issuedAt < self._writeTimeoutMs;
        reject(err);
      });
    });
  }

  _writeChunk(ch, chunk, mode) {
    var m = mode || this._writeMode;
    if (m === 'withoutResponse') return ch.writeValueWithoutResponse(chunk);
    if (m === 'withResponse') return ch.writeValueWithResponse(chunk);
    return ch.writeValue(chunk);
  }
}
