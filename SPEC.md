# obd-web build spec (shared contract for all modules)

Static, privacy-first OBD-II web app for GitHub Pages. Runs in Bluefy (iOS, Web Bluetooth)
and desktop Chrome/Edge. Adapter: Vgate vLinker MC+ (BLE, ELM327 command set).

## Hard rules
- Plain ES modules (`<script type="module">`), no build step, no npm deps, no CDNs, no analytics,
  no fetch() to anywhere, no localStorage/IndexedDB of car data. All data in memory only.
- All user-facing text in plain English. NO em dashes (—) or en dashes (–) anywhere in UI text
  or comments shown to the user. Minimise semicolons in prose. Use commas, periods, parentheses.
- Never tell the user to pair the adapter in iOS Settings. Connection happens in-app only.
- Mobile-first, iPhone 13 mini viewport (375 x 812 CSS px). Must also look fine on desktop.
- Relative paths only (site is served from https://hereiszee.github.io/obd-web/).
- Must work in Safari-engine (Bluefy uses WKWebView): avoid very new JS syntax beyond ES2020,
  no top-level await, no import maps, no `Array.prototype.at` dependency, no CSS nesting.

## File layout
```
index.html
css/app.css
js/app.js          UI + wiring (owner: UI agent)
js/ui-text.js      plain-English explainer strings for sections (owner: UI agent)
js/ble.js          BleTransport (owner: transport agent)
js/sim.js          SimTransport (owner: sim agent)
js/elm.js          Elm327 command queue + init + probe (owner: transport agent)
js/obd.js          OBD protocol parsing + high-level reads (owner: protocol agent)
js/pids.js         Mode 01 PID table with decoders + explanations (owner: pids agent)
js/dtc-db.js       DTC description database (owner: dtc agent)
js/report.js       Shareable plain-text report builder (owner: UI agent)
js/log.js          Debug logger (owner: transport agent)
tests/run.mjs      Node test runner: `node tests/run.mjs` (owner: integrator)
README.md
.nojekyll
```

## Interfaces

### js/log.js
```js
export class Logger {
  constructor()               // in-memory array of entries, max 5000 (drop oldest)
  log(kind, text)             // kind: 'tx' | 'rx' | 'info' | 'warn' | 'error'
  entries()                   // [{t: ms since start, kind, text}]
  subscribe(fn)               // fn(entry) on each new entry. returns unsubscribe fn
  clear()
  toText()                    // "[  12.345] TX ATZ\n[  12.400] RX ELM327 v1.5" etc. rx shows raw incl \r as ⏎
}
export const logger = new Logger();   // shared singleton
```

### Transport interface (implemented by BleTransport in js/ble.js and SimTransport in js/sim.js)
```js
class Transport {
  name                         // 'ble' | 'sim'
  async connect()              // BLE: MUST be called directly from a tap handler (no await before requestDevice)
  async disconnect()
  isConnected()
  async write(text)            // text already ends with '\r'. BLE chunks into <=20 byte writes.
  onData = null                // set by Elm327: fn(string) called with each raw notification chunk (decoded ASCII)
  onDisconnect = null          // fn(reasonString)
  info                         // object describing device: {deviceName, serviceUuid, writeUuid, notifyUuid, allServices:[...]}
}
```
BleTransport details:
- `navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: CANDIDATE_SERVICES })`.
  Bluefy supports acceptAllDevices. Also export `CANDIDATE_SERVICES` including 16-bit 0xfff0, 0xffe0, 0x18f0,
  0xffb0? not needed but harmless, plus 128-bit: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2' (vLinker/OBDLink-style
  "ELM327 BLE" service seen on many clones), '0000fff0-0000-1000-8000-00805f9b34fb' etc, Nordic UART
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', and Microchip/ISSC transparent UART '49535343-fe7d-4ae5-8fa9-9fafd205e455'.
- After connect: getPrimaryServices(), for each service getCharacteristics(), log every service/char UUID and
  properties to logger. Choose notify char (notify or indicate) + write char (writeWithoutResponse preferred, else write),
  preferring same service, preferring known pairs (FFF1 notify/FFF2 write, FFE1 both, 2AF0 notify/2AF1 write,
  bef8d6c9-9c21-4c9e-b632-bd58c1009f9f in e7810a71 service).
- write(): encode ASCII, split into 20-byte chunks, write sequentially (await each). Use writeValueWithoutResponse
  if supported else writeValueWithResponse else writeValue.
- Handle gattserverdisconnected → onDisconnect.
- If `navigator.bluetooth` missing, throw Error with plain-English message: on iPhone use the Bluefy browser,
  on desktop use Chrome or Edge.

