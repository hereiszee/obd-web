# OBD Web

A free, private car diagnostic page that runs entirely in your browser. Plug a Bluetooth OBD-II adapter into your car, open the page, and read trouble codes, readiness monitors, freeze frame data and live sensor readings, all explained in plain English.

Live site: https://hereiszee.github.io/obd-web/

Built and tested for the **Vgate vLinker MC+** (Bluetooth Low Energy, ELM327 command set). Other BLE adapters that speak ELM327 should also work.

## What it does

- **Used car check.** One tap reads the VIN, check engine light, stored, pending and permanent codes, readiness monitors, and how far the car has driven since the codes were last cleared. It flags the classic warning sign of a seller clearing codes just before a viewing.
- **Trouble codes.** Reads and explains codes from every module that answers, with a rough severity and what to do next. Clearing codes is supported, behind a clear warning about what clearing does (it does not fix anything, it resets readiness monitors and erases the freeze frame).
- **Freeze frame.** The snapshot of sensor readings saved when a fault was stored.
- **Live data.** A grid of gauges for the readings your car supports. Tap any tile for an explanation.
- **Report.** Builds a plain-text summary you can copy or share with a mechanic, a seller, or yourself.
- **Simulated car.** Try every feature with fake data and no hardware.
- **Debug console.** Every command and raw reply, with a Copy button, for troubleshooting.

## Privacy

Nothing leaves your phone.

- No accounts, no analytics, no tracking, no cookies, no server.
- The page makes no network requests after it loads. A Content Security Policy blocks it from contacting anything.
- Car data lives in memory only. It is gone when you close or reload the page. Nothing is saved to browser storage.
- Data only leaves the page if you tap Copy or Share yourself.

## How to use it on iPhone (Bluefy)

Safari and Chrome on iPhone cannot talk to Bluetooth devices from a web page. The free **Bluefy** browser can.

1. Install **Bluefy: Web BLE Browser** from the App Store.
2. Plug the adapter into the car's OBD port (usually under the dashboard, near the driver's knees).
3. Turn the ignition ON. On a hybrid or push-button car, press start with your foot on the brake until READY shows. On a normal engine car you can also just start the engine.
4. Open https://hereiszee.github.io/obd-web/ in Bluefy.
5. Tap **Connect adapter** and choose your adapter from the list (it may be called vLinker, OBDII, IOS-Vlink or similar). Allow Bluetooth if Bluefy asks.
6. Wait for "Connected to the car", then run the **Used car check**.

**Important:** the adapter is connected from inside the app, not from the iPhone Settings app. You do not need to pair it under Settings, Bluetooth. Bluetooth Low Energy adapters like the vLinker MC+ are found by the page itself when you tap Connect adapter. If another app (for example Car Scanner) is connected to the adapter, close that app first, because the adapter can only talk to one app at a time.

## On a computer

Use Chrome or Edge (Windows, macOS, Linux, ChromeOS) with Bluetooth turned on. Open the site and tap Connect adapter. Firefox and Safari on desktop do not support Web Bluetooth.

## Troubleshooting

- **The adapter is not in the list.** Check it is fully plugged in and its light is on. Turn the ignition on. Close other OBD apps. Move closer.
- **"The adapter is connected, but the car did not answer."** The ignition is probably off, or the car is asleep. Turn the ignition ON (or get READY on a hybrid), then tap "Ask the car again".
- **Something else.** Open the Debug console at the bottom, tap Copy log, and include it when you ask for help. The log contains raw adapter traffic, which may include your VIN.

## Limits

This is a helpful first look, not a professional inspection. Standard OBD-II mostly covers engine and emissions systems. Airbag, ABS, and detailed hybrid battery data are often manufacturer specific and only partly visible.

## Running locally

There is no build step. Serve the folder with any static file server over `http://localhost`, for example:

```
python3 -m http.server 8000
```

Then open http://localhost:8000 in Chrome. Web Bluetooth needs a secure context (https or localhost). The simulated car works anywhere.

Tests: `node tests/run.mjs`

## Files

- `index.html`, `css/app.css`: the page
- `js/app.js`: UI and wiring, `js/ui-text.js`: the plain-English explainers, `js/report.js`: report builder
- `js/ble.js`: Bluetooth transport, `js/sim.js`: simulated car
- `js/elm.js`: ELM327 command queue, `js/obd.js`: OBD-II protocol parsing
- `js/pids.js`: live reading definitions, `js/dtc-db.js`: trouble code descriptions
- `js/log.js`: in-memory debug log
