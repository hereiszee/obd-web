// BleTransport: talks to a BLE ELM327 adapter (for example Vgate vLinker MC+) over Web Bluetooth.
// Connection happens entirely in this page. No pairing in phone settings is needed.

import { logger as defaultLogger } from './log.js?v=1.0.9';

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
  '49535343-fe7d-4ae5-8fa9-9fafd205e455'    // Microchip / ISSC transparent UART
];

// Known notify/write pairs, in order of preference.
var KNOWN_PAIRS = [
  // Proven on a real vLinker MC-IOS (Bluefy, Nov 2026).
  { service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', notify: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', write: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f' },
  { service: uuid16(0x18f0), notify: uuid16(0x2af0), write: uuid16(0x2af1) },
  { service: uuid16(0xfff0), notify: uuid16(0xfff1), write: uuid16(0xfff2) },
  { service: uuid16(0xffe0), notify: uuid16(0xffe1), write: uuid16(0xffe1) },
  { service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e' },
  { service: '49535343-fe7d-4ae5-8fa9-9fafd205e455', notify: '49535343-1e4d-4bd9-ba61-23c647249616', write: '49535343-8841-43f4-a8d4-ecbe34729bb3' }
];

var CHUNK = 20;

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

// Bluefy reports 16-bit UUIDs in short form ('18f0'). Expand so comparisons work everywhere.
export function normUuid(u) {
  var x = String(u || '').toLowerCase();
  if (/^[0-9a-f]{4}$/.test(x)) return '0000' + x + '-0000-1000-8000-00805f9b34fb';
  if (/^[0-9a-f]{8}$/.test(x)) return x + '-0000-1000-8000-00805f9b34fb';
  return x;
}

function shortUuid(u) {
  var m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(u);
  return m ? m[1] : u;
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

export class BleTransport {
  constructor(opts) {
    opts = opts || {};
    this.name = 'ble';
    this.onData = null;
    this.onDisconnect = null;
    this.info = { deviceName: null, serviceUuid: null, writeUuid: null, notifyUuid: null, allServices: [] };
    this._logger = opts.logger || defaultLogger;
    this._prefer = opts.prefer || 'auto';   // 'auto' | 'e781' | '18f0'
    this._forceWrite = opts.writeMode === 'withResponse' ? 'withResponse' : null;
    this._device = null;
    this._server = null;
    this._notifyChar = null;
    this._writeChar = null;
    this._writeMode = null;
    this._connected = false;
    this._userDisconnect = false;
    this._disconnectReported = false;
    this._writeChain = Promise.resolve();
    this._onNotify = this._handleNotify.bind(this);
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
    this.info = { deviceName: device.name || '(no name)', serviceUuid: null, writeUuid: null, notifyUuid: null, allServices: [] };
    this._logger.log('info', 'Selected device: ' + this.info.deviceName + (device.id ? ' (id ' + device.id + ')' : ''));
    device.addEventListener('gattserverdisconnected', this._onGattDisconnect);

    try {
      await this._setupWithRetry(device);
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
  async _setupWithRetry(device) {
    try {
      await this._setup(device);
    } catch (first) {
      if (this._userDisconnect) throw first;
      this._logger.log('warn', 'Setup failed (' + errText(first) + '). Retrying once...');
      this._teardown();
      try { if (device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch (e3) { /* ignore */ }
      await new Promise(function (r) { setTimeout(r, 800); });
      await this._setup(device);
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
      await this._setupWithRetry(device);
    } catch (e) {
      this._teardown();
      try { if (device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch (e2) { /* ignore */ }
      this._disconnectReported = false;
      throw e;
    }
    this._logger.log('info', 'Reconnected.');
    return this.info;
  }

  async _setup(device) {
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
    if (this._userDisconnect) {
      // The user tapped Disconnect while we were connecting. Do not leave a link nobody owns.
      try { device.gatt.disconnect(); } catch (e) { /* ignore */ }
      throw new Error('Connection cancelled');
    }
    this._server = server;
    this._logger.log('info', 'GATT connected. Discovering services...');

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
    // Lists one service's characteristics. Returns false if listing failed.
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

    // Fast path: open only the known adapter services, in order of preference, and stop at the
    // first usable pair. Listing every service is slow and the vLinker can drop the link meanwhile.
    var pairs = KNOWN_PAIRS.slice();
    var want = this._prefer === '18f0' ? uuid16(0x18f0) : this._prefer === 'e781' ? 'e7810a71-73ae-499d-8c15-faa9aef0c3f2' : null;
    if (want) {
      pairs.sort(function (a, b) { return (a.service === want ? 0 : 1) - (b.service === want ? 0 : 1); });
      this._logger.log('info', 'Preferred Bluetooth channel: ' + shortUuid(want));
    }
    var pick = null;
    for (var k = 0; k < pairs.length && !pick; k++) {
      if (!svcByUuid[pairs[k].service]) continue;
      await listService(pairs[k].service);
      pick = this._choose(chars, pairs);
    }
    // Slow path: list everything else and pick the best match.
    if (!pick) {
      for (var u in svcByUuid) {
        if (!server.connected) break;
        await listService(u);
      }
      pick = this._choose(chars);
    }
    this.info.allServices = all;
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
    var wp = pick.write.props;
    this._writeProps = wp;
    if (wp.writeWithoutResponse && typeof this._writeChar.writeValueWithoutResponse === 'function') this._writeMode = 'withoutResponse';
    else if (typeof this._writeChar.writeValueWithResponse === 'function' && wp.write) this._writeMode = 'withResponse';
    else this._writeMode = 'legacy';
    if (this._forceWrite && wp.write && typeof this._writeChar.writeValueWithResponse === 'function') {
      this._writeMode = 'withResponse';
    }
    this._logger.log('info', 'Using notify ' + pick.notify.uuid + ' and write ' + pick.write.uuid +
      ' in service ' + pick.write.service + ' (' + pick.reason + ', write mode ' + this._writeMode + ')');

    this._notifyChar.addEventListener('characteristicvaluechanged', this._onNotify);
    await withTimeout(this._notifyChar.startNotifications(), 6000, 'Starting notifications');
    this._logger.log('info', 'Notifications started.');
    if (this._userDisconnect) {
      try { device.gatt.disconnect(); } catch (e) { /* ignore */ }
      throw new Error('Connection cancelled');
    }
    this._connected = true;
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
      if (n && w && canNotify(n) && canWrite(w)) return { notify: n, write: w, reason: 'known pair' };
    }
    // 2. Any service having both a notify and a write characteristic. Prefer candidate services,
    //    then writeWithoutResponse.
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
        if (!best || (list[j].props.writeWithoutResponse && !best.props.writeWithoutResponse)) best = list[j];
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

  _handleNotify(event) {
    var dv = event && event.target && event.target.value;
    if (!dv) return;
    var text = decodeBytes(dv);
    if (!text) return;
    if (typeof this.onData === 'function') {
      try { this.onData(text); } catch (e) {
        this._logger.log('error', 'onData handler failed: ' + errText(e));
      }
    }
  }

  _handleGattDisconnect() {
    var wasUser = this._userDisconnect;
    this._teardown();
    this._logger.log(wasUser ? 'info' : 'warn', wasUser ? 'Disconnected from adapter.' : 'Adapter connection lost.');
    this._reportDisconnect(wasUser
      ? 'Disconnected.'
      : 'The adapter disconnected. It may have lost power, gone out of range, or the car went to sleep. Tap Connect to try again.');
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
    if (this._notifyChar) {
      try { this._notifyChar.removeEventListener('characteristicvaluechanged', this._onNotify); } catch (e) { /* ignore */ }
    }
    this._notifyChar = null;
    this._writeChar = null;
    this._server = null;
    this._writeChain = Promise.resolve();
  }

  async disconnect() {
    this._userDisconnect = true;
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
      this._teardown();
      this._logger.log('info', 'Disconnected from adapter.');
      this._reportDisconnect('Disconnected.');
    }
    if (device) {
      try { device.removeEventListener('gattserverdisconnected', this._onGattDisconnect); } catch (e) { /* ignore */ }
    }
    this._device = null;
  }

  async write(text) {
    var self = this;
    var job = this._writeChain.then(function () { return self._writeNow(text); });
    // keep chain alive after errors
    this._writeChain = job.catch(function () {});
    return job;
  }

  async _writeNow(text) {
    if (!this.isConnected() || !this._writeChar) {
      throw new Error('Not connected to the adapter.');
    }
    var bytes = encodeAscii(text);
    for (var off = 0; off < bytes.length; off += CHUNK) {
      var chunk = bytes.slice(off, Math.min(off + CHUNK, bytes.length));
      var ch = this._writeChar;
      if (!ch) throw new Error('Not connected to the adapter.');
      try {
        await this._writeChunk(ch, chunk);
      } catch (e) {
        // Some WebViews reject write-without-response even though the characteristic advertises it.
        // If plain writes are possible, switch to them for good and retry this chunk once.
        var fallback = this._fallbackMode();
        if (!fallback || !this.isConnected()) throw e;
        this._logger.log('warn', 'Write without response failed (' + errText(e) + '). Switching to write mode ' + fallback + '.');
        this._writeMode = fallback;
        await this._writeChunk(ch, chunk);
      }
    }
  }

  _writeChunk(ch, chunk) {
    if (this._writeMode === 'withoutResponse') return ch.writeValueWithoutResponse(chunk);
    if (this._writeMode === 'withResponse') return ch.writeValueWithResponse(chunk);
    return ch.writeValue(chunk);
  }

  _fallbackMode() {
    if (this._writeMode !== 'withoutResponse') return null;
    var ch = this._writeChar;
    var wp = this._writeProps || {};
    if (!ch) return null;
    if (wp.write && typeof ch.writeValueWithResponse === 'function') return 'withResponse';
    if (typeof ch.writeValue === 'function') return 'legacy';
    return null;
  }
}
