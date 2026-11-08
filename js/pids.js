// Mode 01 PID table for OBD Web.
// Formulas follow SAE J1979. Each decoder receives the data bytes after mode+PID as (A, B, C, D).
// Every entry has a plain-English `explain` shown when the user taps a gauge.

const pct = (A) => (A * 100) / 255;
const trim = (A) => ((A - 128) * 100) / 128;
const temp = (A) => A - 40;
const word = (A, B) => A * 256 + B;

const FUEL_SYSTEM_STATUS = {
  0: 'Engine off or not reported',
  1: 'Open loop (engine still warming up)',
  2: 'Closed loop (normal, using oxygen sensors)',
  4: 'Open loop (heavy load or slowing down)',
  8: 'Open loop (system fault)',
  16: 'Closed loop (but a sensor has a fault)'
};

const OBD_STANDARDS = {
  1: 'OBD-II (California ARB)', 2: 'OBD (US EPA)', 3: 'OBD and OBD-II', 4: 'OBD-I',
  5: 'Not OBD compliant', 6: 'EOBD (Europe)', 7: 'EOBD and OBD-II', 8: 'EOBD and OBD',
  9: 'EOBD, OBD and OBD-II', 10: 'JOBD (Japan)', 11: 'JOBD and OBD-II', 12: 'JOBD and EOBD',
  13: 'JOBD, EOBD and OBD-II', 17: 'Engine Manufacturer Diagnostics (EMD)', 18: 'EMD+',
  19: 'Heavy Duty OBD (Child/Partial)', 20: 'Heavy Duty OBD', 21: 'World Wide Harmonized OBD (WWH OBD)',
  23: 'Heavy Duty Euro OBD Stage I without NOx control', 24: 'Heavy Duty Euro OBD Stage I with NOx control',
  25: 'Heavy Duty Euro OBD Stage II without NOx control', 26: 'Heavy Duty Euro OBD Stage II with NOx control',
  28: 'Brazil OBD Phase 1', 29: 'Brazil OBD Phase 2', 30: 'Korean OBD', 31: 'India OBD I',
  32: 'India OBD II', 33: 'Heavy Duty Euro OBD Stage VI'
};

const FUEL_TYPES = {
  0: 'Not available', 1: 'Petrol (gasoline)', 2: 'Methanol', 3: 'Ethanol', 4: 'Diesel', 5: 'LPG',
  6: 'CNG', 7: 'Propane', 8: 'Electric', 9: 'Bi-fuel, petrol', 10: 'Bi-fuel, methanol',
  11: 'Bi-fuel, ethanol', 12: 'Bi-fuel, LPG', 13: 'Bi-fuel, CNG', 14: 'Bi-fuel, propane',
  15: 'Bi-fuel, electricity', 16: 'Bi-fuel, electric and combustion engine', 17: 'Hybrid, petrol',
  18: 'Hybrid, ethanol', 19: 'Hybrid, diesel', 20: 'Hybrid, electric',
  21: 'Hybrid, electric and combustion engine', 22: 'Hybrid, regenerative', 23: 'Bi-fuel, diesel'
};

function fuelSystemText(code) {
  if (FUEL_SYSTEM_STATUS[code] !== undefined) return FUEL_SYSTEM_STATUS[code];
  return 'Unknown status (' + code + ')';
}

// Shared builders for repeated PID families.
function narrowO2(sensorLabel) {
  return {
    name: 'O2 sensor ' + sensorLabel, short: 'O2 ' + sensorLabel, unit: 'V', bytes: 2, decimals: 3,
    decode: (A) => A / 200,
    extra: (A, B) => (B === 0xff ? 'trim not used' : 'trim ' + trim(B).toFixed(1) + ' %'),
    min: 0, max: 1.275,
    explain: 'Voltage from a classic (narrowband) oxygen sensor in the exhaust. Bank 1 is the side of the engine with cylinder 1, ' +
      'sensor 1 is before the catalytic converter and sensor 2 is after it. A healthy front sensor flicks quickly between about ' +
      '0.1 V (lean) and 0.9 V (rich) once warm. A healthy rear sensor stays fairly steady around 0.5 to 0.8 V, which shows the ' +
      'catalytic converter is working. On a hybrid the reading goes flat or near 0 whenever the petrol engine is off, which is normal.'
  };
}

