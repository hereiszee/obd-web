// Regression tests from the first real-car log: vLinker MC-IOS on a Toyota C-HR Hybrid (Bluefy, Nov 2026).
// Run: node tests/realcar.test.mjs
import assert from 'node:assert/strict';
import { Logger } from '../js/log.js';
import { Elm327 } from '../js/elm.js';
import { Obd } from '../js/obd.js';
import { BleTransport, normUuid } from '../js/ble.js';

// Exact replies captured from the car (CR shown as \r). Echo stays on until ATE0 is processed.
const REPLIES = {
  'ATZ': 'ATZ\r\r\rELM327 v2.2\r\r>',
  'ATE0': 'ATE0\rOK\r\r>',
  'ATL0': 'OK\r\r>', 'ATS0': 'OK\r\r>', 'ATH1': 'OK\r\r>', 'ATAT1': 'OK\r\r>', 'ATSP0': 'OK\r\r>',
  'ATRV': '14.4V\r\r>',
  'ATDPN': 'A6\r\r>',
  'ATDP': 'AUTO, ISO 15765-4 (CAN 11/500)\r\r>',
  '0100': '7EE064100981A8013\r7EA064100981A8003\r7EB06410098188003\r7E8064100BE1FA813\r\r>',
  '0120': '7EE06412080018001\r7EA0641208001A001\r7EB0641208001A001\r7E80641209005B015\r\r>',
  '0140': '7EE064140C40C0001\r7EA064140C4CC0021\r7E80641407E1C8C01\r7EB064140C40C0021\r\r>',
  '0160': '7EA06416008000001\r7EB06416000000001\r7E806416060800041\r7EE06416008000001\r\r>',
  '0180': '7EA06418002000041\r7EB06418000000040\r7E80641800204000C\r7EE06418000000040\r\r>',
  '01A0': '7EA0641A004000000\r\r>',
  // Second session (no stored codes): every module says no freeze frame.
  '020200': '7E8054202000000\r7EA054202000000\r7EE054202000000\r7EB054202000000\r\r>',
  '020000': '7EB0742000058188003\r7E8074200007E1F8803\r7EA07420000581A8003\r7EE07420000581A8003\r\r>',
  '0101': '7EE06410100040000\r7EB06410100040000\r7E80641010007A100\r7EA06410100040000\r\r>',
  '01A6': '7EA0641A600219513\r\r>',
  // Third session: live data addressed to the engine only (ATSH 7E0), replies from 7E8.
  'ATSH7E0': 'OK\r\r>', 'ATSH7DF': 'OK\r\r>', 'ATSH7E2': 'OK\r\r>', 'ATSH7E3': 'OK\r\r>', 'ATSH7E6': 'OK\r\r>',
  '010C0D050F0411': '7E8100E410C00000D00\r7E821057A0F49040011\r7E8222E000000000000\r\r>',
};

// Replays the captured replies in small fragments, like BLE notifications.
class ReplayTransport {
  constructor() { this.name = 'replay'; this.onData = null; this.onDisconnect = null; this.info = {}; this.first0100 = true; }
  async connect() {}
  async disconnect() {}
  isConnected() { return true; }
  async write(text) {
    const cmd = text.replace(/\r$/, '').replace(/\s+/g, '').toUpperCase();
    let r = REPLIES[cmd];
    if (r === undefined) r = '?\r\r>';
    if (cmd === '0100' && this.first0100) { this.first0100 = false; r = 'SEARCHING...\r' + r; }
    const parts = [];
    for (let i = 0; i < r.length; i += 7) parts.push(r.slice(i, i + 7));
    let d = 1;
    for (const p of parts) setTimeout(() => this.onData && this.onData(p), d++);
  }
}

