// OBD Web UI and wiring. All data stays in memory on this page.

import { logger } from './log.js?v=1.0.2';
import { BleTransport } from './ble.js?v=1.0.2';
import { SimTransport } from './sim.js?v=1.0.2';
import { Elm327 } from './elm.js?v=1.0.2';
import { Obd, ecuLabel } from './obd.js?v=1.0.2';
import { PIDS, GAUGE_DEFAULTS } from './pids.js?v=1.0.2';
import { describeDtc } from './dtc-db.js?v=1.0.2';
import { TEXT, CODE_KINDS, SEVERITY_LABEL } from './ui-text.js?v=1.0.2';
import { buildReport } from './report.js?v=1.0.2';

var APP_VERSION = '1.0.2';
var BITMAP_PIDS = [0x00, 0x20, 0x40, 0x60, 0x80, 0xA0, 0xC0, 0xE0];
var SKIP_LIVE_PIDS = [0x01, 0x41]; // status bitfields, shown in readiness instead
var SCENARIO_LABELS = { normal: 'Normal car', ignitionOff: 'Ignition off', legacy: 'Older car (pre CAN)' };

// ---------------------------------------------------------------- state

var S = {
  transport: null,
  kind: null,          // 'ble' | 'sim'
  scenario: null,
  elm: null,
  obd: null,
  connected: false,    // car answered
  adapterOnly: false,  // adapter linked but car silent
  busy: false,
  userDisconnecting: false,
  init: null,
  supported: null,
  live: { running: false, promise: null, gen: 0, error: null, selected: [], values: {}, tiles: {}, openPid: null },
  results: { check: null, vin: null, codes: null, readiness: null, freeze: null }
};

// ---------------------------------------------------------------- helpers

function $(id) { return document.getElementById(id); }

function h(tag, attrs, children) {
  var el = document.createElement(tag);
  if (attrs) {
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  if (children != null) {
    if (!Array.isArray(children)) children = [children];
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
  }
  return el;
}

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

function show(el, on) { el.hidden = !on; }

function notice(kind, title, text) {
  return h('div', { class: 'notice notice-' + kind, role: kind === 'bad' ? 'alert' : null }, [
    title ? h('strong', { text: title }) : null,
    text ? h('p', { text: text }) : null
  ]);
}

function setMsg(el, kind, title, text) {
  clear(el);
  if (!title && !text) { show(el, false); return; }
  el.appendChild(notice(kind, title, text));
  show(el, true);
}

function pidNum(p) {
  if (typeof p === 'number') return p;
  if (typeof p === 'string') {
    var s = p.replace(/^0x/i, '');
    if (s.length > 2 && s.slice(0, 2) === '01') s = s.slice(2);
    return parseInt(s, 16);
  }
  return NaN;
}

function hex2(n) { var s = n.toString(16).toUpperCase(); return s.length < 2 ? '0' + s : s; }

function pidDef(pid) { return PIDS[pid] || null; }

function pidName(pid) {
  var d = pidDef(pid);
  return d ? d.name : 'Reading ' + hex2(pid);
}

// Short numeric values stay on one line, longer text values wrap so the table fits a phone screen.
function valClass(val) {
  return /^-?[\d.,]+(\s?\S{1,6})?$/.test(String(val)) ? 'val num' : 'val';
}

function vinText(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v.vin === 'string') return v.vin;
  return '';
}

function safeDescribe(code) {
  try {
    var d = describeDtc(code);
    if (d) return d;
  } catch (e) {
    logger.log('warn', 'describeDtc failed for ' + code + ': ' + (e && e.message));
  }
  return { code: code, description: 'Description not available', explain: '', severity: null };
}

function safeEcuLabel(id) {
  try { return ecuLabel(id) || ('Module at ' + id); } catch (e) { return 'Module at ' + id; }
}

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Clipboard with a fallback for older WebViews.
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
  }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

// ---------------------------------------------------------------- explainers

function buildExplainer(key) {
  var t = TEXT[key];
  if (!t) return null;
  var d = h('details', { class: 'explain' });
  d.appendChild(h('summary', { text: 'How this works and what to do next' }));
  var parts = [['What it does', t.what], ['What the results mean', t.means], ['What to do next', t.next]];
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i][1] || !parts[i][1].length) continue;
    d.appendChild(h('h4', { text: parts[i][0] }));
    d.appendChild(h('ul', null, parts[i][1].map(function (s) { return h('li', { text: s }); })));
  }
  if (key === 'connect' && TEXT.probe) {
    d.appendChild(h('h4', { text: 'Probe adapter' }));
    d.appendChild(h('p', { text: TEXT.probe.lead + ' ' + TEXT.probe.help }));
  }
  if (key === 'codes' && TEXT.readiness) {
    d.appendChild(h('h4', { text: 'Readiness monitors' }));
    d.appendChild(h('p', { text: TEXT.readiness.lead + ' ' + TEXT.readiness.help }));
  }
  return d;
}

function fillStaticText() {
  var leads = document.querySelectorAll('[data-lead]');
  for (var i = 0; i < leads.length; i++) {
    var k = leads[i].getAttribute('data-lead');
    if (TEXT[k] && TEXT[k].lead) leads[i].textContent = TEXT[k].lead;
  }
  var ex = document.querySelectorAll('[data-explain]');
  for (var j = 0; j < ex.length; j++) {
    var node = buildExplainer(ex[j].getAttribute('data-explain'));
    if (node) ex[j].appendChild(node);
  }
  var map = {
    noBtTitle: TEXT.noBluetooth.title,
    noBtText: TEXT.noBluetooth.text,
    consoleHelp: TEXT.console.lead + ' ' + TEXT.console.help,
    aboutTitle: TEXT.about.title,
    privacyTitle: TEXT.privacy.title
  };
  var tx = document.querySelectorAll('[data-text]');
  for (var m = 0; m < tx.length; m++) {
    var key = tx[m].getAttribute('data-text');
    if (map[key]) tx[m].textContent = map[key];
  }
  TEXT.about.paras.forEach(function (p) { $('aboutText').appendChild(h('p', { text: p })); });
  TEXT.privacy.paras.forEach(function (p) { $('privacyText').appendChild(h('p', { text: p })); });
  $('versionLine').textContent = 'Version ' + APP_VERSION + '. Open source, runs entirely in your browser.';

  // Clear dialog text
  $('clearTitle').textContent = TEXT.clear.title;
  $('clearIntro').textContent = TEXT.clear.intro;
  TEXT.clear.consequences.forEach(function (c) { $('clearList').appendChild(h('li', { text: c })); });
  $('clearBefore').textContent = TEXT.clear.before;
  $('clearSafetyText').textContent = TEXT.clear.safety;
  $('clearPrompt').textContent = TEXT.clear.typePrompt;
  $('clearConfirm').textContent = TEXT.clear.confirm;
  $('clearCancel').textContent = TEXT.clear.cancel;
}

// ---------------------------------------------------------------- status + buttons

function setStatus(kind, text, pill) {
  $('statusLine').textContent = text;
  var p = $('statusPill');
  p.className = 'pill pill-' + kind;
  p.textContent = pill || ({ idle: 'Not connected', busy: 'Working...', ok: 'Connected', warn: 'Car not answering', bad: 'Disconnected' })[kind] || '';
}

function setDisabled(id, off) { $(id).disabled = !!off; }