function widebandO2(sensorLabel) {
  return {
    name: 'Wideband O2 sensor ' + sensorLabel, short: 'Lambda ' + sensorLabel, unit: 'lambda', bytes: 4, decimals: 3,
    decode: (A, B) => (2 / 65536) * word(A, B),
    extra: (A, B, C, D) => (C === undefined || D === undefined ? '' : 'current ' + (word(C, D) / 256 - 128).toFixed(2) + ' mA'),
    min: 0.5, max: 1.5,
    explain: 'Air-fuel ratio measured by a wideband (air-fuel ratio) oxygen sensor, shown as lambda. 1.00 means the ideal mix ' +
      'of air and fuel. Below 1 is rich (extra fuel), above 1 is lean (extra air). A warm engine cruising should sit very close ' +
      'to 1.00. Large numbers (around 2) usually mean the engine is off or the fuel is cut while slowing down, which on a hybrid ' +
      'happens often and is normal. The sensor current in mA is also shown (near 0 mA at lambda 1).'
  };
}

function catTemp(label) {
  return {
    name: 'Catalyst temperature ' + label, short: 'Cat ' + label, unit: '°C', bytes: 2, decimals: 0,
    decode: (A, B) => word(A, B) / 10 - 40,
    min: 0, max: 1000,
    explain: 'Estimated or measured temperature of the catalytic converter. Bank 1 is the side with cylinder 1, sensor 1 is the ' +
      'front of the converter. It needs roughly 300 to 400 °C to clean the exhaust well and usually runs 400 to 800 °C when warm. ' +
      'Hybrids sometimes start the engine just to keep the converter hot, so it may cool down during long electric-only stretches.'
  };
}

