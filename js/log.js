// Debug logger. Everything stays in memory, nothing is stored or sent anywhere.

var MAX_ENTRIES = 5000;

function nowMs() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function pad(str, width) {
  str = String(str);
  while (str.length < width) str = ' ' + str;
  return str;
}

function showRaw(text) {
  return String(text)
    .replace(/\r\n/g, '⏎')
    .replace(/\r/g, '⏎')
    .replace(/\n/g, '⏎');
}

export class Logger {
  constructor() {
    this._start = nowMs();
    this._entries = [];
    this._subs = [];
  }

  log(kind, text) {
    var k = kind;
    if (k !== 'tx' && k !== 'rx' && k !== 'info' && k !== 'warn' && k !== 'error') k = 'info';
    var entry = {
      t: Math.round((nowMs() - this._start) * 1000) / 1000,
      kind: k,
      text: text == null ? '' : String(text)
    };
    this._entries.push(entry);
    if (this._entries.length > MAX_ENTRIES) {
      this._entries.splice(0, this._entries.length - MAX_ENTRIES);
    }
    var subs = this._subs.slice();
    for (var i = 0; i < subs.length; i++) {
      try { subs[i](entry); } catch (e) { /* a broken subscriber must not break logging */ }
    }
    return entry;
  }

  entries() {
    return this._entries.slice();
  }

  // Milliseconds on the same clock and origin as entry.t, so other timestamps line up with the log.
  now() {
    return Math.round((nowMs() - this._start) * 1000) / 1000;
  }

  subscribe(fn) {
    var self = this;
    if (typeof fn !== 'function') return function () {};
    this._subs.push(fn);
    return function unsubscribe() {
      var idx = self._subs.indexOf(fn);
      if (idx >= 0) self._subs.splice(idx, 1);
    };
  }

  clear() {
    this._entries = [];
  }

  static format(entry) {
    var secs = (entry.t / 1000).toFixed(3);
    var text = entry.kind === 'rx' || entry.kind === 'tx' ? showRaw(entry.text) : entry.text;
    return '[' + pad(secs, 8) + '] ' + entry.kind.toUpperCase() + ' ' + text;
  }

  toText() {
    var out = [];
    for (var i = 0; i < this._entries.length; i++) out.push(Logger.format(this._entries[i]));
    return out.join('\n');
  }
}

export const logger = new Logger();

// Turns a user agent string into "Bluefy 3.5 on iOS 18.6" style text, or null if it cannot.
// Only used for the debug log. Note: recent iOS versions freeze the OS number in the user agent,
// so the iOS version shown may be lower than the real one.
export function describeUserAgent(ua) {
  var s = String(ua || '');
  if (!s) return null;
  function ver(re) { var m = re.exec(s); return m ? m[1].replace(/_/g, '.') : null; }
  var os = null;
  var v;
  if ((v = ver(/(?:iPhone|CPU) OS (\d+(?:[._]\d+)*)/))) os = 'iOS ' + v;
  else if (/iPad/.test(s) && (v = ver(/OS (\d+(?:[._]\d+)*)/))) os = 'iPadOS ' + v;
  else if ((v = ver(/Android (\d+(?:\.\d+)*)/))) os = 'Android ' + v;
  else if ((v = ver(/Mac OS X (\d+(?:[._]\d+)*)/))) os = 'macOS ' + v;
  else if ((v = ver(/Windows NT (\d+(?:\.\d+)*)/))) os = 'Windows NT ' + v;
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux/.test(s)) os = 'Linux';
  var browser = null;
  if ((v = ver(/Bluefy\/(\d+(?:\.\d+)*)/i))) browser = 'Bluefy ' + v;
  else if ((v = ver(/EdgiOS\/(\d+(?:\.\d+)*)/)) || (v = ver(/Edg\/(\d+(?:\.\d+)*)/))) browser = 'Edge ' + v;
  else if ((v = ver(/CriOS\/(\d+(?:\.\d+)*)/))) browser = 'Chrome ' + v;
  else if ((v = ver(/FxiOS\/(\d+(?:\.\d+)*)/)) || (v = ver(/Firefox\/(\d+(?:\.\d+)*)/))) browser = 'Firefox ' + v;
  else if ((v = ver(/Chrome\/(\d+(?:\.\d+)*)/))) browser = 'Chrome ' + v;
  else if (/AppleWebKit/.test(s) && /Mobile\//.test(s) && !/Safari\//.test(s)) browser = 'iOS app browser (WebKit, name not in user agent)';
  else if ((v = ver(/Version\/(\d+(?:\.\d+)*).*Safari\//))) browser = 'Safari ' + v + ' (or a browser that reports as Safari)';
  if (!browser || !os) return null;
  return browser + ' on ' + os;
}