function updateButtons() {
  var hasT = !!S.transport;
  var live = S.live.running;
  var ready = S.connected && !S.busy && !live && !S.live.promise;

  setDisabled('btnConnect', hasT || S.busy);
  setDisabled('btnSim', hasT || S.busy);
  setDisabled('simScenario', hasT || S.busy);
  setDisabled('btnDisconnect', !hasT);
  setDisabled('btnProbe', !hasT || S.busy || live);
  show($('btnRetry'), S.adapterOnly && hasT);
  setDisabled('btnRetry', S.busy || !S.adapterOnly);

  ['btnCheck', 'btnRead', 'btnClear', 'btnReadiness', 'btnFreeze'].forEach(function (id) { setDisabled(id, !ready); });

  // The old loop may still be finishing its last request after Stop. Keep Start disabled until it has.
  var stopping = !live && !!S.live.promise;
  var lb = $('btnLive');
  lb.textContent = live ? 'Stop live data' : (stopping ? 'Stopping...' : 'Start live data');
  lb.className = live ? 'btn btn-danger' : 'btn btn-primary';
  setDisabled('btnLive', live ? false : (stopping || !S.connected || S.busy || S.live.selected.length === 0));

  // Explain why the main tools are greyed out, once, in the live card.
  if (live) setMsg($('liveMsg'), 'info', null, TEXT.live.stopFirst);
  else if (S.live.error) setMsg($('liveMsg'), 'bad', 'Live data stopped', S.live.error);
  else if (!S.connected) setMsg($('liveMsg'), 'info', null, 'Connect to the car (or the simulated car) to see live readings.');
  else if (S.live.selected.length === 0) setMsg($('liveMsg'), 'info', null, 'No readings selected. Open "Choose readings" and tick a few.');
  else setMsg($('liveMsg'), null, null, null);
}

function errMsg(e) {
  if (e === null || e === undefined) return 'unknown error';
  if (typeof e !== 'object') return 'code ' + String(e);
  return (e.message || String(e));
}

// Wraps a long action: disables conflicting buttons, catches errors, shows plain English.
function run(label, fn, errorEl, onError) {
  if (S.busy) return Promise.resolve();
  S.busy = true;
  updateButtons();
  logger.log('info', '== ' + label);
  return Promise.resolve()
    .then(fn)
    .catch(function (e) {
      logger.log('error', label + ' failed: ' + errMsg(e));
      if (e && e.stack) logger.log('info', 'Stack: ' + e.stack);
      if (errorEl) setMsgOrAppend(errorEl, 'bad', label + ' did not finish', friendlyError(e));
      if (onError) { try { onError(e); } catch (e2) { /* ignore */ } }
    })
    .then(function () {
      S.busy = false;
      updateButtons();
    });
}

function setMsgOrAppend(el, kind, title, text) {
  if (el.classList.contains('msg')) setMsg(el, kind, title, text);
  else { el.appendChild(notice(kind, title, text)); show(el, true); }
}

function friendlyError(e) {
  if (!e) return 'Something went wrong. Details are in the debug console at the bottom of the page.';
  var name = e.name || '';
  if (name === 'NotFoundError') return 'No adapter was chosen. Tap Connect adapter again and pick your adapter from the list. If it is not listed, check it is plugged in and the ignition is on.';
  if (name === 'SecurityError') return 'The browser blocked Bluetooth. Tap the Connect button directly and allow Bluetooth when asked.';
  if (name === 'NetworkError') return 'Could not open a Bluetooth link to the adapter. Close any other app that may be connected to it, move the phone closer, then try again.';
  var msg = e.message ? String(e.message) : String(e);
  // Hide technical messages, keep plain ones.
  if (msg.length > 240 || /undefined|null|is not a function|Cannot read|TypeError|ReferenceError/.test(msg)) {
    return 'Something unexpected happened. Details are in the debug console at the bottom of the page. Try again, or disconnect and reconnect.';
  }
  if (!S.transport && !/adapter|Bluetooth|Bluefy|Chrome/i.test(msg)) msg += ' The adapter is no longer connected.';
  return msg;
}

// ---------------------------------------------------------------- connection

function onConnectBle() {
  if (S.busy || S.transport) return;
  if (!navigator.bluetooth) {
    show($('noBtBox'), true);
    setMsg($('connectMsg'), 'warn', TEXT.noBluetooth.title, TEXT.noBluetooth.text);
    return;
  }
  // Important: connect() is called synchronously inside the tap handler, before any await,
  // so the browser accepts it as a user gesture and shows the device list.
  var t, p;
  try {
    t = new BleTransport({ logger: logger });
    p = t.connect();
  } catch (e) {
    p = Promise.reject(e);
  }
  setMsg($('connectMsg'), null);
  setStatus('busy', 'Choose your adapter from the list. Look for a name like vLinker, OBDII or IOS-Vlink.', 'Connecting...');
  run('Connecting to the adapter', function () {
    return p.then(function () {
      logger.log('info', 'Bluetooth link open to ' + ((t.info && t.info.deviceName) || 'adapter'));
      return attach(t, 'ble', null);
    });
  }, $('connectMsg'), function () {
    try { if (t && t.isConnected && t.isConnected()) t.disconnect(); } catch (e) { /* ignore */ }
    dropTransport(t, 'Not connected. Follow the steps below, then tap Connect adapter.', 'idle');
  });
}

function onConnectSim() {
  if (S.busy || S.transport) return;
  var scenario = $('simScenario').value || 'normal';
  setMsg($('connectMsg'), null);
  setStatus('busy', 'Starting the simulated car...', 'Connecting...');
  run('Starting the simulated car', function () {
    var t = new SimTransport({ scenario: scenario, logger: logger });
    return Promise.resolve(t.connect()).then(function () { return attach(t, 'sim', scenario); });
  }, $('connectMsg'), function () {
    var t = S.transport;
    try { if (t) t.disconnect(); } catch (e) { /* ignore */ }
    dropTransport(t, 'Not connected.', 'idle');
  });
}

function attach(t, kind, scenario) {
  S.transport = t;
  S.kind = kind;
  S.scenario = scenario;
  S.userDisconnecting = false;
  S.elm = new Elm327(t, logger);
  S.obd = new Obd(S.elm);
  var prev = t.onDisconnect;
  t.onDisconnect = function (reason) {
    if (typeof prev === 'function') { try { prev(reason); } catch (e) { /* ignore */ } }
    onTransportLost(t, reason);
  };
  updateButtons();
  return talkToCar();
}

