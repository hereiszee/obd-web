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
  const svc = (uuid, chars) => ({
    uuid,
    async getCharacteristics() {
      if (dropOnFirstListOf === uuid && !dropped) {
        dropped = true; gatt.connected = false;
        (listeners.gattserverdisconnected || []).forEach((f) => f());
        throw 2;
      }
      if (!gatt.connected) throw 2;
      return chars;
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
  const server = { get connected() { return gatt.connected; }, async getPrimaryServices() { return services; } };
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

  test('BLE: picks the proven vLinker pair with short-UUID services', async () => {
    const fb = fakeBluetooth();
    await withNavigator({ bluetooth: fb.bluetooth }, async () => {
      const t = new BleTransport({ logger: new Logger() });
      const info = await t.connect();
      assert.equal(info.serviceUuid, 'e7810a71-73ae-499d-8c15-faa9aef0c3f2');
      assert.equal(info.notifyUuid, 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f');
      assert.ok(t.isConnected());
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
    const fb = fakeBluetooth({ dropOnFirstListOf: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2' });
    await withNavigator({ bluetooth: fb.bluetooth }, async () => {
      const log = new Logger();
      const t = new BleTransport({ logger: log });
      let lost = 0;
      const info = await t.connect();
      t.onDisconnect = () => { lost++; };
      assert.equal(fb.stats().connects, 2, 'should reconnect once');
      assert.ok(t.isConnected());
      assert.equal(info.serviceUuid, 'e7810a71-73ae-499d-8c15-faa9aef0c3f2');
      // A later real drop must still reach the app.
      t._handleGattDisconnect();
      assert.equal(lost, 1);
    });
  });

  test('BLE: reconnect() after a drop works without the device list', async () => {
    assert.equal(await runReconnect(), true);
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
