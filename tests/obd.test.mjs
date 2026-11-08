// Unit tests for js/obd.js. Run: node tests/obd.test.mjs
// Can also be imported by tests/run.mjs: `import { run } from './obd.test.mjs'; await run();`
// obd.js imports ./pids.js and ./dtc-db.js. If those are not written yet the tests are skipped (not failed).
// Set OBD_MODULE=/abs/path/to/obd.js to test another copy.

import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const target = process.env.OBD_MODULE
  ? pathToFileURL(process.env.OBD_MODULE).href
  : new URL('../js/obd.js', import.meta.url).href;

// Fake Elm327 that answers from a table of lines (as Elm327.send would return them).
class FakeElm {
  constructor(table) { this.table = table; this.sent = []; }
  async send(cmd) {
    this.sent.push(cmd);
    const v = this.table[cmd];
    if (v === undefined || v === 'NO DATA') return { cmd, raw: 'NO DATA', lines: ['NO DATA'], status: 'nodata', message: 'The car did not answer this request.' };
    if (v === '?') return { cmd, raw: '?', lines: ['?'], status: 'unknown', message: 'Unknown command.' };
    return { cmd, raw: v.join('\r'), lines: v.slice(), status: 'ok', message: '' };
  }
}

export async function run() {
  let M;
  try {
    M = await import(target);
  } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND' && /(pids|dtc-db)\.js/.test(String(e.message))) {
      console.log('SKIP obd.test.mjs: ' + e.message.split('\n')[0]);
      return { passed: 0, failed: 0, skipped: true };
    }
    throw e;
  }
  const { parseLines, decodeDtc, ecuLabel, ECU_NAMES, parseDtcResponses, parseVin, parseReadiness,
    parseSupportedBitmap, buildUsedCarFlags, Obd } = M;

  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });

  // ---------------- parseLines ----------------
  test('11-bit CAN single frame, no spaces', () => {
    const r = parseLines(['7E8064100BE3FA813'], 'A6');
    assert.deepEqual(r.map((x) => [x.ecu, x.bytes]), [['7E8', [0x41, 0x00, 0xbe, 0x3f, 0xa8, 0x13]]]);
  });

  test('11-bit CAN with spaces and 8 byte padding', () => {
    const r = parseLines(['7E8 06 41 00 BE 3F A8 13 00'], '6');
    assert.deepEqual(r[0].bytes, [0x41, 0x00, 0xbe, 0x3f, 0xa8, 0x13]);
  });

  test('two ECUs 7E8 and 7EA answering 0100', () => {
    const r = parseLines(['7E8064100BE3FA813', '7EA06410098180001'], 'A6');
    assert.equal(r.length, 2);
    assert.equal(r[0].ecu, '7E8');
    assert.equal(r[1].ecu, '7EA');
    assert.deepEqual(r[1].bytes, [0x41, 0x00, 0x98, 0x18, 0x00, 0x01]);
  });

  test('3-code multi-frame 03 reply (P0171 P0420 P0A80)', () => {
    const lines = ['7E8100843030171', '7E8210420 0A80000000'.replace(/ /g, '')];
    // FF: 10 08 43 03 01 71 | CF: 21 04 20 0A 80 00 00 00
    const r = parseLines(lines, 'A6');
    assert.equal(r.length, 1);
    assert.deepEqual(r[0].bytes, [0x43, 0x03, 0x01, 0x71, 0x04, 0x20, 0x0a, 0x80]);
    const d = parseDtcResponses(r, true);
    assert.deepEqual(d[0].codes, ['P0171', 'P0420', 'P0A80']);
    assert.equal(d[0].ecu, '7E8');
  });

  test('3-code 03 reply as ELM prints it with spaces and full 8 byte frames', () => {
    const r = parseLines(['7E8 10 08 43 03 01 71 04 20', '7E8 21 0A 80 00 00 00 00 00'], '6');
    assert.deepEqual(parseDtcResponses(r, true)[0].codes, ['P0171', 'P0420', 'P0A80']);
  });

  const VIN_LINES = ['7E81014490201 4E4D54'.replace(/ /g, ''), '7E8214B5A334258 3130'.replace(/ /g, ''), '7E822523030303030 31'.replace(/ /g, '')];
  test('VIN multi-frame from 7E8', () => {
    const r = parseLines(VIN_LINES, 'A6');
    assert.equal(r.length, 1);
    assert.equal(r[0].bytes.length, 0x14);
    assert.deepEqual(parseVin(r), { vin: 'NMTKZ3BX10R000001', ecu: '7E8' });
  });

  test('ISO-TP frames from two ECUs interleaved are reassembled per ECU', () => {
    const r = parseLines(['7E8100843030171', '7EA06430101710000', '7E8210420 0A80000000'.replace(/ /g, '')], 'A6');
    const d = parseDtcResponses(r, true);
    assert.deepEqual(d.map((x) => [x.ecu, x.codes]), [['7E8', ['P0171', 'P0420', 'P0A80']], ['7EA', ['P0171']]]);
  });

  test('29-bit CAN', () => {
    const r = parseLines(['18DAF11006410098180001'], 'A7');
    assert.deepEqual(r.map((x) => [x.ecu, x.bytes]), [['18DAF110', [0x41, 0x00, 0x98, 0x18, 0x00, 0x01]]]);
    assert.equal(ecuLabel('18DAF110'), 'Engine (ECM)');
  });

  test('29-bit CAN with spaces and unknown protocol', () => {
    const r = parseLines(['18 DA F1 10 06 41 00 98 18 00 01']);
    assert.equal(r[0].ecu, '18DAF110');
    assert.deepEqual(r[0].bytes, [0x41, 0x00, 0x98, 0x18, 0x00, 0x01]);
  });

  test('legacy ISO 9141 486B10 with checksum stripped', () => {
    const r = parseLines(['486B104100BE3FA8139C'], '3');
    assert.deepEqual(r.map((x) => [x.ecu, x.bytes]), [['10', [0x41, 0x00, 0xbe, 0x3f, 0xa8, 0x13]]]);
    assert.equal(ecuLabel('10'), 'Engine (ECM)');
  });

  test('legacy with spaces and no protocol number', () => {
    const r = parseLines(['48 6B 10 41 00 BE 3F A8 13 BC']);
    assert.equal(r[0].ecu, '10');
    assert.equal(r[0].proto, 'legacy');
  });

  test('legacy 03 replies: pairs without count byte, 0000 skipped, several messages', () => {
    const r = parseLines(['486B104301710420030055', '486B10430A80000000006A'], 'A3');
    assert.deepEqual(parseDtcResponses(r, false)[0].codes, ['P0171', 'P0420', 'P0300', 'P0A80']);
  });

  test('legacy VIN in 5 messages', () => {
    const vin = 'NMTKZ3BX10R000001'.split('').map((c) => c.charCodeAt(0));
    const data = [0, 0, 0].concat(vin);
    const lines = [];
    for (let s = 1; s <= 5; s++) {
      const chunk = data.slice((s - 1) * 4, s * 4);
      lines.push('486B104902' + [s].concat(chunk).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase() + '00');
    }
    lines.reverse(); // out of order on purpose
    assert.equal(parseVin(parseLines(lines, '3')).vin, 'NMTKZ3BX10R000001');
  });

  test('KWP2000 header (83 F1 10)', () => {
    const r = parseLines(['83F1104100BE3FA8139C'.replace('83F110', '86F110')], '5');
    assert.equal(r[0].ecu, '10');
    assert.deepEqual(r[0].bytes.slice(0, 2), [0x41, 0x00]);
  });

  test('headers off multiline fallback', () => {
    const r = parseLines(['014', '0: 49 02 01 4E 4D 54', '1: 4B 5A 33 42 58 31 30', '2: 52 30 30 30 30 30 31'], '6');
    assert.equal(r.length, 1);
    assert.equal(parseVin(r).vin, 'NMTKZ3BX10R000001');
  });

  test('headers off single line', () => {
    const r = parseLines(['41 0C 1A F8'], '6');
    assert.deepEqual(r[0].bytes, [0x41, 0x0c, 0x1a, 0xf8]);
  });

  test('ignores status text and handles raw string input', () => {
    const r = parseLines('SEARCHING...\r7E8064100BE3FA813\r\r>', 'A6');
    assert.equal(r.length, 1);
    assert.deepEqual(parseLines(['NO DATA'], '6'), []);
  });

  test('headers off, unknown protocol: 41 6B ... is a PID 6B reply, not a J1850 header', () => {
    const r = parseLines(['416B5A5A00'], null);
    assert.equal(r.length, 1);
    assert.equal(r[0].proto, 'raw');
    assert.deepEqual(r[0].bytes, [0x41, 0x6b, 0x5a, 0x5a, 0x00]);
  });

  test('unknown protocol: J1850 frame with a valid CRC is still read as legacy', () => {
    // 48 6B 10 41 0D 32 + J1850 CRC
    const body = [0x48, 0x6b, 0x10, 0x41, 0x0d, 0x32];
    let crc = 0xff;
    body.forEach((b) => { crc ^= b; for (let k = 0; k < 8; k++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x1d) & 0xff : (crc << 1) & 0xff; });
    const line = body.concat([(~crc) & 0xff]).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const r = parseLines([line], null);
    assert.equal(r[0].proto, 'legacy');
    assert.equal(r[0].ecu, '10');
    assert.deepEqual(r[0].bytes, [0x41, 0x0d, 0x32]);
  });

  test('ISO-TP: first frame without its consecutive frame is marked incomplete', () => {
    const r = parseLines(['7E8 10 08 43 03 01 71 04 20'], '6');
    assert.equal(r.length, 1);
    assert.equal(r[0].incomplete, true);
    const d = parseDtcResponses(r, true);
    assert.deepEqual(d[0].codes, ['P0171', 'P0420']);
    assert.equal(d[0].partial, true);
  });

  test('ISO-TP: a skipped consecutive frame sequence number marks the message incomplete', () => {
    const r = parseLines(['7E8 10 0E 43 06 01 71 04 20', '7E8 22 0A 80 03 00 00 00 00'], '6');
    assert.equal(r.length, 1);
    assert.equal(r[0].incomplete, true);
    assert.deepEqual(r[0].bytes, [0x43, 0x06, 0x01, 0x71, 0x04, 0x20], 'data after the gap is not appended');
  });

  test('ISO-TP: consecutive frames in order are reassembled and complete', () => {
    const r = parseLines(['7E8 10 0A 43 04 01 71 04 20', '7E8 21 0A 80 03 00 00 00 00'], '6');
    assert.equal(r[0].incomplete, undefined);
    assert.deepEqual(parseDtcResponses(r, true)[0].codes, ['P0171', 'P0420', 'P0A80', 'P0300']);
  });

  test('negative response 7F', () => {
    const r = parseLines(['7E8037F0A12'], '6');
    assert.deepEqual(r[0].bytes, [0x7f, 0x0a, 0x12]);
  });

  // ---------------- DTC / bitmap / labels ----------------
  test('decodeDtc letters and digits', () => {
    assert.equal(decodeDtc(0x03, 0x01), 'P0301');
    assert.equal(decodeDtc(0x0a, 0x80), 'P0A80');
    assert.equal(decodeDtc(0x41, 0x23), 'C0123');
    assert.equal(decodeDtc(0x92, 0x34), 'B1234');
    assert.equal(decodeDtc(0xc1, 0x00), 'U0100');
    assert.equal(decodeDtc(0x30, 0x00), 'P3000');
  });

  test('parseSupportedBitmap BE3FA813', () => {
    const p = parseSupportedBitmap(0, [0xbe, 0x3f, 0xa8, 0x13]);
    assert.deepEqual(p, [0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x15, 0x1c, 0x1f, 0x20]);
  });

  test('ECU names', () => {
    assert.equal(ECU_NAMES['7E8'], 'Engine (ECM)');
    assert.equal(ecuLabel('7E9'), 'Transmission / Hybrid (TCM)');
    assert.ok(/7EF/.test(ecuLabel('7EF')));
    assert.equal(ecuLabel('7C8'), 'Module at 7C8');
  });

  // ---------------- readiness ----------------
  test('readiness spark: MIL on, 3 codes, EVAP incomplete', () => {
    const r = parseReadiness([0x83, 0x07, 0x65, 0x04]);
    assert.equal(r.milOn, true);
    assert.equal(r.dtcCount, 3);
    assert.equal(r.ignition, 'spark');
    const by = Object.fromEntries(r.monitors.map((m) => [m.key, m]));
    assert.equal(by.misfire.available, true);
    assert.equal(by.misfire.complete, true);
    assert.equal(by.catalyst.complete, true);
    assert.equal(by.evap.available, true);
    assert.equal(by.evap.complete, false);
    assert.equal(by.o2Sensor.complete, true);
    assert.equal(by.egr.available, false);
    assert.equal(by.egr.complete, null);
    r.monitors.forEach((m) => { assert.equal(typeof m.name, 'string'); assert.equal(typeof m.explain, 'string'); });
  });

  test('readiness compression ignition layout', () => {
    // B = 0x0F (diesel + continuous available), C = 0x63 (NMHC, NOx, exhaust sensor, DPF), D = 0x40 (DPF incomplete)
    const r = parseReadiness([0x00, 0x0f, 0x63, 0x40]);
    assert.equal(r.ignition, 'compression');
    assert.equal(r.milOn, false);
    const by = Object.fromEntries(r.monitors.map((m) => [m.key, m]));
    assert.equal(by.nmhcCatalyst.complete, true);
    assert.equal(by.noxScr.complete, true);
    assert.equal(by.pmFilter.complete, false);
    assert.equal(by.boostPressure.available, false);
    assert.equal(by.catalyst, undefined);
  });

  // ---------------- Obd class with fake adapter ----------------
  const table = {
    ATDPN: ['A6'],
    '0100': ['7E8064100BE3FA813', '7EA06410098180001'],
    '0120': ['7E80641208005B011'],
    '0140': ['7E8064140FED08500'],
    '0101': ['7E806410183076504'],
    '0141': ['7E806414100076504'],
    '0902': VIN_LINES,
    '03': ['7E8100843030171', '7E8210420 0A80000000'.replace(/ /g, '')],
    '07': ['7E806470103000000'],
    '0A': ['7E8037F0A12'],
    '04': ['7E8014400000000'],
    '010C0D': ['7E806410C1AF80D32']
  };

  test('Obd.readDtcs 03/07/0A', async () => {
    const obd = new Obd(new FakeElm(table));
    const s = await obd.readDtcs('03');
    assert.equal(s.supported, true);
    assert.deepEqual(s.byEcu[0].codes, ['P0171', 'P0420', 'P0A80']);
    assert.equal(s.byEcu[0].label, 'Engine (ECM)');
    const p = await obd.readDtcs('07');
    assert.deepEqual(p.byEcu[0].codes, ['P0300']);
    const a = await obd.readDtcs('0A');
    assert.equal(a.supported, false);
    assert.equal(a.message, 'Not supported by this car');
  });

  test('Obd.readDtcs warns when part of a multi-frame answer was lost', async () => {
    const obd = new Obd(new FakeElm(Object.assign({}, table, { '03': ['7E8 10 08 43 03 01 71 04 20'] })));
    obd.protocolNumber = '6';
    const s = await obd.readDtcs('03');
    assert.equal(s.status, 'ok');
    assert.equal(s.partial, true);
    assert.ok(/some codes may be missing/i.test(s.message), s.message);
    assert.deepEqual(s.byEcu[0].codes, ['P0171', 'P0420']);
  });

  test('Obd.freezeFrame asks for the freeze frame DTC with a frame number (020200)', async () => {
    const elm = new FakeElm(Object.assign({}, table, {
      '020200': ['7E8064202000171'],
      '020000': ['7E8074200005C000000'],
      '020C00': ['7E80542 0C 00 17 C0'.replace(/ /g, '')]
    }));
    const obd = new Obd(elm);
    obd.protocolNumber = '6';
    const ff = await obd.freezeFrame();
    assert.ok(elm.sent.indexOf('020200') !== -1, 'sent: ' + elm.sent.join(','));
    assert.ok(elm.sent.indexOf('0202') === -1, 'must not send a 2-byte mode 02 request');
    assert.equal(ff.dtc, 'P0171');
  });

  test('used car flags: interrupted reads are not reported as "not supported"', () => {
    const stopped = { status: 'stopped', supported: false, message: 'The request was stopped before the car answered.', byEcu: [] };
    const flags = buildUsedCarFlags({
      vin: { vin: null, status: 'timeout', message: 'x' },
      readiness: parseReadiness([0x83, 0x07, 0x65, 0x25]),
      vals: {}, items: [],
      stored: { status: 'ok', supported: true, byEcu: [{ ecu: '7E8', codes: ['P0171'] }] },
      pending: stopped,
      permanent: stopped
    }).map((f) => f.level + ': ' + f.text);
    const all = flags.join('\n');
    assert.ok(!/Permanent codes: not supported/.test(all), all);
    assert.ok(!/VIN: not supported/.test(all), all);
    assert.ok(/warn: Could not read the pending codes, permanent codes, VIN \(connection problem\)/.test(all), all);
  });

  test('Obd.readVin, clearDtcs, supportedPids', async () => {
    const obd = new Obd(new FakeElm(table));
    const v = await obd.readVin();
    assert.equal(v.vin, 'NMTKZ3BX10R000001');
    assert.equal(v.ecu, '7E8');
    assert.equal((await obd.clearDtcs()).ok, true);
    const s = await obd.supportedPids();
    assert.ok(s.all.has(0x0c));
    assert.ok(s.byEcu['7EA'].has(0x01));
    assert.ok(s.all.has(0x41));
    assert.ok(!s.all.has(0xa6));
  });

  test('Obd.readiness with 0141', async () => {
    const obd = new Obd(new FakeElm(table));
    const r = await obd.readiness();
    assert.equal(r.milOn, true);
    assert.equal(r.dtcCount, 3);
    assert.ok(Array.isArray(r.thisDrive));
  });

  test('Obd.readPids multi-PID on CAN, then fallback when multi fails', async () => {
    const elm = new FakeElm(Object.assign({}, table, { '010C': ['7E804410C1AF8'], '010D': ['7E803410D32'] }));
    const obd = new Obd(elm);
    const r = await obd.readPids([0x0c, 0x0d]);
    assert.equal(r.length, 2);
    assert.equal(r[0].status, 'ok');
    assert.equal(r[1].ecu, '7E8');
    assert.ok(elm.sent.indexOf('010C0D') !== -1);
    const elm2 = new FakeElm(Object.assign({}, table, { '010C0D': '?', '010C': ['7E804410C1AF8'], '010D': ['7E803410D32'] }));
    const obd2 = new Obd(elm2);
    const r2 = await obd2.readPids([0x0c, 0x0d]);
    assert.deepEqual(r2.map((x) => x.status), ['ok', 'ok']);
    assert.ok(elm2.sent.indexOf('010C') !== -1);
  });

  test('used car flags: recently cleared and unsupported items', () => {
    const flags = buildUsedCarFlags({
      vin: { vin: 'NMTKZ3BX10R000001' },
      readiness: parseReadiness([0x83, 0x07, 0x65, 0x25]),
      vals: { distanceSinceClear: 85, timeSinceClear: 42, warmupsSinceClear: 3, distanceWithMil: 0 },
      items: [{ label: 'Odometer (from the engine computer)', supported: false }],
      stored: { status: 'ok', byEcu: [{ ecu: '7E8', codes: ['P0171'] }] },
      pending: { status: 'ok', byEcu: [] },
      permanent: { status: 'unsupported', supported: false, byEcu: [] }
    }).map((f) => f.text);
    const all = flags.join('\n');
    assert.ok(/cleared recently/.test(all));
    assert.ok(/Not supported by this car: Odometer/.test(all));
    assert.ok(/check engine light is ON/.test(all));
    assert.ok(!/[\u2013\u2014]/.test(all), 'no en or em dashes');
  });

  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log('ok   ' + t.name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + t.name + '\n     ' + (e && e.message ? e.message.split('\n').join('\n     ') : e));
    }
  }
  console.log(`obd.test.mjs: ${passed} passed, ${failed} failed`);
  return { passed, failed, skipped: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().then((r) => { if (r.failed) process.exitCode = 1; }, (e) => { console.error(e); process.exitCode = 1; });
}
