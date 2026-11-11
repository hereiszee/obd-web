// OBD-II protocol parsing and high-level reads.
// Works with the Elm327 class from ./elm.js (send(cmd) resolves {cmd, raw, lines, status, message}).
// Plain ES2020, no dependencies beyond the sibling modules.

import { decodePid, PIDS, MONITORS } from './pids.js?v=1.2.0';
import { describeDtc } from './dtc-db.js?v=1.2.0';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hex2(n) {
  const s = (n & 0xff).toString(16).toUpperCase();
  return s.length < 2 ? '0' + s : s;
}

function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;
}

const HEX_RE = /^[0-9A-F]+$/;
const CAN_PROTOCOLS = ['6', '7', '8', '9', 'A', 'B', 'C'];
const LEGACY_PROTOCOLS = ['1', '2', '3', '4', '5'];

// ATDPN may return 'A6' (automatic, protocol 6). Strip the 'A' prefix only when two chars long.
export function normalizeProtocol(p) {
  if (p === null || p === undefined) return null;
  let s = String(p).trim().toUpperCase();
  if (s.length === 2 && s.charAt(0) === 'A') s = s.charAt(1);
  if (s.length !== 1) return null;
  if (s === '0') return null;
  return s;
}

export function isCanProtocol(p) {
  const n = normalizeProtocol(p);
  return n !== null && CAN_PROTOCOLS.indexOf(n) !== -1;
}

function isLegacyProtocol(p) {
  const n = normalizeProtocol(p);
  return n !== null && LEGACY_PROTOCOLS.indexOf(n) !== -1;
}

function isLegacyFormatByte(b) {
  // ISO 9141 / J1850 VPW: 48 or 68. J1850 PWM: 41 or 61. KWP2000: 8x or Cx (length in low bits).
  return b === 0x48 || b === 0x68 || b === 0x41 || b === 0x61 || (b & 0xc0) === 0x80 || (b & 0xc0) === 0xc0;
}

// J1850 CRC-8 (polynomial 0x1D, init 0xFF, inverted result).
function j1850Crc(bytes) {
  let crc = 0xff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x1d) & 0xff : (crc << 1) & 0xff;
  }
  return (~crc) & 0xff;
}

function legacyCheckOk(bytes) {
  const body = bytes.slice(0, bytes.length - 1);
  const last = bytes[bytes.length - 1];
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum = (sum + body[i]) & 0xff;
  return sum === last || j1850Crc(body) === last;
}

