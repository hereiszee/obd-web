// Test runner: node tests/run.mjs
// 1. Runs every tests/*.test.mjs file that exports run().
// 2. Runs an end-to-end test: Elm327 + Obd over SimTransport for all three scenarios.
// 3. Checks every module parses, and that no user-facing file contains em or en dashes.
// No dependencies. Exit code 1 on any failure.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const jsUrl = (f) => pathToFileURL(join(root, 'js', f)).href;

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log('ok   ' + name + ' (' + (Date.now() - t0) + ' ms)');
  } catch (e) {
    failed++;
    failures.push(name);
    console.log('FAIL ' + name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     '));
  }
}

// ---------------------------------------------------------------- unit test files

async function runTestFiles() {
  const files = readdirSync(here).filter((f) => /\.test\.mjs$/.test(f)).sort();
  for (const f of files) {
    console.log('\n== ' + f);
    const mod = await import(pathToFileURL(join(here, f)).href);
    if (typeof mod.run !== 'function') {
      failed++;
      failures.push(f + ' (no run export)');
      console.log('FAIL ' + f + ' does not export run()');
      continue;
    }
    const r = await mod.run();
    if (r && r.skipped) {
      failed++;
      failures.push(f + ' (skipped)');
      console.log('FAIL ' + f + ' was skipped, a module is missing');
      continue;
    }
    passed += (r && r.passed) || 0;
    failed += (r && r.failed) || 0;
    if (r && r.failed) failures.push(f + ' (' + r.failed + ' failed)');
  }
}

// ---------------------------------------------------------------- module syntax / import check