function talkToCar() {
  var elm = S.elm;
  var t = S.transport;
  // True when the adapter was disconnected (or replaced) while we were waiting on it.
  function stale() { return S.transport !== t || S.elm !== elm || !t; }
  setStatus('busy', 'Adapter connected. Waking up the adapter and asking the car to answer. The first time can take up to 15 seconds.', 'Talking to car...');
  setMsg($('connectMsg'), null);
  return elm.init().then(function (r) {
    if (stale()) { logger.log('info', 'Adapter setup finished after the connection was closed. Result ignored.'); return; }
    S.init = r || {};
    if (S.obd) {
      S.obd.protocolNumber = (r && r.protocolNumber) || null;
      S.obd.supported = null;
    }
    renderConnectInfo();
    if (!r || !r.ok) {
      S.adapterOnly = true;
      S.connected = false;
      setStatus('warn', 'The adapter is connected, but the car did not answer.');
      setMsg($('connectMsg'), 'warn', 'The car is not answering yet',
        (r && r.message ? r.message + ' You can use the "Ask the car again" button below without reconnecting the adapter.' : null) || 'Turn the ignition ON (or press start with your foot on the brake until READY shows), check the adapter is pushed fully into the port, then tap "Ask the car again".');
      return;
    }
    S.adapterOnly = false;
    S.connected = true;
    setStatus('busy', 'The car answered. Checking which live readings it supports...', 'Reading car...');
    return Promise.resolve()
      .then(function () { return S.obd.supportedPids(); })
      .catch(function (e) {
        logger.log('warn', 'Supported PID check failed: ' + ((e && e.stack) || e));
        return null;
      })
      .then(function (sup) {
        if (stale()) return;
        S.supported = sup && sup.all ? sup : { all: new Set(), byEcu: {} };
        try {
          var ecus = Object.keys(S.supported.byEcu || {}).sort();
          logger.log('info', 'Modules answering: ' + (ecus.length ? ecus.map(function (id) {
            var set = S.supported.byEcu[id];
            return id + ' ' + ecuLabel(id) + ' (' + (set ? set.size : 0) + ' readings)';
          }).join(', ') : 'none'));
          logger.log('info', 'Supported readings (all modules): ' + Array.from(S.supported.all).sort(function (a, b) { return a - b; }).map(function (n) { return (n < 16 ? '0' : '') + n.toString(16).toUpperCase(); }).join(' '));
        } catch (e) { /* logging only */ }
        var sim = S.kind === 'sim' ? ' (simulated car)' : '';
        setStatus('ok', 'Connected to the car' + sim + '. Everything below is ready to use.', S.kind === 'sim' ? 'Simulated car' : 'Connected');
        setMsg($('connectMsg'), 'ok', null, 'Next: run the Used car check, or read the trouble codes.');
        if (!S.reconnecting) setupLive();
        if (S.kind === 'ble') { keepAwake(true); if (S.elm) S.elm.startKeepAlive(4000); }
      });
  });
}

function onRetry() {
  if (!S.elm) return;
  run('Asking the car again', talkToCar, $('connectMsg'));
}

function renderConnectInfo() {
  var box = $('connectInfo');
  clear(box);
  var r = S.init || {};
  var info = (S.transport && S.transport.info) || {};
  var rows = [];
  rows.push(['Source', S.kind === 'sim' ? 'Simulated car (' + (SCENARIO_LABELS[S.scenario] || SCENARIO_LABELS.normal) + ')' : (info.deviceName || 'Bluetooth adapter')]);
  if (r.elmVersion) rows.push(['Adapter chip', r.elmVersion]);
  // 'AUTO' alone means no protocol was found yet, which tells the user nothing.
  var proto = r.protocol ? String(r.protocol).replace(/^AUTO,\s*/i, '').trim() : '';
  if (proto && !/^AUTO$/i.test(proto)) rows.push(['Car protocol', proto]);
  if (r.voltage) rows.push(['Battery voltage', voltText(r.voltage) + ' (about 12.4V or more with engine off is healthy, 13.5V to 14.7V while running or READY)']);
  rows.forEach(function (row) {
    box.appendChild(h('div', { class: 'k', text: row[0] }));
    box.appendChild(h('div', { class: 'v', text: row[1] }));
  });
  show(box, rows.length > 0);
}

function voltText(v) {
  var s = String(v).trim();
  return /^\d+(\.\d+)?$/.test(s) ? s + 'V' : s;
}

function onDisconnectClick() {
  var t = S.transport;
  if (!t) return;
  S.userDisconnecting = true;
  S.live.running = false;
  try { if (S.elm) S.elm.cancelAll(); } catch (e) { /* ignore */ }
  Promise.resolve()
    .then(function () { return t.disconnect(); })
    .catch(function (e) { logger.log('warn', 'Disconnect: ' + ((e && e.message) || e)); })
    .then(function () {
      dropTransport(t, 'Disconnected. You can unplug the adapter now.', 'idle');
      setMsg($('connectMsg'), null);
    });
}

function onTransportLost(t, reason) {
  if (S.transport !== t) return;
  var user = S.userDisconnecting;
  // A drop while auto-reconnecting is handled by the retry loop itself.
  if (S.reconnecting && !user) return;
  var wasLive = S.live.running;
  try {
    var idle = S.elm ? Math.round(S.elm.idleMs() / 100) / 10 : null;
    logger.log('warn', 'Drop details: page ' + (document.visibilityState || '?') + ', adapter idle ' + (idle === null ? '?' : idle + ' s') + (wasLive ? ', live data was running' : '') + '.');
  } catch (e) { /* logging only */ }
  try { if (S.elm) S.elm.stopKeepAlive(); } catch (e) { /* ignore */ }
  S.live.running = false;
  try { if (S.elm) S.elm.cancelAll(); } catch (e) { /* ignore */ }
  if (!user && S.kind === 'ble' && typeof t.reconnect === 'function' && !S.reconnecting) {
    autoReconnect(t, wasLive, reason);
    return;
  }
  if (user) {
    dropTransport(t, 'Disconnected. You can unplug the adapter now.', 'idle');
  } else {
    dropTransport(t, 'The adapter disconnected.', 'bad');
    setMsg($('connectMsg'), 'bad', 'Connection lost',
      (reason ? String(reason) + ' ' : '') + 'This happens if the car turns off, the adapter is unplugged, or the phone moves out of range. Your results so far are kept. Tap Connect adapter to reconnect.');
  }
}

var RECONNECT_DELAYS = [700, 1500, 3000, 5000];

// After an unexpected Bluetooth drop: reconnect to the same adapter, set it up again and
// carry on (including live data) without the user doing anything.
function autoReconnect(t, wasLive, reason) {
  S.reconnecting = true;
  S.connected = false;
  S.adapterOnly = false;
  var keepSel = S.live.selected.slice();
  logger.log('warn', 'Connection dropped' + (reason ? ' (' + reason + ')' : '') + '. Trying to reconnect automatically.');
  updateButtons();
  var attempt = 0;
  function aborted() { return S.userDisconnecting || S.transport !== t; }
  function waitIdle(ms) {
    return new Promise(function (resolve) {
      var waited = 0;
      (function tick() {
        if (!S.busy || waited >= ms) return resolve();
        waited += 100;
        setTimeout(tick, 100);
      })();
    });
  }
  function next() {
    if (aborted()) { S.reconnecting = false; return; }
    if (attempt >= RECONNECT_DELAYS.length) {
      S.reconnecting = false;
      logger.log('error', 'Could not reconnect after ' + attempt + ' tries.');
      dropTransport(t, 'The adapter disconnected.', 'bad');
      setMsg($('connectMsg'), 'bad', 'Connection lost',
        'The app tried to reconnect ' + attempt + ' times without luck. Check the car is still ON or in READY and the adapter light is on, then tap Connect adapter. Your results so far are kept.');
      return;
    }
    var delay = RECONNECT_DELAYS[attempt];
    attempt++;
    setStatus('busy', 'The Bluetooth link dropped. Reconnecting (try ' + attempt + ' of ' + RECONNECT_DELAYS.length + ')... Keep the phone near the car.', 'Reconnecting...');
    setTimeout(function () {
      if (aborted()) { S.reconnecting = false; return; }
      waitIdle(6000).then(function () {
        if (aborted()) { S.reconnecting = false; return; }
        S.busy = true;
        updateButtons();
        return t.reconnect().then(function () {
          if (aborted()) return 'aborted';
          S.elm = new Elm327(t, logger);
          S.obd = new Obd(S.elm);
          return talkToCar().then(function () { return 'done'; });
        });
      }).then(function (res) {
        S.busy = false;
        S.reconnecting = false;
        if (res !== 'done') { updateButtons(); return; }
        if (!S.connected) { updateButtons(); return; }
        // Keep the readings the user picked.
        var avail = supportedLivePids();
        var sel = keepSel.filter(function (p) { return avail.indexOf(p) >= 0; });
        if (sel.length) { S.live.selected = sel; renderPicker(avail); renderTiles(); }
        setMsg($('connectMsg'), 'ok', 'Reconnected', 'The Bluetooth link dropped for a moment and the app reconnected by itself.' + (wasLive ? ' Live data has restarted.' : ''));
        updateButtons();
        if (wasLive) onLiveToggle();
      }, function (e) {
        S.busy = false;
        updateButtons();
        logger.log('warn', 'Reconnect try ' + attempt + ' failed: ' + errMsg(e));
        S.reconnecting = true;
        next();
      });
    }, delay);
  }
  next();
}