export const PIDS = {
  0x01: {
    name: 'Monitor status since codes cleared', short: 'Status', unit: '', bytes: 4, isText: true,
    decode: (A) => A,
    format: (A) => {
      const mil = (A & 0x80) !== 0;
      const count = A & 0x7f;
      return 'Check engine light ' + (mil ? 'ON' : 'off') + ', ' + count + ' stored code' + (count === 1 ? '' : 's');
    },
    min: 0, max: 127,
    explain: 'Whether the check engine light is on, how many trouble codes are stored, and which self-tests (readiness monitors) ' +
      'have finished since the codes were last cleared. The readiness section of this app shows the details.'
  },
  0x03: {
    name: 'Fuel system status', short: 'Fuel sys', unit: '', bytes: 2, isText: true,
    decode: (A) => A,
    format: (A, B) => {
      let t = fuelSystemText(A);
      if (B !== undefined && B !== 0) t += '. System 2: ' + fuelSystemText(B);
      return t;
    },
    min: 0, max: 16,
    explain: 'Whether the engine computer is using the oxygen sensors to fine-tune the fuel mix. "Closed loop" is the normal state ' +
      'for a warm engine. "Open loop" is normal during warm-up, hard acceleration or when slowing down. On a hybrid it often shows ' +
      'engine off or open loop while the petrol engine is stopped, which is normal.'
  },
  0x04: {
    name: 'Calculated engine load', short: 'Load', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => pct(A),
    min: 0, max: 100,
    explain: 'How hard the engine is working compared with its maximum at the current speed. Idle is usually 15 to 35 %, ' +
      'gentle cruising 20 to 50 %, full throttle close to 100 %. On a hybrid it reads 0 % when the petrol engine is off.'
  },
  0x05: {
    name: 'Engine coolant temperature', short: 'Coolant', unit: '°C', bytes: 1, decimals: 0,
    decode: (A) => temp(A),
    min: -40, max: 130,
    explain: 'Temperature of the engine coolant. A fully warm engine normally sits around 80 to 105 °C. Above about 110 °C ' +
      'suggests overheating, so stop and check coolant level. On a hybrid the engine can cool down while it is switched off ' +
      'in electric mode, so readings of 40 to 70 °C during town driving are normal.'
  },
  0x06: {
    name: 'Short term fuel trim, bank 1', short: 'STFT B1', unit: '%', bytes: 1, decimals: 1,
    decode: (A) => trim(A),
    min: -25, max: 25,
    explain: 'Instant correction the engine computer makes to the fuel amount. Positive means it is adding fuel (the mix was lean), ' +
      'negative means removing fuel (the mix was rich). It normally jumps around within about plus or minus 10 %. Bank 1 is the side ' +
      'of the engine with cylinder 1. On a hybrid it reads 0 % while the petrol engine is off.'
  },
  0x07: {
    name: 'Long term fuel trim, bank 1', short: 'LTFT B1', unit: '%', bytes: 1, decimals: 1,
    decode: (A) => trim(A),
    min: -25, max: 25,
    explain: 'Learned, slow-changing fuel correction. Healthy engines usually stay within plus or minus 5 to 10 %. Consistently ' +
      'above +10 % often points to an air leak, weak fuel pump or dirty air flow sensor (common with code P0171). Consistently below ' +
      '-10 % suggests too much fuel, for example a leaking injector.'
  },
  0x08: {
    name: 'Short term fuel trim, bank 2', short: 'STFT B2', unit: '%', bytes: 1, decimals: 1,
    decode: (A) => trim(A),
    min: -25, max: 25,
    explain: 'Instant fuel correction for bank 2 (the side of a V engine without cylinder 1). Normal range is about plus or minus 10 %. ' +
      'Four-cylinder engines, including most hybrids, only have bank 1.'
  },
  0x09: {
    name: 'Long term fuel trim, bank 2', short: 'LTFT B2', unit: '%', bytes: 1, decimals: 1,
    decode: (A) => trim(A),
    min: -25, max: 25,
    explain: 'Learned fuel correction for bank 2. Healthy values stay within about plus or minus 5 to 10 %. Only V6 and V8 style ' +
      'engines have a bank 2.'
  },
  0x0A: {
    name: 'Fuel pressure', short: 'Fuel press', unit: 'kPa', bytes: 1, decimals: 0,
    decode: (A) => A * 3,
    min: 0, max: 765,
    explain: 'Fuel pressure measured relative to the air outside. Port-injected petrol engines are usually around 250 to 400 kPa. ' +
      'Many cars do not report this.'
  },
  0x0B: {
    name: 'Intake manifold pressure', short: 'MAP', unit: 'kPa', bytes: 1, decimals: 0,
    decode: (A) => A,
    min: 0, max: 255,
    explain: 'Absolute air pressure inside the intake manifold. At idle it is low (about 25 to 40 kPa, a strong vacuum). At full ' +
      'throttle it approaches outside air pressure (about 100 kPa), or higher on a turbo engine. With the engine off it equals ' +
      'outside air pressure, so a hybrid in electric mode shows about 100 kPa.'
  },
  0x0C: {
    name: 'Engine speed', short: 'RPM', unit: 'rpm', bytes: 2, decimals: 0,
    decode: (A, B) => word(A, B) / 4,
    min: 0, max: 8000,
    explain: 'How fast the engine is turning, in revolutions per minute. A warm idle is usually 600 to 900 rpm. On a hybrid this ' +
      'is often 0 when the petrol engine is off, which is normal. Hybrid engines also tend to run at steady speeds of about ' +
      '1000 to 2500 rpm while the electric motor does the rest.'
  },
  0x0D: {
    name: 'Vehicle speed', short: 'Speed', unit: 'km/h', bytes: 1, decimals: 0,
    decode: (A) => A,
    min: 0, max: 200,
    explain: 'Road speed as the car computer sees it. It may differ slightly from the dashboard, which often reads a little high on purpose.'
  },
  0x0E: {
    name: 'Ignition timing advance', short: 'Timing', unit: '° BTDC', bytes: 1, decimals: 1,
    decode: (A) => A / 2 - 64,
    min: -20, max: 60,
    explain: 'How early the spark plug fires before the piston reaches the top, in degrees. Typical values are 5 to 15 degrees at ' +
      'idle and 20 to 40 degrees while cruising. Low or negative values under load can mean the engine is pulling timing to stop ' +
      'knocking. Hybrids may show unusual values (or negative values) during engine warm-up as they heat the catalytic converter.'
  },
  0x0F: {
    name: 'Intake air temperature', short: 'Intake air', unit: '°C', bytes: 1, decimals: 0,
    decode: (A) => temp(A),
    min: -40, max: 100,
    explain: 'Temperature of the air going into the engine. Usually a few degrees to about 30 °C above the outside temperature. ' +
      'It rises when parked in the sun or crawling in traffic. A reading of -40 °C usually means a broken or unplugged sensor.'
  },
  0x10: {
    name: 'Mass air flow rate', short: 'MAF', unit: 'g/s', bytes: 2, decimals: 2,
    decode: (A, B) => word(A, B) / 100,
    min: 0, max: 200,
    explain: 'How much air the engine is breathing in, in grams per second. A warm 1.8 to 2.0 litre engine at idle usually reads ' +
      'about 2 to 5 g/s. A rough rule is that idle MAF is close to engine size in litres times 1.5 to 2.5. On a hybrid it reads ' +
      '0 g/s while the petrol engine is off.'
  },
  0x11: {
    name: 'Throttle position', short: 'Throttle', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => pct(A),
    min: 0, max: 100,
    explain: 'How far the throttle valve is open. Many cars never show exactly 0 % or 100 % because of how the sensor is set up, ' +
      'so closed might read 10 to 20 % and wide open 80 to 90 %. On a hybrid the computer controls the throttle, so it may not ' +
      'follow your foot directly.'
  },
  0x12: {
    name: 'Commanded secondary air status', short: 'Sec air', unit: '', bytes: 1, isText: true,
    decode: (A) => A,
    format: (A) => ({ 1: 'Upstream of catalyst', 2: 'Downstream of catalyst', 4: 'Outside air or off', 8: 'Pump on for diagnosis' })[A] || ('Status ' + A),
    min: 0, max: 8,
    explain: 'Where the secondary air pump (if fitted) is blowing fresh air into the exhaust. It runs for a short time after a ' +
      'cold start to help heat the catalytic converter. Most cars do not have one.'
  },
  0x13: {
    name: 'Oxygen sensors present', short: 'O2 present', unit: '', bytes: 1, isText: true,
    decode: (A) => A,
    format: (A) => {
      const list = [];
      for (let i = 0; i < 8; i++) if (A & (1 << i)) list.push('B' + (i < 4 ? 1 : 2) + 'S' + ((i % 4) + 1));
      return list.length ? list.join(', ') : 'None reported';
    },
    min: 0, max: 255,
    explain: 'Which oxygen sensors the engine has. B1S1 means bank 1, sensor 1 (before the catalytic converter). S2 is usually ' +
      'after the converter.'
  },
  0x14: narrowO2('B1S1'),
  0x15: narrowO2('B1S2'),
  0x16: narrowO2('B1S3'),
  0x17: narrowO2('B1S4'),
  0x18: narrowO2('B2S1'),
  0x19: narrowO2('B2S2'),
  0x1A: narrowO2('B2S3'),
  0x1B: narrowO2('B2S4'),
  0x1C: {
    name: 'OBD standard', short: 'OBD std', unit: '', bytes: 1, isText: true,
    decode: (A) => A,
    format: (A) => OBD_STANDARDS[A] || ('Standard code ' + A),
    min: 0, max: 255,
    explain: 'Which diagnostic standard the car was built to. US cars usually report OBD-II, European cars EOBD, Japanese market ' +
      'cars JOBD. Many cars report a combination.'
  },
  0x1F: {
    name: 'Run time since engine start', short: 'Run time', unit: 's', bytes: 2, decimals: 0,
    decode: (A, B) => word(A, B),
    min: 0, max: 7200,
    explain: 'Seconds since the car was started this trip. On a hybrid this usually counts from when the car was switched to ' +
      'READY, even if the petrol engine has not run.'
  },
  0x21: {
    name: 'Distance with check engine light on', short: 'MIL dist', unit: 'km', bytes: 2, decimals: 0,
    decode: (A, B) => word(A, B),
    min: 0, max: 1000,
    explain: 'How far the car has been driven while the check engine light was on. It should be 0. A large number means a fault ' +
      'was ignored for a long time.'
  },
  0x22: {
    name: 'Fuel rail pressure (relative to vacuum)', short: 'Rail press', unit: 'kPa', bytes: 2, decimals: 0,
    decode: (A, B) => word(A, B) * 0.079,
    min: 0, max: 5177,
    explain: 'Fuel pressure in the fuel rail compared with intake manifold vacuum. Typical port injection values are about 250 to 400 kPa.'
  },
  0x23: {
    name: 'Fuel rail pressure', short: 'Rail press', unit: 'kPa', bytes: 2, decimals: 0,
    decode: (A, B) => word(A, B) * 10,
    min: 0, max: 30000,
    explain: 'Fuel pressure in the fuel rail. Direct injection petrol engines run very high pressure (roughly 3000 to 20000 kPa). ' +
      'Diesels run even higher. Some hybrids with both port and direct injection report this.'
  },
  0x2C: {
    name: 'Commanded EGR', short: 'EGR cmd', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => pct(A),
    min: 0, max: 100,
    explain: 'How much the engine computer is asking the exhaust gas recirculation (EGR) valve to open. EGR feeds some exhaust back ' +
      'into the engine to lower emissions and, on many hybrids, to save fuel. 0 % at idle is normal. Cruising values of 5 to 30 % are common.'
  },
  0x2D: {
    name: 'EGR error', short: 'EGR err', unit: '%', bytes: 1, decimals: 1,
    decode: (A) => trim(A),
    min: -100, max: 100,
    explain: 'Difference between where the EGR valve was told to go and where it actually is. Near 0 % is good. A large constant ' +
      'error can mean a sticking or clogged EGR valve.'
  },
  0x2E: {
    name: 'Commanded evaporative purge', short: 'Purge', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => pct(A),
    min: 0, max: 100,
    explain: 'How much the engine is drawing fuel vapour from the charcoal canister to burn it. It varies a lot and is often 0 % ' +
      'on a hybrid while the engine is off.'
  },
  0x2F: {
    name: 'Fuel tank level', short: 'Fuel', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => pct(A),
    min: 0, max: 100,
    explain: 'How full the fuel tank is. It may not exactly match the dashboard gauge, which is often smoothed. Some hybrids with ' +
      'a bladder fuel tank read less precisely.'
  },
  0x30: {
    name: 'Warm-ups since codes cleared', short: 'Warm-ups', unit: '', bytes: 1, decimals: 0,
    decode: (A) => A,
    min: 0, max: 255,
    explain: 'How many times the engine has warmed up properly since the trouble codes were last cleared. It stops at 255. A low ' +
      'number (under about 20) on a used car means the codes were cleared recently, possibly to hide a problem.'
  },
  0x31: {
    name: 'Distance since codes cleared', short: 'Since clear', unit: 'km', bytes: 2, decimals: 0,
    decode: (A, B) => word(A, B),
    min: 0, max: 65535,
    explain: 'How far the car has been driven since the trouble codes were last cleared (or the battery was disconnected). It stops ' +
      'at 65535 km. A very small number (under a few hundred km) on a used car is a warning sign that someone may have cleared ' +
      'codes just before the sale.'
  },
  0x32: {
    name: 'Evap system vapour pressure', short: 'Evap press', unit: 'Pa', bytes: 2, decimals: 1,
    decode: (A, B) => { let v = word(A, B); if (v > 32767) v -= 65536; return v / 4; },
    min: -8192, max: 8192,
    explain: 'Pressure in the fuel vapour system, used for leak testing. Values near 0 Pa are normal when the system is not testing.'
  },
  0x33: {
    name: 'Barometric pressure', short: 'Baro', unit: 'kPa', bytes: 1, decimals: 0,
    decode: (A) => A,
    min: 50, max: 110,
    explain: 'Outside air pressure. About 101 kPa at sea level, lower at altitude (roughly 1 kPa less per 100 m). The engine uses ' +
      'it to adjust fuelling.'
  },
  0x34: widebandO2('B1S1'),
  0x35: widebandO2('B1S2'),
  0x36: widebandO2('B1S3'),
  0x37: widebandO2('B1S4'),
  0x38: widebandO2('B2S1'),
  0x39: widebandO2('B2S2'),
  0x3A: widebandO2('B2S3'),
  0x3B: widebandO2('B2S4'),
  0x3C: catTemp('B1S1'),
  0x3D: catTemp('B2S1'),
  0x3E: catTemp('B1S2'),
  0x3F: catTemp('B2S2'),
  0x42: {
    name: 'Control module voltage', short: 'Battery', unit: 'V', bytes: 2, decimals: 2,
    decode: (A, B) => word(A, B) / 1000,
    min: 10, max: 16,
    explain: 'Voltage of the 12 V system as seen by the engine computer. With the engine running (or a hybrid in READY) it should ' +
      'be about 13.5 to 14.8 V, showing the battery is being charged. On a hybrid this charging comes from the high voltage battery ' +
      'through a converter, not an alternator. With everything off a healthy battery reads 12.4 to 12.8 V. Below about 12.0 V means ' +
      'a weak or flat 12 V battery, a very common cause of hybrids refusing to start.'
  },
  0x43: {
    name: 'Absolute engine load', short: 'Abs load', unit: '%', bytes: 2, decimals: 0,
    decode: (A, B) => (word(A, B) * 100) / 255,
    min: 0, max: 100,
    explain: 'Air going into each cylinder compared with a perfect fill at sea level. Idle is often 20 to 40 %. It can go over ' +
      '100 % on turbo engines. On a hybrid it is 0 % while the petrol engine is off.'
  },
  0x44: {
    name: 'Commanded air-fuel ratio', short: 'Cmd lambda', unit: 'lambda', bytes: 2, decimals: 3,
    decode: (A, B) => (2 / 65536) * word(A, B),
    min: 0.5, max: 1.5,
    explain: 'The air-fuel mix the engine computer is aiming for, as lambda. 1.00 is the ideal mix and is normal when cruising. ' +
      'Below 1 (richer) is used under heavy load or cold start. Values near 2 usually mean fuel is cut, such as when slowing down ' +
      'or when a hybrid engine is stopped.'
  },
  0x45: {
    name: 'Relative throttle position', short: 'Rel throttle', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => pct(A),
    min: 0, max: 100,
    explain: 'Throttle opening compared with the learned closed position, so closed reads close to 0 %. On a hybrid this is set by ' +
      'the computer and may not match your foot.'
  },
  0x46: {
    name: 'Outside air temperature', short: 'Outside', unit: '°C', bytes: 1, decimals: 0,
    decode: (A) => temp(A),
    min: -40, max: 60,
    explain: 'Temperature of the outside air. It can read high when the car has been sitting in traffic or sunshine, because heat ' +
      'from the road and engine reaches the sensor.'
  },
  0x47: {
    name: 'Absolute throttle position B', short: 'Throttle B', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => pct(A),
    min: 0, max: 100,
    explain: 'Second throttle position sensor, used as a cross-check of the first. It normally moves together with throttle ' +
      'position but at a different scale.'
  },
  0x48: {
    name: 'Absolute throttle position C', short: 'Throttle C', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => pct(A),
    min: 0, max: 100,
    explain: 'Third throttle position sensor, used as a backup check. Few cars have it.'
  },
  0x49: {
    name: 'Accelerator pedal position D', short: 'Pedal D', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => pct(A),
    min: 0, max: 100,
    explain: 'How far the accelerator pedal is pressed (first pedal sensor). Released is often around 10 to 20 % rather than 0 %, ' +
      'and fully pressed often around 70 to 90 %. That is normal.'
  },
  0x4A: {
    name: 'Accelerator pedal position E', short: 'Pedal E', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => pct(A),
    min: 0, max: 100,
    explain: 'Second accelerator pedal sensor, used to double-check the first. It usually reads a different number but moves together with it.'
  },
  0x4B: {
    name: 'Accelerator pedal position F', short: 'Pedal F', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => pct(A),
    min: 0, max: 100,
    explain: 'Third accelerator pedal sensor, present on a few cars as an extra safety check.'
  },
  0x4C: {
    name: 'Commanded throttle actuator', short: 'Throttle cmd', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => pct(A),
    min: 0, max: 100,
    explain: 'How far the engine computer is asking the electric throttle to open. On a hybrid this is decided by the hybrid ' +
      'system, not directly by the pedal.'
  },
  0x4D: {
    name: 'Time run with check engine light on', short: 'MIL time', unit: 'min', bytes: 2, decimals: 0,
    decode: (A, B) => word(A, B),
    min: 0, max: 6000,
    explain: 'Minutes the engine has run while the check engine light was on. It should be 0 on a car without faults.'
  },
  0x4E: {
    name: 'Time since codes cleared', short: 'Since clear', unit: 'min', bytes: 2, decimals: 0,
    decode: (A, B) => word(A, B),
    min: 0, max: 65535,
    explain: 'Minutes the engine has run since trouble codes were last cleared. A small number (under a few hundred minutes) on ' +
      'a used car means codes were cleared recently. On some hybrids this only counts while the car is in READY.'
  },
  0x51: {
    name: 'Fuel type', short: 'Fuel type', unit: '', bytes: 1, isText: true,
    decode: (A) => A,
    format: (A) => FUEL_TYPES[A] || ('Fuel type code ' + A),
    min: 0, max: 255,
    explain: 'The fuel the car is built for, as reported by the engine computer. Many hybrids simply report petrol.'
  },
  0x52: {
    name: 'Ethanol fuel percentage', short: 'Ethanol', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => pct(A),
    min: 0, max: 100,
    explain: 'How much ethanol is in the fuel. Regular E10 petrol is about 10 %, E85 is up to 85 %. Only flex-fuel cars usually report this.'
  },
  0x5A: {
    name: 'Relative accelerator pedal position', short: 'Pedal', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => pct(A),
    min: 0, max: 100,
    explain: 'How far the accelerator pedal is pressed, adjusted so that released reads close to 0 %.'
  },
  0x5B: {
    name: 'Hybrid battery pack remaining life', short: 'HV battery', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => pct(A),
    min: 0, max: 100,
    explain: 'The standard calls this hybrid battery pack remaining life, but most hybrids, including Toyota, actually report the ' +
      'current state of charge here (how full the high voltage battery is right now). Toyota hybrids keep it roughly between ' +
      '40 and 80 % and never let it go fully empty or full, to protect the battery. It is not a measure of battery health on its own.'
  },
  0x5C: {
    name: 'Engine oil temperature', short: 'Oil temp', unit: '°C', bytes: 1, decimals: 0,
    decode: (A) => temp(A),
    min: -40, max: 150,
    explain: 'Temperature of the engine oil. Once fully warm it is usually 90 to 120 °C. It warms up more slowly than the coolant. ' +
      'On a hybrid it may stay lower during short or mostly electric trips.'
  },
  0x5D: {
    name: 'Fuel injection timing', short: 'Inj timing', unit: '°', bytes: 2, decimals: 2,
    decode: (A, B) => word(A, B) / 128 - 210,
    min: -210, max: 302,
    explain: 'When fuel injection starts relative to the piston position, in degrees. Mostly reported by diesels.'
  },
  0x5E: {
    name: 'Engine fuel rate', short: 'Fuel rate', unit: 'L/h', bytes: 2, decimals: 2,
    decode: (A, B) => word(A, B) / 20,
    min: 0, max: 30,
    explain: 'How much fuel the engine is using right now, in litres per hour. Idle is typically 0.5 to 1.2 L/h. On a hybrid it ' +
      'drops to 0 whenever the petrol engine is off.'
  },
  0x61: {
    name: 'Driver demand engine torque', short: 'Torque dem', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => A - 125,
    min: -125, max: 130,
    explain: 'How much engine torque is being requested, as a percentage of the engine reference torque. Negative values mean ' +
      'engine braking. On a hybrid the electric motor may supply part of what you ask for.'
  },
  0x62: {
    name: 'Actual engine torque', short: 'Torque', unit: '%', bytes: 1, decimals: 0,
    decode: (A) => A - 125,
    min: -125, max: 130,
    explain: 'How much torque the engine is actually producing, as a percentage of the engine reference torque. 0 % on a hybrid ' +
      'while the petrol engine is off.'
  },
  0x63: {
    name: 'Engine reference torque', short: 'Ref torque', unit: 'Nm', bytes: 2, decimals: 0,
    decode: (A, B) => word(A, B),
    min: 0, max: 1000,
    explain: 'The engine maximum torque used as the 100 % reference for the torque readings. It is a fixed number for the engine.'
  },
  0xA6: {
    name: 'Odometer', short: 'Odometer', unit: 'km', bytes: 4, decimals: 1,
    decode: (A, B, C, D) => (A * 16777216 + B * 65536 + C * 256 + D) / 10,
    min: 0, max: 999999,
    explain: 'Total distance the car has driven, stored in the engine computer. Compare it with the dashboard. A big difference ' +
      'can be a sign of a tampered odometer. Only newer cars report this (many European models do not).'
  }
};

