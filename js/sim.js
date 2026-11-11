// SimTransport: a simulated ELM327 v1.5 adapter plugged into a simulated car.
// Same interface as BleTransport (js/ble.js). Used for demos and for testing
// the parsing code without a real car.
//
// Scenarios:
//   normal       2020 Toyota C-HR Hybrid style car, ISO 15765-4 CAN 11 bit 500k,
//                engine ECU 7E8 and hybrid control ECU 7EA.
//   ignitionOff  adapter has power but the car is asleep: searches fail.
//   legacy       older petrol car on ISO 9141-2 (protocol 3), headers 48 6B 10.
//
// Options: new SimTransport({ scenario, timeScale, noDataRate, canPadding, seed })
//   timeScale   multiplies every delay (1 = realistic, 0.05 = fast tests)
//   noDataRate  chance a live sensor PID request gets NO DATA (default 0.05)
//   canPadding  pad CAN frames to 8 bytes with 00 (visible when headers are on)
//   seed        number for a repeatable random sequence

const ELM_ID = 'ELM327 v1.5';
const DEVICE_DESC = 'vLinker MC+ (simulated)';
const SVC = 'e7810a71-73ae-499d-8c15-faa9aef0c3f2';
const CHR = 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f';

const PROTO_NAMES = {
  1: 'SAE J1850 PWM',
  2: 'SAE J1850 VPW',
  3: 'ISO 9141-2',
  4: 'ISO 14230-4 (KWP 5BAUD)',
  5: 'ISO 14230-4 (KWP FAST)',
  6: 'ISO 15765-4 (CAN 11/500)',
  7: 'ISO 15765-4 (CAN 29/500)',
  8: 'ISO 15765-4 (CAN 11/250)',
  9: 'ISO 15765-4 (CAN 29/250)',
  10: 'SAE J1939 (CAN 29/250)',
  11: 'USER1 CAN (11* /125)',
  12: 'USER2 CAN (11* /50)'
};

// Mode 01 PIDs each simulated ECU supports (bitmap PIDs 20/40 mark "next block supported").
const SUPPORTED = {
  normal: {
    '7E8': [0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x13, 0x15, 0x1C, 0x1F, 0x20,
      0x21, 0x24, 0x2E, 0x2F, 0x30, 0x31, 0x33, 0x34, 0x3C, 0x40,
      0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x49, 0x4A, 0x4C, 0x4D, 0x4E, 0x51],
    '7EA': [0x01, 0x1C, 0x20, 0x21, 0x30, 0x31, 0x40, 0x42, 0x4D, 0x4E, 0x5B]
  },
  legacy: {
    '10': [0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x13, 0x14, 0x15, 0x1C, 0x20, 0x21]
  }
};

// Mode 02 (freeze frame) PIDs supported by the engine ECU.
const FF_SUPPORTED = {
  normal: [0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x11, 0x1F, 0x20, 0x40, 0x42, 0x43, 0x44, 0x45, 0x46, 0x49],
  legacy: [0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0C, 0x0D, 0x0E, 0x0F, 0x11]
};

// Freeze frame captured when P0171 (system too lean) was set. Physical values.
const FREEZE_P0171 = {
  0x03: 2, 0x04: 27.8, 0x05: 86, 0x06: 17.2, 0x07: 14.8, 0x0B: 38, 0x0C: 1520, 0x0D: 48, 0x0E: 14.5,
  0x0F: 22, 0x11: 17.6, 0x1F: 1342, 0x42: 13.98, 0x43: 26.3, 0x44: 1.0, 0x45: 4.3, 0x46: 12, 0x49: 22.4
};

// Sensor PIDs that may randomly return NO DATA (to exercise error handling).
const FLAKY = [0x04, 0x05, 0x06, 0x07, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x14, 0x15, 0x24, 0x2E, 0x2F,
  0x33, 0x34, 0x3C, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x49, 0x4A, 0x4C, 0x5B];

const FAKE_VIN = 'NMTKZ3BX10R000001';

// Speed profile in km/h: [seconds into a 120 s loop, target speed].
const DRIVE = [[0, 0], [12, 0], [30, 50], [45, 56], [60, 48], [70, 50], [85, 20], [95, 35], [105, 30], [118, 0], [120, 0]];

// ---------- small helpers ----------

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function u8(v) { return clamp(Math.round(v), 0, 255); }
function u16(v) { const r = clamp(Math.round(v), 0, 65535); return [r >> 8, r & 0xFF]; }
function pct(v) { return u8(v * 255 / 100); }
function tmp(v) { return u8(v + 40); }
function trim(v) { return u8(v * 128 / 100 + 128); }
function hex2(b) { return (b < 16 ? '0' : '') + b.toString(16).toUpperCase(); }

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function encodeDtc(code) {
  const first = { P: 0, C: 1, B: 2, U: 3 }[code.charAt(0)];
  const d1 = parseInt(code.charAt(1), 16);
  const d2 = parseInt(code.charAt(2), 16);
  return [(first << 6) | (d1 << 4) | d2, parseInt(code.substr(3, 2), 16)];
}