// Keep the screen on while connected. iOS can drop Bluetooth when the phone locks.
var wakeLock = null;
function keepAwake(on) {
  try {
    if (on) {
      if (wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
      navigator.wakeLock.request('screen').then(function (l) {
        wakeLock = l;
        logger.log('info', 'Screen will stay on while connected.');
        l.addEventListener('release', function () { wakeLock = null; });
      }, function (e) { logger.log('info', 'Screen wake lock not available: ' + errMsg(e)); });
    } else if (wakeLock) {
      var l = wakeLock; wakeLock = null;
      l.release().catch(function () {});
    }
  } catch (e) { /* not supported */ }
}

function dropTransport(t, text, kind) {
  if (t && S.transport && S.transport !== t) return;
  try { if (S.elm) S.elm.stopKeepAlive(); } catch (e) { /* ignore */ }
  S.transport = null;
  S.elm = null;
  S.obd = null;
  S.connected = false;
  S.adapterOnly = false;
  S.reconnecting = false;
  S.live.running = false;
  keepAwake(false);
  setStatus(kind || 'idle', text);
  show($('connectInfo'), false);
  updateButtons();
}

function onProbe() {
  if (!S.elm) return;
  var out = $('probeOut');
  clear(out);
  show(out, true);
  out.appendChild(h('p', { class: 'muted small', text: 'Asking the adapter about itself...' }));
  run('Probing the adapter', function () {
    return S.elm.probe().then(function (results) {
      clear(out);
      out.appendChild(h('h3', { text: 'Probe results' }));
      var table = h('table', { class: 'table' });
      (results || []).forEach(function (r) {
        var ans = r.status === 'ok' ? (r.lines || []).join(' / ') || 'OK' : (r.message || r.status);
        table.appendChild(h('tr', null, [
          h('td', { class: 'mono', text: r.cmd }),
          h('td', { text: probeLabel(r.cmd) + ': ' + ans })
        ]));
      });
      out.appendChild(table);
      out.appendChild(h('p', { class: 'muted small', text: 'Raw replies are in the debug console. Copy the log if you need help.' }));
    });
  }, out);
}

function probeLabel(cmd) {
  var m = {
    ATI: 'Chip version', 'AT@1': 'Adapter description', ATDP: 'Protocol', ATDPN: 'Protocol number',
    ATRV: 'Battery voltage', '0100': 'Car answer test'
  };
  return m[String(cmd).toUpperCase().replace(/\s/g, '')] || 'Reply';
}

// ---------------------------------------------------------------- used car check

function onCheck() {
  var out = $('checkOut');
  clear(out);
  var prog = $('checkProgress');
  var bar = $('checkBar');
  show(prog, true);
  bar.className = 'progress-fill indeterminate';
  bar.style.width = '';
  $('checkStep').textContent = 'Starting...';

  function onProgress(a, b) {
    var text = '';
    var frac = null;
    if (typeof a === 'string') text = a;
    else if (typeof a === 'number' && typeof b === 'number' && b > 0) frac = a / b;
    else if (a && typeof a === 'object') {
      text = a.label || a.text || a.message || '';
      if (typeof a.done === 'number' && typeof a.total === 'number' && a.total > 0) frac = a.done / a.total;
      else if (typeof a.step === 'number' && typeof a.total === 'number' && a.total > 0) frac = a.step / a.total;
      else if (typeof a.index === 'number' && typeof a.total === 'number' && a.total > 0) frac = a.index / a.total;
      else if (typeof a.fraction === 'number') frac = a.fraction;
      else if (typeof a.pct === 'number') frac = a.pct > 1 ? a.pct / 100 : a.pct;
    }
    if (typeof b === 'number' && frac == null) frac = b > 1 ? b / 100 : b;
    if (text) $('checkStep').textContent = String(text);
    if (frac != null && isFinite(frac)) {
      bar.className = 'progress-fill';
      bar.style.width = Math.max(4, Math.min(100, Math.round(frac * 100))) + '%';
    }
  }

  run('Used car check', function () {
    return S.obd.usedCarCheck(onProgress).then(function (res) {
      S.results.check = res || null;
      S.results.vin = (res && res.vin) || null;
      if (res && res.readiness && res.readiness.monitors) S.results.readiness = res.readiness;
      renderCheck(res || {});
    });
  }, out).then(function () { show(prog, false); });
}

function renderCheck(res) {
  var out = $('checkOut');
  clear(out);
  var flags = Array.isArray(res.flags) ? res.flags : [];
  if (res.interrupted) {
    out.appendChild(notice('warn', 'The check did not finish',
      'Some parts could not be read because of a connection problem, so the findings below are incomplete. Check the adapter is connected, then run the check again.'));
  }
  out.appendChild(h('h3', { text: 'Findings' }));
  out.appendChild(h('div', { class: 'legend' }, [
    h('span', null, [h('span', { class: 'dot dot-warn' }), 'Needs attention']),
    h('span', null, [h('span', { class: 'dot dot-info' }), 'Worth knowing']),
    h('span', null, [h('span', { class: 'dot dot-ok' }), 'Looks good'])
  ]));
  if (!flags.length) {
    out.appendChild(h('p', { class: 'muted', text: 'No findings were produced. Check the debug console for details.' }));
  } else {
    var order = { warn: 0, info: 1, ok: 2 };
    var rank = function (f) { return f.level in order ? order[f.level] : 1; };
    var sorted = flags.slice().sort(function (a, b) { return rank(a) - rank(b); });
    var ul = h('ul', { class: 'flags' });
    sorted.forEach(function (f) {
      var lvl = f.level === 'warn' || f.level === 'ok' ? f.level : 'info';
      var icon = lvl === 'warn' ? '!' : (lvl === 'ok' ? '✓' : 'i');
      ul.appendChild(h('li', { class: 'flag flag-' + lvl }, [
        h('span', { class: 'flag-icon', 'aria-hidden': 'true', text: icon }),
        h('div', null, [
          h('span', { class: 'sr-only', text: lvl === 'warn' ? 'Needs attention: ' : (lvl === 'ok' ? 'Looks good: ' : 'Worth knowing: ') }),
          String(f.text || ''),
          f.explain ? h('div', { class: 'small muted', text: f.explain }) : null
        ])
      ]));
    });
    out.appendChild(ul);
  }

  var vin = vinText(res.vin);
  if (vin) {
    out.appendChild(h('h3', { text: 'VIN reported by the car' }));
    out.appendChild(h('p', { class: 'mono', text: vin }));
    out.appendChild(h('p', { class: 'small muted', text: 'Check this matches the VIN plate (usually at the bottom of the windscreen) and the registration papers.' }));
  }

  // Extra readings if the protocol module gives them as a list.
  var items = res.items || res.readings || res.values;
  if (Array.isArray(items) && items.length) {
    out.appendChild(h('h3', { text: 'Readings used for the check' }));
    var table = h('table', { class: 'table' });
    items.forEach(function (it) {
      if (!it) return;
      var val = it.text != null ? it.text : (it.value != null ? it.value + (it.unit ? ' ' + it.unit : '') : (it.supported === false ? 'Not supported by this car' : '--'));
      table.appendChild(h('tr', null, [
        h('td', null, [String(it.label || it.name || ''), it.explain ? h('div', { class: 'small muted', text: it.explain }) : null]),
        h('td', { class: valClass(val), text: String(val) })
      ]));
    });
    out.appendChild(table);
  }

  var codes = {
    stored: res.stored || (res.dtcs && res.dtcs.stored) || (res.codes && res.codes.stored) || null,
    pending: res.pending || (res.dtcs && res.dtcs.pending) || (res.codes && res.codes.pending) || null,
    permanent: res.permanent || (res.dtcs && res.dtcs.permanent) || (res.codes && res.codes.permanent) || null
  };
  if (codes.stored || codes.pending || codes.permanent) {
    out.appendChild(h('h3', { text: 'Trouble codes' }));
    out.appendChild(renderCodeGroups(codes));
    S.results.codes = codes;
  }

  if (res.readiness && Array.isArray(res.readiness.monitors)) {
    out.appendChild(h('h3', { text: 'Readiness monitors' }));
    out.appendChild(renderReadinessBody(res.readiness));
  }

  out.appendChild(h('p', { class: 'small muted', text: 'Next: build a report at the bottom of the page to keep or share these results.' }));
}

// ---------------------------------------------------------------- trouble codes

function countCodes(r) {
  var n = 0;
  if (r && Array.isArray(r.byEcu)) r.byEcu.forEach(function (e) { n += (e.codes || []).length; });
  return n;
}

function renderDtc(code, ecu) {
  var d = safeDescribe(code);
  var sev = d.severity || 'none';
  var meta = [];
  meta.push('From: ' + (ecu.label || safeEcuLabel(ecu.ecu)));
  if (d.system) meta.push(d.system);
  if (d.manufacturerSpecific) meta.push('Maker specific code, description is general');
  return h('div', { class: 'dtc' }, [
    h('div', { class: 'dtc-head' }, [
      h('span', { class: 'dtc-code', text: code }),
      h('span', { class: 'sev sev-' + sev, text: SEVERITY_LABEL[sev] || 'Severity unknown' })
    ]),
    h('div', { class: 'dtc-desc', text: d.description || 'Description not available' }),
    h('div', { class: 'dtc-meta', text: meta.join('. ') }),
    d.explain ? h('p', { class: 'dtc-explain', text: d.explain }) : null
  ]);
}

function renderCodeGroups(codes) {
  var frag = h('div');
  CODE_KINDS.forEach(function (k) {
    var r = codes[k.key];
    frag.appendChild(h('h4', { class: 'group-title', text: k.title }));
    if (!r) { frag.appendChild(h('p', { class: 'ns-line', text: 'Not read.' })); return; }
    if (r.supported === false && r.status && r.status !== 'unsupported' && r.status !== 'nodata') {
      frag.appendChild(h('p', { class: 'ns-line', text: r.message || 'Could not read these codes.' }));
      return;
    }
    if (r.supported === false) {
      frag.appendChild(h('p', { class: 'ns-line', text: TEXT.codes.notSupported + (k.key === 'permanent' ? ' Many cars before about 2010 do not report permanent codes. That is normal.' : '') }));
      return;
    }
    var n = countCodes(r);
    if (n === 0) {
      var bad = r.status && r.status !== 'ok' && r.status !== 'nodata';
      if (bad) frag.appendChild(h('p', { class: 'ns-line', text: r.message || 'Could not read these codes.' }));
      else frag.appendChild(h('p', { class: 'none-line', text: TEXT.codes.none }));
      return;
    }
    r.byEcu.forEach(function (ecu) {
      (ecu.codes || []).forEach(function (c) { frag.appendChild(renderDtc(c, ecu)); });
    });
  });
  return frag;
}

function onReadCodes() {
  var out = $('codesOut');
  clear(out);
  out.appendChild(h('p', { class: 'muted small', text: 'Reading stored, pending and permanent codes...' }));
  run('Reading trouble codes', function () {
    var codes = { stored: null, pending: null, permanent: null, at: new Date() };
    return readCodesInto(codes).then(function () {
      S.results.codes = codes;
      clear(out);
      var total = countCodes(codes.stored) + countCodes(codes.pending) + countCodes(codes.permanent);
      out.appendChild(total === 0
        ? notice('ok', 'No trouble codes found', 'None of the modules that answered reported a fault code. Check the readiness monitors too, since cleared codes also look like this.')
        : notice('warn', total + (total === 1 ? ' code found' : ' codes found'), 'Each code is explained below. Fix the cause before clearing.'));
      out.appendChild(renderCodeGroups(codes));
    });
  }, out);
}

function readCodesInto(codes) {
  return S.obd.readDtcs('03').then(function (r) {
    codes.stored = r;
    return S.obd.readDtcs('07');
  }).then(function (r) {
    codes.pending = r;
    return S.obd.readDtcs('0A');
  }).then(function (r) {
    codes.permanent = r;
  });
}

// Clear codes dialog
var lastFocus = null;

function openClearDialog() {
  if (!S.connected || S.busy || S.live.running) return;
  lastFocus = document.activeElement;
  $('clearSafety').checked = false;
  $('clearInput').value = '';
  updateClearConfirm();
  show($('clearModal'), true);
  document.body.classList.add('modal-open');
  setTimeout(function () { $('clearCancel').focus(); }, 30);
}

function closeClearDialog() {
  show($('clearModal'), false);
  document.body.classList.remove('modal-open');
  if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* ignore */ } }
}

