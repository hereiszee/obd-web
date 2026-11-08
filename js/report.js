// Builds a clean plain-text report from whatever the user has read so far.
// Pure function, no DOM, no network. Text only, so it can be shared anywhere.

import { describeDtc } from './dtc-db.js?v=1.0.2';

var LINE = '========================================';
var SUB = '----------------------------------------';

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function formatDate(d) {
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear() + ', ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ' (local time)';
}

function safeDescribe(code) {
  try {
    var d = describeDtc(code);
    if (d) return d;
  } catch (e) { /* fall through */ }
  return { code: code, description: 'Description not available', severity: null };
}

function vinOf(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v.vin === 'string') return v.vin;
  return '';
}

function section(out, title) {
  out.push('');
  out.push(title.toUpperCase());
  out.push(SUB);
}

function countCodes(r) {
  var n = 0;
  if (r && Array.isArray(r.byEcu)) {
    for (var i = 0; i < r.byEcu.length; i++) n += (r.byEcu[i].codes || []).length;
  }
  return n;
}

function codeBlock(out, title, r) {
  out.push(title + ':');
  if (!r) { out.push('  Not read.'); return; }
  if (r.supported === false && r.status && r.status !== 'unsupported' && r.status !== 'nodata') { out.push('  Could not be read.'); return; }
  if (r.supported === false) { out.push('  Not supported by this car.'); return; }
  if (countCodes(r) === 0) {
    out.push('  None.');
    return;
  }
  for (var i = 0; i < r.byEcu.length; i++) {
    var ecu = r.byEcu[i];
    var codes = ecu.codes || [];
    for (var j = 0; j < codes.length; j++) {
      var d = safeDescribe(codes[j]);
      var line = '  ' + codes[j] + '  ' + (d.description || '');
      out.push(line);
      var meta = [];
      meta.push('From: ' + (ecu.label || ecu.ecu || 'unknown module'));
      if (d.severity) meta.push('Severity: ' + d.severity);
      if (d.manufacturerSpecific) meta.push('maker specific code');
      out.push('      ' + meta.join(', '));
    }
  }
}

function monitorsBlock(out, readiness) {
  if (!readiness || !Array.isArray(readiness.monitors)) return;
  var used = readiness.monitors.filter(function (m) { return m.available; });
  var ready = used.filter(function (m) { return m.complete; });
  if (typeof readiness.milOn === 'boolean') {
    out.push('Check engine light: ' + (readiness.milOn ? 'ON' : 'off'));
  }
  if (typeof readiness.dtcCount === 'number') {
    out.push('Codes the car says are stored: ' + readiness.dtcCount);
  }
  out.push('Readiness monitors: ' + ready.length + ' of ' + used.length + ' ready');
  for (var i = 0; i < used.length; i++) {
    out.push('  ' + (used[i].complete ? '[ready]     ' : '[NOT ready] ') + used[i].name);
  }
}

function flagTag(level) {
  if (level === 'warn') return '[!]  ';
  if (level === 'ok') return '[ok] ';
  return '[i]  ';
}

/**
 * data: {
 *   appVersion, generatedAt: Date, includeVin: boolean,
 *   connection: {kind:'ble'|'sim', scenario, deviceName, elmVersion, protocol, protocolNumber, voltage},
 *   check: usedCarCheck result, codes: {stored, pending, permanent, at}, readiness, freeze,
 *   live: [{name, text}], vin: string
 * }
 */
