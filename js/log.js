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