function updateClearConfirm() {
  var typed = $('clearInput').value.trim().toUpperCase() === 'CLEAR';
  $('clearConfirm').disabled = !(typed && $('clearSafety').checked);
}

function onClearConfirmed() {
  if ($('clearConfirm').disabled) return;
  closeClearDialog();
  var out = $('codesOut');
  clear(out);
  out.appendChild(h('p', { class: 'muted small', text: 'Sending the clear command...' }));
  run('Clearing trouble codes', function () {
    return S.obd.clearDtcs().then(function (r) {
      clear(out);
      if (!r || !r.ok) {
        out.appendChild(notice('bad', 'The car did not clear the codes',
          (r && r.message) || 'Make sure the engine is off and the ignition is on, then try again. Some cars refuse while the engine is running.'));
        return;
      }
      logger.log('info', 'Codes cleared by user.');
      S.results.freeze = null;
      S.results.readiness = null;
      // The used car check and readiness shown earlier describe the car before the clear.
      S.results.check = null;
      clear($('checkOut'));
      clear($('readinessOut'));
      clear($('freezeOut'));
      $('checkOut').appendChild(h('p', { class: 'muted small', text: 'Codes were cleared, so the earlier check results no longer apply. Run the check again to see the current state.' }));
      out.appendChild(notice('ok', 'Codes cleared', TEXT.clear.success));
      var codes = { stored: null, pending: null, permanent: null, at: new Date() };
      return delay(400).then(function () { return readCodesInto(codes); }).then(function () {
        S.results.codes = codes;
        var left = countCodes(codes.stored) + countCodes(codes.pending);
        out.appendChild(left === 0
          ? notice('info', 'Checked again: no stored or pending codes', TEXT.clear.afterwards)
          : notice('warn', 'Some codes are still there', 'The car reported codes again straight away. The fault is likely still present. ' + TEXT.clear.afterwards));
        out.appendChild(renderCodeGroups(codes));
      });
    });
  }, out);
}