### js/elm.js
```js
export class Elm327 {
  constructor(transport, logger)
  async send(cmd, {timeout = 4000} = {})
      // queued: one command at a time. Writes cmd + '\r'. Buffers onData until '>' prompt.
      // returns {cmd, raw, lines, status, message}
      //   lines: cleaned non-empty lines, excluding echo of cmd, excluding 'SEARCHING...', 'BUS INIT: ...' prefixes stripped,
      //          'OK' kept, spaces preserved as received.
      //   status: 'ok' | 'nodata' | 'unknown' ('?') | 'unable' (UNABLE TO CONNECT) | 'canerror' | 'buserror' (BUS ERROR,
      //           BUS INIT: ...ERROR, FB ERROR, DATA ERROR, <RX ERROR, ERR94 etc) | 'stopped' | 'busy' (BUS BUSY)
      //           | 'timeout' | 'lowvoltage' (LV RESET) | 'bufferfull' (BUFFER FULL)
      //   message: plain-English explanation when status != 'ok' (e.g. nodata → "The car did not answer this request.
      //            This usually means it is not supported by this car.")
      // On timeout: resolve with status 'timeout' (not reject), clear buffer, continue queue.
      // ATZ uses timeout 5000. First OBD command after ATSP0 may take long (SEARCHING), use 10000 for it.
  async init()        // runs: ATZ, ATE0, ATL0, ATS0, ATH1, ATAT1, ATST 64? (skip, use default), ATSP0, then 0100 (timeout 12000)
                      // then ATDPN. Returns {ok, elmVersion, protocol, protocolNumber, voltage, message}
                      // If 0100 fails with unable/nodata: ok=false, message explains car must be ignition ON or READY
                      // (hybrids: press start with foot on brake until READY light), and engine bay adapter seated.
  async probe()       // runs ATI, AT@1, ATDP, ATDPN, ATRV, 0100 and returns array of results (all logged anyway)
  cancelAll()         // reject/resolve pending queue with status 'stopped' (used on disconnect)
  get headersOn()     // true after init (ATH1)
}
```
ELM replies: with ATS0 + ATH1, a CAN 11-bit line looks like `7E8064100BE3FA813` (no spaces) — header 3 hex chars,
then PCI+data. With 29-bit CAN: `18DAF11006410098180001`. Legacy protocols (J1850/ISO9141/KWP) with headers:
`486B104100BE3FA8139C` (3 header bytes, data, checksum byte at end). Parsers must handle spaces present or absent.

### js/obd.js
```js
export function parseLines(lines, protocolNumber)
  // → [{ecu: '7E8', bytes: [0x41,0x00,...]}] one entry per ECU per complete message.
  // Handles: 11-bit CAN (hdr 3 hex), 29-bit CAN (hdr 8 hex, ECU = last byte e.g. '18DAF110' → ecu '10'... label as '18DAF110'),
  // ISO-TP: single frame (PCI 0x0N), first frame (0x1N NN), consecutive (0x2N), reassemble per ECU, trim to declared length.
  // Legacy (protocol 1-5): 3 header bytes (priority, target, source), strip trailing checksum, ecu = source byte hex.
  // Also handle ELM multi-line format when headers OFF (e.g. '014\r0: 49 02 01 ...') just in case.
  // protocolNumber: from ATDPN, may be 'A6' (auto, 6) → strip 'A'. CAN = 6..9 (and A,B,C).
export const ECU_NAMES   // {'7E8':'Engine (ECM)', '7E9':'Transmission / Hybrid (TCM)', '7EA':'ECU 3', ... , '7EF'}
                         // plain-English; note Toyota hybrids often answer 7E8 engine, 7EA hybrid control etc. Use generic label
                         // "Module at 7E9" when unsure plus a best-guess.
export function ecuLabel(id)

export class Obd {
  constructor(elm)
  async query(cmdHex, opts)          // e.g. '0100' → {status, message, responses:[{ecu, bytes}]} filters responses whose first byte
                                     // == mode+0x40 (or 0x7F negative response → status 'unsupported' for that ecu)
  async supportedPids()              // queries 0100, 0120, 0140, 0160, 0180, 01A0, 01C0 while previous bitmap says next block supported.
                                     // returns {byEcu: {'7E8': Set<number>}, all: Set<number>}
  async readDtcs(mode)               // mode '03'|'07'|'0A'. returns {status, supported:boolean, message, byEcu:[{ecu, label, codes:['P0301',...]}]}
                                     // CAN: byte after 0x43 is count. Legacy: no count byte, pairs of bytes, skip 0000.
                                     // mode 0A NO DATA or 7F → supported=false, message "Not supported by this car".
  async clearDtcs()                  // sends 04, returns {ok, message}
  async readVin()                    // 0902, multiframe, returns {vin, ecu, status, message}. strip leading count byte 0x01 and non-printables.
  async readiness()                  // 0101 → {milOn, dtcCount, ignition:'spark'|'compression', monitors:[{key,name,explain,available,complete}]}
                                     // per SAE J1979 bit layout of PID 01 byte B,C,D. Also 0141 (this drive cycle) if supported.
  async usedCarCheck(onProgress)     // runs VIN, 0101, 0131, 014E, 0130, 0121, 01A6 (only if supported), 0141, 03, 07, 0A.
                                     // returns structured result + `flags: [{level:'warn'|'info'|'ok', text}]` plain-English findings:
                                     //   - distance since clear < 200 km or warmups < 20 or time since clear < 300 min → "codes were probably cleared recently"
                                     //   - many monitors incomplete → same suspicion
                                     //   - MIL on, stored/pending codes present
                                     //   - unsupported items listed as "not supported by this car" not errors
  async freezeFrame()                // 0202 (DTC that caused freeze frame), then for supported PIDs via 0200 bitmap, read 02 XX 00 for
                                     // common PIDs (04,05,06,07,0B,0C,0D,0E,0F,11,42...). returns {dtc, values:[{pid,name,value,unit}] , status, message}
  async readPid(pid)                 // single PID live read → {pid, ecu, value, unit, text} using pids.js decoder (first ECU that answers, prefer 7E8)
  async readPids(pidList)            // CAN allows up to 6 PIDs per request (e.g. '010C0D0511'); use multi-PID on CAN, single on legacy. Fallback
                                     // to single requests if multi fails.
}
export function decodeDtc(byteA, byteB) // → 'P0301' (first two bits: P,C,B,U)
```