function bitmap(list, base) {
  const out = [0, 0, 0, 0];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p > base && p <= base + 0x20) {
      const idx = p - base - 1;
      out[idx >> 3] |= 0x80 >> (idx & 7);
    }
  }
  return out;
}

function ascii(str, len) {
  const out = [];
  for (let i = 0; i < len; i++) out.push(i < str.length ? str.charCodeAt(i) : 0);
  return out;
}

function interp(profile, t) {
  for (let i = 1; i < profile.length; i++) {
    if (t <= profile[i][0]) {
      const a = profile[i - 1];
      const b = profile[i];
      return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
    }
  }
  return profile[profile.length - 1][1];
}

// Inverse SAE J1979 formulas: physical value to raw data bytes.
const ENC = {
  0x03: (v) => [v, 0],
  0x04: (v) => [pct(v)],
  0x05: (v) => [tmp(v)],
  0x06: (v) => [trim(v)],
  0x07: (v) => [trim(v)],
  0x0B: (v) => [u8(v)],
  0x0C: (v) => u16(v * 4),
  0x0D: (v) => [u8(v)],
  0x0E: (v) => [u8((v + 64) * 2)],
  0x0F: (v) => [tmp(v)],
  0x10: (v) => u16(v * 100),
  0x11: (v) => [pct(v)],
  0x13: (v) => [v],
  0x14: (v) => [u8(v.volts * 200), v.trim === null ? 0xFF : trim(v.trim)],
  0x15: (v) => [u8(v.volts * 200), v.trim === null ? 0xFF : trim(v.trim)],
  0x1C: (v) => [v],
  0x1F: (v) => u16(v),
  0x21: (v) => u16(v),
  0x24: (v) => u16(v.lambda * 32768).concat(u16(v.volts * 8192)),
  0x2E: (v) => [pct(v)],
  0x2F: (v) => [pct(v)],
  0x30: (v) => [u8(v)],
  0x31: (v) => u16(v),
  0x33: (v) => [u8(v)],
  0x34: (v) => u16(v.lambda * 32768).concat(u16((v.ma + 128) * 256)),
  0x3C: (v) => u16((v + 40) * 10),
  0x41: (v) => v,
  0x42: (v) => u16(v * 1000),
  0x43: (v) => u16(v * 255 / 100),
  0x44: (v) => u16(v * 32768),
  0x45: (v) => [pct(v)],
  0x46: (v) => [tmp(v)],
  0x47: (v) => [pct(v)],
  0x49: (v) => [pct(v)],
  0x4A: (v) => [pct(v)],
  0x4C: (v) => [pct(v)],
  0x4D: (v) => u16(v),
  0x4E: (v) => u16(v),
  0x51: (v) => [v],
  0x5B: (v) => [pct(v)]
};

// ---------- the transport ----------

export class SimTransport {
  constructor(opts) {
    const o = opts || {};
    this.name = 'sim';
    this.onData = null;
    this.onDisconnect = null;
    this.scenario = (o.scenario === 'ignitionOff' || o.scenario === 'legacy') ? o.scenario : 'normal';
    this.timeScale = typeof o.timeScale === 'number' ? o.timeScale : 1;
    this.noDataRate = typeof o.noDataRate === 'number' ? o.noDataRate : 0.05;
    this.canPadding = o.canPadding !== false;
    this._rand = typeof o.seed === 'number' ? mulberry32(o.seed) : Math.random;
    this.info = {
      deviceInfo: null,
      deviceName: DEVICE_DESC,
      serviceUuid: SVC,
      writeUuid: CHR,
      notifyUuid: CHR,
      allServices: [
        { uuid: '00001800-0000-1000-8000-00805f9b34fb', characteristics: [{ uuid: '00002a00-0000-1000-8000-00805f9b34fb', properties: 'read' }] },
        { uuid: SVC, characteristics: [{ uuid: CHR, properties: 'read, write, writeWithoutResponse, notify' }] }
      ]
    };
    this._connected = false;
    this.lastDrop = null; // BleTransport sets link stats here on a drop. Not used by the simulator.
    this._gen = 0;
    this._timers = [];
    this._busy = false;
    this._inBuf = '';
    this._lastCmd = '';
    this._resetElm(true);
    this._resetCar();
  }

  // ----- Transport interface -----

  async connect() {
    if (this._connected) return this.info;
    await this._sleep(300 + this._rand() * 300);
    this._connected = true;
    this._resetElm(true);
    this._resetCar();
    return this.info;
  }

  async disconnect() {
    if (!this._connected) return;
    this._connected = false;
    this._abort();
    if (typeof this.onDisconnect === 'function') this.onDisconnect('Disconnected from the simulated adapter.');
  }

  // Same shape as BleTransport.readDeviceInfo, with clearly simulated values.
  async readDeviceInfo() {
    this.info.deviceInfo = { manufacturer: 'Simulated adapter', model: 'Sim', hardware: null, firmware: 'sim-1.0', software: null };
    return this.info.deviceInfo;
  }

  // Same shape as BleTransport.listServices (used by the Probe button).
  async listServices() {
    return this.info.allServices;
  }

  isConnected() { return this._connected; }