// ---------------------------------------------------------------- readiness

function renderReadinessBody(r) {
  var wrap = h('div');
  var mons = Array.isArray(r.monitors) ? r.monitors : [];
  var used = mons.filter(function (m) { return m.available; });
  var ready = used.filter(function (m) { return m.complete; });
  // Same rule as the used car check findings: count the non-continuous monitors that are not finished.
  var notReady = used.filter(function (m) { return !m.complete && !m.continuous; }).length;
  var contNotReady = used.filter(function (m) { return !m.complete && m.continuous; }).length;

  if (typeof r.milOn === 'boolean') {
    wrap.appendChild(r.milOn
      ? notice('bad', 'Check engine light is ON', 'The car has at least one confirmed fault' + (typeof r.dtcCount === 'number' ? ' (it reports ' + r.dtcCount + ' stored code' + (r.dtcCount === 1 ? '' : 's') + ')' : '') + '. Read the trouble codes to see which.')
      : notice('ok', 'Check engine light is off', typeof r.dtcCount === 'number' && r.dtcCount > 0 ? 'But the car reports ' + r.dtcCount + ' stored code(s). Read the codes to see them.' : null));
  }
  if (used.length) {
    var summary = ready.length + ' of ' + used.length + ' monitors ready.';
    var advice;
    if (notReady === 0) advice = contNotReady ? ' The main self-tests have completed.' : ' All self-tests have completed. That is a good sign.';
    else if (notReady === 1) advice = ' One not ready is fairly common after short trips, especially the fuel vapour (EVAP) test.';
    else advice = ' Two or more not ready often means the codes were cleared or the battery was disconnected recently. Drive normally for a few days and check again.';
    wrap.appendChild(h('p', null, [h('strong', { text: summary }), advice]));
  }
  if (r.ignition) {
    wrap.appendChild(h('p', { class: 'small muted', text: 'Engine type reported: ' + (r.ignition === 'compression' ? 'diesel (compression ignition)' : 'petrol (spark ignition)') + '.' }));
  }
  var ul = h('ul', { class: 'monitors' });
  var sorted = mons.slice().sort(function (a, b) {
    function rank(m) { return !m.available ? 2 : (m.complete ? 1 : 0); }
    return rank(a) - rank(b);
  });
  sorted.forEach(function (m) {
    var cls = !m.available ? 'na' : (m.complete ? 'ready' : 'not');
    var label = !m.available ? TEXT.readiness.notUsed : (m.complete ? TEXT.readiness.ready : TEXT.readiness.notReady);
    ul.appendChild(h('li', { class: 'monitor' }, [
      h('div', null, [
        h('div', { class: 'monitor-name', text: m.name || m.key }),
        m.explain && m.available ? h('div', { class: 'monitor-explain', text: m.explain }) : null
      ]),
      h('span', { class: 'mstate mstate-' + cls, text: label })
    ]));
  });
  wrap.appendChild(ul);
  return wrap;
}

function onReadiness() {
  var out = $('readinessOut');
  clear(out);
  out.appendChild(h('p', { class: 'muted small', text: 'Reading readiness monitors...' }));
  run('Reading readiness monitors', function () {
    return S.obd.readiness().then(function (r) {
      S.results.readiness = r;
      clear(out);
      out.appendChild(h('h3', { text: 'Readiness monitors' }));
      out.appendChild(h('p', { class: 'small muted', text: TEXT.readiness.help }));
      out.appendChild(renderReadinessBody(r || {}));
    });
  }, out);
}

// ---------------------------------------------------------------- freeze frame

function onFreeze() {
  var out = $('freezeOut');
  clear(out);
  out.appendChild(h('p', { class: 'muted small', text: 'Reading the freeze frame...' }));
  run('Reading freeze frame', function () {
    return S.obd.freezeFrame().then(function (r) {
      r = r || {};
      S.results.freeze = r;
      clear(out);
      var vals = Array.isArray(r.values) ? r.values : [];
      if (!vals.length) {
        out.appendChild(notice('info', 'No freeze frame', r.message && r.status !== 'nodata' ? r.message : TEXT.freeze.none));
        return;
      }
      if (r.dtc) {
        var d = safeDescribe(r.dtc);
        out.appendChild(notice('warn', 'Saved when code ' + r.dtc + ' was stored', d.description || null));
      }
      var table = h('table', { class: 'table' });
      vals.forEach(function (v) {
        var pid = pidNum(v.pid);
        var def = pidDef(pid);
        var val = v.text != null ? v.text : (v.value != null ? v.value + (v.unit ? ' ' + v.unit : '') : '--');
        table.appendChild(h('tr', null, [
          h('td', { text: v.name || pidName(pid) }),
          h('td', { class: valClass(val), text: String(val) })
        ]));
      });
      out.appendChild(table);
      out.appendChild(h('p', { class: 'small muted', text: 'This snapshot is erased if you clear the codes. Include it in a report for your mechanic.' }));
    });
  }, out);
}

// ---------------------------------------------------------------- live data

function supportedLivePids() {
  var all = (S.supported && S.supported.all) || new Set();
  var list = [];
  Object.keys(PIDS).forEach(function (k) {
    var pid = parseInt(k, 10);
    if (isNaN(pid)) return;
    if (BITMAP_PIDS.indexOf(pid) >= 0 || SKIP_LIVE_PIDS.indexOf(pid) >= 0) return;
    if (all.has(pid)) list.push(pid);
  });
  list.sort(function (a, b) { return a - b; });
  return list;
}

function setupLive() {
  var avail = supportedLivePids();
  var sel = GAUGE_DEFAULTS.filter(function (p) { return avail.indexOf(p) >= 0; });
  if (!sel.length) sel = avail.slice(0, 6);
  S.live.selected = sel;
  S.live.values = {};
  S.live.error = null;
  renderPicker(avail);
  renderTiles();
  updateButtons();
}

function renderPicker(avail) {
  var list = $('pickerList');
  clear(list);
  if (!avail.length) {
    list.appendChild(h('p', { class: 'muted small', text: S.connected ? 'This car did not report any live readings this app knows.' : 'Connect first to see the readings your car supports.' }));
    return;
  }
  avail.forEach(function (pid) {
    var def = pidDef(pid);
    var cb = h('input', { type: 'checkbox', value: String(pid) });
    cb.checked = S.live.selected.indexOf(pid) >= 0;
    cb.addEventListener('change', function () {
      var i = S.live.selected.indexOf(pid);
      if (cb.checked && i < 0) S.live.selected.push(pid);
      if (!cb.checked && i >= 0) S.live.selected.splice(i, 1);
      renderTiles();
      updateButtons();
    });
    list.appendChild(h('label', { class: 'check small' }, [cb, h('span', { text: (def ? def.name : pidName(pid)) })]));
  });
}

function renderTiles() {
  var grid = $('tiles');
  clear(grid);
  S.live.tiles = {};
  if (S.live.openPid != null && S.live.selected.indexOf(S.live.openPid) < 0) closeTileExplain();
  S.live.selected.forEach(function (pid) {
    var def = pidDef(pid) || {};
    var valEl = h('span', { class: 'tile-num', text: '--' });
    var unitEl = h('span', { class: 'tile-unit', text: def.unit || '' });
    var valueWrap = h('div', { class: 'tile-value' }, [valEl, unitEl]);
    var fill = h('div', { class: 'tile-fill' });
    var tile = h('button', { type: 'button', class: 'tile stale', 'aria-expanded': S.live.openPid === pid ? 'true' : 'false' }, [
      h('div', { class: 'tile-name', text: def.name || pidName(pid) }),
      valueWrap,
      h('div', { class: 'tile-bar', 'aria-hidden': 'true' }, fill)
    ]);
    tile.addEventListener('click', function () { toggleTileExplain(pid); });
    grid.appendChild(tile);
    S.live.tiles[pid] = { tile: tile, valEl: valEl, unitEl: unitEl, valueWrap: valueWrap, fill: fill };
    var last = S.live.values[pid];
    if (last) paintTile(pid, last);
  });
}