### js/pids.js
```js
export const PIDS = {
  0x0C: { name:'Engine speed', short:'RPM', unit:'rpm', bytes:2, decode:(A,B)=>..., min:0, max:8000,
          explain:'How fast the engine is turning. On a hybrid this is often 0 when the petrol engine is off, which is normal.' },
  ...
}
// Cover at least: 01 (handled specially by obd), 03 fuel system status (text), 04 load, 05 coolant, 06-09 fuel trims, 0A fuel pressure,
// 0B MAP, 0C RPM, 0D speed, 0E timing advance, 0F intake air temp, 10 MAF, 11 throttle, 14-1B O2 sensor voltage+trim (A/200 V, B),
// 1C OBD standard (text), 1F run time, 21 distance with MIL, 2C/2D EGR, 2F fuel level, 30 warmups since clear, 31 distance since clear,
// 33 baro, 34-3B wideband O2 (lambda + current), 3C-3F catalyst temps, 42 control module voltage, 43 absolute load, 44 commanded lambda,
// 45 relative throttle, 46 ambient temp, 47-4B throttle/pedal, 4C commanded throttle, 4D time with MIL, 4E time since clear, 51 fuel type (text),
// 52 ethanol %, 5A relative pedal, 5B hybrid battery remaining life %, 5C oil temp, 5E fuel rate, 61-63 torque, A6 odometer (4 bytes /10 km).
export const GAUGE_DEFAULTS = [0x0C,0x0D,0x05,0x0F,0x04,0x11,0x06,0x07,0x42,0x5B,0x2F,0x46]
export function decodePid(pid, bytes)   // bytes = data bytes after mode+pid. returns {value, unit, text} text is formatted for display
export const MONITORS   // readiness monitor definitions with plain-English explain for spark and compression
```

### js/dtc-db.js
```js
export function describeDtc(code)  // → {code, system:'Powertrain (engine/transmission)'|..., description, explain, severity:'low'|'medium'|'high'|null,
                                   //    generic: boolean, manufacturerSpecific: boolean}
// Big table of SAE J2012 generic codes (P0xxx, P2xxx, P34xx, C0xxx, B0xxx, U0xxx) with short descriptions.
// For codes not in table: describe by structure (P0 = generic, P1 = manufacturer specific, subsystem digit meaning:
// P01xx/P02xx fuel and air metering, P03xx ignition/misfire, P04xx emissions controls, P05xx speed/idle, P06xx computer/outputs,
// P07xx-P09xx transmission, P0Axx hybrid propulsion, etc). Include common Toyota hybrid P0A**/P3000-P3190 descriptions where well known.
// `explain` gives what it means and what to do next in plain English for the most common ~150 codes; generic fallback text otherwise.
```