export const GAUGE_DEFAULTS = [0x0C, 0x0D, 0x05, 0x0F, 0x04, 0x11, 0x06, 0x07, 0x42, 0x5B, 0x2F, 0x46];

function hex2(n) {
  return (n < 16 ? '0' : '') + n.toString(16).toUpperCase();
}

function formatNumber(v, decimals) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  const d = decimals === undefined ? 1 : decimals;
  return v.toFixed(d);
}

// bytes = data bytes after mode+pid. Returns {value, unit, text}.
export function decodePid(pid, bytes) {
  const def = PIDS[pid];
  const b = Array.isArray(bytes) ? bytes : (bytes ? Array.prototype.slice.call(bytes) : []);
  if (!def) {
    return { value: null, unit: '', text: b.length ? 'Raw data: ' + b.map(hex2).join(' ') : 'No data' };
  }
  // Text style PIDs only really need the first byte. Numeric PIDs need their full length.
  const need = def.isText ? 1 : (def.bytes === 4 && pid >= 0x34 && pid <= 0x3B ? 2 : def.bytes);
  if (b.length < need) {
    return { value: null, unit: def.unit, text: 'No data' };
  }
  const A = b[0], B = b[1], C = b[2], D = b[3];
  let value;
  try {
    value = def.decode(A, B, C, D);
  } catch (e) {
    return { value: null, unit: def.unit, text: 'Could not read value' };
  }
  let text;
  if (def.isText) {
    text = def.format ? def.format(A, B, C, D) : String(value);
  } else {
    text = formatNumber(value, def.decimals) + (def.unit ? ' ' + def.unit : '');
    if (def.extra) {
      const ex = def.extra(A, B, C, D);
      if (ex) text += ' (' + ex + ')';
    }
  }
  return { value, unit: def.unit, text };
}