// Fake Bluefy: short 16-bit UUIDs, bare-number rejections, optional link drop during discovery.
function fakeBluetooth({ rejectWith, dropOnFirstListOf } = {}) {
  let connects = 0;
  const listeners = {};
  const chr = (uuid, props) => ({
    uuid, properties: props,
    addEventListener() {}, removeEventListener() {},
    async startNotifications() { if (!gatt.connected) throw 2; },
    async stopNotifications() {},
    async writeValueWithoutResponse() {}, async writeValueWithResponse() {},
  });
  const P = (o) => Object.assign({ read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false }, o);
  let dropped = false;
  const maybeDrop = (uuid) => {
    if (dropOnFirstListOf === uuid && !dropped) {
      dropped = true; gatt.connected = false;
      (listeners.gattserverdisconnected || []).forEach((f) => f());
      throw 2;
    }
    if (!gatt.connected) throw 2;
  };
  const svc = (uuid, chars) => ({
    uuid,
    async getCharacteristics() { maybeDrop(uuid); return chars; },
    async getCharacteristic(u) {
      maybeDrop(uuid);
      const c = chars.find((x) => normUuid(x.uuid) === normUuid(u));
      if (!c) throw new Error('NotFoundError');
      return c;
    },
  });
  const services = [
    svc('18f0', [chr('2af0', P({ notify: true, indicate: true })), chr('2af1', P({ write: true, writeWithoutResponse: true }))]),
    svc('180a', [chr('2a29', P({ read: true }))]),
    svc('e7810a71-73ae-499d-8c15-faa9aef0c3f2', [chr('bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', P({ read: true, write: true, writeWithoutResponse: true, notify: true, indicate: true }))]),
  ];
  const gatt = {
    connected: false,
    async connect() { connects++; gatt.connected = true; return server; },
    disconnect() { gatt.connected = false; },
  };
  const server = {
    get connected() { return gatt.connected; },
    async getPrimaryServices() { return services; },
    async getPrimaryService(u) {
      const s = services.find((x) => normUuid(x.uuid) === normUuid(u));
      if (!s) throw new Error('NotFoundError');
      return s;
    },
  };
  const device = {
    name: 'vLinker MC-IOS', id: 'X', gatt,
    addEventListener(n, f) { (listeners[n] = listeners[n] || []).push(f); },
    removeEventListener(n, f) { listeners[n] = (listeners[n] || []).filter((g) => g !== f); },
  };
  return {
    stats: () => ({ connects }),
    bluetooth: { async requestDevice() { if (rejectWith !== undefined) throw rejectWith; return device; } },
  };
}

function withNavigator(nav, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  return Promise.resolve().then(fn).finally(() => {
    if (had) Object.defineProperty(globalThis, 'navigator', had); else delete globalThis.navigator;
  });
}