export function buildReport(data) {
  data = data || {};
  var out = [];
  var when = data.generatedAt instanceof Date ? data.generatedAt : new Date();
  var conn = data.connection || null;

  out.push('OBD WEB CAR REPORT');
  out.push(LINE);
  out.push('Created: ' + formatDate(when));
  if (conn) {
    if (conn.kind === 'sim') {
      out.push('Source: SIMULATED CAR (demo data, not a real vehicle)');
    } else {
      out.push('Source: Bluetooth adapter' + (conn.deviceName ? ' "' + conn.deviceName + '"' : ''));
    }
    if (conn.elmVersion) out.push('Adapter chip: ' + conn.elmVersion);
    if (conn.protocol) out.push('Car protocol: ' + conn.protocol);
    if (conn.voltage) out.push('Battery voltage at the port: ' + conn.voltage);
  } else {
    out.push('Source: no car connected when this report was made');
  }

  // Vehicle
  var vin = vinOf(data.vin) || (data.check ? vinOf(data.check.vin) : '');
  section(out, 'Vehicle');
  if (!vin) out.push('VIN: not read');
  else if (data.includeVin) out.push('VIN: ' + vin);
  else out.push('VIN: hidden (tick "Include VIN" to add it)');

  // Findings
  var check = data.check;
  if (check && Array.isArray(check.flags) && check.flags.length) {
    section(out, 'Used car check findings');
    for (var i = 0; i < check.flags.length; i++) {
      var f = check.flags[i];
      if (!f || !f.text) continue;
      var text = String(f.text);
      if (!data.includeVin && vin) text = text.split(vin).join('(VIN hidden)');
      out.push(flagTag(f.level) + text);
    }
    out.push('Key: [!] needs attention, [i] for information, [ok] looks good');
  }

  // Readiness
  var readiness = data.readiness || (check && check.readiness) || null;
  if (readiness && Array.isArray(readiness.monitors)) {
    section(out, 'Warning light and readiness');
    monitorsBlock(out, readiness);
  }

  // Codes
  var codes = data.codes || null;
  var fromCheck = check ? {
    stored: check.stored || (check.dtcs && check.dtcs.stored) || (check.codes && check.codes.stored) || null,
    pending: check.pending || (check.dtcs && check.dtcs.pending) || (check.codes && check.codes.pending) || null,
    permanent: check.permanent || (check.dtcs && check.dtcs.permanent) || (check.codes && check.codes.permanent) || null
  } : null;
  var useCodes = codes || (fromCheck && (fromCheck.stored || fromCheck.pending || fromCheck.permanent) ? fromCheck : null);
  if (useCodes) {
    section(out, 'Trouble codes');
    codeBlock(out, 'Stored (confirmed)', useCodes.stored);
    codeBlock(out, 'Pending (not confirmed yet)', useCodes.pending);
    codeBlock(out, 'Permanent', useCodes.permanent);
  }

  // Freeze frame
  var ff = data.freeze;
  if (ff && Array.isArray(ff.values) && ff.values.length) {
    var title = 'Freeze frame';
    if (ff.dtc) {
      var dd = safeDescribe(ff.dtc);
      title += ' (saved for ' + ff.dtc + (dd.description ? ', ' + dd.description : '') + ')';
    }
    section(out, title);
    for (var k = 0; k < ff.values.length; k++) {
      var v = ff.values[k];
      var val = v.text != null ? v.text : (v.value != null ? v.value + (v.unit ? ' ' + v.unit : '') : '--');
      out.push('  ' + (v.name || ('PID ' + v.pid)) + ': ' + val);
    }
  }

  // Live data
  if (Array.isArray(data.live) && data.live.length) {
    section(out, 'Live data snapshot (last values seen)');
    for (var m = 0; m < data.live.length; m++) {
      out.push('  ' + data.live[m].name + ': ' + data.live[m].text);
    }
  }

  if (!check && !useCodes && !readiness && !(ff && ff.values && ff.values.length) && !(data.live && data.live.length)) {
    section(out, 'Nothing read yet');
    out.push('Connect to the car and run the Used car check or Read codes first.');
  }

  out.push('');
  out.push(LINE);
  out.push('Made with OBD Web' + (data.appVersion ? ' ' + data.appVersion : '') + '. Everything was read and built on the phone. Nothing was uploaded.');
  out.push('This is a helpful first look, not a professional inspection.');
  return out.join('\n');
}