// Readiness monitors per SAE J1979 PID 01 (and PID 41) layout.
// Byte B holds the three "continuous" monitors: availability bits 0 to 2, incomplete bits 4 to 6.
// Bit 3 of byte B: 0 = spark ignition (petrol), 1 = compression ignition (diesel).
// Bytes C (available) and D (incomplete, 1 = not finished yet) hold the other monitors, whose meaning depends on ignition type.
// Each entry: {key, name, explain, availByte, availBit, incByte, incBit}. Bytes are 'B' | 'C' | 'D'.
const common = [
  { key: 'misfire', name: 'Misfire', availByte: 'B', availBit: 0, incByte: 'B', incBit: 4,
    explain: 'Checks that every cylinder is firing properly. It runs all the time while the engine is on, so it is normally complete.' },
  { key: 'fuelSystem', name: 'Fuel system', availByte: 'B', availBit: 1, incByte: 'B', incBit: 5,
    explain: 'Checks the fuel mix stays within the limits the computer can correct. Runs continuously and is normally complete.' },
  { key: 'components', name: 'Comprehensive components', availByte: 'B', availBit: 2, incByte: 'B', incBit: 6,
    explain: 'Checks sensors and actuators for broken wires, shorts and impossible readings. Runs continuously and is normally complete.' }
];