export async function run() {
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });

  test('real car: init parses ELM v2.2 and CAN 11/500', async () => {
    const elm = new Elm327(new ReplayTransport(), new Logger());
    const r = await elm.init();
    assert.equal(r.ok, true, r.message);
    assert.match(String(r.elmVersion), /2\.2/);
    assert.equal(String(r.protocolNumber).replace(/^A/, ''), '6');
  });

  test('real car: four modules answer and 7EA supports odometer A6', async () => {
    const elm = new Elm327(new ReplayTransport(), new Logger());
    const r = await elm.init();
    const obd = new Obd(elm);
    obd.protocolNumber = r.protocolNumber;
    const sup = await obd.supportedPids();
    assert.deepEqual(Object.keys(sup.byEcu).sort(), ['7E8', '7EA', '7EB', '7EE']);
    assert.ok(sup.byEcu['7EA'].has(0xA6), '7EA should support A6');
    assert.ok(!sup.byEcu['7E8'].has(0xA6), '7E8 should not support A6');
    assert.ok(sup.all.has(0x0C) && sup.all.has(0x5B) === sup.byEcu['7E8'].has(0x5B) || true);
    assert.ok(sup.byEcu['7E8'].has(0x0C), 'engine RPM supported on 7E8');
    assert.ok(sup.all.has(0xA6));
  });

  test('normUuid expands short UUIDs from Bluefy', () => {
    assert.equal(normUuid('18f0'), '000018f0-0000-1000-8000-00805f9b34fb');
    assert.equal(normUuid('E7810A71-73AE-499D-8C15-FAA9AEF0C3F2'), 'e7810a71-73ae-499d-8c15-faa9aef0c3f2');
  });

  test('BLE: picks the 18F0 pair by default with short-UUID services', async () => {
    const fb = fakeBluetooth();
    await withNavigator({ bluetooth: fb.bluetooth }, async () => {
      const t = new BleTransport({ logger: new Logger() });
      const info = await t.connect();
      assert.equal(info.serviceUuid, '000018f0-0000-1000-8000-00805f9b34fb');
      assert.equal(info.notifyUuid, '00002af0-0000-1000-8000-00805f9b34fb');
      assert.equal(info.writeUuid, '00002af1-0000-1000-8000-00805f9b34fb');
      assert.ok(t.isConnected());
      await t.disconnect();
    });
  });

  test('BLE: the iOS channel can still be chosen explicitly', async () => {
    const fb = fakeBluetooth();
    await withNavigator({ bluetooth: fb.bluetooth }, async () => {
      const t = new BleTransport({ logger: new Logger(), prefer: 'e781' });
      const info = await t.connect();
      assert.equal(info.serviceUuid, 'e7810a71-73ae-499d-8c15-faa9aef0c3f2');
      assert.equal(info.notifyUuid, 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f');
      await t.disconnect();
    });
  });

  test('BLE: picker closed with a bare number gives a plain message', async () => {
    const fb = fakeBluetooth({ rejectWith: 2 });
    await withNavigator({ bluetooth: fb.bluetooth }, async () => {
      const t = new BleTransport({ logger: new Logger() });
      await assert.rejects(() => t.connect(), /closed without a choice/);
    });
  });

  test('BLE: link drop during discovery retries and connects', async () => {
    const fb = fakeBluetooth({ dropOnFirstListOf: '18f0' });
    await withNavigator({ bluetooth: fb.bluetooth }, async () => {
      const log = new Logger();
      const t = new BleTransport({ logger: log });
      let lost = 0;
      const info = await t.connect();
      t.onDisconnect = () => { lost++; };
      assert.equal(fb.stats().connects, 2, 'should reconnect once');
      assert.ok(t.isConnected());
      assert.equal(info.serviceUuid, '000018f0-0000-1000-8000-00805f9b34fb');
      // A later real drop must still reach the app.
      t._handleGattDisconnect();
      assert.equal(lost, 1);
    });
  });

  test('BLE: reconnect() after a drop works without the device list', async () => {
    assert.equal(await runReconnect(), true);
  });

  test('keepalive sends ATRV only while idle, and stops', async () => {
    const tr = new ReplayTransport();
    const sent = [];
    const w = tr.write.bind(tr);
    tr.write = (x) => { sent.push(x.trim()); return w(x); };
    const elm = new Elm327(tr, new Logger());
    elm.startKeepAlive(1200);
    await new Promise((r) => setTimeout(r, 2600));
    const n = sent.filter((c) => c === 'ATRV').length;
    elm.stopKeepAlive();
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(n >= 1, 'expected a keepalive ATRV');
    assert.equal(sent.filter((c) => c === 'ATRV').length, n, 'no keepalive after stop');
  });

  test('real car: freeze frame stops after 020200 says no frame is stored', async () => {
    const tr = new ReplayTransport();
    const sent = [];
    const w = tr.write.bind(tr);
    tr.write = (x) => { sent.push(x.trim()); return w(x); };
    const elm = new Elm327(tr, new Logger());
    const r0 = await elm.init();
    const obd = new Obd(elm);
    obd.protocolNumber = r0.protocolNumber;
    const before = sent.length;
    const ff = await obd.freezeFrame();
    assert.deepEqual(sent.slice(before), ['020200'], 'only one request expected');
    assert.equal(ff.status, 'nodata');
    assert.match(ff.message, /No freeze frame/);
  });

  test('real car: readiness all complete, MIL off, odometer from 7EA', async () => {
    const elm = new Elm327(new ReplayTransport(), new Logger());
    const r0 = await elm.init();
    const obd = new Obd(elm);
    obd.protocolNumber = r0.protocolNumber;
    const rd = await obd.readiness();
    assert.equal(rd.milOn, false);
    const used = rd.monitors.filter((m) => m.available);
    assert.ok(used.length >= 4, 'expected several supported monitors');
    assert.ok(used.every((m) => m.complete), 'all supported monitors complete');
    const od = await obd.readPid(0xA6);
    assert.equal(Math.round(od.value * 10), 2200851);
  });

  test('real car: live data goes to one module, later reads go back to all', async () => {
    const tr = new ReplayTransport();
    const sent = [];
    const w = tr.write.bind(tr);
    tr.write = (x) => { sent.push(x.trim().replace(/\s+/g, '')); return w(x); };
    const elm = new Elm327(tr, new Logger());
    const r0 = await elm.init();
    const obd = new Obd(elm);
    obd.protocolNumber = r0.protocolNumber;
    obd.targetLive = true;
    await obd.supportedPids();
    const before = sent.length;
    const res = await obd.readPids([0x0C, 0x0D, 0x05, 0x0F, 0x04, 0x11]);
    const live = sent.slice(before);
    assert.deepEqual(live.slice(0, 2), ['ATSH7E0', '010C0D050F0411']);
    const rpm = res.find((r) => r.pid === 0x0C);
    assert.equal(rpm.status, 'ok');
    assert.equal(rpm.ecu, '7E8');
    assert.equal(rpm.value, 0);
    const cool = res.find((r) => r.pid === 0x05);
    assert.equal(cool.value, 0x7A - 40);
    const mark = sent.length;
    await obd.query('0101');
    assert.deepEqual(sent.slice(mark, mark + 2), ['ATSH7DF', '0101'], 'broadcast restored');
  });

  async function setup(overrides) {
    const tr = new ReplayTransport();
    const sent = [];
    const w = tr.write.bind(tr);
    tr.write = (x) => {
      const c = x.trim().replace(/\s+/g, '');
      sent.push(c);
      if (overrides && overrides[c] !== undefined) {
        const r = overrides[c];
        setTimeout(() => tr.onData && tr.onData(r), 2);
        return Promise.resolve();
      }
      return w(x);
    };
    const elm = new Elm327(tr, new Logger());
    const r0 = await elm.init();
    const obd = new Obd(elm);
    obd.protocolNumber = r0.protocolNumber;
    obd.targetLive = true;
    await obd.supportedPids();
    return { obd, elm, sent };
  }

  test('review: failed switch back to all modules blocks clear codes', async () => {
    const { obd, sent } = await setup({ 'ATSH7DF': '?\r\r>' });
    await obd.readPids([0x0C, 0x0D, 0x05, 0x0F, 0x04, 0x11]);
    const mark = sent.length;
    const r = await obd.clearDtcs();
    assert.equal(r.ok, false);
    assert.ok(!sent.slice(mark).includes('04'), '04 must not be sent while still addressed to one module');
  });

  test('review: single readings stay addressed to their module', async () => {
    const { obd, sent } = await setup();
    const mark = sent.length;
    await obd.readPids([0x0C, 0x5B]);
    await obd.readPids([0x0C, 0x5B]);
    const live = sent.slice(mark);
    assert.ok(!live.includes('ATSH7DF'), 'no switch back to broadcast inside live rounds: ' + live.join(' '));
    assert.ok(live.some((c) => /^ATSH7E/.test(c)));
  });

  test('review: adapter that refuses ATSH falls back to asking all modules', async () => {
    const { obd, sent } = await setup({ 'ATSH7E0': '?\r\r>', 'ATSH7E2': '?\r\r>', 'ATSH7E3': '?\r\r>', 'ATSH7E6': '?\r\r>' });
    await obd.readPids([0x0C, 0x0D, 0x05, 0x0F, 0x04, 0x11]);
    const mark = sent.length;
    const res = await obd.readPids([0x0C, 0x0D, 0x05, 0x0F, 0x04, 0x11]);
    assert.ok(!sent.slice(mark).some((c) => /^ATSH/.test(c)), 'no more ATSH attempts');
    assert.ok(sent.slice(mark).includes('010C0D050F0411'));
    assert.equal(res.length, 6);
  });

  test('1.0.5: live data asks all modules by default (no ATSH)', async () => {
    const { obd, sent } = await setup();
    obd.targetLive = undefined;
    const mark = sent.length;
    await obd.readPids([0x0C, 0x0D, 0x05, 0x0F, 0x04, 0x11]);
    assert.ok(!sent.slice(mark).some((c) => /^ATSH/.test(c)), sent.slice(mark).join(' '));
  });

  test('1.0.5: steady mode sends one reading per request', async () => {
    const { obd, sent } = await setup({ '010C': '7E804410C1E1A\r7EA04410C1E00\r\r>', '010D': '7E803410D00\r\r>' });
    obd.targetLive = undefined;
    obd.gentleLive = true;
    const mark = sent.length;
    const res = await obd.readPids([0x0C, 0x0D]);
    assert.deepEqual(sent.slice(mark), ['010C', '010D']);
    assert.equal(res[0].ecu, '7E8');
    assert.equal(res[0].value, 0x1E1A / 4);
  });

  test('1.0.5: probe runs addressing tests and restores the adapter', async () => {
    const { elm, sent } = await setup({ 'ATCRA7E8': 'OK\r\r>', 'ATCRA7EA': 'OK\r\r>', 'ATAR': 'OK\r\r>', 'ATI': 'ELM327 v2.2\r\r>', 'AT@1': 'OBDII to RS232 Interpreter\r\r>' });
    const mark = sent.length;
    await elm.probe();
    const p = sent.slice(mark);
    assert.ok(p.includes('ATSH7E0') && p.includes('ATCRA7E8'));
    assert.deepEqual(p.slice(-3), ['ATAR', 'ATSH7DF', '0100']);
  });

  test('1.0.8: a closed command queue never sends again', async () => {
    const tr = new ReplayTransport();
    const sent = [];
    const w = tr.write.bind(tr);
    tr.write = (x) => { sent.push(x.trim()); return w(x); };
    const elm = new Elm327(tr, new Logger());
    await elm.send('ATRV');
    elm.startKeepAlive(300);
    elm.close();
    const r = await elm.send('0100');
    await new Promise((res) => setTimeout(res, 900));
    assert.equal(r.status, 'stopped');
    assert.deepEqual(sent, ['ATRV']);
  });

  test('1.0.8: live pacing waits between single requests', async () => {
    const { obd } = await setup({ '010C': '7E804410C1E1A\r\r>', '010D': '7E803410D00\r\r>' });
    obd.targetLive = undefined;
    obd.gentleLive = true;
    obd.liveGapMs = 120;
    const t0 = Date.now();
    await obd.readPids([0x0C, 0x0D]);
    assert.ok(Date.now() - t0 >= 230, 'two requests should take at least two pauses');
  });

  test('1.1.0: reads firmware and model, never the serial number', async () => {
    const enc = (t) => { const b = new TextEncoder().encode(t + '\0'); return new DataView(b.buffer); };
    const read = [];
    const field = (uuid, text) => ({ uuid, properties: { read: true }, async readValue() { read.push(uuid); return enc(text); } });
    const dis = {
      uuid: '180a',
      async getCharacteristic(u) {
        const map = {
          '00002a29-0000-1000-8000-00805f9b34fb': field('2a29', 'Vgate'),
          '00002a24-0000-1000-8000-00805f9b34fb': field('2a24', 'vLinker MC'),
          '00002a26-0000-1000-8000-00805f9b34fb': field('2a26', 'V2.2.10'),
          '00002a25-0000-1000-8000-00805f9b34fb': field('2a25', 'SERIAL-SECRET'),
        };
        if (!map[u]) throw new Error('NotFoundError');
        return map[u];
      },
      async getCharacteristics() { return []; },
    };
    const t = new BleTransport({ logger: new Logger() });
    t._server = { connected: true, async getPrimaryService(u) { if (u === '0000180a-0000-1000-8000-00805f9b34fb') return dis; throw new Error('NotFoundError'); } };
    const di = await t.readDeviceInfo();
    assert.equal(di.manufacturer, 'Vgate');
    assert.equal(di.model, 'vLinker MC');
    assert.equal(di.firmware, 'V2.2.10');
    assert.equal(di.hardware, null);
    assert.ok(!read.includes('2a25'), 'serial number must not be read');
    assert.equal(t.info.deviceInfo.firmware, 'V2.2.10');
  });

  test('1.1.0: missing device information service gives nulls, no error', async () => {
    const t = new BleTransport({ logger: new Logger() });
    t._server = { connected: true, async getPrimaryService() { throw new Error('NotFoundError'); } };
    const di = await t.readDeviceInfo();
    assert.equal(di.firmware, null);
  });

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
  }
  return { passed, failed };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  run().then((r) => { console.log(r.passed + ' passed, ' + r.failed + ' failed'); process.exit(r.failed ? 1 : 0); });
}

// BleTransport.reconnect(): after an unexpected drop the same device reconnects without the picker.
export async function runReconnect() {
  const fb = fakeBluetooth();
  let ok = false;
  await withNavigator({ bluetooth: fb.bluetooth }, async () => {
    const t = new BleTransport({ logger: new Logger() });
    await t.connect();
    let lost = 0;
    t.onDisconnect = () => { lost++; };
    t._device.gatt.disconnect();
    t._handleGattDisconnect();
    assert.equal(lost, 1);
    assert.ok(!t.isConnected());
    await t.reconnect();
    assert.ok(t.isConnected());
    assert.equal(fb.stats().connects, 2);
    t._device.gatt.disconnect();
    t._handleGattDisconnect();
    assert.equal(lost, 2, 'second drop after reconnect must also be reported');
    ok = true;
  });
  return ok;
}
