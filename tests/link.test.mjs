// 1.3.0 "ride through the drops": fast stall classes, held commands, transparent resend,
// clear codes safety, header safety, live data across drops, flaky simulator.
// Run: node tests/link.test.mjs
import assert from 'node:assert/strict';
import { Logger } from '../js/log.js';
import { Elm327, fastStallMs, isIdempotent } from '../js/elm.js';
import { Obd } from '../js/obd.js';
import { LinkKeeper, replyLooksResumed, SETTLE_RECONNECT_MS, SETTLE_FIRST_MS, HOLD_MS } from '../js/link.js';
import { SimTransport } from '../js/sim.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s).replace(/\s+/g, '').toUpperCase();

const BASE = {
  ATWS: '\r\rELM327 v2.2\r\r>', ATZ: '\r\rELM327 v2.2\r\r>',
  ATL0: 'OK\r\r>', ATS0: 'OK\r\r>', ATH1: 'OK\r\r>', ATAT1: 'OK\r\r>', ATSP0: 'OK\r\r>',
  ATRV: '12.6V\r\r>', ATDPN: 'A6\r\r>', ATDP: 'AUTO, ISO 15765-4 (CAN 11/500)\r\r>',
  ATSH7DF: 'OK\r\r>', ATSH7E0: 'OK\r\r>',
  '0100': '7E8064100BE3FA813\r\r>',
  '010C': '7E804410C1AF8\r\r>', '010D': '7E803410D20\r\r>', '0105': '7E80341057B\r\r>',
  '0101': '7E80641010007A100\r\r>', '03': '7E8024300\r\r>', '04': '7E80144\r\r>',
};

// A scripted adapter with a link that can drop. The adapter keeps its settings across drops
// unless a test sets echo back on (a reset). Records every command with its link number and time.
class FakeAdapter {
  constructor(o = {}) {
    this.name = 'fake'; this.onData = null; this.onDisconnect = null; this.info = {};
    this.connected = true; this.link = 0; this.sent = []; this.echo = false;
    this.replies = Object.assign({}, BASE, o.replies || {});
    this.dropOn = o.dropOn || (() => false);       // (cmd, self) => true: go silent and drop 30 ms later
    this.silentOn = o.silentOn || (() => false);   // (cmd, self) => true: go silent, never drop by itself
    this.reconnectMs = o.reconnectMs != null ? o.reconnectMs : 20;
    this.failReconnects = o.failReconnects || 0;
    this.neverReconnect = !!o.neverReconnect;
    this.reconnectedAt = null;
  }
  isConnected() { return this.connected; }
  async write(text) {
    if (!this.connected) throw new Error('not connected');
    const cmd = norm(text);
    if (!cmd) return;
    this.sent.push({ cmd, link: this.link, at: Date.now() });
    if (this.dropOn(cmd, this)) { setTimeout(() => this.drop(), 30); return; }
    if (this.silentOn(cmd, this)) return;
    let r = this.replies[cmd];
    if (r === undefined) r = '?\r\r>';
    if (typeof r === 'function') r = r(this);
    if (cmd === 'ATE0') { this.echo = false; r = 'OK\r\r>'; } else if (this.echo) r = text.replace(/\r$/, '') + '\r' + r;
    const link = this.link;
    setTimeout(() => { if (this.connected && this.link === link && this.onData) this.onData(r); }, 3);
  }
  drop() { if (!this.connected) return; this.connected = false; if (this.onDisconnect) this.onDisconnect('lost'); }
  dropNow() { if (!this.connected) return false; this.drops = (this.drops || 0) + 1; this.drop(); return true; }
  async reconnect() {
    await sleep(this.reconnectMs);
    if (this.neverReconnect) throw new Error('the adapter is not advertising');
    if (this.failReconnects > 0) { this.failReconnects--; throw new Error('connect failed'); }
    this.link++; this.connected = true; this.reconnectedAt = Date.now();
    return this.info;
  }
  after(link) { return this.sent.filter((s) => s.link >= link).map((s) => s.cmd); }
}

function stack(fake, o = {}) {
  const log = new Logger();
  const elm = new Elm327(fake, log);
  const obd = new Obd(elm);
  obd.protocolNumber = '6';
  elm.protocolNumber = '6';
  const keeper = new LinkKeeper(Object.assign({ transport: fake, elm, obd, logger: log }, o));
  fake.onDisconnect = () => keeper.handleDrop('test');
  return { log, elm, obd, keeper };
}

const texts = (log, re) => log.entries().filter((e) => re.test(e.text));