const spark = [
  { key: 'catalyst', name: 'Catalytic converter', bit: 0,
    explain: 'Checks the catalytic converter is cleaning the exhaust well. Needs a fully warm engine and some steady cruising. ' +
      'On hybrids this can take longer because the engine turns off often.' },
  { key: 'heatedCatalyst', name: 'Heated catalyst', bit: 1,
    explain: 'Checks an electrically heated catalytic converter. Very few cars have one.' },
  { key: 'evap', name: 'Evaporative system (EVAP)', bit: 2,
    explain: 'Checks the fuel tank and vapour system for leaks, which can be as small as a loose fuel cap. It often needs the car ' +
      'to sit overnight with the fuel tank between a quarter and three quarters full, so it is usually the last to complete.' },
  { key: 'secondaryAir', name: 'Secondary air system', bit: 3,
    explain: 'Checks the air pump that helps heat the catalytic converter after a cold start. Only some cars have one.' },
  { key: 'acRefrigerant', name: 'A/C refrigerant', bit: 4,
    explain: 'Checks the air conditioning refrigerant system. Rarely used, and treated as reserved in newer versions of the standard.' },
  { key: 'o2Sensor', name: 'Oxygen sensors', bit: 5,
    explain: 'Checks the oxygen sensors in the exhaust respond quickly and correctly. Needs a warm engine and a mix of driving.' },
  { key: 'o2Heater', name: 'Oxygen sensor heaters', bit: 6,
    explain: 'Checks the heaters that bring the oxygen sensors up to working temperature. Usually completes within a few drives.' },
  { key: 'egr', name: 'EGR and/or VVT system', bit: 7,
    explain: 'Checks the exhaust gas recirculation valve and, on many cars, variable valve timing. Needs some steady driving and slowing down.' }
];