  async write(text) {
    if (!this._connected) throw new Error('The simulated adapter is not connected.');
    await this._sleep(2 + this._rand() * 8);
    if (!this._connected) return;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);
      if (ch === '\n' || ch === '\0') continue;
      if (this._busy) {
        // Like a real ELM327: any input while it is working interrupts it.
        this._abort();
        this._emit([{ delay: 5 }, { text: 'STOPPED' + this._eol() + this._eol() + '>' }]);
        return;
      }
      if (ch === '\r') {
        const raw = this._inBuf;
        this._inBuf = '';
        this._process(raw);
      } else {
        this._inBuf += ch;
      }
    }
  }

  // Test helper: pretend the BLE link dropped.
  simulateDrop() {
    if (!this._connected) return;
    this._connected = false;
    this._abort();
    if (typeof this.onDisconnect === 'function') this.onDisconnect('The adapter connection was lost (simulated).');
  }

  // ----- ELM and car state -----

  _resetElm(full) {
    this.echo = true;
    this.headers = false;
    this.spaces = true;
    this.linefeeds = false;
    this.caf = true;
    this.header = null; // null = default functional address
    if (full) {
      this.protocol = 0; // 0 = auto
      this.protoAuto = true;
      this.found = 0; // protocol number found on the bus, 0 = not yet
    }
  }

  _resetCar() {
    const legacy = this.scenario === 'legacy';
    this._t0 = Date.now();
    this._lastTick = this._t0;
    this.car = {
      t: 0,
      speed: 0,
      accel: 0,
      rpm: legacy ? 900 : 1300,
      engineOn: true,
      engineTimer: 0,
      coolant: 40,
      coolantStart: 40,
      warmupCounted: false,
      cat: 120,
      soc: 55,
      stft: 2,
      ltft: legacy ? 9.4 : 14.8,
      fuel: 62,
      km: 0,
      kmAtClear: 0,
      tAtClear: null,
      warmups: 3,
      distBase: 85,
      minBase: 42
    };
    this.dtc = {
      stored: legacy ? ['P0171', 'P0420'] : ['P0171', 'P0420', 'P0A80'],
      pending: ['P0300'],
      permanent: legacy ? [] : ['P0420'],
      mil: true,
      freeze: 'P0171',
      cleared: false
    };
  }

  _eol() { return this.linefeeds ? '\r\n' : '\r'; }

  _sleep(ms) {
    return new Promise((res) => setTimeout(res, ms * this.timeScale));
  }

  _abort() {
    this._gen++;
    this._timers.forEach((t) => clearTimeout(t));
    this._timers = [];
    this._busy = false;
    this._inBuf = '';
  }

  // Steps: {delay: ms}, {text: string} or {fn: function} (state change that only happens
  // if the reply is not interrupted first). Text is split into random 1-20 char
  // fragments with 5-60 ms gaps, the way BLE notifications arrive.
  _emit(steps) {
    const gen = this._gen;
    this._busy = true;
    const queue = [];
    steps.forEach((s) => {
      if (s.delay) queue.push({ delay: s.delay });
      if (s.fn) queue.push({ fn: s.fn });
      if (s.text) {
        let i = 0;
        while (i < s.text.length) {
          const n = 1 + Math.floor(this._rand() * 20);
          queue.push({ chunk: s.text.substr(i, n) });
          i += n;
          if (i < s.text.length) queue.push({ delay: 5 + this._rand() * 55 });
        }
      }
    });
    const next = () => {
      if (gen !== this._gen) return;
      while (queue.length) {
        const item = queue.shift();
        if (item.delay) {
          const t = setTimeout(next, item.delay * this.timeScale);
          this._timers.push(t);
          return;
        }
        if (item.fn) { item.fn(); continue; }
        if (typeof this.onData === 'function') this.onData(item.chunk);
        if (gen !== this._gen) return;
      }
      this._busy = false;
      this._timers = [];
    };
    next();
  }

  _reply(lines, delay) {
    const eol = this._eol();
    let text = '';
    lines.forEach((l) => { text += l + eol; });
    return [{ delay: delay || 10 }, { text: text + eol + '>' }];
  }

  // ----- command processing -----

  _process(raw) {
    let cmd = raw.replace(/[\s]/g, '').toUpperCase();
    const steps = [];
    if (this.echo) steps.push({ text: raw + this._eol() });
    if (cmd === '') {
      if (!this._lastCmd) { steps.push({ text: '>' }); this._emit(steps); return; }
      cmd = this._lastCmd;
    } else {
      this._lastCmd = cmd;
    }
    const body = cmd.indexOf('AT') === 0 ? this._at(cmd.substr(2)) : this._obd(cmd);
    this._emit(steps.concat(body));
  }

  _at(c) {
    const ok = (d) => this._reply(['OK'], d || 15 + this._rand() * 20);
    const q = () => this._reply(['?'], 10);
    let m;
    if (c === 'Z') {
      this._resetElm(true);
      return [{ delay: 600 + this._rand() * 300 }, { text: '\r\r' + ELM_ID + '\r\r>' }];
    }
    if (c === 'WS') {
      this._resetElm(true);
      return [{ delay: 150 }, { text: '\r\r' + ELM_ID + '\r\r>' }];
    }
    if (c === 'D') { this._resetElm(false); return ok(); }
    if (c === 'I') return this._reply([ELM_ID], 15);
    if (c === '@1') return this._reply([DEVICE_DESC], 15);
    if ((m = /^([EHSLMR])([01])$/.exec(c))) {
      const on = m[2] === '1';
      if (m[1] === 'E') this.echo = on;
      if (m[1] === 'H') this.headers = on;
      if (m[1] === 'S') this.spaces = on;
      if (m[1] === 'L') this.linefeeds = on;
      return ok();
    }
    if ((m = /^CAF([01])$/.exec(c))) { this.caf = m[1] === '1'; return ok(); }
    if ((m = /^(SP|TP)(A?)([0-9A-C])$/.exec(c))) {
      const n = parseInt(m[3], 16);
      this.protocol = n;
      this.protoAuto = n === 0 || m[2] === 'A';
      this.found = 0;
      return ok();
    }
    if (c === 'DP') return this._reply([this._dp(false)], 15);
    if (c === 'DPN') return this._reply([this._dp(true)], 15);
    if (c === 'RV') return this._reply([this._voltage().toFixed(1) + 'V'], 20 + this._rand() * 20);
    if (c === 'IGN') return this._reply([this.scenario === 'ignitionOff' ? 'OFF' : 'ON'], 15);
    if (c === 'PC') { this.found = 0; return ok(); }
    if ((m = /^SH([0-9A-F]{3}|[0-9A-F]{6}|[0-9A-F]{8})$/.exec(c))) { this.header = m[1]; return ok(); }
    if (/^ST[0-9A-F]{2}$/.test(c) || /^AT[012]$/.test(c) || /^(CFC|CSM|D|V|KW|BI|R|JE|JS|MA0)[01]?$/.test(c) ||
        /^(AL|NL|AR|FE|LP|SI|SR|SLOW|CEA|BI)$/.test(c) || /^IB(10|48|96)$/.test(c) || /^SW[0-9A-F]{2}$/.test(c) ||
        /^CRA[0-9A-FX]{3,8}$/.test(c) || /^(CF|CM)[0-9A-F]{3,8}$/.test(c) || /^WM[0-9A-F]{6,12}$/.test(c) ||
        /^(CEA|TA)[0-9A-F]{2}$/.test(c) || /^PB[0-9A-F]{4}$/.test(c)) {
      return ok();
    }
    return q();
  }

  _dp(numeric) {
    const p = this.found || this.protocol;
    if (numeric) return (this.protoAuto ? 'A' : '') + p.toString(16).toUpperCase();
    if (p === 0) return 'AUTO';
    return (this.protoAuto ? 'AUTO, ' : '') + PROTO_NAMES[p];
  }

  _voltage() {
    const t = (Date.now() - this._t0) / 1000;
    if (this.scenario === 'ignitionOff') return 12.3 + this._rand() * 0.1;
    if (this.scenario === 'legacy') return 13.9 + 0.15 * Math.sin(t / 7) + this._rand() * 0.1;
    return 14.2 + 0.08 * Math.sin(t / 5) + this._rand() * 0.05;
  }

  _carProtocol() { return this.scenario === 'legacy' ? 3 : 6; }

  _obd(cmd) {
    if (!/^[0-9A-F]+$/.test(cmd) || cmd.length < 2) return this._reply(['?'], 10);
    let maxResp = 0;
    if (cmd.length % 2 === 1) {
      // Trailing single digit = number of responses to wait for.
      maxResp = parseInt(cmd.charAt(cmd.length - 1), 16);
      cmd = cmd.substr(0, cmd.length - 1);
    }
    const bytes = [];
    for (let i = 0; i < cmd.length; i += 2) bytes.push(parseInt(cmd.substr(i, 2), 16));
    if (bytes.length > 7) return this._reply(['?'], 10);

    const steps = [];
    const eol = this._eol();
    const carProto = this._carProtocol();
    const asleep = this.scenario === 'ignitionOff';
    // Protocol the reply is formatted for. While searching, this.found is only set once the
    // search delay has run, so an interrupted search (STOPPED) leaves the adapter unlocked.
    let fmtProto = this.found;
    const lock = (p) => { fmtProto = p; steps.push({ fn: () => { this.found = p; } }); };

    if (!this.found) {
      const first = this.protocol || carProto;
      const tryWorks = !asleep && first === carProto;
      if (this.protoAuto && !(this.protocol !== 0 && tryWorks)) {
        steps.push({ delay: 20 }, { text: 'SEARCHING...' + eol });
        if (asleep) {
          const d = this._failedSearches ? 3200 : 4500;
          this._failedSearches = (this._failedSearches || 0) + 1;
          return steps.concat(this._reply(['UNABLE TO CONNECT'], d));
        }
        steps.push({ delay: carProto === 3 ? 2600 : 800 + this._rand() * 150 });
        lock(carProto);
      } else if (!this.protoAuto || tryWorks) {
        const p = this.protocol;
        if (p >= 3 && p <= 5) {
          steps.push({ delay: 20 }, { text: 'BUS INIT: ' }, { delay: 700 }, { text: '...' }, { delay: 1500 });
          if (p !== carProto || asleep) return steps.concat([{ text: 'ERROR' + eol + eol + '>' }]);
          steps.push({ text: 'OK' + eol });
          lock(p);
        } else if (p === 1 || p === 2) {
          return this._reply(['NO DATA'], 300);
        } else if (p === 6 && carProto === 6 && !asleep) {
          lock(6);
        } else if (p === 7 && carProto === 6 && !asleep) {
          return this._reply(['NO DATA'], 250);
        } else {
          return this._reply(['CAN ERROR'], 400);
        }
      }
    }

    this._tick();
    let msgs = this._answer(bytes);
    if (msgs === null || msgs.length === 0) return steps.concat(this._reply(['NO DATA'], 180 + this._rand() * 80));
    if (maxResp > 0) msgs = msgs.slice(0, maxResp);
    const lines = fmtProto === 3 ? this._formatLegacy(msgs) : this._formatCan(msgs);
    const delay = 35 + this._rand() * 60 + (msgs.length > 1 ? 30 : 0);
    return steps.concat(this._reply(lines, delay));
  }

  // ----- ECU behaviour -----

  _ecus() {
    if (this.scenario === 'legacy') return ['10'];
    const h = this.header;
    if (h === null || h === '7DF') return ['7E8', '7EA'];
    if (h === '7E0') return ['7E8'];
    if (h === '7E2') return ['7EA'];
    return [];
  }

  // Returns [{ecu, data:[...]}] (one entry per message) or null for no answer.
  _answer(req) {
    const mode = req[0];
    const ecus = this._ecus();
    const legacy = this.scenario === 'legacy';
    const out = [];
    const neg = (code) => ecus.forEach((e) => out.push({ ecu: e, data: [0x7F, mode, code] }));

    if (mode === 0x01) {
      const pids = req.slice(1);
      if (pids.length === 0) { neg(0x13); return out; }
      if (pids.length > (legacy ? 1 : 6)) return null;
      const live = pids.every((p) => FLAKY.indexOf(p) >= 0);
      if (live && this._rand() < this.noDataRate) return null;
      ecus.forEach((e) => {
        const data = [0x41];
        pids.forEach((p) => {
          const v = this._pidBytes(e, p);
          if (v) data.push(p, ...v);
        });
        if (data.length > 1) out.push({ ecu: e, data: data });
      });
      return out;
    }

    if (mode === 0x02) {
      // Mode 02 requests are PID + frame number pairs (02 0C 00). A PID without its frame
      // number is a malformed request: CAN ECUs answer 7F 02 13, older protocols stay silent.
      if (req.length < 2 || (req.length - 1) % 2 !== 0) {
        if (legacy) return null;
        neg(0x13);
        return out;
      }
      const e = ecus[0] === '7E8' || ecus[0] === '10' ? ecus[0] : null;
      if (!e) return null;
      const data = [0x42];
      for (let i = 1; i < req.length; i += 2) {
        const pid = req[i];
        const frame = req[i + 1];
        if (frame !== 0) continue;
        const v = this._freezeBytes(pid);
        if (v) data.push(pid, frame, ...v);
      }
      return data.length > 1 ? [{ ecu: e, data: data }] : null;
    }

    if (mode === 0x03 || mode === 0x07 || mode === 0x0A) {
      if (req.length !== 1) { neg(0x13); return out; }
      if (legacy && mode === 0x0A) return null;
      const list = mode === 0x03 ? this.dtc.stored : mode === 0x07 ? this.dtc.pending : this.dtc.permanent;
      ecus.forEach((e) => {
        const codes = (e === '7E8' || e === '10') ? list : [];
        if (legacy) {
          // ISO 9141: no count byte, 3 codes per message, padded with 0000.
          const n = Math.max(1, Math.ceil(codes.length / 3));
          for (let i = 0; i < n; i++) {
            const data = [mode + 0x40];
            for (let j = 0; j < 3; j++) {
              const c = codes[i * 3 + j];
              const b = c ? encodeDtc(c) : [0, 0];
              data.push(b[0], b[1]);
            }
            out.push({ ecu: e, data: data });
          }
        } else {
          const data = [mode + 0x40, codes.length];
          codes.forEach((c) => { const b = encodeDtc(c); data.push(b[0], b[1]); });
          out.push({ ecu: e, data: data });
        }
      });
      return out;
    }

    if (mode === 0x04) {
      if (req.length !== 1) { neg(0x13); return out; }
      this._clear();
      ecus.forEach((e) => out.push({ ecu: e, data: [0x44] }));
      return out;
    }

    if (mode === 0x09) return this._mode09(req, ecus);

    if (mode === 0x05 || mode === 0x06) {
      // Mode 05 is not used on CAN. Mode 06 is not simulated.
      if (mode === 0x05 && !legacy) { neg(0x11); return out; }
      return null;
    }

    // Anything else (08, 22, 10, 3E ...) is rejected by the ECUs.
    neg(0x11);
    return out;
  }

  _mode09(req, ecus) {
    const legacy = this.scenario === 'legacy';
    const out = [];
    if (req.length !== 2) {
      ecus.forEach((e) => out.push({ ecu: e, data: [0x7F, 0x09, 0x13] }));
      return out;
    }
    const info = req[1];
    if (legacy) {
      if (info === 0x00) return [{ ecu: '10', data: [0x49, 0x00, 0x01, 0xC0, 0x00, 0x00, 0x00] }];
      if (info === 0x01) return [{ ecu: '10', data: [0x49, 0x01, 0x05] }];
      if (info === 0x02) {
        // 5 messages: first carries 3 filler zeros plus 1 char, then 4 chars each.
        const v = [0, 0, 0].concat(ascii(FAKE_VIN, 17));
        for (let i = 0; i < 5; i++) out.push({ ecu: '10', data: [0x49, 0x02, i + 1].concat(v.slice(i * 4, i * 4 + 4)) });
        return out;
      }
      return null;
    }
    ecus.forEach((e) => {
      const ecm = e === '7E8';
      if (info === 0x00) out.push({ ecu: e, data: [0x49, 0x00, ecm ? 0x54 : 0x14, 0x40, 0x00, 0x00] });
      else if (info === 0x02 && ecm) out.push({ ecu: e, data: [0x49, 0x02, 0x01].concat(ascii(FAKE_VIN, 17)) });
      else if (info === 0x04) out.push({ ecu: e, data: [0x49, 0x04, 0x01].concat(ascii(ecm ? 'SIM-ECM-CAL-0001' : 'SIM-HVC-CAL-0001', 16)) });
      else if (info === 0x06) out.push({ ecu: e, data: [0x49, 0x06, 0x01].concat(ecm ? [0xA1, 0xB2, 0xC3, 0xD4] : [0x0B, 0xAD, 0xF0, 0x0D]) });
      else if (info === 0x0A) {
        const name = ecm ? ascii('ECM', 4).concat([0x2D]).concat(ascii('EngineControl', 15))
          : ascii('HPCM', 4).concat([0x2D]).concat(ascii('HybridPtControl', 15));
        out.push({ ecu: e, data: [0x49, 0x0A, 0x01].concat(name) });
      }
    });
    return out;
  }

  _clear() {
    const c = this.car;
    this.dtc.stored = [];
    this.dtc.pending = [];
    this.dtc.mil = false;
    this.dtc.freeze = null;
    this.dtc.cleared = true;
    // Permanent codes cannot be erased with mode 04, they clear themselves after good drive cycles.
    c.kmAtClear = c.km;
    c.tAtClear = c.t;
    c.warmups = 0;
    c.distBase = 0;
    c.minBase = 0;
    c.ltft = 0; // learned fuel trims are reset too
  }

  // Readiness bytes for PID 01 (since clear) or PID 41 (this drive cycle).
  _readiness(ecu, thisCycle) {
    const legacy = this.scenario === 'legacy';
    if (ecu === '7EA') return [0x00, 0x00, 0x00, 0x00];
    const avail = legacy ? 0x65 : 0xE5; // cat, evap, O2, O2 heater (+ EGR/VVT on the hybrid)
    let incomplete;
    if (thisCycle) {
      incomplete = avail;
      if (this.car.t > 60) incomplete &= ~0x60; // O2 and O2 heater finish after a minute of driving
      if (this.car.t > 90 && !legacy) incomplete &= ~0x80;
      return [0x00, 0x07, avail, incomplete];
    }
    incomplete = this.dtc.cleared ? avail : (legacy ? 0x01 : 0x05);
    const a = (this.dtc.mil ? 0x80 : 0) | Math.min(this.dtc.stored.length, 0x7F);
    return [a, 0x07, avail, incomplete];
  }

  _pidBytes(ecu, pid) {
    const sc = this.scenario === 'legacy' ? 'legacy' : 'normal';
    const sup = SUPPORTED[sc][ecu];
    if (!sup) return null;
    if (pid % 0x20 === 0) {
      // Bitmap PIDs. 00 is always answered, others only if the previous block says so.
      if (pid !== 0 && sup.indexOf(pid) < 0) return null;
      return bitmap(sup, pid);
    }
    if (sup.indexOf(pid) < 0) return null;
    if (pid === 0x01) return this._readiness(ecu, false);
    if (pid === 0x41) return this._readiness(ecu, true);
    const v = this._value(pid, ecu);
    if (v === null || v === undefined) return null;
    return ENC[pid](v);
  }

  _freezeBytes(pid) {
    const sc = this.scenario === 'legacy' ? 'legacy' : 'normal';
    const sup = FF_SUPPORTED[sc];
    if (!this.dtc.freeze) {
      // No freeze frame stored. ECU reports DTC 0000 and nothing else.
      return pid === 0x02 ? [0x00, 0x00] : null;
    }
    if (pid % 0x20 === 0) {
      if (pid !== 0 && sup.indexOf(pid) < 0) return null;
      return bitmap(sup, pid);
    }
    if (sup.indexOf(pid) < 0) return null;
    if (pid === 0x02) return encodeDtc(this.dtc.freeze);
    const v = FREEZE_P0171[pid];
    return v === undefined ? null : ENC[pid](v);
  }

  // ----- physical model -----

  _tick() {
    const now = Date.now();
    let dt = (now - this._lastTick) / 1000;
    this._lastTick = now;
    if (dt <= 0) return;
    if (dt > 120) dt = 120;
    while (dt > 0) {
      const step = Math.min(0.1, dt);
      this._step(step);
      dt -= step;
    }
  }

  _step(dt) {
    const c = this.car;
    const legacy = this.scenario === 'legacy';
    c.t += dt;
    const target = Math.max(0, interp(DRIVE, c.t % 120) + 1.5 * Math.sin(c.t / 3.7));
    const prev = c.speed;
    c.speed += (target - c.speed) * Math.min(1, dt / 1.5);
    if (c.speed < 0.3 && target === 0) c.speed = 0;
    c.accel = c.accel * 0.8 + 0.2 * ((c.speed - prev) / dt);
    c.km += c.speed / 3600 * dt;
    c.fuel = Math.max(5, 62 - c.km * 0.05);

    // Engine on or off. A hybrid runs the engine to warm up, for hard acceleration,
    // above about 45 km/h, or to charge the battery.
    const wasOn = c.engineOn;
    if (legacy) {
      c.engineOn = true;
    } else {
      const want = c.coolant < 55 || target > 45 || c.accel > 1.2 || c.soc < 48;
      c.engineTimer += dt;
      if (want && !c.engineOn) { c.engineOn = true; c.engineTimer = 0; }
      else if (!want && c.engineOn && c.engineTimer > 8) { c.engineOn = false; c.engineTimer = 0; }
    }
    if (wasOn !== c.engineOn) c.stft = 0;

    // Temperatures
    if (c.engineOn) c.coolant += (91 - c.coolant) * 0.02 * dt;
    else c.coolant -= (c.coolant - 14) * 0.002 * dt;
    if (!c.warmupCounted && c.coolant >= 70 && c.coolant - c.coolantStart >= 22) {
      c.warmupCounted = true;
      c.warmups = Math.min(255, c.warmups + 1);
    }
    if (c.engineOn) c.cat += (650 - c.cat) * 0.012 * dt;
    else c.cat -= (c.cat - 150) * 0.003 * dt;

    // RPM
    let rpmT = 0;
    if (c.engineOn) {
      if (legacy) rpmT = clamp(750 + c.speed * 35 + Math.max(0, c.accel) * 200, 700, 3200);
      else if (c.speed < 1) rpmT = c.coolant < 60 ? 1300 : 1000;
      else rpmT = clamp(1100 + c.speed * 18 + Math.max(0, c.accel) * 250, 1100, 2400);
    }
    c.rpm += (rpmT - c.rpm) * Math.min(1, dt / (rpmT > c.rpm ? 0.6 : 0.3));
    if (c.rpm < 50 && rpmT === 0) c.rpm = 0;

    // Hybrid battery state of charge
    if (!legacy) {
      if (c.engineOn) c.soc += 0.12 * dt;
      else c.soc -= 0.1 * dt * (c.speed / 50);
      if (c.accel < -0.5) c.soc += -c.accel * 0.04 * dt;
      c.soc = clamp(c.soc, 38, 80);
    }

    // Fuel trims: closed loop wanders around a slightly lean value (P0171 story).
    if (c.engineOn) {
      c.stft += (this._rand() - 0.5) * 6 * dt + (3 - c.stft) * 0.1 * dt;
      c.stft = clamp(c.stft, -10, 12);
      const goal = legacy ? 9.4 : 14.8;
      c.ltft += (goal - c.ltft) * 0.003 * dt;
    }
  }

  _value(pid, ecu) {
    const c = this.car;
    const on = c.engineOn;
    const t = c.t;
    const legacy = this.scenario === 'legacy';
    const j = (amt) => (this._rand() - 0.5) * 2 * amt;
    const load = on ? clamp((legacy ? 22 : 18) + Math.max(0, c.accel) * 12 + c.speed * 0.3, 15, 85) : 0;
    const thr = on ? 15 + load * 0.35 : 13.3;
    const pedal = c.speed > 0.5 || c.accel > 0 ? clamp(14.5 + Math.max(0, c.accel) * 10 + c.speed * 0.25, 14.5, 80) : 14.5;
    const lambda = on ? 1 + 0.02 * Math.sin(t * 3) + c.stft * 0.002 : 1.99;
    const minutes = Math.floor(((c.tAtClear === null ? t : t - c.tAtClear)) / 60);
    switch (pid) {
      case 0x03: return on ? (c.coolant < 60 ? 0x01 : 0x02) : 0x04;
      case 0x04: return load + (on ? j(0.8) : 0);
      case 0x05: return c.coolant;
      case 0x06: return on ? c.stft : 0;
      case 0x07: return c.ltft;
      case 0x0B: return on ? 28 + load * 0.75 + j(1) : 100;
      case 0x0C: return c.rpm > 0 ? c.rpm + j(12) : 0;
      case 0x0D: return c.speed;
      case 0x0E: return on ? clamp(8 + (c.rpm - 1000) / 100 - load * 0.08 + j(0.5), -5, 35) : 0;
      case 0x0F: return 18 + (c.coolant - 40) * 0.1 + 0.5 * Math.sin(t / 30);
      case 0x10: return on ? c.rpm / 1000 * load / 100 * 10 + j(0.1) : 0;
      case 0x11: return thr + (on ? j(0.3) : 0);
      case 0x13: return 0x03;
      case 0x14: return { volts: on ? 0.45 + 0.4 * Math.sin(t * 4) : 0.05, trim: on ? c.stft : null };
      case 0x15: return { volts: on ? (c.cat > 300 ? 0.68 + 0.08 * Math.sin(t / 2) : 0.3 + 0.3 * Math.sin(t * 2)) : 0.05, trim: null };
      case 0x1C: return legacy ? 0x01 : 0x06;
      case 0x1F: return Math.floor(210 + t);
      case 0x21: return this.dtc.mil ? Math.floor(c.km) : 0;
      case 0x24: return { lambda: lambda, volts: clamp(3.3 + (lambda - 1) * 1.2, 0, 7.99) };
      case 0x2E: return on && c.coolant > 70 ? 10 + 8 * Math.sin(t / 9) : 0;
      case 0x2F: return c.fuel;
      case 0x30: return c.warmups;
      case 0x31: return c.distBase + Math.floor(c.km - c.kmAtClear);
      case 0x33: return 100;
      case 0x34: return { lambda: lambda, ma: clamp((lambda - 1) * 1.5, -128, 127.99) };
      case 0x3C: return c.cat;
      case 0x42: return this._voltage() + (ecu === '7EA' ? -0.03 : 0);
      case 0x43: return load * 0.95;
      case 0x44: return on && load > 60 ? 0.97 : 1.0;
      case 0x45: return Math.max(0, thr - 13.3);
      case 0x46: return 14;
      case 0x47: return Math.min(100, thr + 15.7);
      case 0x49: return pedal;
      case 0x4A: return pedal * 0.5 + 7;
      case 0x4C: return on ? Math.max(0, thr - 12) : 0;
      case 0x4D: return this.dtc.mil ? 3 + Math.floor(t / 60) : 0;
      case 0x4E: return c.minBase + minutes;
      case 0x51: return 0x01;
      case 0x5B: return c.soc;
      default: return null;
    }
  }

  // ----- output formatting -----

  _join(arr) { return arr.join(this.spaces ? ' ' : ''); }

  _isoTp(data) {
    const pad = (f) => { if (this.canPadding) while (f.length < 8) f.push(0x00); return f; };
    if (data.length <= 7) return [pad([data.length].concat(data))];
    const frames = [pad([0x10 | ((data.length >> 8) & 0x0F), data.length & 0xFF].concat(data.slice(0, 6)))];
    let seq = 1;
    for (let i = 6; i < data.length; i += 7) {
      frames.push(pad([0x20 | (seq & 0x0F)].concat(data.slice(i, i + 7))));
      seq++;
    }
    return frames;
  }

  _formatCan(msgs) {
    const groups = msgs.map((m) => {
      const frames = this._isoTp(m.data);
      if (this.headers) return frames.map((f) => this._join([m.ecu].concat(f.map(hex2))));
      if (!this.caf) return frames.map((f) => this._join(f.map(hex2)));
      if (m.data.length <= 7) return [this._join(m.data.map(hex2))];
      const lines = [('00' + m.data.length.toString(16).toUpperCase()).slice(-3)];
      lines.push('0:' + (this.spaces ? ' ' : '') + this._join(m.data.slice(0, 6).map(hex2)));
      let seq = 1;
      for (let i = 6; i < m.data.length; i += 7) {
        lines.push((seq & 0x0F).toString(16).toUpperCase() + ':' + (this.spaces ? ' ' : '') + this._join(m.data.slice(i, i + 7).map(hex2)));
        seq++;
      }
      return lines;
    });
    // ECUs answer in whatever order they like.
    for (let i = groups.length - 1; i > 0; i--) {
      const k = Math.floor(this._rand() * (i + 1));
      const tmpG = groups[i]; groups[i] = groups[k]; groups[k] = tmpG;
    }
    // With headers on, another ECU's short reply may land between a first frame and its consecutive frames.
    if (this.headers && groups.length > 1 && groups[0].length > 1 && this._rand() < 0.5) {
      const first = groups[0];
      const others = [];
      groups.slice(1).forEach((g) => { others.push.apply(others, g); });
      return [first[0]].concat(others, first.slice(1));
    }
    const out = [];
    groups.forEach((g) => { out.push.apply(out, g); });
    return out;
  }

  _formatLegacy(msgs) {
    return msgs.map((m) => {
      let b = m.data;
      if (this.headers) {
        b = [0x48, 0x6B, parseInt(m.ecu, 16)].concat(m.data);
        let sum = 0;
        b.forEach((x) => { sum = (sum + x) & 0xFF; });
        b = b.concat([sum]);
      }
      return this._join(b.map(hex2));
    });
  }
}

export default SimTransport;