function toggleTileExplain(pid) {
  if (S.live.openPid === pid) { closeTileExplain(); return; }
  S.live.openPid = pid;
  var def = pidDef(pid) || {};
  var box = $('tileExplain');
  clear(box);
  box.appendChild(h('strong', { text: def.name || pidName(pid) }));
  box.appendChild(h('p', { text: def.explain || 'No extra explanation for this reading.' }));
  if (typeof def.min === 'number' && typeof def.max === 'number') {
    box.appendChild(h('p', { class: 'small muted', text: 'Bar range: ' + def.min + ' to ' + def.max + (def.unit ? ' ' + def.unit : '') + '.' }));
  }
  var last = S.live.values[pid];
  if (last && last.ecu) box.appendChild(h('p', { class: 'small muted', text: 'Answered by: ' + safeEcuLabel(last.ecu) + '. OBD reading 01 ' + hex2(pid) + '.' }));
  show(box, true);
  Object.keys(S.live.tiles).forEach(function (k) {
    S.live.tiles[k].tile.setAttribute('aria-expanded', parseInt(k, 10) === pid ? 'true' : 'false');
  });
}

function closeTileExplain() {
  S.live.openPid = null;
  show($('tileExplain'), false);
  Object.keys(S.live.tiles).forEach(function (k) { S.live.tiles[k].tile.setAttribute('aria-expanded', 'false'); });
}

function paintTile(pid, r) {
  var t = S.live.tiles[pid];
  if (!t) return;
  var def = pidDef(pid) || {};
  var ok = r && (r.value != null || r.text != null) && r.status !== 'nodata' && r.status !== 'timeout';
  t.tile.classList.toggle('stale', !ok);
  if (!ok) { t.valEl.textContent = '--'; return; }
  var isNum = typeof r.value === 'number' && isFinite(r.value);
  var display;
  if (isNum) {
    var v = r.value;
    display = Math.abs(v) >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString();
    t.unitEl.textContent = r.unit != null ? r.unit : (def.unit || '');
  } else {
    display = r.text != null ? String(r.text) : String(r.value);
    t.unitEl.textContent = '';
  }
  t.valEl.textContent = display;
  t.valueWrap.classList.toggle('text-val', !isNum);
  if (isNum && typeof def.min === 'number' && typeof def.max === 'number' && def.max > def.min) {
    var pct = (r.value - def.min) / (def.max - def.min);
    t.fill.style.width = Math.max(0, Math.min(100, pct * 100)) + '%';
  } else {
    t.fill.style.width = '0%';
  }
}

function normalizeReadings(res) {
  if (!res) return [];
  var arr = null;
  if (Array.isArray(res)) arr = res;
  else if (Array.isArray(res.values)) arr = res.values;
  else if (Array.isArray(res.results)) arr = res.results;
  else if (Array.isArray(res.readings)) arr = res.readings;
  else if (typeof Map !== 'undefined' && res instanceof Map) arr = Array.from(res.values());
  else if (typeof res === 'object') {
    arr = Object.keys(res).map(function (k) {
      var v = res[k];
      if (v && typeof v === 'object') { if (v.pid == null) v.pid = parseInt(k, 10); return v; }
      return null;
    });
  }
  return (arr || []).filter(function (x) { return x && typeof x === 'object' && x.pid != null; });
}

function liveLoop(gen) {
  var count = 0;
  var t0 = Date.now();
  var lastRate = t0;
  // Only the loop with the current generation may keep running.
  function mine() { return S.live.running && S.live.gen === gen && !!S.obd; }
  function cycle() {
    if (!mine()) return Promise.resolve();
    var sel = S.live.selected.slice();
    if (!sel.length) return delay(300).then(cycle);
    var chunks = [];
    for (var i = 0; i < sel.length; i += 6) chunks.push(sel.slice(i, i + 6));
    var p = Promise.resolve();
    chunks.forEach(function (chunk) {
      p = p.then(function () {
        if (!mine()) return;
        return S.obd.readPids(chunk).then(function (res) {
          var got = normalizeReadings(res);
          var seen = {};
          got.forEach(function (r) {
            var pid = pidNum(r.pid);
            seen[pid] = true;
            var entry = { value: r.value, unit: r.unit, text: r.text, ecu: r.ecu, status: r.status, at: Date.now() };
            var good = !r.status || r.status === 'ok';
            if (good && (r.value != null || r.text != null)) S.live.values[pid] = entry;
            paintTile(pid, entry);
          });
          chunk.forEach(function (pid) { if (!seen[pid]) paintTile(pid, { status: 'nodata' }); });
        }, function (e) {
          logger.log('warn', 'Live read failed: ' + ((e && e.message) || e));
          return delay(250);
        });
      });
    });
    return p.then(function () {
      count++;
      var now = Date.now();
      if (mine() && now - lastRate > 1500) {
        var rate = count / ((now - t0) / 1000);
        $('liveRate').textContent = 'About ' + (Math.round(rate * 10) / 10) + ' updates per second';
        lastRate = now;
      }
      // Yield so the page stays responsive.
      return delay(S.kind === 'sim' ? 120 : 0);
    }).then(cycle);
  }
  return cycle();
}

function onLiveToggle() {
  if (S.live.running) { stopLive(); return; }
  // A previous loop is still finishing its last request: wait for it (the button is disabled meanwhile).
  if (S.live.promise) return;
  if (!S.connected || S.busy || !S.live.selected.length) return;
  var gen = ++S.live.gen;
  S.live.running = true;
  S.live.error = null;
  logger.log('info', '== Live data started');
  $('liveRate').textContent = 'Starting...';
  updateButtons();
  var p = liveLoop(gen).catch(function (e) {
    logger.log('error', 'Live loop stopped: ' + ((e && e.stack) || e));
    if (S.live.gen === gen) S.live.error = friendlyError(e);
  }).then(function () {
    if (S.live.promise === p) {
      S.live.running = false;
      S.live.promise = null;
      $('liveRate').textContent = '';
    }
    logger.log('info', '== Live data stopped');
    updateButtons();
  });
  S.live.promise = p;
}

function stopLive() {
  S.live.running = false;
  $('liveRate').textContent = 'Stopping...';
  updateButtons();
  return S.live.promise || Promise.resolve();
}

// ---------------------------------------------------------------- report

function liveSnapshot() {
  var out = [];
  Object.keys(S.live.values).forEach(function (k) {
    var pid = parseInt(k, 10);
    var v = S.live.values[k];
    if (!v) return;
    var text = typeof v.value === 'number' ? (Math.abs(v.value) >= 100 ? Math.round(v.value) : Math.round(v.value * 10) / 10) + (v.unit ? ' ' + v.unit : '') : (v.text != null ? String(v.text) : String(v.value));
    out.push({ pid: pid, name: pidName(pid), text: text });
  });
  out.sort(function (a, b) { return a.pid - b.pid; });
  return out;
}