const compression = [
  { key: 'nmhcCatalyst', name: 'NMHC catalyst', bit: 0,
    explain: 'Checks the diesel oxidation catalyst that burns off unburnt fuel in the exhaust.' },
  { key: 'noxScr', name: 'NOx / SCR aftertreatment', bit: 1,
    explain: 'Checks the system that reduces nitrogen oxides, often using AdBlue (DEF).' },
  { key: 'reserved2', name: 'Reserved', bit: 2,
    explain: 'Not used by the standard. If a car reports it, it can be ignored.' },
  { key: 'boostPressure', name: 'Boost pressure', bit: 3,
    explain: 'Checks the turbocharger boost control.' },
  { key: 'reserved4', name: 'Reserved', bit: 4,
    explain: 'Not used by the standard. If a car reports it, it can be ignored.' },
  { key: 'exhaustSensor', name: 'Exhaust gas sensor', bit: 5,
    explain: 'Checks the exhaust gas sensors (oxygen or NOx sensors).' },
  { key: 'pmFilter', name: 'Particulate filter (DPF)', bit: 6,
    explain: 'Checks the diesel particulate filter that traps soot. It needs regular longer drives to clean itself.' },
  { key: 'egrVvt', name: 'EGR and/or VVT system', bit: 7,
    explain: 'Checks the exhaust gas recirculation valve and, on some engines, variable valve timing.' }
];

