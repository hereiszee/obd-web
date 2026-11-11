// 1.2.0 Bluetooth profile and instrumentation tests: channel order, write mode, write
// serialisation, direct service path, drop handling, ring buffer, stall warning, adapter info gate.
// Run: node tests/ble.test.mjs
import assert from 'node:assert/strict';
import { Logger, describeUserAgent } from '../js/log.js';
import { Elm327 } from '../js/elm.js';
import { BleTransport, chooseWriteMode, normUuid, CHUNK, CANDIDATE_SERVICES } from '../js/ble.js';
import { AdapterInfoGate } from '../js/adapter-info.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = (o) => Object.assign({ read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false }, o);

// Fake Web Bluetooth with the vLinker MC-IOS layout (short UUIDs like Bluefy). Records every
// GATT call and every write, and how many writes were in flight at once.
function makeFake(opts = {}) {
  const calls = { getPrimaryService: [], getPrimaryServices: 0, connects: 0, starts: 0 };
  const writes = [];
  const state = { inFlight: 0, maxInFlight: 0, badViews: 0 };
  const devListeners = {};
  const fireDevice = (n) => (devListeners[n] || []).slice().forEach((f) => f({ type: n }));

  function chr(uuid, props) {
    const l = [];
    const c = {
      uuid, properties: props, value: null,
      addEventListener(n, f) { if (n === 'characteristicvaluechanged') l.push(f); },
      removeEventListener(n, f) { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); },
      listenerCount: () => l.length,
      async startNotifications() { calls.starts++; if (!gatt.connected) throw 2; },
      async stopNotifications() {},
      fire(text) {
        const b = new TextEncoder().encode(text);
        c.value = new DataView(b.buffer);
        l.slice().forEach((f) => f({ target: c }));
      },
    };
    const doWrite = async (data, mode) => {
      // Bluefy sends a view's whole underlying buffer, so every write must be an exact-size copy.
      const off = data.byteOffset || 0;
      if (off !== 0 || data.byteLength !== data.buffer.byteLength) {
        state.badViews++;
        throw new Error('write passed a view onto a larger buffer');
      }
      const entry = { uuid: normUuid(uuid), mode, bytes: Array.from(data), start: Date.now(), end: null };
      writes.push(entry);
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (opts.onWrite) await opts.onWrite(entry);
        else await sleep(1 + Math.floor(Math.random() * 6));
      } finally {
        state.inFlight--;
        entry.end = Date.now();
      }
    };
    if (props.write && opts.withResponseFn !== false) c.writeValueWithResponse = (d) => doWrite(d, 'withResponse');
    if (props.writeWithoutResponse) c.writeValueWithoutResponse = (d) => doWrite(d, 'withoutResponse');
    if (opts.legacyFn !== false) c.writeValue = (d) => doWrite(d, 'legacy');
    return c;
  }

  const svc = (uuid, chars) => ({
    uuid,
    async getCharacteristics() { if (!gatt.connected) throw 2; return chars; },
    async getCharacteristic(u) {
      if (!gatt.connected) throw 2;
      const c = chars.find((x) => normUuid(x.uuid) === normUuid(u));
      if (!c) throw new Error('NotFoundError');
      return c;
    },
  });
  const c2af0 = chr('2af0', P({ notify: true, indicate: true }));
  const c2af1 = chr('2af1', P(opts.writeProps || { write: true, writeWithoutResponse: true }));
  const cbef8 = chr('bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', P({ read: true, write: true, writeWithoutResponse: true, notify: true, indicate: true }));
  const services = [
    svc('18f0', [c2af0, c2af1]),
    svc('180a', [chr('2a29', P({ read: true }))]),
    svc('e7810a71-73ae-499d-8c15-faa9aef0c3f2', [cbef8]),
  ];
  const gatt = {
    connected: false,
    async connect() { calls.connects++; gatt.connected = true; return server; },
    disconnect() {
      if (!gatt.connected) return;
      gatt.connected = false;
      setTimeout(() => fireDevice('gattserverdisconnected'), 5);
    },
  };
  const server = {
    get connected() { return gatt.connected; },
    async getPrimaryServices() { calls.getPrimaryServices++; return services; },
    async getPrimaryService(u) {
      calls.getPrimaryService.push(normUuid(u));
      if (opts.directFails) throw new Error('NotFoundError');
      const s = services.find((x) => normUuid(x.uuid) === normUuid(u));
      if (!s) throw new Error('NotFoundError');
      return s;
    },
  };
  const device = {
    name: 'Test adapter', gatt,
    addEventListener(n, f) { (devListeners[n] = devListeners[n] || []).push(f); },
    removeEventListener(n, f) { devListeners[n] = (devListeners[n] || []).filter((g) => g !== f); },
  };
  return {
    calls, writes, state, device, gatt, chars: { c2af0, c2af1, cbef8 },
    // The link goes away without the browser saying so (yet).
    silentDrop() { gatt.connected = false; },
    fireDisconnect() { fireDevice('gattserverdisconnected'); },
    bluetooth: { async requestDevice() { return device; } },
  };
}