function onBuildReport() {
  var init = S.init || {};
  var info = (S.transport && S.transport.info) || {};
  var text;
  try {
    text = buildReport({
      appVersion: APP_VERSION,
      generatedAt: new Date(),
      includeVin: $('includeVin').checked,
      connection: S.kind ? {
        kind: S.kind,
        scenario: S.scenario,
        deviceName: info.deviceName || null,
        elmVersion: init.elmVersion || null,
        protocol: init.protocol || null,
        protocolNumber: init.protocolNumber || null,
        voltage: init.voltage ? voltText(init.voltage) : null
      } : null,
      vin: S.results.vin || (S.results.check ? S.results.check.vin : null),
      check: S.results.check,
      codes: S.results.codes,
      readiness: S.results.readiness,
      freeze: S.results.freeze,
      live: liveSnapshot()
    });
  } catch (e) {
    logger.log('error', 'Report failed: ' + ((e && e.stack) || e));
    $('reportMsg').textContent = 'The report could not be built. Details are in the debug console.';
    show($('reportBox'), true);
    return;
  }
  $('reportText').value = text;
  show($('reportBox'), true);
  $('btnShare').textContent = navigator.share ? 'Share' : 'Copy to share';
  $('reportMsg').textContent = 'You can edit the text before sharing. Nothing is sent unless you tap Share or Copy.';
}

function onShare() {
  var text = $('reportText').value;
  if (!text) return;
  if (navigator.share) {
    navigator.share({ title: 'OBD Web car report', text: text }).then(function () {
      $('reportMsg').textContent = 'Shared.';
    }, function (e) {
      if (e && e.name === 'AbortError') { $('reportMsg').textContent = 'Sharing cancelled.'; return; }
      logger.log('warn', 'Share failed: ' + ((e && e.message) || e));
      doCopyReport('Sharing is not available here, so the report was copied instead.');
    });
  } else {
    doCopyReport('Copied. Paste it into a message, email or note.');
  }
}

function doCopyReport(okText) {
  var text = $('reportText').value;
  copyText(text).then(function (ok) {
    if (ok) $('reportMsg').textContent = okText || 'Copied to the clipboard.';
    else {
      $('reportText').focus();
      $('reportText').select();
      $('reportMsg').textContent = 'Could not copy automatically. The text is selected, use the Copy option from the menu.';
    }
  });
}

// ---------------------------------------------------------------- debug console

var logState = { pending: [], scheduled: false, lines: 0 };
var MAX_DOM_LINES = 1500;

function fmtEntry(entry) {
  var secs = ((entry.t || 0) / 1000).toFixed(3);
  while (secs.length < 8) secs = ' ' + secs;
  var text = String(entry.text == null ? '' : entry.text);
  if (entry.kind === 'rx' || entry.kind === 'tx') text = text.replace(/\r\n|\r|\n/g, '\u23CE');
  return '[' + secs + '] ' + String(entry.kind || 'info').toUpperCase() + ' ' + text;
}

function logLine(entry) {
  return h('span', { class: 'l-' + entry.kind, text: fmtEntry(entry) + '\n' });
}

function flushLog() {
  logState.scheduled = false;
  var view = $('logView');
  var items = logState.pending;
  logState.pending = [];
  if (!items.length) return;
  var frag = document.createDocumentFragment();
  items.forEach(function (e) { frag.appendChild(logLine(e)); });
  view.appendChild(frag);
  logState.lines += items.length;
  if (logState.lines > MAX_DOM_LINES) {
    var drop = logState.lines - MAX_DOM_LINES;
    for (var i = 0; i < drop && view.firstChild; i++) view.removeChild(view.firstChild);
    logState.lines = MAX_DOM_LINES;
  }
  if ($('autoScroll').checked) view.scrollTop = view.scrollHeight;
}

function onLogEntry(entry) {
  logState.pending.push(entry);
  if (!logState.scheduled) {
    logState.scheduled = true;
    (window.requestAnimationFrame || function (f) { return setTimeout(f, 50); })(flushLog);
  }
}

function initConsole() {
  var existing = logger.entries();
  existing.slice(-MAX_DOM_LINES).forEach(onLogEntry);
  logger.subscribe(onLogEntry);
  $('btnCopyLog').addEventListener('click', function () {
    var txt = logger.toText();
    copyText(txt || '(log is empty)').then(function (ok) {
      $('logMsg').textContent = ok ? 'Log copied (' + logger.entries().length + ' lines).' : 'Could not copy automatically. Long-press the log to select it.';
    });
  });
  $('btnClearLog').addEventListener('click', function () {
    logger.clear();
    clear($('logView'));
    logState.lines = 0;
    logState.pending = [];
    $('logMsg').textContent = 'Log cleared.';
  });
  $('consoleBox').addEventListener('toggle', function () {
    if ($('consoleBox').open && $('autoScroll').checked) $('logView').scrollTop = $('logView').scrollHeight;
  });
}

// ---------------------------------------------------------------- boot

function bind() {
  $('btnConnect').addEventListener('click', onConnectBle);
  $('btnSim').addEventListener('click', onConnectSim);
  $('btnRetry').addEventListener('click', onRetry);
  $('btnDisconnect').addEventListener('click', onDisconnectClick);
  $('btnProbe').addEventListener('click', onProbe);
  $('btnCheck').addEventListener('click', onCheck);
  $('btnRead').addEventListener('click', onReadCodes);
  $('btnClear').addEventListener('click', openClearDialog);
  $('btnReadiness').addEventListener('click', onReadiness);
  $('btnFreeze').addEventListener('click', onFreeze);
  $('btnLive').addEventListener('click', onLiveToggle);
  document.addEventListener('visibilitychange', function () {
    logger.log('info', 'Page is now ' + document.visibilityState + (document.visibilityState === 'hidden' ? ' (phone locked or another app in front). iOS may drop Bluetooth while hidden.' : '.'));
    if (document.visibilityState === 'visible' && S.connected && S.kind === 'ble') keepAwake(true);
  });
  $('btnReport').addEventListener('click', onBuildReport);
  $('btnShare').addEventListener('click', onShare);
  $('btnCopyReport').addEventListener('click', function () { doCopyReport(); });

  $('clearInput').addEventListener('input', updateClearConfirm);
  $('clearSafety').addEventListener('change', updateClearConfirm);
  $('clearCancel').addEventListener('click', closeClearDialog);
  $('clearConfirm').addEventListener('click', onClearConfirmed);
  $('clearModal').addEventListener('click', function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute('data-close')) closeClearDialog();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('clearModal').hidden) closeClearDialog();
  });
  $('clearInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') onClearConfirmed();
  });

  window.addEventListener('pagehide', function () {
    if (S.transport) { try { S.transport.disconnect(); } catch (e) { /* ignore */ } }
  });
}

function boot() {
  fillStaticText();
  initConsole();
  bind();
  if (!navigator.bluetooth) {
    show($('noBtBox'), true);
    $('btnConnect').title = 'Bluetooth is not available in this browser';
  }
  renderPicker([]);
  updateButtons();
  setStatus('idle', 'Not connected. Follow the steps under "How this works" if this is your first time, then tap Connect adapter.');
  logger.log('info', 'OBD Web ' + APP_VERSION + ' loaded. Web Bluetooth ' + (navigator.bluetooth ? 'available' : 'not available') + '.');
}

window.addEventListener('error', function (e) {
  logger.log('error', 'Page error: ' + (e.message || e) + (e.filename ? ' at ' + e.filename + ':' + e.lineno : ''));
});
window.addEventListener('unhandledrejection', function (e) {
  var r = e.reason;
  logger.log('error', 'Unhandled: ' + ((r && r.stack) || r));
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