function withBytes(list) {
  return list.map((m) => ({ key: m.key, name: m.name, explain: m.explain,
    availByte: 'C', availBit: m.bit, incByte: 'D', incBit: m.bit }));
}

export const MONITORS = {
  common: common,
  spark: withBytes(spark),
  compression: withBytes(compression)
};

// Convenience helper (optional for callers): decode the 4 data bytes of PID 01 or PID 41.
// Returns {milOn, dtcCount, ignition, monitors:[{key,name,explain,available,complete}]}.
// For PID 41 the first byte is reserved, so milOn and dtcCount are not meaningful there.
export function decodeReadiness(bytes) {
  const b = bytes || [];
  const byName = { B: b[1] || 0, C: b[2] || 0, D: b[3] || 0 };
  const A = b[0] || 0;
  const ignition = (byName.B & 0x08) ? 'compression' : 'spark';
  const defs = MONITORS.common.concat(ignition === 'compression' ? MONITORS.compression : MONITORS.spark);
  const monitors = defs.map((m) => {
    const available = (byName[m.availByte] & (1 << m.availBit)) !== 0;
    const incomplete = (byName[m.incByte] & (1 << m.incBit)) !== 0;
    return { key: m.key, name: m.name, explain: m.explain, available, complete: available && !incomplete };
  });
  return { milOn: (A & 0x80) !== 0, dtcCount: A & 0x7f, ignition, monitors };
}