function withNavigator(nav, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  return Promise.resolve().then(fn).finally(() => {
    if (had) Object.defineProperty(globalThis, 'navigator', had); else delete globalThis.navigator;
  });
}

async function connected(fake, extra) {
  const log = new Logger();
  const t = new BleTransport(Object.assign({ logger: log }, extra || {}));
  await withNavigator({ bluetooth: fake.bluetooth }, () => t.connect());
  return { t, log };
}

const texts = (log, re) => log.entries().filter((e) => re.test(e.text));

export async function run() {
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);

  // ---------------------------------------------------------------- channel and write mode

  test('1.2.0: auto channel prefers 18F0 and opens it directly (no service walk)', async () => {
    const f = makeFake();
    const { t, log } = await connected(f);
    assert.equal(t.info.serviceUuid, '000018f0-0000-1000-8000-00805f9b34fb');
    assert.equal(t.info.notifyUuid, '00002af0-0000-1000-8000-00805f9b34fb');
    assert.equal(t.info.writeUuid, '00002af1-0000-1000-8000-00805f9b34fb');
    assert.equal(f.calls.getPrimaryServices, 0, 'no full walk');
    assert.deepEqual(f.calls.getPrimaryService, ['000018f0-0000-1000-8000-00805f9b34fb'], 'only 18F0 opened');
    assert.equal(f.calls.starts, 1, 'one notify subscription');
    assert.equal(f.chars.c2af0.listenerCount(), 1);
    assert.equal(f.chars.cbef8.listenerCount(), 0);
    assert.equal(texts(log, /^Using notify .*\(known pair, write mode with response\)$/).length, 1);
    await t.disconnect();
  });

  test('1.2.0: direct path failing falls back to the full walk', async () => {
    const f = makeFake({ directFails: true });
    const { t, log } = await connected(f);
    assert.ok(f.calls.getPrimaryServices >= 1, 'walk used');
    assert.equal(t.info.serviceUuid, '000018f0-0000-1000-8000-00805f9b34fb', 'walk still prefers 18F0');
    assert.ok(texts(log, /Discovering all services/).length === 1);
    assert.ok(texts(log, /^  Characteristic 2af1/).length >= 1, 'walk logs characteristics');
    await t.disconnect();
  });

  test('1.2.0: chooseWriteMode picks with response when possible, falls back when not', () => {
    const both = { writeValueWithResponse() {}, writeValueWithoutResponse() {}, writeValue() {} };
    const noWith = { writeValueWithoutResponse() {}, writeValue() {} };
    const onlyLegacy = { writeValue() {} };
    const pw = P({ write: true, writeWithoutResponse: true });
    assert.equal(chooseWriteMode('auto', pw, both), 'withResponse');
    assert.equal(chooseWriteMode('withResponse', pw, both), 'withResponse');
    assert.equal(chooseWriteMode('withoutResponse', pw, both), 'withoutResponse');
    assert.equal(chooseWriteMode('auto', pw, noWith), 'legacy', 'method missing: writeValue is next');
    assert.equal(chooseWriteMode('auto', pw, { writeValueWithoutResponse() {} }), 'withoutResponse', 'only without response left');
    assert.equal(chooseWriteMode('auto', P({ writeWithoutResponse: true }), both), 'withoutResponse', 'property missing');
    assert.equal(chooseWriteMode('auto', pw, onlyLegacy), 'legacy');
    assert.equal(chooseWriteMode('withoutResponse', P({ write: true }), both), 'withResponse');
    assert.equal(chooseWriteMode('auto', pw, both, true), 'withoutResponse', 'session downgrade remembered');
    assert.equal(chooseWriteMode('withResponse', pw, both, true), 'withResponse', 'explicit choice ignores the downgrade');
  });

  test('1.2.0: connect uses with response, falls back to writeValue, then without response', async () => {
    let f = makeFake();
    let r = await connected(f);
    await r.t.write('ATZ\r');
    assert.ok(f.writes.length && f.writes.every((w) => w.mode === 'withResponse'));
    assert.equal(texts(r.log, /^Write method writeValueWithResponse /).length, 1);
    await r.t.disconnect();

    f = makeFake({ withResponseFn: false });
    r = await connected(f);
    assert.equal(texts(r.log, /write mode browser default \(writeValue\)\)$/).length, 1);
    assert.equal(texts(r.log, /^Write method writeValue /).length, 1);
    await r.t.write('ATZ\r');
    assert.ok(f.writes.every((w) => w.mode === 'legacy'));
    await r.t.disconnect();

    f = makeFake({ withResponseFn: false, legacyFn: false });
    r = await connected(f);
    assert.equal(texts(r.log, /write mode without response\)$/).length, 1);
    await r.t.write('ATZ\r');
    assert.ok(f.writes.every((w) => w.mode === 'withoutResponse'));
    await r.t.disconnect();

    f = makeFake();
    r = await connected(f, { writeMode: 'withoutResponse' });
    await r.t.write('ATZ\r');
    assert.ok(f.writes.every((w) => w.mode === 'withoutResponse'), 'old behaviour can still be chosen');
    await r.t.disconnect();
  });

  // ---------------------------------------------------------------- write serialisation

  test('1.2.0: writes never overlap and are at most 20 bytes each', async () => {
    const f = makeFake();
    const { t } = await connected(f);
    const msgs = ['010C0D050F0411010C0D050F0411010C0D050F0411\r', 'ATRV\r', '\r', '0123456789ABCDEFGHI\r', '0123456789ABCDEFGHIJ\r', '0100\r'];
    await Promise.all(msgs.map((m) => t.write(m)));
    assert.equal(f.state.maxInFlight, 1, 'overlapping writes seen');
    assert.ok(f.writes.every((w) => w.bytes.length >= 1 && w.bytes.length <= CHUNK), 'chunk sizes: ' + f.writes.map((w) => w.bytes.length));
    const sent = String.fromCharCode(...f.writes.flatMap((w) => w.bytes));
    assert.equal(sent, msgs.join(''), 'bytes in order');
    for (let i = 1; i < f.writes.length; i++) assert.ok(f.writes[i].start >= f.writes[i - 1].end, 'write ' + i + ' started early');
    await t.disconnect();
  });

  test('1.2.0: a rejected write is a normal send error (Elm reports stopped)', async () => {
    const f = makeFake({ onWrite: async () => { await sleep(2); throw new Error('GATT operation failed'); } });
    const { t, log } = await connected(f, { writeMode: 'withResponse' });
    const elm = new Elm327(t, log);
    const r = await elm.send('ATRV', { timeout: 1000 });
    assert.equal(r.status, 'stopped');
    assert.match(r.message, /Could not send/);
    await t.disconnect();
  });

  test('1.2.0: an unconfirmed write fails after the timeout, and the next write waits for it', async () => {
    let release;
    let first = true;
    const f = makeFake({
      onWrite: async () => {
        if (first) { first = false; await new Promise((r) => { release = r; }); return; }
        await sleep(1);
      },
    });
    const { t } = await connected(f, { writeTimeoutMs: 80, writeMode: 'withResponse' });
    const t0 = Date.now();
    const p1 = t.write('ATRV\r');
    const p2 = t.write('0100\r');
    await assert.rejects(p1, /not confirmed/);
    assert.ok(Date.now() - t0 < 400, 'caller hears about it at the timeout');
    await sleep(150);
    assert.equal(f.writes.length, 1, 'second write must wait for the first to settle');
    release();
    await p2;
    assert.equal(f.writes.length, 2);
    assert.ok(f.writes[1].start >= f.writes[0].end);
    assert.equal(f.state.maxInFlight, 1);
    await t.disconnect();
  });

  test('1.2.0: a write queued before a drop never lands on the new link', async () => {
    const f = makeFake({ onWrite: () => sleep(20) });
    const { t } = await connected(f);
    const long = t.write('010C0D050F0411010C0D050F0411010C0D050F0411\r'); // 3 chunks
    await sleep(5);
    f.gatt.disconnect();
    await assert.rejects(long, /Not connected/);
    await t.reconnect();
    const n = f.writes.length;
    await sleep(80);
    assert.equal(f.writes.length, n, 'no stray chunks after reconnect');
    await t.disconnect();
  });

  test('1.2.0: every write is an exact-size copy (no views), including the CR interrupt', async () => {
    const f = makeFake();
    const { t, log } = await connected(f);
    await t.write('010C0D050F0411010C0D050F0411010C0D050F0411\r');
    await t.write('\r');
    const elm = new Elm327(t, log);
    f.chars.c2af0.fire('');
    const p = elm.send('ATRV', { timeout: 60 }); // times out, so Elm sends its CR interrupt
    await p;
    await sleep(120);
    assert.ok(f.writes.length >= 5);
    assert.equal(f.state.badViews, 0);
    await t.disconnect();
  });

  test('1.2.0: first acknowledged write rejecting with a bare number downgrades once and resends', async () => {
    const f = makeFake({ onWrite: async (w) => { await sleep(1); if (w.mode === 'withResponse') throw 2; } });
    const { t, log } = await connected(f);
    await t.write('ATZ\r');
    assert.deepEqual(f.writes.map((w) => w.mode), ['withResponse', 'withoutResponse'], 'one resend');
    const warn = texts(log, /^Acknowledged writes failed on this browser \(.*code 2.*\)\. Switching to writes without acknowledgement for this session\.$/);
    assert.equal(warn.length, 1);
    await t.write('ATE0\r');
    assert.equal(f.writes[2].mode, 'withoutResponse');
    // Remembered for reconnects in the same page session.
    f.gatt.disconnect();
    await sleep(20);
    await t.reconnect();
    assert.equal(texts(log, /write mode without response\)$/).length, 1, 'reconnect starts without acknowledgement');
    await t.write('0100\r');
    assert.equal(f.writes[f.writes.length - 1].mode, 'withoutResponse');
    await t.disconnect();
  });

  test('1.2.0: first acknowledged write hanging, then a drop: no downgrade, next link still acknowledged', async () => {
    const f = makeFake({ onWrite: () => new Promise(() => {}) }); // the adapter radio went silent
    const { t, log } = await connected(f, { writeTimeoutMs: 80, strikeWaitMs: 50 });
    let lost = 0;
    t.onDisconnect = () => { lost++; };
    setTimeout(() => f.gatt.disconnect(), 150); // the phone notices later
    await assert.rejects(t.write('ATZ\r'), /not confirmed within/);
    await sleep(200);
    assert.equal(lost, 1);
    assert.equal(f.writes.length, 1, 'no resend after a timeout');
    assert.equal(texts(log, /Switching to writes without acknowledgement/).length, 0);
    assert.ok(/with response$/.test(t.lastDrop.writeModeText));
    f.writes.length = 0;
    await t.reconnect();
    assert.equal(texts(log, /^Changed on this link: /).length, 0, 'next link is the same as before (still with response)');
    f.writes.length = 0;
    const w = t.write('ATE0\r');
    await sleep(5);
    assert.equal(f.writes[0].mode, 'withResponse');
    t.dropNow('test');
    await assert.rejects(w);
  });

  test('1.2.0: quick refusal followed by a drop within 300 ms does not downgrade', async () => {
    let n = 0;
    const f = makeFake({
      onWrite: async () => {
        n++;
        await sleep(1);
        if (n === 1) { setTimeout(() => f.gatt.disconnect(), 50); throw 2; }
      },
    });
    const { t, log } = await connected(f);
    await assert.rejects(t.write('ATZ\r'), /code 2/);
    await sleep(20);
    assert.deepEqual(f.writes.map((w) => w.mode), ['withResponse'], 'no resend');
    assert.equal(texts(log, /Switching to writes without acknowledgement/).length, 0);
    await t.reconnect();
    await t.write('ATE0\r');
    assert.equal(f.writes[f.writes.length - 1].mode, 'withResponse');
    await t.disconnect();
  });

  test('1.2.0: two "not confirmed but the adapter answered" strikes downgrade, one does not', async () => {
    const f = makeFake({
      onWrite: (w) => {
        if (w.mode === 'withoutResponse') return sleep(1);
        setTimeout(() => f.chars.c2af0.fire('OK\r\r>'), 5); // the adapter answers
        return new Promise(() => {});                        // the browser never confirms
      },
    });
    const { t, log } = await connected(f, { writeTimeoutMs: 60, strikeWaitMs: 40 });
    await t.write('ATE0\r');
    await sleep(160);
    assert.equal(texts(log, /\(1 of 2 before/).length, 1, 'one strike');
    assert.equal(texts(log, /Switching to writes without acknowledgement/).length, 0, 'one strike is not enough');
    await t.write('ATL0\r');
    await sleep(160);
    assert.equal(texts(log, /^The browser did not confirm writes that the adapter clearly received\. Switching to writes without acknowledgement for this session\.$/).length, 1);
    await t.write('ATS0\r');
    assert.equal(f.writes[f.writes.length - 1].mode, 'withoutResponse');
    f.gatt.disconnect();
    await sleep(20);
    assert.match(t.lastDrop.writeModeText, /^without response \(acknowledged writes switched off this session\)$/);
    await t.reconnect();
    assert.equal(texts(log, /^Changed on this link: Using notify .*write mode without response\)$/).length, 1, 'the downgrade shows in the log on reconnect');
    await t.disconnect();
  });

  test('1.2.0: a pending acknowledgement does not delay the next command once the reply arrived', async () => {
    let n = 0;
    const f = makeFake({
      onWrite: (w) => {
        n++;
        if (n === 1) {
          setTimeout(() => f.chars.c2af0.fire('14.2V\r\r>'), 10);
          return sleep(500).then(() => { throw 2; }); // late, and even fails: must not surface
        }
        setTimeout(() => f.chars.c2af0.fire('OK\r\r>'), 5);
        return sleep(1);
      },
    });
    const { t, log } = await connected(f, { writeTimeoutMs: 2000 });
    const elm = new Elm327(t, log);
    const t0 = Date.now();
    const r1 = await elm.send('ATRV');
    const r2 = await elm.send('ATE0');
    assert.equal(r1.status, 'ok');
    assert.equal(r2.status, 'ok');
    assert.ok(Date.now() - t0 < 300, 'took ' + (Date.now() - t0) + ' ms');
    assert.equal(texts(log, /replied before the browser confirmed the write/).length, 1);
    await sleep(600);
    assert.equal(texts(log, /Switching to writes without acknowledgement/).length, 0);
    await t.disconnect();
  });

  test('1.2.0: explicit withResponse never downgrades', async () => {
    const f = makeFake({ onWrite: async () => { await sleep(1); throw 2; } });
    const { t, log } = await connected(f, { writeMode: 'withResponse' });
    await assert.rejects(t.write('ATZ\r'), /code 2/);
    assert.deepEqual(f.writes.map((w) => w.mode), ['withResponse']);
    assert.equal(texts(log, /^Acknowledged writes failed/).length, 0);
    await t.disconnect();
  });

  test('1.2.0: optionalServices are full 128-bit UUID strings with no duplicates', () => {
    assert.equal(new Set(CANDIDATE_SERVICES).size, CANDIDATE_SERVICES.length);
    CANDIDATE_SERVICES.forEach((u) => {
      assert.equal(typeof u, 'string');
      assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.equal(u.length, 36);
    });
  });

  // ---------------------------------------------------------------- reconnect

  test('1.2.0: reconnect opens the last working pair directly, one listener only', async () => {
    const f = makeFake();
    const { t, log } = await connected(f, { prefer: 'e781' });
    assert.equal(t.info.serviceUuid, 'e7810a71-73ae-499d-8c15-faa9aef0c3f2');
    f.calls.getPrimaryService.length = 0;
    let lost = 0;
    t.onDisconnect = () => { lost++; };
    f.gatt.disconnect();
    await sleep(20);
    assert.equal(lost, 1);
    assert.equal(f.chars.cbef8.listenerCount(), 0, 'old listener removed on drop');
    await t.reconnect();
    assert.deepEqual(f.calls.getPrimaryService, ['e7810a71-73ae-499d-8c15-faa9aef0c3f2']);
    assert.equal(f.calls.getPrimaryServices, 0);
    assert.equal(f.chars.cbef8.listenerCount(), 1, 'exactly one listener after reconnect');
    let got = '';
    t.onData = (s) => { got += s; };
    f.chars.cbef8.fire('OK\r\r>');
    assert.equal(got, 'OK\r\r>', 'data delivered once');
    assert.equal(texts(log, /^Using notify /).length, 1, 'reconnect is quiet when nothing changed');
    assert.equal(texts(log, /^Notifications started/).length, 1);
    assert.equal(texts(log, /Reconnecting to/).length, 0);
    assert.equal(t.sessionStats().links, 2);
    await t.disconnect();
  });

  // ---------------------------------------------------------------- drop instrumentation

  test('1.3.0: unexpected drop logs one line of last data plus the partial reply', async () => {
    const f = makeFake();
    const { t, log } = await connected(f);
    await t.write('0100\r');
    for (let i = 0; i < 15; i++) f.chars.c2af0.fire('7E8 line ' + i + '\r');
    f.chars.c2af0.fire('>');
    f.chars.c2af0.fire('7E80641\r7E8');
    f.gatt.disconnect();
    await sleep(20);
    const dump = texts(log, /^Last data before the drop: /);
    assert.equal(dump.length, 1);
    assert.match(dump[0].text, /^Last data before the drop: 11 bytes at \d+\.\d{3} s, ending "….{24}"$/);
    assert.ok(dump[0].text.endsWith('⏎>7E80641⏎7E8"'), dump[0].text);
    const partial = texts(log, /^Partial reply at the drop: /);
    assert.equal(partial.length, 1);
    assert.equal(partial[0].text, 'Partial reply at the drop: "7E80641⏎7E8"');
    assert.equal(texts(log, /^Adapter connection lost/).length, 0, 'the app describes the drop in one line');
    const d = t.lastDrop;
    assert.equal(d.channel, '18f0');
    assert.equal(d.writeModeText, 'with response');
    assert.equal(d.commands, 1);
    assert.ok(d.rxBytes > 100);
    assert.ok(d.secondsSinceLastRx >= 0 && d.secondsSinceLastRx < 1);
    assert.ok(d.secondsSinceConnect >= 0);
  });

  test('1.3.0: fast stall closes the link itself: drop handled once, late browser event ignored', async () => {
    const f = makeFake();
    const { t, log } = await connected(f);
    let lost = 0;
    let reason = '';
    t.onDisconnect = (r) => { lost++; reason = r; };
    let gattDisconnects = 0;
    const orig = f.gatt.disconnect;
    f.gatt.disconnect = () => { gattDisconnects++; orig(); };
    assert.equal(t.dropNow('no data for 0.7 s'), true);
    assert.equal(t.dropNow('again'), false, 'only once');
    assert.equal(lost, 1);
    assert.equal(gattDisconnects, 1, 'the link is closed by us');
    assert.ok(!/^Disconnected\.$/.test(reason), 'reported as an unexpected drop, not a user disconnect');
    assert.equal(t._userDisconnect, false);
    await t.reconnect(); // starts at once, before the browser's event for the old link arrives
    await sleep(40);
    assert.equal(lost, 1, 'the late event for the old link changed nothing');
    assert.ok(t.isConnected(), 'the new link is still up');
    assert.equal(texts(log, /already handled/).length, 0, 'our own close is not logged as late');
    await t.disconnect();
  });

  test('1.3.0: radio trace is per link and uses the log clock', async () => {
    const f = makeFake();
    const { t, log } = await connected(f);
    f.chars.c2af0.fire('OK\r\r>');
    const mark = log.log('info', 'mark');
    const tr = t.radioTrace();
    assert.equal(tr.length, 1);
    assert.ok(Math.abs(tr[0].t * 1000 - mark.t) < 20, 'ring ' + tr[0].t + ' s vs log ' + mark.t + ' ms');
    f.gatt.disconnect();
    await sleep(20);
    await t.reconnect();
    assert.equal(t.radioTrace().length, 0, 'cleared when the new link opened');
    t.dropNow('test');
    assert.equal(texts(log, /^Last data before the drop: nothing was received on this link\.$/).length, 1);
    await sleep(20);
  });

  test('1.2.0: user disconnect does not dump the ring buffer', async () => {
    const f = makeFake();
    const { t, log } = await connected(f);
    f.chars.c2af0.fire('12.6V\r\r>');
    f.chars.c2af0.fire('7E8');
    let lost = 0;
    t.onDisconnect = () => { lost++; };
    await t.disconnect();
    await sleep(20);
    assert.equal(lost, 1);
    assert.equal(texts(log, /^Last data before the drop|^Partial reply at the drop/).length, 0);
  });

  test('1.2.0: polling and the disconnect event together run the drop handling once', async () => {
    const f = makeFake();
    const { t, log } = await connected(f, { pollMs: 20 });
    let lost = 0;
    t.onDisconnect = () => { lost++; };
    f.silentDrop();
    await sleep(120);
    assert.equal(lost, 0, 'waits for the event');
    f.fireDisconnect();
    f.fireDisconnect();
    await sleep(10);
    assert.equal(lost, 1);
    assert.equal(texts(log, /^Link reported closed by polling, \d+ ms before the browser's disconnect event\.$/).length, 1);
    assert.equal(texts(log, /^Last data before the drop/).length, 1, 'one dump (nothing received)');
    assert.equal(t.sessionStats().drops, 1);
  });

  test('1.2.0: polling handles a drop once when the event never comes, late event ignored', async () => {
    const f = makeFake();
    const { t, log } = await connected(f, { pollMs: 20, eventWaitMs: 100 });
    let lost = 0;
    t.onDisconnect = () => { lost++; };
    f.silentDrop();
    await sleep(250);
    assert.equal(lost, 1);
    assert.equal(texts(log, /did not come within 0\.1 s/).length, 1);
    f.fireDisconnect();
    await sleep(10);
    assert.equal(lost, 1, 'late event must not report again');
    assert.equal(texts(log, /arrived \d+ ms after polling saw the link close \(already handled\)/).length, 1);
    assert.equal(t.sessionStats().drops, 1);
  });

  // ---------------------------------------------------------------- stall warning

  test('1.2.0: stall warning once per stall, with a follow-up when data arrives', async () => {
    const log = new Logger();
    const tr = {
      name: 'stub', onData: null, onDisconnect: null, info: {},
      isConnected: () => true,
      async write() {
        setTimeout(() => this.onData('41'), 5);
        setTimeout(() => this.onData('00BE1FA813\r\r>'), 450);
      },
    };
    const elm = new Elm327(tr, log);
    elm.stallMs = 150;
    const r = await elm.send('0100', { timeout: 2000 });
    assert.equal(r.status, 'ok');
    const warn = log.entries().filter((e) => e.kind === 'warn' && /^Adapter stalled for \d+\.\d s/.test(e.text));
    assert.equal(warn.length, 1, 'one warning: ' + warn.map((e) => e.text));
    assert.equal(texts(log, /^Adapter data resumed after a stall of \d+\.\d s \(reply to 0100\)\.$/).length, 1);
    // A quick reply produces no warning.
    const r2 = await new Elm327({ ...tr, onData: null, async write() { setTimeout(() => this.onData('OK\r\r>'), 5); } }, log).send('ATE0');
    assert.equal(r2.status, 'ok');
    assert.equal(log.entries().filter((e) => /^Adapter stalled/.test(e.text)).length, 1);
  });

  // ---------------------------------------------------------------- adapter info gate

  function gateCtx(over) {
    const reads = { n: 0 };
    const born = Date.now();
    const ctx = Object.assign({
      transport: { async readDeviceInfo() { reads.n++; return { firmware: 'V1' }; } },
      deviceName: 'Test adapter',
      linkAgeMs: () => Date.now() - born,
      isHealthy: () => true,
      isLive: () => false,
      readyToRead: () => true,
      sameLink: () => true,
      done: [],
    }, over || {});
    ctx.onDone = (di) => ctx.done.push(di);
    return { ctx, reads };
  }

  test('1.3.0: adapter info is read once the link has been up long enough, then cached', async () => {
    const gate = new AdapterInfoGate({ linkUpMs: 80, checkMs: 10 });
    const { ctx, reads } = gateCtx();
    assert.equal(gate.arm(ctx), true);
    await sleep(30);
    assert.equal(reads.n, 0, 'not before the link is old enough');
    await sleep(150);
    assert.equal(reads.n, 1);
    assert.equal(gate.get('Test adapter').firmware, 'V1');
    assert.equal(gate.arm(gateCtx().ctx), false, 'never armed again after a successful read');
    const again = await gate.readNow({ transport: ctx.transport, deviceName: 'Test adapter' });
    assert.equal(again.firmware, 'V1');
    assert.equal(reads.n, 1, 'probe reuses the cache');
  });

  test('1.3.0: adapter info waits for live data and a free queue, retries after an interrupted read', async () => {
    const g2 = new AdapterInfoGate({ linkUpMs: 30, checkMs: 10 });
    let live = true;
    let pending = true;
    const b = gateCtx({ isLive: () => live, readyToRead: () => !pending });
    g2.arm(b.ctx);
    await sleep(120);
    assert.equal(b.reads.n, 0, 'postponed while live data runs');
    live = false;
    await sleep(60);
    assert.equal(b.reads.n, 0, 'waits while a command is pending');
    pending = false;
    await sleep(60);
    assert.equal(b.reads.n, 1, 'read once the queue is free');

    // A drop during the read: nothing is kept and a later link tries again.
    const g3 = new AdapterInfoGate({ linkUpMs: 20, checkMs: 10 });
    const c = gateCtx({ sameLink: () => false });
    g3.arm(c.ctx);
    await sleep(80);
    assert.equal(c.reads.n, 1);
    assert.equal(g3.get('Test adapter'), null, 'interrupted read is not cached');
    const d = gateCtx();
    assert.equal(g3.arm(d.ctx), true, 'armed again on the next link');
    await sleep(80);
    assert.equal(d.reads.n, 1);
    assert.equal(g3.get('Test adapter').firmware, 'V1');

    // A young link that drops before the read is cancelled.
    const g4 = new AdapterInfoGate({ linkUpMs: 50, checkMs: 10 });
    const e = gateCtx();
    g4.arm(e.ctx);
    await sleep(20);
    g4.cancel();
    await sleep(100);
    assert.equal(e.reads.n, 0, 'a drop cancels the read');
  });

  test('1.2.0: browser line parsed from the user agent', () => {
    assert.equal(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Bluefy/3.5.1'), 'Bluefy 3.5.1 on iOS 18.6');
    assert.equal(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'), 'Chrome 131.0.0.0 on Windows NT 10.0');
    assert.equal(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'), 'iOS app browser (WebKit, name not in user agent) on iOS 17.4');
    assert.equal(describeUserAgent('something odd'), null);
    assert.equal(describeUserAgent(''), null);
  });

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
  }
  await sleep(50);
  process.off('unhandledRejection', onUnhandled);
  if (unhandled) { failed++; console.log('FAIL no unhandled promise rejections (' + unhandled + ' seen)'); }
  else { passed++; console.log('ok   no unhandled promise rejections'); }
  return { passed, failed };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  run().then((r) => { console.log(r.passed + ' passed, ' + r.failed + ' failed'); process.exit(r.failed ? 1 : 0); });
}