### js/sim.js — SimTransport
Same interface as BleTransport. Pretends to be an ELM327 v1.5 on a 2020 Toyota C-HR Hybrid style car:
- Tracks ELM state (echo on/off, headers on/off, spaces on/off, linefeeds) and formats replies accordingly
  (echo of command when ATE1, '\r' line endings, '\r\r>' prompt).
- Replies delivered via onData in random fragments (1-20 chars) with small setTimeout delays (5-60ms).
- First OBD request after ATSP0 emits 'SEARCHING...\r' before the answer, with ~800ms delay.
- ATZ → '\r\rELM327 v1.5\r\r>'. ATI → 'ELM327 v1.5'. AT@1 → 'OBDII to RS232 Interpreter' style string (use 'vLinker MC+ (simulated)').
  ATRV → '12.6V' (14.2V-ish when "running"). ATDP → 'AUTO, ISO 15765-4 (CAN 11/500)'. ATDPN → 'A6'.
- Two ECUs answer 0100: 7E8 and 7EA (hybrid). Supported PID bitmaps realistic for a Toyota hybrid; A6 odometer NOT supported (EU).
- 0902 VIN multi-frame from 7E8: '7E81014490201...' then '7E821...' '7E822...'. Use fake VIN 'NMTKZ3BX10R000001' (clearly fake).
- 03 → 7E8 with 2 stored codes (P0171, P0420) in a multi-frame reply? 2 codes fit single frame: '7E806430201710420'. Make the multi-DTC
  case multi-frame at least when there are >2 codes: give 7E8 three stored codes P0171, P0420, P0A80 (3 codes = 1+6 bytes+mode = needs FF).
  07 → one pending P0300 from 7E8. 0A → NO DATA? No, return permanent code P0420 from 7E8 (CAN cars 2010+ support it).
- 04 clears codes in sim state (subsequent 03 returns 0 codes, readiness resets, 0131/014E/0130 go to 0).
- 0101 MIL on, readiness with a couple incomplete. 0131 = 85 km, 014E = 42 min, 0130 = 3 warm-ups (so "recently cleared" flag fires).
  0121 = 0. 0141 realistic.
- Live PIDs vary smoothly over time (RPM 0 when engine off in EV mode, sometimes 1100-2400, speed 0-60, coolant warming 40→90 C, etc).
- 0202/02xx00 freeze frame values for P0171.
- Unknown commands → '?'. Unsupported PIDs → 'NO DATA'. Occasional (5%) 'NO DATA' on a live PID to exercise handling (not on init cmds).
- A 'scenario' option: new SimTransport({scenario:'normal'|'ignitionOff'|'legacy'}) where ignitionOff makes 0100 return
  'SEARCHING...\rUNABLE TO CONNECT' and legacy uses ISO 9141-2 (protocol 3) with headers format '486B10...' and no mode 0A.

### js/app.js UI
Single page, sections (cards, collapsible where useful):
1. Header: app name "OBD Web", privacy badge ("Nothing leaves your phone").
2. Connect card: buttons "Connect adapter" (BLE), "Try simulated car" (with scenario select), "Disconnect", "Probe adapter".
   Status line with plain-English state. Help text: plug adapter in under dash, turn ignition ON or press start until READY,
   open this page in Bluefy, tap Connect, pick the vLinker from the list. Explicitly NOT pairing in iOS Settings.
   If navigator.bluetooth missing, show the Bluefy/Chrome message and still allow simulated mode.
3. Used Car Check card: one big button, progress, results with flags (colored), each item explained.
4. Trouble codes card: buttons Read codes (does 03, 07, 0A), Clear codes (confirmation dialog: explains light returns if fault remains,
   readiness monitors reset so the car may fail an inspection until driven, freeze frame is erased, engine should be off but ignition on;
   require typing CLEAR or a second explicit confirm). Each code shows code, ECU label, description, severity, explain.
5. Freeze frame card.
6. Live data card: start/stop; supported gauges grid (only PIDs supported by the car), each tile shows value, unit, simple bar,
   tap tile for explanation. Picker to add/remove PIDs. Poll loop using readPids, sequential, ~ as fast as adapter allows, stop on
   disconnect. Max 6 PIDs per request.
7. Report card: "Build report" then textarea preview, Copy button, Share button (navigator.share({title,text}) when available, else copy).
8. Debug console (collapsible <details>): live log, Copy log button, Clear button, auto-scroll, monospace small font.
Also a short "What is this?" explainer and privacy statement at bottom.
All long-running actions disable conflicting buttons while running. Errors shown in plain English, never raw stack traces (stack goes to log).
Dark mode via prefers-color-scheme. No external fonts.