export async function run() {
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });

  test('1.3.0: fast stall thresholds and exemptions', () => {
    assert.equal(fastStallMs('010C'), 700);
    assert.equal(fastStallMs('01 0D'), 700);
    assert.equal(fastStallMs('ATRV'), 700);
    assert.equal(fastStallMs('ATSH 7DF'), 1500);
    assert.equal(fastStallMs('010C0D'), 1500, 'multi PID request');
    assert.equal(fastStallMs('0101'), 700);
    assert.equal(fastStallMs('020200'), 1500);
    for (const c of ['ATZ', 'ATWS', '03', '07', '0A', '04', '0902', '0904']) assert.equal(fastStallMs(c), null, c);
    assert.equal(fastStallMs('0100', { afterProtocolSet: true }), null, 'first 0100 after a protocol search');
    assert.equal(fastStallMs('0100'), 700);
    assert.equal(fastStallMs('0101', { timeout: 6000 }), null, 'explicit long timeout');
    assert.equal(fastStallMs('0101', { timeout: 2500 }), 700);
    assert.equal(isIdempotent('04'), false);
    assert.equal(isIdempotent('03'), true);
    assert.equal(SETTLE_RECONNECT_MS, 300);
    assert.equal(SETTLE_FIRST_MS, 2000);
    assert.equal(HOLD_MS, 12000);
  });

  test('1.3.0: fast stall closes a quiet link once and the command rides through', async () => {
    let n = 0;
    const fake = new FakeAdapter({ silentOn: (c) => c === '010C' && ++n === 1 });
    const { elm, log, keeper } = stack(fake);
    elm.fastStall = true;
    assert.equal((await elm.send('ATRV')).status, 'ok'); // a complete reply first
    const t0 = Date.now();
    const r = await elm.send('010C');
    assert.equal(r.status, 'ok', r.message);
    assert.equal(fake.drops, 1, 'one internal drop');
    assert.equal(keeper.drops, 1);
    assert.equal(texts(log, /^No data for 0\.7 s\. Reconnecting without waiting for the phone to notice\.$/).length, 1);
    assert.ok(Date.now() - t0 < 2000, 'recovered in ' + (Date.now() - t0) + ' ms');
    assert.equal(texts(log, /^Adapter stalled/).length, 0, 'fast stall replaces the slow stall warning');
  });

  test('1.3.0: no fast stall before the first complete reply, nor for exempt commands', async () => {
    const fake = new FakeAdapter({ replies: { '03': (f) => { return undefined; } }, silentOn: (c) => c === '03' });
    const { elm } = stack(fake);
    elm.fastStall = true;
    elm.stallMs = 5000;
    assert.equal((await elm.send('ATRV')).status, 'ok');
    const p = elm.send('03', { timeout: 1200 });
    const r = await p;
    assert.equal(r.status, 'timeout', 'a slow 03 is waited for, not treated as a dead link');
    assert.equal(fake.drops || 0, 0);
  });

  test('1.3.0: reconnect uses the short settle, no 0100 check, and resends the interrupted command', async () => {
    let n = 0;
    const fake = new FakeAdapter({ dropOn: (c) => c === '010C' && ++n === 1 });
    const { elm, log, keeper } = stack(fake);
    const r = await elm.send('010C');
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.lines, ['7E804410C1AF8']);
    assert.deepEqual(fake.after(1), ['010C'], 'only the interrupted command after the reconnect');
    const first = fake.sent.find((s) => s.link === 1);
    assert.ok(first.at - fake.reconnectedAt >= SETTLE_RECONNECT_MS - 10, 'settle ' + (first.at - fake.reconnectedAt));
    assert.ok(first.at - fake.reconnectedAt < SETTLE_RECONNECT_MS + 200);
    await sleep(20); // the caller gets its reply a moment before the summary line is written
    const rec = texts(log, /^Reconnected in \d+\.\d s \(link 2, drop 1\)\. Average link life \d+\.\d s\.$/);
    assert.equal(rec.length, 1);
    assert.equal(texts(log, /^Link dropped \(test\)\. Reconnecting\.$/).length, 1);
    assert.ok(keeper.lastRecoverMs > 0);
  });

  test('1.3.0: with nothing interrupted, ATRV is the check after a reconnect', async () => {
    const fake = new FakeAdapter();
    const { elm } = stack(fake);
    await elm.send('ATRV');
    fake.drop();
    await sleep(500);
    assert.deepEqual(fake.after(1), ['ATRV']);
    assert.equal((await elm.send('010D')).status, 'ok');
  });

  test('1.3.0: an echo after the reconnect means a reset: full setup, then the command', async () => {
    let n = 0;
    const fake = new FakeAdapter({ dropOn: (c, f) => { if (c === '0105' && ++n === 1) { f.echo = true; return true; } return false; } });
    const { elm, log } = stack(fake);
    const r = await elm.send('0105');
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.lines, ['7E80341057B']);
    const after = fake.after(1);
    assert.equal(after[0], '0105', 'first the interrupted command');
    assert.ok(after.includes('ATWS') && after.includes('ATE0'), 'then the full setup: ' + after.join(' '));
    assert.equal(after[after.length - 1], '0105', 'then the command again');
    assert.equal(texts(log, /^The adapter lost its settings during the drop \(the command was echoed back\)\. Setting it up again\.$/).length, 1);
    assert.equal(replyLooksResumed('010C', { raw: '7E8 04 41 0C 1A F8\r', lines: ['7E8 04 41 0C 1A F8'] }, '6'), 'the reply has spaces');
    assert.equal(replyLooksResumed('010C', { raw: '410C1AF8\r', lines: ['410C1AF8'] }, '6'), 'the reply has no header');
    assert.equal(replyLooksResumed('010C', { raw: '7E804410C1AF8\r', lines: ['7E804410C1AF8'] }, 'A6'), null);
    assert.equal(replyLooksResumed('ATRV', { raw: 'ATRV\r12.6V\r', lines: ['12.6V'] }, '6'), 'the command was echoed back');
  });

  test('1.3.0: queue order is kept across a drop', async () => {
    let n = 0;
    const fake = new FakeAdapter({ dropOn: (c) => c === '010C' && ++n === 1 });
    const { elm } = stack(fake);
    const ps = ['010C', '010D', '0105', '0101'].map((c) => elm.send(c));
    const rs = await Promise.all(ps);
    rs.forEach((r) => assert.equal(r.status, 'ok', r.cmd));
    assert.deepEqual(fake.after(1), ['010C', '010D', '0105', '0101']);
  });

  test('1.3.0: a command is retried at most twice across drops', async () => {
    const fake = new FakeAdapter({ dropOn: (c) => c === '010C' });
    const { elm } = stack(fake);
    const p1 = elm.send('010C');
    const p2 = elm.send('010D');
    const r1 = await p1;
    assert.equal(r1.status, 'stopped');
    assert.equal(fake.sent.filter((s) => s.cmd === '010C').length, 3, 'sent once plus two retries');
    const r2 = await p2;
    assert.equal(r2.status, 'ok', 'the queue carries on');
  });

  test('1.3.0: waiting commands fail when the hold time runs out', async () => {
    const fake = new FakeAdapter({ dropOn: (c) => c === '010C', reconnectMs: 30 });
    const { elm, log } = stack(fake, { holdMs: 300, delays: [0, 200, 200, 200] });
    fake.neverReconnect = true;
    const t0 = Date.now();
    const rs = await Promise.all([elm.send('010C'), elm.send('010D')]);
    rs.forEach((r) => assert.equal(r.status, 'stopped'));
    assert.match(rs[0].message, /did not come back in time/);
    assert.ok(Date.now() - t0 < 900);
    assert.equal(texts(log, /^Waited 0 s for the adapter|^Waited \d+ s for the adapter to come back\. 2 waiting request\(s\) failed\.$/).length, 1);
    await sleep(800);
    assert.equal(texts(log, /^Could not reconnect after 4 tries\.$/).length, 1);
  });

  test('1.3.0: a reconnect that fails once, or takes long, is retried and recovers', async () => {
    let n = 0;
    const fake = new FakeAdapter({ dropOn: (c) => c === '010C' && ++n === 1, failReconnects: 1, reconnectMs: 400 });
    const { elm, log } = stack(fake, { delays: [0, 100, 100] });
    const r = await elm.send('010C');
    assert.equal(r.status, 'ok');
    await sleep(20);
    assert.equal(texts(log, /^Reconnect try 1 of 3 failed: connect failed$/).length, 1);
    assert.equal(texts(log, /^Reconnected in /).length, 1);
  });

  test('1.3.0: clear codes (04) in flight at a drop fails with "result unknown" and is never resent', async () => {
    const fake = new FakeAdapter({ dropOn: (c) => c === '04' });
    const { elm, obd } = stack(fake);
    const res = await obd.clearDtcs();
    assert.equal(res.ok, false);
    assert.match(res.message, /result is unknown/);
    assert.match(res.message, /Read the trouble codes again/);
    await sleep(500);
    assert.equal(fake.sent.filter((s) => s.cmd === '04').length, 1, 'the adapter saw 04 only once');
    assert.equal((await elm.send('010D')).status, 'ok', 'the link came back for other requests');
  });

  test('1.3.0: clear codes (04) queued at a drop fails and is never sent', async () => {
    let n = 0;
    const fake = new FakeAdapter({ dropOn: (c) => c === '010C' && ++n === 1 });
    const { elm } = stack(fake);
    const p1 = elm.send('010C');
    const p2 = elm.send('04');
    const p3 = elm.send('010D');
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(r1.status, 'ok');
    assert.equal(r2.status, 'stopped');
    assert.match(r2.message, /result is unknown/);
    assert.equal(r3.status, 'ok');
    assert.equal(fake.sent.filter((s) => s.cmd === '04').length, 0);
    assert.equal((await elm.send('04', { idempotent: true })).status, 'ok', 'explicit flag is honoured');
  });

  test('1.3.0: header is unknown after a reconnect, and broadcast is refused until 7DF is confirmed', async () => {
    let n = 0;
    const fake = new FakeAdapter({ dropOn: (c) => c === '010C' && ++n === 1 });
    const { elm, obd } = stack(fake);
    const r = await obd.query('010C');
    assert.equal(r.status, 'ok');
    assert.equal(obd._header, 'unknown', 'unknown until confirmed');
    fake.replies.ATSH7DF = '?\r\r>';
    const mark = fake.sent.length;
    const c = await obd.clearDtcs();
    assert.equal(c.ok, false);
    const sent = fake.sent.slice(mark).map((s) => s.cmd);
    assert.ok(!sent.includes('04'), '04 must not be sent: ' + sent.join(' '));
    assert.deepEqual(sent, ['ATSH7DF', 'ATSH7DF']);
    fake.replies.ATSH7DF = 'OK\r\r>';
    const q = await obd.query('0101');
    assert.equal(q.status, 'ok');
    assert.equal(obd._header, '7DF');
    assert.equal(elm.isHeld(), false);
  });

  test('1.3.0: a request addressed to one module is re-addressed before it is resent', async () => {
    let n = 0;
    const fake = new FakeAdapter({ dropOn: (c) => c === '010C' && ++n === 1 });
    const { obd } = stack(fake);
    const r = await obd.query('010C', { header: '7E0' });
    assert.equal(r.status, 'ok');
    assert.deepEqual(fake.after(1), ['ATSH7E0', '010C']);
    assert.equal(obd._header, '7E0');
  });

  test('1.3.0: live readings ride through a drop without errors', async () => {
    let n = 0;
    const fake = new FakeAdapter({ dropOn: (c) => c === '010D' && ++n === 2 });
    const { obd, log, keeper } = stack(fake);
    obd.gentleLive = true;
    let rounds = 0;
    const bad = [];
    const stopAt = Date.now() + 1500;
    while (Date.now() < stopAt) {
      const res = await obd.readPids([0x0C, 0x0D]);
      res.forEach((x) => { if (x.status !== 'ok') bad.push(x.pid + ' ' + x.status); });
      rounds++;
    }
    assert.equal(keeper.drops, 1);
    assert.deepEqual(bad, [], 'no failed readings');
    assert.ok(rounds > 5);
    assert.equal(texts(log, /Live data (stopped|started)|Cancelled/).length, 0);
  });

  test('1.3.0: flaky simulator recovers repeatedly without user action', async () => {
    const t = new SimTransport({ scenario: 'flaky', seed: 3, noDataRate: 0, flakyMinMs: 1200, flakyMaxMs: 2000, noticeMs: 3000 });
    t.flaky = false; // a steady link while the adapter is set up (a search is exempt from fast stall)
    await t.connect();
    const log = new Logger();
    const elm = new Elm327(t, log);
    const obd = new Obd(elm);
    const keeper = new LinkKeeper({ transport: t, elm, obd, logger: log });
    t.onDisconnect = () => keeper.handleDrop('simulated');
    elm.fastStall = true;
    const init = await elm.init();
    assert.equal(init.ok, true, init.message);
    obd.protocolNumber = init.protocolNumber;
    obd.gentleLive = true;
    t.flaky = true;
    t._armFlaky();
    const bad = [];
    const stopAt = Date.now() + 9000;
    while (Date.now() < stopAt && keeper.recoveries < 3) {
      const res = await obd.readPids([0x0C, 0x0D, 0x05]);
      res.forEach((x) => { if (x.status !== 'ok') bad.push(x.pid + ' ' + x.status); });
    }
    keeper.abort(); // as a user disconnect does
    await t.disconnect();
    assert.ok(keeper.recoveries >= 2, 'recoveries: ' + keeper.recoveries);
    assert.deepEqual(bad, []);
    const avg = keeper.averageRecoverS();
    console.log('     flaky simulator: ' + keeper.recoveries + ' recoveries, last byte to first good reply ' + avg.toFixed(2) + ' s on average');
    assert.ok(avg < 2.0, 'average recovery ' + avg);
    assert.equal(texts(log, /^No data for 0\.7 s/).length, keeper.drops, 'every drop was caught by the fast stall');
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