async function runImportChecks() {
  console.log('\n== module import checks');
  // Modules that must load in node without any browser globals.
  const pure = ['log.js', 'elm.js', 'obd.js', 'pids.js', 'dtc-db.js', 'sim.js', 'report.js', 'ui-text.js', 'ble.js'];
  for (const f of pure) {
    await test('import js/' + f, async () => {
      const m = await import(jsUrl(f));
      assert.ok(Object.keys(m).length > 0, 'no exports');
    });
  }
  // app.js touches the DOM at load time, so only check that it parses.
  await test('parse js/app.js', async () => {
    const vm = await import('node:vm');
    const src = readFileSync(join(root, 'js', 'app.js'), 'utf8');
    if (typeof vm.SourceTextModule === 'function') {
      // eslint-disable-next-line no-new
      new vm.SourceTextModule(src);
    } else {
      // Strip import/export lines and check the rest compiles as a function body.
      const body = src.replace(/^\s*import[^;]*;\s*$/gm, '').replace(/^\s*export\s+(default\s+)?/gm, '');
      // eslint-disable-next-line no-new-func
      new Function(body);
    }
  });
  await test('all local imports carry the same ?v= version stamp', () => {
    const stamps = new Set();
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="(?:js|css)\/[^"]*\?v=([^"]+)"/g)) stamps.add(m[1]);
    for (const f of readdirSync(join(root, 'js')).filter((x) => x.endsWith('.js'))) {
      const src = readFileSync(join(root, 'js', f), 'utf8');
      for (const m of src.matchAll(/from '\.\/[^']+'/g)) {
        const v = /\?v=([^']+)'/.exec(m[0]);
        assert.ok(v, f + ' has an unversioned import: ' + m[0] + ' (run sh tools/bump-version.sh)');
        stamps.add(v[1]);
      }
    }
    const app = readFileSync(join(root, 'js', 'app.js'), 'utf8');
    stamps.add((/APP_VERSION = '([^']+)'/.exec(app) || [])[1]);
    assert.equal(stamps.size, 1, 'mixed version stamps: ' + [...stamps].join(', '));
  });
  await test('index.html references existing files', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const refs = [];
    html.replace(/(?:src|href)="([^"#:]+)"/g, (m, p) => { refs.push(p.replace(/\?.*$/, '')); return m; });
    assert.ok(refs.some((r) => /js\/app\.js$/.test(r)), 'index.html does not load js/app.js');
    for (const r of refs) {
      assert.ok(!r.startsWith('/'), 'absolute path in index.html: ' + r);
      readFileSync(join(root, r)); // throws if missing
    }
  });
}

// ---------------------------------------------------------------- dash check

function runDashCheck() {
  console.log('\n== em/en dash check');
  const files = ['index.html', 'css/app.css', 'README.md']
    .concat(readdirSync(join(root, 'js')).map((f) => 'js/' + f));
  return test('no em or en dashes in user-facing files', () => {
    const bad = [];
    for (const f of files) {
      let src;
      try { src = readFileSync(join(root, f), 'utf8'); } catch (e) { continue; }
      src.split('\n').forEach((line, i) => {
        if (/[\u2013\u2014]/.test(line)) bad.push(f + ':' + (i + 1) + ': ' + line.trim().slice(0, 80));
      });
    }
    assert.deepEqual(bad, []);
  });
}

// ---------------------------------------------------------------- end to end over SimTransport

async function makeStack(scenario, extra) {
  const { SimTransport } = await import(jsUrl('sim.js'));
  const { Elm327 } = await import(jsUrl('elm.js'));
  const { Obd } = await import(jsUrl('obd.js'));
  const { Logger } = await import(jsUrl('log.js'));
  const logger = new Logger();
  const t = new SimTransport(Object.assign({ scenario, timeScale: 0.02, noDataRate: 0, seed: 42 }, extra || {}));
  await t.connect();
  const elm = new Elm327(t, logger);
  const obd = new Obd(elm);
  return { t, elm, obd, logger };
}

function codesOf(r) {
  const out = [];
  (r.byEcu || []).forEach((e) => e.codes.forEach((c) => out.push(c)));
  return out;
}

function noErrorsLogged(logger) {
  const errs = logger.entries().filter((e) => e.kind === 'error');
  assert.deepEqual(errs.map((e) => e.text), [], 'errors in log');
}

async function runE2E() {
  const { buildReport } = await import(jsUrl('report.js'));
  console.log('\n== end to end: normal scenario (CAN 11/500, two ECUs)');
  {
    const S = await makeStack('normal');
    const { elm, obd, t, logger } = S;
    let init;
    await test('normal: init', async () => {
      init = await elm.init();
      assert.equal(init.ok, true, init.message);
      assert.equal(init.elmVersion, 'v1.5');
      assert.equal(init.protocolNumber, '6');
      assert.ok(/15765/.test(init.protocol), 'protocol: ' + init.protocol);
      assert.equal(typeof init.voltage, 'number');
      assert.equal(elm.headersOn, true);
      obd.protocolNumber = init.protocolNumber;
    });
    await test('normal: probe', async () => {
      const res = await elm.probe();
      assert.equal(res.length, 6);
      assert.deepEqual(res.map((r) => r.cmd), ['ATI', 'AT@1', 'ATDP', 'ATDPN', 'ATRV', '0100']);
      res.forEach((r) => assert.equal(r.status, 'ok', r.cmd + ' ' + r.status));
      assert.ok(/ELM327/.test(res[0].lines.join(' ')));
      assert.ok(/vLinker/.test(res[1].lines.join(' ')));
    });
    await test('normal: supportedPids', async () => {
      const s = await obd.supportedPids();
      assert.equal(s.status, 'ok');
      assert.ok(s.byEcu['7E8'] && s.byEcu['7EA'], 'both ECUs: ' + Object.keys(s.byEcu));
      assert.ok(s.all.has(0x0c) && s.all.has(0x31) && s.all.has(0x4e) && s.all.has(0x5b));
      assert.ok(!s.all.has(0xa6), 'A6 must not be supported');
    });
    await test('normal: readDtcs 03/07/0A', async () => {
      const r03 = await obd.readDtcs('03');
      assert.equal(r03.status, 'ok');
      assert.deepEqual(codesOf(r03).sort(), ['P0171', 'P0420', 'P0A80']);
      const e = r03.byEcu.find((x) => x.ecu === '7E8');
      assert.ok(e && e.label === 'Engine (ECM)');
      assert.ok(e.details && e.details[0].description, 'descriptions attached');
      const r07 = await obd.readDtcs('07');
      assert.deepEqual(codesOf(r07), ['P0300']);
      const r0a = await obd.readDtcs('0A');
      assert.equal(r0a.supported, true);
      assert.deepEqual(codesOf(r0a), ['P0420']);
    });
    await test('normal: readVin', async () => {
      const v = await obd.readVin();
      assert.equal(v.status, 'ok', v.message);
      assert.equal(v.vin, 'NMTKZ3BX10R000001');
      assert.equal(v.ecu, '7E8');
    });
    await test('normal: readiness', async () => {
      const r = await obd.readiness();
      assert.equal(r.status, 'ok', r.message);
      assert.equal(r.milOn, true);
      assert.ok(r.dtcCount >= 3, 'dtcCount ' + r.dtcCount);
      assert.equal(r.ignition, 'spark');
      assert.ok(r.monitors.length >= 8);
      assert.ok(r.monitors.some((m) => m.available && m.complete === false), 'some incomplete monitor');
      assert.ok(Array.isArray(r.thisDrive), '0141 read');
    });
    let check;
    await test('normal: usedCarCheck flags recently cleared', async () => {
      const steps = [];
      check = await obd.usedCarCheck((p) => steps.push(p));
      assert.ok(steps.length >= 5, 'progress callbacks ' + steps.length);
      assert.equal(check.vin.vin, 'NMTKZ3BX10R000001');
      const txt = check.flags.map((f) => f.level + ': ' + f.text).join('\n');
      assert.ok(check.flags.some((f) => f.level === 'warn' && /cleared recently/i.test(f.text)), 'recently cleared flag missing:\n' + txt);
      assert.ok(check.flags.some((f) => /check engine light is ON/i.test(f.text)), 'MIL flag');
      assert.ok(check.flags.some((f) => /stored trouble code/i.test(f.text)), 'stored codes flag');
      const odo = check.items.find((i) => i.key === 'odometer');
      assert.equal(odo.supported, false);
      assert.ok(check.flags.some((f) => /Not supported by this car: .*Odometer/.test(f.text)), 'odometer listed as not supported');
      const dist = check.items.find((i) => i.key === 'distanceSinceClear');
      assert.equal(dist.value, 85);
    });
    let ff;
    await test('normal: freezeFrame', async () => {
      ff = await obd.freezeFrame();
      assert.equal(ff.status, 'ok', ff.message);
      assert.equal(ff.dtc, 'P0171');
      const rpm = ff.values.find((v) => v.pid === 0x0c);
      assert.ok(rpm && Math.abs(rpm.value - 1520) < 1, 'freeze RPM ' + (rpm && rpm.value));
      const ect = ff.values.find((v) => v.pid === 0x05);
      assert.ok(ect && ect.value === 86, 'freeze coolant ' + (ect && ect.value));
    });
    await test('normal: readPids (multi-PID, 8 PIDs, mixed support)', async () => {
      const list = [0x0c, 0x0d, 0x05, 0x0f, 0x04, 0x11, 0x42, 0x5b];
      const res = await obd.readPids(list);
      assert.equal(res.length, list.length);
      res.forEach((r, i) => {
        assert.equal(r.pid, list[i]);
        assert.equal(r.status, 'ok', 'pid ' + list[i].toString(16) + ' ' + r.status);
        assert.equal(typeof r.value, 'number');
      });
      assert.equal(res.find((r) => r.pid === 0x5b).ecu, '7EA');
      const one = await obd.readPid(0xa6);
      assert.notEqual(one.status, 'ok');
      assert.equal(one.text, 'Not supported by this car');
    });
    await test('normal: report builds', () => {
      const text = buildReport({
        appVersion: 'test', generatedAt: new Date(), includeVin: true,
        connection: { kind: 'sim', scenario: 'normal', elmVersion: init.elmVersion, protocol: init.protocol, protocolNumber: init.protocolNumber },
        vin: check.vin, check, codes: null, readiness: check.readiness, freeze: ff, live: []
      });
      assert.equal(typeof text, 'string');
      assert.ok(/NMTKZ3BX10R000001/.test(text));
      assert.ok(!/[\u2013\u2014]/.test(text), 'dash in report');
    });
    await test('normal: clearDtcs then re-read shows 0 codes', async () => {
      const c = await obd.clearDtcs();
      assert.equal(c.ok, true, c.message);
      const r03 = await obd.readDtcs('03');
      assert.equal(r03.status, 'ok');
      assert.equal(codesOf(r03).length, 0, 'codes after clear: ' + codesOf(r03));
      const r07 = await obd.readDtcs('07');
      assert.equal(codesOf(r07).length, 0);
      const rd = await obd.readiness();
      assert.equal(rd.milOn, false);
      const d = await obd.readPid(0x31);
      assert.equal(d.value, 0);
    });
    await test('normal: no errors in debug log', () => noErrorsLogged(logger));
    await test('normal: disconnect cancels and later sends stop cleanly', async () => {
      const p = elm.send('0100');
      await t.disconnect();
      elm.cancelAll();
      const r = await p;
      assert.equal(r.status, 'stopped');
      const r2 = await elm.send('0100');
      assert.equal(r2.status, 'stopped');
      assert.ok(/not connected/i.test(r2.message));
    });
  }

  console.log('\n== end to end: normal scenario with flaky live data (5% NO DATA)');
  {
    const { elm, obd } = await makeStack('normal', { noDataRate: 0.3, seed: 7 });
    await test('flaky: readPids loop survives random NO DATA', async () => {
      const init = await elm.init();
      assert.equal(init.ok, true);
      obd.protocolNumber = init.protocolNumber;
      await obd.supportedPids();
      for (let i = 0; i < 5; i++) {
        const res = await obd.readPids([0x0c, 0x0d, 0x05, 0x0f, 0x04, 0x11, 0x06, 0x07]);
        assert.equal(res.length, 8);
        res.forEach((r) => assert.ok(r && typeof r.status === 'string'));
      }
    });
  }

  console.log('\n== end to end: timeout recovery and strict mode 02');
  {
    const { elm, obd } = await makeStack('normal', { timeScale: 0.5 });
    await test('timeout: adapter is resynchronised so the next command is not lost', async () => {
      assert.equal((await elm.send('ATE0')).status, 'ok');
      assert.equal((await elm.send('ATH1')).status, 'ok');
      // The simulated search takes about 400 ms here, so this times out mid-search.
      const r1 = await elm.send('0100', { timeout: 100 });
      assert.equal(r1.status, 'timeout');
      const r2 = await elm.send('010D');
      assert.equal(r2.status, 'ok', 'next command after a timeout: ' + r2.status + ' ' + JSON.stringify(r2.raw));
      assert.ok(r2.lines.some((l) => /^7E8/.test(l)), 'real data: ' + r2.lines.join('|'));
      // The interrupted search did not lock a protocol, so the adapter searched again.
      assert.ok(/SEARCHING/.test(r2.raw), 'searched again: ' + JSON.stringify(r2.raw));
      const r3 = await elm.send('010C');
      assert.equal(r3.status, 'ok');
      assert.ok(!/SEARCHING/.test(r3.raw), 'protocol locked after a completed search');
    });
    await test('sim: mode 02 request without a frame number is rejected (7F 02 13)', async () => {
      obd.protocolNumber = '6';
      const bad = await obd.query('0202');
      assert.equal(bad.status, 'unsupported');
      assert.equal(bad.negative[0].nrc, 0x13);
      const good = await obd.query('020200');
      assert.equal(good.status, 'ok');
      assert.deepEqual(good.responses[0].bytes.slice(0, 3), [0x42, 0x02, 0x00]);
    });
    await test('init after a dropped link reports a lost connection', async () => {
      const S2 = await makeStack('normal', { timeScale: 1 });
      S2.t.onDisconnect = () => S2.elm.cancelAll(); // as the app does
      setTimeout(() => S2.t.simulateDrop(), 150);
      const r = await S2.elm.init();
      assert.equal(r.ok, false);
      assert.ok(/Lost connection/i.test(r.message), r.message);
    });
  }

  console.log('\n== end to end: legacy scenario (ISO 9141-2)');
  {
    const { elm, obd, logger } = await makeStack('legacy');
    await test('legacy: init', async () => {
      const init = await elm.init();
      assert.equal(init.ok, true, init.message);
      assert.equal(init.protocolNumber, '3');
      obd.protocolNumber = init.protocolNumber;
    });
    await test('legacy: supportedPids', async () => {
      const s = await obd.supportedPids();
      assert.equal(s.status, 'ok');
      assert.ok(s.byEcu['10'], 'ECU 10: ' + Object.keys(s.byEcu));
      assert.ok(s.all.has(0x0c));
    });
    await test('legacy: readDtcs reads codes, 0A not supported', async () => {
      const r03 = await obd.readDtcs('03');
      assert.equal(r03.status, 'ok');
      assert.ok(codesOf(r03).length >= 1, 'legacy stored codes: ' + codesOf(r03));
      codesOf(r03).forEach((c) => assert.match(c, /^[PCBU][0-9A-F]{4}$/));
      assert.equal(r03.byEcu[0].label, 'Engine (ECM)');
      const r0a = await obd.readDtcs('0A');
      assert.equal(r0a.supported, false);
      assert.equal(r0a.message, 'Not supported by this car');
    });
    await test('legacy: VIN handled gracefully', async () => {
      const v = await obd.readVin();
      if (v.vin) {
        assert.equal(v.status, 'ok');
        assert.match(v.vin, /^[A-Z0-9]{17}$/);
      } else {
        assert.ok(/not supported/i.test(v.message), v.message);
      }
    });
    await test('legacy: readiness, freeze frame, single PID reads', async () => {
      const r = await obd.readiness();
      assert.equal(r.status, 'ok', r.message);
      assert.equal(typeof r.milOn, 'boolean');
      const ff = await obd.freezeFrame();
      assert.ok(ff.status === 'ok' || /freeze frame/i.test(ff.message), ff.message);
      const res = await obd.readPids([0x0c, 0x0d, 0x05]);
      res.forEach((x) => assert.equal(x.status, 'ok', 'pid ' + x.pid + ' ' + x.status));
    });
    await test('legacy: usedCarCheck completes', async () => {
      const c = await obd.usedCarCheck();
      assert.ok(c.flags.length > 0);
      assert.ok(c.flags.some((f) => /Permanent codes: not supported/i.test(f.text)));
      c.flags.forEach((f) => assert.ok(['warn', 'info', 'ok'].indexOf(f.level) >= 0));
    });
    await test('legacy: no errors in debug log', () => noErrorsLogged(logger));
  }

  console.log('\n== end to end: ignitionOff scenario');
  {
    const { elm, obd } = await makeStack('ignitionOff');
    await test('ignitionOff: init fails with plain-English message', async () => {
      const init = await elm.init();
      assert.equal(init.ok, false);
      assert.ok(/did not answer/i.test(init.message), init.message);
      assert.ok(/ignition ON/i.test(init.message), init.message);
      assert.ok(/READY/.test(init.message), init.message);
      assert.ok(!/settings/i.test(init.message), 'must not mention Settings');
      assert.ok(!/tap Connect again/i.test(init.message), 'the app offers "Ask the car again" instead: ' + init.message);
      assert.equal(init.elmVersion, 'v1.5', 'adapter itself still answers');
    });
    await test('ignitionOff: OBD reads fail gracefully', async () => {
      const r = await obd.readDtcs('03');
      assert.notEqual(r.status, 'ok');
      assert.equal(typeof r.message, 'string');
      assert.ok(r.message.length > 0);
    });
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  await runTestFiles();
  await runImportChecks();
  await runDashCheck();
  await runE2E();
  console.log('\n' + passed + ' passed, ' + failed + ' failed (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  if (failed) {
    console.log('Failures: ' + failures.join('; '));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