// strict: protocol unknown. A headers-off reply such as 41 6B 5A 5A 00 (mode 01 PID 6B) has the
// same shape as a J1850 PWM header (41 6B 10), so then the check byte must also be valid.
function looksLegacyHeader(bytes, strict) {
  if (bytes.length < 5) return false;
  if (bytes[1] !== 0x6b && bytes[1] !== 0xf1) return false;
  if (!isLegacyFormatByte(bytes[0])) return false;
  if (bytes[3] < 0x40 || bytes[3] > 0x7f) return false; // must be a response service ID (or 7F)
  if (strict && !legacyCheckOk(bytes)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// parseLines
// ---------------------------------------------------------------------------

/**
 * Parse ELM327 response lines into complete messages per ECU.
 * @param {string[]|string} lines cleaned lines from Elm327.send (or a raw string)
 * @param {string|number} [protocolNumber] from ATDPN, e.g. 'A6'
 * @returns {{ecu:string, bytes:number[], proto:string, incomplete?:boolean}[]}
 */
export function parseLines(lines, protocolNumber) {
  if (typeof lines === 'string') lines = lines.split(/[\r\n]+/);
  if (!Array.isArray(lines)) return [];
  const proto = normalizeProtocol(protocolNumber);
  const knownCan = proto !== null && CAN_PROTOCOLS.indexOf(proto) !== -1;
  const knownLegacy = proto !== null && LEGACY_PROTOCOLS.indexOf(proto) !== -1;

  // Clean: strip spaces, uppercase, drop prompt chars and obvious status text.
  const clean = [];
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (l === null || l === undefined) continue;
    l = String(l).replace(/[\s>]/g, '').toUpperCase();
    if (!l) continue;
    clean.push(l);
  }

  const hasMultiline = clean.some((l) => /^[0-9A-F]:[0-9A-F]*$/.test(l));
  const out = [];
  const canState = {}; // ecu -> {len, data}
  let ml = null; // headers-off multiline state {len, data}

  function flushMultiline() {
    if (ml && ml.data.length) {
      const bytes = ml.len ? ml.data.slice(0, ml.len) : ml.data;
      const msg = { ecu: 'ECU', bytes, proto: knownLegacy ? 'legacy' : 'can' };
      if (ml.len && ml.data.length < ml.len) msg.incomplete = true;
      out.push(msg);
    }
    ml = null;
  }

  function canFrame(ecu, frame, protoTag) {
    if (!frame.length) return;
    const pci = frame[0];
    const type = pci >> 4;
    if (type === 0) {
      let len = pci & 0x0f;
      let start = 1;
      if (len === 0 && frame.length > 1) { len = frame[1]; start = 2; } // CAN FD escape
      const data = frame.slice(start, start + len);
      out.push({ ecu, bytes: data, proto: protoTag });
      delete canState[ecu];
    } else if (type === 1) {
      if (frame.length < 2) return;
      if (canState[ecu]) finishCan(ecu, protoTag, true);
      const len = ((pci & 0x0f) << 8) | frame[1];
      canState[ecu] = { len, data: frame.slice(2), proto: protoTag, seq: 1 };
      if (canState[ecu].data.length >= len) finishCan(ecu, protoTag, false);
    } else if (type === 2) {
      const st = canState[ecu];
      if (!st) return; // consecutive frame without a first frame, ignore
      if ((pci & 0x0f) !== st.seq) {
        // A consecutive frame was lost. The rest cannot be lined up, so close the message as incomplete.
        finishCan(ecu, protoTag, true);
        return;
      }
      st.seq = (st.seq + 1) & 0x0f;
      for (let i = 1; i < frame.length; i++) st.data.push(frame[i]);
      if (st.data.length >= st.len) finishCan(ecu, protoTag, false);
    }
    // type 3 = flow control, ignore
  }

  function finishCan(ecu, protoTag, incomplete) {
    const st = canState[ecu];
    if (!st) return;
    const msg = { ecu, bytes: st.data.slice(0, st.len), proto: st.proto || protoTag };
    if (incomplete || st.data.length < st.len) msg.incomplete = true;
    out.push(msg);
    delete canState[ecu];
  }

  for (let i = 0; i < clean.length; i++) {
    const l = clean[i];

    // Headers-off multiline format: '014' then '0:490201...', '1:...'
    if (hasMultiline) {
      const m = /^([0-9A-F]):([0-9A-F]*)$/.exec(l);
      if (m) {
        if (!ml) ml = { len: 0, data: [] };
        const b = hexToBytes(m[2]);
        for (let j = 0; j < b.length; j++) ml.data.push(b[j]);
        if (ml.len && ml.data.length >= ml.len) flushMultiline();
        continue;
      }
      if (/^[0-9A-F]{3}$/.test(l)) {
        flushMultiline();
        ml = { len: parseInt(l, 16), data: [] };
        continue;
      }
    }

    if (!HEX_RE.test(l)) continue; // OK, NO DATA, SEARCHING..., errors, etc.

    const odd = l.length % 2 === 1;
    // 29-bit headers look like 18DAF110. Mode replies start with 4x or 7F, so a leading '1' is a header.
    const is29 = !odd && l.length >= 10 && (/^18D[AB]/.test(l) || ((proto === '7' || proto === '9') && l.charAt(0) === '1'));

    if (odd && !knownLegacy && l.length >= 5) {
      // 11-bit CAN with header
      canFrame(l.substr(0, 3), hexToBytes(l.substr(3)), 'can');
      continue;
    }
    if (is29 && !knownLegacy) {
      canFrame(l.substr(0, 8), hexToBytes(l.substr(8)), 'can');
      continue;
    }
    if (odd) continue; // nothing sensible left

    const bytes = hexToBytes(l);
    if (!knownCan && looksLegacyHeader(bytes, !knownLegacy)) {
      // priority/format, target, source, data..., checksum
      out.push({ ecu: hex2(bytes[2]), bytes: bytes.slice(3, bytes.length - 1), proto: 'legacy' });
      continue;
    }

    // Headers off, single line of data
    out.push({ ecu: 'ECU', bytes, proto: knownLegacy ? 'legacy' : (knownCan ? 'can' : 'raw') });
  }

  flushMultiline();
  Object.keys(canState).forEach((ecu) => finishCan(ecu, 'can', true));
  return out;
}

// ---------------------------------------------------------------------------
// ECU names
// ---------------------------------------------------------------------------

export const ECU_NAMES = {
  '7E8': 'Engine (ECM)',
  '7E9': 'Transmission / Hybrid (TCM)',
  '7EA': 'Module at 7EA (on Toyota hybrids usually the hybrid control computer)',
  '7EB': 'Module at 7EB (often hybrid battery or other module)',
  '7EC': 'Module at 7EC',
  '7ED': 'Module at 7ED',
  '7EE': 'Module at 7EE',
  '7EF': 'Module at 7EF',
  ECU: 'Car computer'
};

// Source addresses used by 29-bit CAN and by older (legacy) protocols.
const SOURCE_NAMES = {
  '10': 'Engine (ECM)',
  '11': 'Engine (second module)',
  '18': 'Transmission (TCM)',
  '19': 'Transmission (second module)',
  '1A': 'Module at address 1A (often hybrid control)',
  '28': 'Brakes (ABS)'
};

export function ecuLabel(id) {
  if (id === null || id === undefined) return 'Unknown module';
  const s = String(id).toUpperCase();
  if (ECU_NAMES[s]) return ECU_NAMES[s];
  if (s.length === 8 && /^18DA/.test(s)) {
    const src = s.substr(6, 2);
    return SOURCE_NAMES[src] || ('Module at ' + s);
  }
  if (s.length === 2 && SOURCE_NAMES[s]) return SOURCE_NAMES[s];
  return 'Module at ' + s;
}

function ecuRank(ecu) {
  // Prefer the engine computer when picking a single answer.
  if (ecu === '7E8' || ecu === '18DAF110' || ecu === '10') return 0;
  if (ecu === 'ECU') return 1;
  return 2;
}

function sortByEcu(list) {
  return list.slice().sort((a, b) => {
    const r = ecuRank(a.ecu) - ecuRank(b.ecu);
    if (r) return r;
    return a.ecu < b.ecu ? -1 : a.ecu > b.ecu ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// DTC decoding
// ---------------------------------------------------------------------------

export function decodeDtc(byteA, byteB) {
  const letter = 'PCBU'.charAt((byteA >> 6) & 3);
  const d1 = (byteA >> 4) & 3;
  return (letter + d1 + (byteA & 0x0f).toString(16) + hex2(byteB)).toUpperCase();
}

/**
 * Extract DTCs from mode 03/07/0A response messages.
 * CAN: [0x4X, count, A, B, ...]. Legacy: [0x4X, A, B, A, B, A, B] per message, 0000 = padding.
 * @returns {{ecu, label, codes:string[]}[]}
 */
export function parseDtcResponses(responses, isCan) {
  const byEcu = {};
  const order = [];
  const partial = {};
  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    const b = r.bytes;
    if (!b || !b.length) continue;
    let can = isCan;
    if (r.proto === 'can') can = true;
    else if (r.proto === 'legacy') can = false;
    else if (can === undefined || can === null) {
      // Heuristic: count byte matches number of pairs that follow
      can = b.length >= 2 && (b.length - 2) % 2 === 0 && b[1] === (b.length - 2) / 2;
    }
    if (!byEcu[r.ecu]) { byEcu[r.ecu] = []; order.push(r.ecu); }
    const codes = byEcu[r.ecu];
    let start = 1;
    let max = Infinity;
    if (can) { start = 2; max = b[1]; }
    if (r.incomplete || (can && b[1] > Math.floor((b.length - 2) / 2))) partial[r.ecu] = true;
    let n = 0;
    for (let j = start; j + 1 < b.length && n < max; j += 2) {
      if (b[j] === 0 && b[j + 1] === 0) continue;
      const code = decodeDtc(b[j], b[j + 1]);
      n++;
      if (codes.indexOf(code) === -1) codes.push(code);
    }
  }
  return sortByEcu(order.map((ecu) => {
    const e = { ecu, label: ecuLabel(ecu), codes: byEcu[ecu] };
    if (partial[ecu]) e.partial = true;
    return e;
  }));
}

// ---------------------------------------------------------------------------
// VIN
// ---------------------------------------------------------------------------

/** @returns {{vin:string|null, ecu:string|null}} from mode 09 PID 02 messages */
export function parseVin(responses) {
  const groups = {};
  const order = [];
  responses.forEach((r) => {
    if (!r.bytes || r.bytes[0] !== 0x49 || r.bytes[1] !== 0x02) return;
    if (!groups[r.ecu]) { groups[r.ecu] = []; order.push(r.ecu); }
    groups[r.ecu].push(r.bytes);
  });
  const ecus = sortByEcu(order.map((ecu) => ({ ecu })));
  let best = null;
  for (let i = 0; i < ecus.length; i++) {
    const msgs = groups[ecus[i].ecu];
    let data = [];
    if (msgs.length === 1) {
      data = msgs[0].slice(2);
    } else {
      // Legacy: several messages, each 49 02 seq b1 b2 b3 b4
      msgs.slice().sort((a, b) => a[2] - b[2]).forEach((m) => { data = data.concat(m.slice(3)); });
    }
    let s = '';
    data.forEach((c) => { if (c >= 0x30 && c <= 0x5a) s += String.fromCharCode(c); });
    s = s.replace(/[^A-Z0-9]/g, '');
    if (s.length > 17) s = s.substr(s.length - 17);
    if (!s) continue;
    if (s.length === 17) return { vin: s, ecu: ecus[i].ecu };
    if (!best) best = { vin: s, ecu: ecus[i].ecu };
  }
  return best || { vin: null, ecu: null };
}

// ---------------------------------------------------------------------------
// Supported PID bitmaps
// ---------------------------------------------------------------------------

/** 4 bitmap bytes for block starting at base → array of supported PID numbers */
export function parseSupportedBitmap(base, dataBytes) {
  const out = [];
  for (let i = 0; i < 32; i++) {
    const byte = dataBytes[i >> 3];
    if (byte === undefined) break;
    if (byte & (0x80 >> (i & 7))) out.push(base + i + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Readiness monitors (SAE J1979 PID 01 / PID 41)
// ---------------------------------------------------------------------------

// Byte B: bits 0-2 available (misfire, fuel, components), bits 4-6 incomplete, bit 3 ignition type.
const CONTINUOUS = [
  { key: 'misfire', bit: 0, name: 'Misfire monitor', explain: 'Watches for engine misfires all the time while driving.' },
  { key: 'fuelSystem', bit: 1, name: 'Fuel system', explain: 'Checks that the engine gets the right fuel mixture.' },
  { key: 'components', bit: 2, name: 'Comprehensive components', explain: 'Checks sensors and actuators for electrical faults.' }
];
// Byte C available, byte D incomplete.
const SPARK = [
  { key: 'catalyst', bit: 0, name: 'Catalytic converter', explain: 'Checks the catalytic converter is still cleaning the exhaust properly.' },
  { key: 'heatedCatalyst', bit: 1, name: 'Heated catalyst', explain: 'Checks the electrically heated catalyst (few cars have one).' },
  { key: 'evap', bit: 2, name: 'Evaporative system (fuel vapour)', explain: 'Checks the fuel tank and vapour system for leaks. Often the last monitor to finish.' },
  { key: 'secondaryAir', bit: 3, name: 'Secondary air system', explain: 'Checks the air pump that helps warm up the catalyst on cold starts.' },
  { key: 'acRefrigerant', bit: 4, name: 'A/C refrigerant', explain: 'Checks the air conditioning refrigerant system (rarely used).' },
  { key: 'o2Sensor', bit: 5, name: 'Oxygen sensors', explain: 'Checks the oxygen sensors that measure the exhaust.' },
  { key: 'o2Heater', bit: 6, name: 'Oxygen sensor heaters', explain: 'Checks the heaters that bring the oxygen sensors up to temperature.' },
  { key: 'egr', bit: 7, name: 'EGR and/or VVT system', explain: 'Checks exhaust gas recirculation and/or variable valve timing.' }
];
const COMPRESSION = [
  { key: 'nmhcCatalyst', bit: 0, name: 'NMHC catalyst', explain: 'Checks the diesel oxidation catalyst that burns off unburnt fuel.' },
  { key: 'noxScr', bit: 1, name: 'NOx aftertreatment (SCR / NOx trap)', explain: 'Checks the system that removes nitrogen oxides (often uses AdBlue).' },
  { key: 'boostPressure', bit: 3, name: 'Boost pressure', explain: 'Checks the turbo boost pressure control.' },
  { key: 'exhaustSensor', bit: 5, name: 'Exhaust gas sensor', explain: 'Checks the exhaust gas sensors.' },
  { key: 'pmFilter', bit: 6, name: 'Particulate filter (DPF)', explain: 'Checks the diesel particulate filter that traps soot.' },
  { key: 'egrVvt', bit: 7, name: 'EGR and/or VVT system', explain: 'Checks exhaust gas recirculation and/or variable valve timing.' }
];

// MONITORS comes from pids.js. Its exact shape is not fixed by the spec, so look up loosely.
function monitorMeta(def, ignition) {
  let m = null;
  try {
    if (MONITORS) {
      const pools = [MONITORS[ignition], MONITORS, MONITORS.common, MONITORS.continuous];
      for (let i = 0; i < pools.length && !m; i++) {
        const p = pools[i];
        if (!p || typeof p !== 'object') continue;
        if (Array.isArray(p)) {
          m = p.find((x) => x && (x.key === def.key || x.id === def.key)) || null;
        } else if (p[def.key] && typeof p[def.key] === 'object') {
          m = p[def.key];
        }
      }
    }
  } catch (e) { m = null; }
  return {
    name: (m && typeof m.name === 'string' && m.name) || def.name,
    explain: (m && typeof m.explain === 'string' && m.explain) || def.explain
  };
}

/**
 * Decode 4 data bytes A B C D of PID 01 (or PID 41 when thisDrive is true).
 * For PID 41 "available" means enabled for this drive cycle.
 */
export function parseReadiness(data, thisDrive) {
  const A = data[0] || 0, B = data[1] || 0, C = data[2] || 0, D = data[3] || 0;
  const ignition = (B & 0x08) ? 'compression' : 'spark';
  const monitors = [];
  CONTINUOUS.forEach((def) => {
    const meta = monitorMeta(def, ignition);
    const available = !!(B & (1 << def.bit));
    const incomplete = !!(B & (1 << (def.bit + 4)));
    monitors.push({ key: def.key, name: meta.name, explain: meta.explain, continuous: true, available, complete: available ? !incomplete : null });
  });
  (ignition === 'compression' ? COMPRESSION : SPARK).forEach((def) => {
    const meta = monitorMeta(def, ignition);
    const available = !!(C & (1 << def.bit));
    const incomplete = !!(D & (1 << def.bit));
    monitors.push({ key: def.key, name: meta.name, explain: meta.explain, continuous: false, available, complete: available ? !incomplete : null });
  });
  const res = { ignition, monitors };
  if (!thisDrive) {
    res.milOn = !!(A & 0x80);
    res.dtcCount = A & 0x7f;
  }
  return res;
}

// Combine several ECUs answering 0101: MIL on if any, counts summed,
// a monitor is available if any ECU supports it, complete only if all supporting ECUs say complete.
function combineReadiness(list) {
  const base = list[0];
  const out = { milOn: false, dtcCount: 0, ignition: base.ignition, monitors: base.monitors.map((m) => Object.assign({}, m)) };
  list.forEach((r) => {
    if (r.milOn) out.milOn = true;
    out.dtcCount += r.dtcCount || 0;
  });
  out.monitors.forEach((m) => {
    let available = false;
    let complete = true;
    list.forEach((r) => {
      if (r.ignition !== base.ignition) return;
      const o = r.monitors.find((x) => x.key === m.key);
      if (o && o.available) { available = true; if (!o.complete) complete = false; }
    });
    m.available = available;
    m.complete = available ? complete : null;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Multi-PID splitting
// ---------------------------------------------------------------------------

function pidByteLength(pid) {
  const d = PIDS && PIDS[pid];
  if (d && typeof d.bytes === 'number' && d.bytes > 0) return d.bytes;
  return null;
}

/** Split a mode 01 multi-PID reply [0x41, pid, data..., pid, data...] into {pid: bytes}. null if not splittable. */
export function splitMultiPid(bytes, requested) {
  if (!bytes || bytes[0] !== 0x41) return null;
  const out = {};
  let i = 1;
  while (i < bytes.length) {
    const pid = bytes[i];
    if (requested && requested.indexOf(pid) === -1) {
      // Probably padding after the last value
      if (Object.keys(out).length) break;
      return null;
    }
    const len = pidByteLength(pid);
    if (!len) return null;
    if (i + 1 + len > bytes.length) return null;
    out[pid] = bytes.slice(i + 1, i + 1 + len);
    i += 1 + len;
  }
  return out;
}

function safeDecode(pid, data) {
  try {
    const r = decodePid(pid, data);
    if (r && typeof r === 'object') return r;
  } catch (e) { /* fall through */ }
  return { value: null, unit: '', text: data.map(hex2).join(' ') };
}

function pidName(pid) {
  const d = PIDS && PIDS[pid];
  return (d && d.name) || ('PID ' + hex2(pid));
}

function safeDescribe(code) {
  try { return describeDtc(code); } catch (e) { return { code, description: '', explain: '', severity: null }; }
}

const NOT_SUPPORTED = 'Not supported by this car';
const PARTIAL_CODES = 'Part of the answer from the car was lost, so some codes may be missing. Read the codes again.';

// ---------------------------------------------------------------------------
// Obd class
// ---------------------------------------------------------------------------

export class Obd {
  constructor(elm) {
    this.elm = elm;
    this.protocolNumber = null; // set by app from init(), or detected via ATDPN
    this.supported = null;      // cache from supportedPids()
    this._multiPidOk = null;    // null unknown, true works, false do not use
    this._multiPidFails = 0;
    this._header = null;        // last ATSH we sent (null = adapter default, broadcast 7DF)
  }

  // True on 11-bit CAN, where each module can be addressed directly (7E0 to 7E7).
  async _canTarget() {
    const p = normalizeProtocol(await this._protocol());
    return p === '6' || p === '8';
  }

  // Sets the CAN request header. Returns false if the adapter refused it.
  async _setHeader(h) {
    if (this._header === h) return true;
    const r = await this.elm.send('ATSH ' + h);
    if (r && r.status === 'ok') { this._header = h; return true; }
    // We no longer know which header the adapter has (the reply may just have been lost).
    // 'unknown' makes the next broadcast query send ATSH 7DF again.
    this._header = 'unknown';
    return false;
  }

  // Points the adapter back at all modules (7DF) if live data left it on one module.
  async resetHeader() {
    if (this._header === null || this._header === '7DF') return true;
    return this._setHeader('7DF');
  }

  async _protocol() {
    if (this.protocolNumber && normalizeProtocol(this.protocolNumber)) return this.protocolNumber;
    try {
      const r = await this.elm.send('ATDPN');
      if (r && r.status === 'ok' && r.lines && r.lines.length) {
        const p = r.lines[r.lines.length - 1].trim();
        if (normalizeProtocol(p)) this.protocolNumber = p;
      }
    } catch (e) { /* ignore */ }
    return this.protocolNumber;
  }

  async isCan() {
    const p = await this._protocol();
    if (p === null) return null;
    return isCanProtocol(p);
  }

  async query(cmdHex, opts) {
    const cmd = String(cmdHex).replace(/\s+/g, '').toUpperCase();
    const proto = await this._protocol();
    // Live data may have pointed the adapter at one module. Everything else asks all modules.
    const wantHeader = opts && opts.header ? opts.header : null;
    if (wantHeader) {
      if (!(await this._setHeader(wantHeader))) {
        return { status: 'error', message: 'The adapter refused to address one module.', responses: [], negative: [] };
      }
    } else if (this._header !== null && this._header !== '7DF') {
      // Never send a broadcast request (especially 04 clear codes) while the adapter may still
      // be pointed at one module. Try twice, then refuse.
      if (!(await this._setHeader('7DF')) && !(await this._setHeader('7DF'))) {
        return { status: 'error', message: 'The adapter did not switch back to asking all modules. Disconnect, connect again, then retry.', responses: [], negative: [] };
      }
    }
    let r;
    try {
      r = await this.elm.send(cmd, opts && opts.timeout ? { timeout: opts.timeout } : undefined);
    } catch (e) {
      return { status: 'error', message: 'The adapter did not respond properly. ' + (e && e.message ? e.message : ''), responses: [], negative: [] };
    }
    if (!r || r.status !== 'ok') {
      return { status: (r && r.status) || 'error', message: (r && r.message) || 'No answer from the adapter.', responses: [], negative: [], raw: r && r.raw };
    }
    const mode = parseInt(cmd.substr(0, 2), 16);
    const parsed = parseLines(r.lines || [], proto);
    const responses = [];
    const negative = [];
    parsed.forEach((m) => {
      if (!m.bytes.length) return;
      if (m.bytes[0] === mode + 0x40) responses.push(m);
      else if (m.bytes[0] === 0x7f && m.bytes[1] === mode) negative.push({ ecu: m.ecu, nrc: m.bytes[2] });
    });
    if (responses.length) {
      const res = { status: 'ok', message: '', responses, negative, raw: r.raw };
      if (responses.some((m) => m.incomplete)) res.incomplete = true;
      return res;
    }
    if (negative.length) {
      return { status: 'unsupported', message: NOT_SUPPORTED + '.', responses, negative, raw: r.raw };
    }
    return { status: 'nodata', message: 'The car sent a reply that this app could not read.', responses, negative, raw: r.raw };
  }

  async supportedPids() {
    const byEcu = {};
    const all = new Set();
    let base = 0;
    let status = 'ok';
    let message = '';
    while (base <= 0xe0) {
      let q = await this.query('01' + hex2(base));
      // One retry on a timeout, so a brief stall does not leave half the readings missing.
      if (q.status === 'timeout') q = await this.query('01' + hex2(base));
      if (q.status !== 'ok') {
        if (base === 0) { status = q.status; message = q.message; }
        break;
      }
      let more = false;
      q.responses.forEach((m) => {
        if (m.bytes[1] !== base) return;
        const pids = parseSupportedBitmap(base, m.bytes.slice(2, 6));
        if (!byEcu[m.ecu]) byEcu[m.ecu] = new Set();
        pids.forEach((p) => { byEcu[m.ecu].add(p); all.add(p); });
        if (pids.indexOf(base + 0x20) !== -1) more = true;
      });
      if (!more) break;
      base += 0x20;
    }
    const res = { byEcu, all, status, message };
    if (status === 'ok') this.supported = res;
    return res;
  }

  _isSupported(pid) {
    if (!this.supported || !this.supported.all || !this.supported.all.size) return null;
    return this.supported.all.has(pid);
  }

  async readDtcs(mode) {
    const m = String(mode || '03').toUpperCase();
    const q = await this.query(m);
    const can = await this.isCan();
    if (q.status === 'ok') {
      const byEcu = parseDtcResponses(q.responses, can === null ? undefined : can);
      byEcu.forEach((e) => { e.details = e.codes.map(safeDescribe); });
      const total = byEcu.reduce((n, e) => n + e.codes.length, 0);
      if (q.incomplete || byEcu.some((e) => e.partial)) {
        return { status: 'ok', supported: true, partial: true, message: PARTIAL_CODES, byEcu };
      }
      return { status: 'ok', supported: true, message: total ? '' : 'No codes reported.', byEcu };
    }
    if (q.status === 'unsupported' || (m === '0A' && q.status === 'nodata')) {
      return { status: q.status, supported: false, message: NOT_SUPPORTED, byEcu: [] };
    }
    if (q.status === 'nodata') {
      return {
        status: 'ok', supported: true, byEcu: [],
        message: 'The car did not answer this request. This usually means there are no codes of this type.'
      };
    }
    return { status: q.status, supported: false, message: q.message, byEcu: [] };
  }

  async clearDtcs() {
    const q = await this.query('04', { timeout: 8000 });
    if (q.status === 'ok') {
      return { ok: true, message: 'Codes cleared. If the fault is still there, the check engine light will come back.' };
    }
    if (q.status === 'unsupported') {
      const nrc = q.negative.length ? q.negative[0].nrc : null;
      if (nrc === 0x22) {
        return { ok: false, message: 'The car refused to clear codes right now. Most cars only allow this with the ignition on and the engine off.' };
      }
      return { ok: false, message: 'The car refused the request to clear codes.' };
    }
    if (q.status === 'nodata') {
      return { ok: false, message: 'The car did not confirm the clear. Read the codes again to check whether they are gone.' };
    }
    return { ok: false, message: q.message || 'Clearing codes failed.' };
  }

  async readVin() {
    const q = await this.query('0902', { timeout: 6000 });
    if (q.status !== 'ok') {
      const ns = q.status === 'nodata' || q.status === 'unsupported';
      return { vin: null, ecu: null, status: q.status, message: ns ? NOT_SUPPORTED + '. Older cars often do not report the VIN.' : q.message };
    }
    const v = parseVin(q.responses);
    if (!v.vin) return { vin: null, ecu: null, status: 'nodata', message: 'The car answered but did not include a readable VIN.' };
    const msg = v.vin.length === 17 ? '' : 'The VIN looks incomplete. Compare it with the plate on the car.';
    return { vin: v.vin, ecu: v.ecu, status: 'ok', message: msg };
  }

  async readiness() {
    const q = await this.query('0101');
    if (q.status !== 'ok') {
      return { status: q.status, message: q.message, milOn: null, dtcCount: null, ignition: null, monitors: [], thisDrive: null };
    }
    const list = sortByEcu(q.responses.filter((m) => m.bytes[1] === 0x01 && m.bytes.length >= 6))
      .map((m) => Object.assign({ ecu: m.ecu }, parseReadiness(m.bytes.slice(2, 6), false)));
    if (!list.length) {
      return { status: 'nodata', message: 'The car sent a reply that this app could not read.', milOn: null, dtcCount: null, ignition: null, monitors: [], thisDrive: null };
    }
    const res = list.length === 1 ? list[0] : combineReadiness(list);
    const out = { status: 'ok', message: '', milOn: res.milOn, dtcCount: res.dtcCount, ignition: res.ignition, monitors: res.monitors, thisDrive: null, byEcu: list };

    if (this._isSupported(0x41) !== false) {
      const q2 = await this.query('0141');
      if (q2.status === 'ok') {
        const m = sortByEcu(q2.responses.filter((x) => x.bytes[1] === 0x41 && x.bytes.length >= 6))[0];
        if (m) {
          const d = m.bytes.slice(2, 6);
          d[1] = (d[1] & 0xf7) | (res.ignition === 'compression' ? 0x08 : 0); // use ignition type from PID 01
          out.thisDrive = parseReadiness(d, true).monitors.map((x) => Object.assign(x, { enabled: x.available }));
        }
      }
    }
    return out;
  }

  async readPid(pid, opts) {
    const p = typeof pid === 'string' ? parseInt(pid, 16) : pid;
    const q = await this.query('01' + hex2(p), opts);
    if (q.status !== 'ok') {
      const ns = q.status === 'nodata' || q.status === 'unsupported';
      return { pid: p, ecu: null, value: null, unit: '', text: ns ? NOT_SUPPORTED : '', status: q.status, message: ns ? NOT_SUPPORTED : q.message };
    }
    const m = sortByEcu(q.responses.filter((x) => x.bytes[1] === p))[0];
    if (!m) return { pid: p, ecu: null, value: null, unit: '', text: '', status: 'nodata', message: 'The car sent a reply that this app could not read.' };
    const d = safeDecode(p, m.bytes.slice(2));
    return { pid: p, ecu: m.ecu, value: d.value, unit: d.unit || '', text: d.text, status: 'ok', message: '' };
  }

  // Picks the module to ask for each PID: the engine (7E8) when it has it, otherwise the
  // first module that said it supports it. Returns [{ecu, header, pids}] or null when the
  // car or adapter cannot be addressed per module.
  async _liveGroups(pids) {
    if (!(await this._canTarget())) return null;
    const by = this.supported && this.supported.byEcu;
    if (!by) return null;
    const ecus = Object.keys(by).filter((e) => /^7E[89A-F]$/.test(e)).sort((a, b) => (a === '7E8' ? -1 : b === '7E8' ? 1 : a < b ? -1 : a > b ? 1 : 0));
    if (!ecus.length) return null;
    const groups = {};
    const order = [];
    pids.forEach((p) => {
      const ecu = ecus.find((e) => by[e] && by[e].has && by[e].has(p)) || ecus[0];
      if (!groups[ecu]) { groups[ecu] = []; order.push(ecu); }
      groups[ecu].push(p);
    });
    return order.map((ecu) => ({ ecu, header: (parseInt(ecu, 16) - 8).toString(16).toUpperCase(), pids: groups[ecu] }));
  }

  // Live data. On 11-bit CAN each request goes to one module, so only that module answers.
  // On a car with several modules this cuts the reply traffic a lot, which matters on BLE.
  async readPids(pidList) {
    const pids = (pidList || []).map((p) => (typeof p === 'string' ? parseInt(p, 16) : p));
    let groups = null;
    // Off unless switched on: a real Toyota C-HR answered NO DATA to every request addressed
    // to one module (ATSH 7E0), so asking all modules is the safe default.
    if (this.targetLive === true && this._targetFails !== true) {
      try { groups = await this._liveGroups(pids); } catch (e) { groups = null; }
    }
    if (!groups) return this._readPidsOn(pids, null);
    const results = {};
    for (let g = 0; g < groups.length; g++) {
      const part = await this._readPidsOn(groups[g].pids, groups[g].header);
      part.forEach((r) => { results[r.pid] = r; });
    }
    // If addressing modules gave nothing at all, fall back to asking everyone for good.
    const any = pids.some((p) => results[p] && results[p].status === 'ok');
    // Only a clear "this module does not have it" counts against targeting. Timeouts and
    // dropped links say nothing about addressing.
    const allNo = pids.every((p) => results[p] && (results[p].status === 'nodata' || results[p].status === 'unsupported'));
    if (!any && allNo) {
      this._targetMisses = (this._targetMisses || 0) + 1;
      if (this._targetMisses >= 3) this._targetFails = true;
      return this._readPidsOn(pids, null);
    }
    this._targetMisses = 0;
    return pids.map((p) => results[p]);
  }

  // Optional pause before each live request (liveGapMs). The app raises it after a
  // Bluetooth drop so a struggling link gets less traffic.
  _livePause() {
    const ms = this.liveGapMs;
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  async _readPidsOn(pidList, header) {
    const pids = pidList;
    if (header && !(await this._setHeader(header))) {
      // This adapter does not accept ATSH. Stop addressing modules and ask everyone.
      this._targetFails = true;
      return this._readPidsOn(pids, null);
    }
    const qopts = header ? { header } : undefined;
    const results = {};
    const can = await this.isCan();
    // gentleLive: one reading per request. Replies stay short (no multi-frame bursts), which
    // held a BLE link better on a real car with four modules answering.
    const useMulti = can === true && this._multiPidOk !== false && !this.gentleLive;

    if (useMulti) {
      for (let i = 0; i < pids.length; i += 6) {
        const chunk = pids.slice(i, i + 6);
        if (chunk.length === 1 || chunk.some((p) => !pidByteLength(p))) {
          for (let j = 0; j < chunk.length; j++) { await this._livePause(); results[chunk[j]] = await this.readPid(chunk[j], qopts); }
          continue;
        }
        const q = await this.query('01' + chunk.map(hex2).join(''), qopts);
        let got = 0;
        if (q.status === 'ok') {
          sortByEcu(q.responses).forEach((m) => {
            const split = splitMultiPid(m.bytes, chunk);
            if (!split) return;
            Object.keys(split).forEach((k) => {
              const p = parseInt(k, 10);
              if (results[p]) return; // first (preferred) ECU wins
              const d = safeDecode(p, split[k]);
              results[p] = { pid: p, ecu: m.ecu, value: d.value, unit: d.unit || '', text: d.text, status: 'ok', message: '' };
              got++;
            });
          });
        }
        if (got) {
          this._multiPidOk = true;
          this._multiPidFails = 0;
          chunk.forEach((p) => {
            if (!results[p]) results[p] = { pid: p, ecu: null, value: null, unit: '', text: NOT_SUPPORTED, status: 'nodata', message: NOT_SUPPORTED };
          });
        } else {
          if (q.status === 'ok' || q.status === 'unknown' || q.status === 'nodata') {
            this._multiPidFails++;
            if (this._multiPidOk !== true || this._multiPidFails >= 3) this._multiPidOk = false;
          }
          for (let j = 0; j < chunk.length; j++) { await this._livePause(); results[chunk[j]] = await this.readPid(chunk[j], qopts); }
        }
      }
    } else {
      for (let j = 0; j < pids.length; j++) { await this._livePause(); results[pids[j]] = await this.readPid(pids[j], qopts); }
    }
    return pids.map((p) => results[p]);
  }

  async freezeFrame() {
    // Mode 02 PID 02 (the code that stored the freeze frame), frame 0: 02 02 00.
    const q = await this.query('020200');
    let dtc = null;
    if (q.status === 'ok') {
      const m = sortByEcu(q.responses.filter((x) => x.bytes[1] === 0x02 && x.bytes.length >= 5))[0];
      if (m && (m.bytes[3] || m.bytes[4])) dtc = decodeDtc(m.bytes[3], m.bytes[4]);
      // Every module answered "no code stored a freeze frame" (00 00). Stop here instead of
      // asking for readings that cannot exist. Slow NO DATA replies also strain BLE links.
      const answers = q.responses.filter((x) => x.bytes[1] === 0x02 && x.bytes.length >= 5);
      if (!dtc && answers.length && answers.every((x) => !x.bytes[3] && !x.bytes[4])) {
        return { dtc: null, values: [], status: 'nodata', message: 'No freeze frame is saved. The car saves one only when a fault turns on the check engine light, and right now no module has one.' };
      }
    }

    // Which PIDs are stored in frame 0
    let supported = null;
    let base = 0;
    while (base <= 0x40) {
      const b = await this.query('02' + hex2(base) + '00');
      if (b.status !== 'ok') break;
      let more = false;
      b.responses.forEach((m) => {
        if (m.bytes[1] !== base) return;
        if (!supported) supported = new Set();
        const list = parseSupportedBitmap(base, m.bytes.slice(3, 7));
        list.forEach((p) => supported.add(p));
        if (list.indexOf(base + 0x20) !== -1) more = true;
      });
      if (!more) break;
      base += 0x20;
    }

    const COMMON = [0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x1f, 0x2f, 0x33, 0x42, 0x43, 0x44, 0x45, 0x46, 0x5c];
    const wanted = COMMON.filter((p) => (supported ? supported.has(p) : true));
    const values = [];
    let failures = 0;
    for (let i = 0; i < wanted.length; i++) {
      const p = wanted[i];
      const r = await this.query('02' + hex2(p) + '00');
      if (r.status !== 'ok') {
        failures++;
        if (!supported && failures >= 3 && !values.length) break; // car clearly has no freeze frame
        continue;
      }
      const m = sortByEcu(r.responses.filter((x) => x.bytes[1] === p))[0];
      if (!m) continue;
      const d = safeDecode(p, m.bytes.slice(3));
      values.push({ pid: p, name: pidName(p), value: d.value, unit: d.unit || '', text: d.text });
    }

    if (!dtc && !values.length) {
      const msg = q.status === 'ok' || q.status === 'nodata' || q.status === 'unsupported'
        ? 'No freeze frame stored. The car saves one when a fault turns on the check engine light.'
        : q.message;
      return { dtc: null, values: [], status: q.status === 'ok' ? 'nodata' : q.status, message: msg };
    }
    return { dtc, dtcInfo: dtc ? safeDescribe(dtc) : null, values, status: 'ok', message: '' };
  }

  async usedCarCheck(onProgress) {
    const steps = [
      'Checking which data this car supports',
      'Reading VIN',
      'Reading readiness monitors',
      'Reading distance and time since codes were cleared',
      'Reading stored codes',
      'Reading pending codes',
      'Reading permanent codes'
    ];
    let step = 0;
    const progress = (label) => {
      step++;
      if (typeof onProgress === 'function') {
        try { onProgress({ step, total: steps.length, label: label || steps[step - 1] }); } catch (e) { /* ignore UI errors */ }
      }
    };

    progress();
    if (!this.supported) await this.supportedPids();
    progress();
    const vin = await this.readVin();
    progress();
    const readiness = await this.readiness();
    progress();

    const ITEMS = [
      { pid: 0x31, key: 'distanceSinceClear', label: 'Distance since codes were cleared' },
      { pid: 0x4e, key: 'timeSinceClear', label: 'Engine run time since codes were cleared' },
      { pid: 0x30, key: 'warmupsSinceClear', label: 'Warm-ups since codes were cleared' },
      { pid: 0x21, key: 'distanceWithMil', label: 'Distance driven with the check engine light on' },
      { pid: 0x4d, key: 'timeWithMil', label: 'Engine run time with the check engine light on' },
      { pid: 0xa6, key: 'odometer', label: 'Odometer (from the car computers)', onlyIfSupported: true }
    ];
    const items = [];
    const vals = {};
    for (let i = 0; i < ITEMS.length; i++) {
      const it = ITEMS[i];
      const sup = this._isSupported(it.pid);
      if (sup === false || (it.onlyIfSupported && sup !== true)) {
        items.push({ key: it.key, pid: it.pid, label: it.label, supported: false, value: null, unit: '', text: NOT_SUPPORTED });
        continue;
      }
      const r = await this.readPid(it.pid);
      if (r.status === 'ok') {
        const num = typeof r.value === 'number' ? r.value : parseFloat(r.value);
        vals[it.key] = isNaN(num) ? null : num;
        items.push({ key: it.key, pid: it.pid, label: it.label, supported: true, value: r.value, unit: r.unit, text: r.text });
      } else {
        const ns = r.status === 'nodata' || r.status === 'unsupported';
        items.push({ key: it.key, pid: it.pid, label: it.label, supported: !ns ? null : false, value: null, unit: '', text: ns ? NOT_SUPPORTED : (r.message || 'Could not read') });
      }
    }

    progress();
    const stored = await this.readDtcs('03');
    progress();
    const pending = await this.readDtcs('07');
    progress();
    const permanent = await this.readDtcs('0A');

    const flags = buildUsedCarFlags({ vin, readiness, vals, items, stored, pending, permanent });
    const interrupted = [vin, readiness, stored, pending, permanent].some((r) => r && readFailed(r.status)) ||
      items.some((it) => it.supported === null);
    return { vin, readiness, items, dtcs: { stored, pending, permanent }, flags, interrupted };
  }
}

// A status that means "we could not ask" (connection trouble), as opposed to "the car said no".
function readFailed(status) {
  return !!status && status !== 'ok' && status !== 'nodata' && status !== 'unsupported';
}

function countCodes(r) {
  if (!r || !r.byEcu) return 0;
  return r.byEcu.reduce((n, e) => n + e.codes.length, 0);
}

function listCodes(r) {
  const out = [];
  (r && r.byEcu ? r.byEcu : []).forEach((e) => e.codes.forEach((c) => { if (out.indexOf(c) === -1) out.push(c); }));
  return out.join(', ');
}

/** Pure: turn used car check results into plain-English findings. */
export function buildUsedCarFlags(d) {
  const flags = [];
  const vals = d.vals || {};
  const rd = d.readiness || {};

  if (typeof rd.milOn === 'boolean') {
    if (rd.milOn) flags.push({ level: 'warn', text: 'The check engine light is ON. The car has detected a fault that affects emissions or engine running.' });
    else flags.push({ level: 'ok', text: 'The check engine light is off.' });
  }

  const nStored = countCodes(d.stored);
  const nPending = countCodes(d.pending);
  const nPerm = countCodes(d.permanent);
  if (nStored) flags.push({ level: 'warn', text: nStored + ' stored trouble code' + (nStored > 1 ? 's' : '') + ' (' + listCodes(d.stored) + '). These are confirmed faults.' });
  if (nPending) flags.push({ level: 'warn', text: nPending + ' pending code' + (nPending > 1 ? 's' : '') + ' (' + listCodes(d.pending) + '). The car has seen a possible fault that is not yet confirmed.' });
  if (nPerm) flags.push({ level: 'warn', text: nPerm + ' permanent code' + (nPerm > 1 ? 's' : '') + ' (' + listCodes(d.permanent) + '). These cannot be erased with a scan tool. They go away only after the car confirms the repair by itself.' });
  const couldNotRead = [];
  if (d.stored && readFailed(d.stored.status)) couldNotRead.push('stored codes');
  if (d.pending && readFailed(d.pending.status)) couldNotRead.push('pending codes');
  if (d.permanent && readFailed(d.permanent.status)) couldNotRead.push('permanent codes');
  else if (d.permanent && d.permanent.supported === false) flags.push({ level: 'info', text: 'Permanent codes: not supported by this car.' });
  if (d.stored && d.stored.partial || d.pending && d.pending.partial || d.permanent && d.permanent.partial) {
    flags.push({ level: 'warn', text: 'Part of the trouble code answer was lost, so some codes may be missing. Run the check again.' });
  }
  if (rd.status && readFailed(rd.status)) couldNotRead.push('readiness monitors');
  if (d.vin && !d.vin.vin && readFailed(d.vin.status)) couldNotRead.push('VIN');
  if (couldNotRead.length) {
    flags.push({ level: 'warn', text: 'Could not read the ' + couldNotRead.join(', ') + ' (connection problem). Run the check again.' });
  }
  const allRead = d.stored && d.stored.status === 'ok' && d.pending && d.pending.status === 'ok';
  if (allRead && !nStored && !nPending && !nPerm) flags.push({ level: 'ok', text: 'No stored or pending trouble codes.' });

  // Recently cleared?
  const reasons = [];
  if (typeof vals.distanceSinceClear === 'number' && vals.distanceSinceClear < 200) reasons.push('only ' + vals.distanceSinceClear + ' km driven since then');
  if (typeof vals.warmupsSinceClear === 'number' && vals.warmupsSinceClear < 20) reasons.push('only ' + vals.warmupsSinceClear + ' warm-ups since then');
  if (typeof vals.timeSinceClear === 'number' && vals.timeSinceClear < 300) reasons.push('only ' + vals.timeSinceClear + ' minutes of engine running since then');

  const mons = (rd.monitors || []).filter((m) => m.available && !m.continuous);
  const incomplete = mons.filter((m) => m.complete === false);
  if (reasons.length) {
    flags.push({ level: 'warn', text: 'Codes were probably cleared recently (' + reasons.join(', ') + '). Clearing codes can hide a problem. Ask the seller why, and check again after some driving.' });
  }
  if (incomplete.length >= 2) {
    flags.push({ level: 'warn', text: incomplete.length + ' readiness monitors are not finished (' + incomplete.map((m) => m.name).join(', ') + '). This often means the codes were cleared or the battery was disconnected recently.' });
  } else if (incomplete.length === 1) {
    flags.push({ level: 'info', text: 'One readiness monitor is not finished (' + incomplete[0].name + '). One incomplete monitor is fairly common, especially the fuel vapour (EVAP) test.' });
  } else if (mons.length) {
    flags.push({ level: 'ok', text: 'All readiness monitors are complete. This suggests codes were not cleared recently.' });
  }

  if (typeof vals.distanceWithMil === 'number' && vals.distanceWithMil > 0) {
    flags.push({ level: 'warn', text: 'The car has been driven ' + vals.distanceWithMil + ' km with the check engine light on.' });
  }

  if (typeof vals.odometer === 'number') {
    flags.push({ level: 'info', text: 'Odometer stored in the car computers: ' + vals.odometer + ' km. Compare it with the dashboard reading.' });
  }

  if (d.vin && d.vin.vin) flags.push({ level: 'info', text: 'VIN reported by the car: ' + d.vin.vin + '. Check it matches the plate on the car and the paperwork.' });
  else if (d.vin && !readFailed(d.vin.status)) flags.push({ level: 'info', text: 'VIN: not supported by this car (common on older cars).' });

  const unsupported = (d.items || []).filter((it) => it.supported === false).map((it) => it.label);
  if (unsupported.length) flags.push({ level: 'info', text: 'Not supported by this car: ' + unsupported.join(', ') + '. This is normal and not a fault.' });

  return flags;
}
