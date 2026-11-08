// DTC description database (SAE J2012 style generic codes).
// Plain ES module, no dependencies. All text is plain English.
// Codes that are not in the table fall back to a description built from the code structure.

const D = {};

function put(obj) {
  for (const k in obj) D[k] = obj[k];
}

// Helper for "base, Range/Performance, Low, High, Intermittent" style families.
function family(start, base, suffixes) {
  const n = parseInt(start.slice(1), 16);
  const letter = start[0];
  for (let i = 0; i < suffixes.length; i++) {
    if (suffixes[i] === null) continue;
    const code = letter + (n + i).toString(16).toUpperCase().padStart(4, '0');
    D[code] = suffixes[i] ? base + ' ' + suffixes[i] : base;
  }
}
const RLHI = ['', 'Range/Performance', 'Low', 'High', 'Intermittent'];
const RLHI_E = ['', 'Range/Performance', 'Low', 'High', 'Intermittent/Erratic'];

// ---------- P00xx ----------
put({
  P0010: '"A" Camshaft Position Actuator Circuit (Bank 1)',
  P0011: '"A" Camshaft Position Timing Over-Advanced or System Performance (Bank 1)',
  P0012: '"A" Camshaft Position Timing Over-Retarded (Bank 1)',
  P0013: '"B" Camshaft Position Actuator Circuit (Bank 1)',
  P0014: '"B" Camshaft Position Timing Over-Advanced or System Performance (Bank 1)',
  P0015: '"B" Camshaft Position Timing Over-Retarded (Bank 1)',
  P0016: 'Crankshaft Position / Camshaft Position Correlation (Bank 1 Sensor A)',
  P0017: 'Crankshaft Position / Camshaft Position Correlation (Bank 1 Sensor B)',
  P0018: 'Crankshaft Position / Camshaft Position Correlation (Bank 2 Sensor A)',
  P0019: 'Crankshaft Position / Camshaft Position Correlation (Bank 2 Sensor B)',
  P0020: '"A" Camshaft Position Actuator Circuit (Bank 2)',
  P0021: '"A" Camshaft Position Timing Over-Advanced or System Performance (Bank 2)',
  P0022: '"A" Camshaft Position Timing Over-Retarded (Bank 2)',
  P0023: '"B" Camshaft Position Actuator Circuit (Bank 2)',
  P0024: '"B" Camshaft Position Timing Over-Advanced or System Performance (Bank 2)',
  P0025: '"B" Camshaft Position Timing Over-Retarded (Bank 2)',
  P0026: 'Intake Valve Control Solenoid Circuit Range/Performance (Bank 1)',
  P0027: 'Exhaust Valve Control Solenoid Circuit Range/Performance (Bank 1)',
  P0028: 'Intake Valve Control Solenoid Circuit Range/Performance (Bank 2)',
  P0029: 'Exhaust Valve Control Solenoid Circuit Range/Performance (Bank 2)',
  P0033: 'Turbocharger/Supercharger Bypass Valve Control Circuit',
  P0034: 'Turbocharger/Supercharger Bypass Valve Control Circuit Low',
  P0035: 'Turbocharger/Supercharger Bypass Valve Control Circuit High',
  P0040: 'O2 Sensor Signals Swapped Bank 1 Sensor 1 / Bank 2 Sensor 1',
  P0041: 'O2 Sensor Signals Swapped Bank 1 Sensor 2 / Bank 2 Sensor 2',
  P0065: 'Air Assisted Injector Control Range/Performance',
  P0066: 'Air Assisted Injector Control Circuit or Circuit Low',
  P0067: 'Air Assisted Injector Control Circuit High',
  P0068: 'MAP/MAF - Throttle Position Correlation',
  P0069: 'Manifold Absolute Pressure - Barometric Pressure Correlation',
  P0087: 'Fuel Rail/System Pressure - Too Low',
  P0088: 'Fuel Rail/System Pressure - Too High',
  P0089: 'Fuel Pressure Regulator 1 Performance',
  P0090: 'Fuel Pressure Regulator 1 Control Circuit',
  P0091: 'Fuel Pressure Regulator 1 Control Circuit Low',
  P0092: 'Fuel Pressure Regulator 1 Control Circuit High',
  P0093: 'Fuel System Leak Detected - Large Leak',
  P0094: 'Fuel System Leak Detected - Small Leak'
});
// O2 heater circuits
[['P0030', 'Bank 1 Sensor 1'], ['P0036', 'Bank 1 Sensor 2'], ['P0042', 'Bank 1 Sensor 3'],
 ['P0050', 'Bank 2 Sensor 1'], ['P0056', 'Bank 2 Sensor 2'], ['P0062', 'Bank 2 Sensor 3']].forEach(function (x) {
  const n = parseInt(x[0].slice(1), 16);
  const c = function (i) { return 'P' + (n + i).toString(16).toUpperCase().padStart(4, '0'); };
  D[c(0)] = 'HO2S Heater Control Circuit (' + x[1] + ')';
  D[c(1)] = 'HO2S Heater Control Circuit Low (' + x[1] + ')';
  D[c(2)] = 'HO2S Heater Control Circuit High (' + x[1] + ')';
});
put({
  P0053: 'HO2S Heater Resistance (Bank 1 Sensor 1)',
  P0054: 'HO2S Heater Resistance (Bank 1 Sensor 2)',
  P0055: 'HO2S Heater Resistance (Bank 1 Sensor 3)',
  P0059: 'HO2S Heater Resistance (Bank 2 Sensor 1)',
  P0060: 'HO2S Heater Resistance (Bank 2 Sensor 2)',
  P0061: 'HO2S Heater Resistance (Bank 2 Sensor 3)'
});
family('P0070', 'Ambient Air Temperature Sensor Circuit', RLHI);
[['P0075', 'Intake', 'Bank 1'], ['P0078', 'Exhaust', 'Bank 1'], ['P0081', 'Intake', 'Bank 2'], ['P0084', 'Exhaust', 'Bank 2']].forEach(function (x) {
  const n = parseInt(x[0].slice(1), 10);
  const b = x[1] + ' Valve Control Solenoid Circuit';
  D['P' + n.toString().padStart(4, '0')] = b + ' (' + x[2] + ')';
  D['P' + (n + 1).toString().padStart(4, '0')] = b + ' Low (' + x[2] + ')';
  D['P' + (n + 2).toString().padStart(4, '0')] = b + ' High (' + x[2] + ')';
});
family('P0095', 'Intake Air Temperature Sensor 2 Circuit', RLHI);

// ---------- P01xx ----------
family('P0100', 'Mass or Volume Air Flow "A" Circuit', RLHI);
family('P0105', 'Manifold Absolute Pressure/Barometric Pressure Circuit', RLHI);
family('P0110', 'Intake Air Temperature Sensor 1 Circuit', RLHI_E);
family('P0115', 'Engine Coolant Temperature Sensor 1 Circuit', RLHI_E);
family('P0120', 'Throttle/Pedal Position Sensor/Switch "A" Circuit', RLHI);
put({
  P0125: 'Insufficient Coolant Temperature for Closed Loop Fuel Control',
  P0126: 'Insufficient Coolant Temperature for Stable Operation',
  P0127: 'Intake Air Temperature Too High',
  P0128: 'Coolant Thermostat (Coolant Temperature Below Thermostat Regulating Temperature)',
  P0129: 'Barometric Pressure Too Low'
});
[['P0130', 'Bank 1 Sensor 1'], ['P0136', 'Bank 1 Sensor 2'], ['P0142', 'Bank 1 Sensor 3'],
 ['P0150', 'Bank 2 Sensor 1'], ['P0156', 'Bank 2 Sensor 2'], ['P0162', 'Bank 2 Sensor 3']].forEach(function (x) {
  const n = parseInt(x[0].slice(1), 10);
  const parts = ['Circuit', 'Circuit Low Voltage', 'Circuit High Voltage', 'Circuit Slow Response', 'Circuit No Activity Detected', 'Heater Circuit'];
  parts.forEach(function (p, i) {
    D['P' + (n + i).toString().padStart(4, '0')] = 'O2 Sensor ' + p + ' (' + x[1] + ')';
  });
});
put({
  P0168: 'Fuel Temperature Too High',
  P0169: 'Incorrect Fuel Composition',
  P0170: 'Fuel Trim (Bank 1)',
  P0171: 'System Too Lean (Bank 1)',
  P0172: 'System Too Rich (Bank 1)',
  P0173: 'Fuel Trim (Bank 2)',
  P0174: 'System Too Lean (Bank 2)',
  P0175: 'System Too Rich (Bank 2)'
});
family('P0176', 'Fuel Composition Sensor Circuit', ['', 'Range/Performance', 'Low', 'High']);
family('P0180', 'Fuel Temperature Sensor "A" Circuit', RLHI);
family('P0185', 'Fuel Temperature Sensor "B" Circuit', RLHI);
family('P0190', 'Fuel Rail Pressure Sensor "A" Circuit', RLHI);
family('P0195', 'Engine Oil Temperature Sensor Circuit', RLHI);

// ---------- P02xx ----------
D.P0200 = 'Injector Circuit/Open';
for (let i = 1; i <= 12; i++) D['P02' + String(i).padStart(2, '0')] = 'Injector Circuit/Open - Cylinder ' + i;
put({
  P0213: 'Cold Start Injector 1',
  P0214: 'Cold Start Injector 2',
  P0215: 'Engine Shutoff Solenoid',
  P0216: 'Injector/Injection Timing Control Circuit',
  P0217: 'Engine Coolant Over Temperature Condition',
  P0218: 'Transmission Fluid Over Temperature Condition',
  P0219: 'Engine Overspeed Condition',
  P0230: 'Fuel Pump Primary Circuit',
  P0231: 'Fuel Pump Secondary Circuit Low',
  P0232: 'Fuel Pump Secondary Circuit High',
  P0233: 'Fuel Pump Secondary Circuit Intermittent',
  P0234: 'Turbocharger/Supercharger "A" Overboost Condition',
  P0297: 'Vehicle Overspeed Condition',
  P0298: 'Engine Oil Over Temperature',
  P0299: 'Turbocharger/Supercharger "A" Underboost Condition'
});
family('P0220', 'Throttle/Pedal Position Sensor/Switch "B" Circuit', RLHI);
family('P0225', 'Throttle/Pedal Position Sensor/Switch "C" Circuit', RLHI);
family('P0235', 'Turbocharger/Supercharger Boost Sensor "A" Circuit', ['', 'Range/Performance', 'Low', 'High']);
family('P0239', 'Turbocharger/Supercharger Boost Sensor "B" Circuit', ['', 'Range/Performance', 'Low', 'High']);
family('P0243', 'Turbocharger/Supercharger Wastegate Solenoid "A"', ['', 'Range/Performance', 'Low', 'High']);
family('P0247', 'Turbocharger/Supercharger Wastegate Solenoid "B"', ['', 'Range/Performance', 'Low', 'High']);
for (let i = 0; i < 12; i++) {
  const n = 261 + i * 3;
  const cyl = 'Cylinder ' + (i + 1);
  D['P0' + n] = cyl + ' Injector "A" Circuit Low';
  D['P0' + (n + 1)] = cyl + ' Injector "A" Circuit High';
  D['P0' + (n + 2)] = cyl + ' Contribution/Balance';
}

// ---------- P03xx ----------
D.P0300 = 'Random/Multiple Cylinder Misfire Detected';
for (let i = 1; i <= 12; i++) D['P03' + String(i).padStart(2, '0')] = 'Cylinder ' + i + ' Misfire Detected';
put({
  P0313: 'Misfire Detected with Low Fuel',
  P0314: 'Single Cylinder Misfire (Cylinder not Specified)',
  P0315: 'Crankshaft Position System Variation Not Learned',
  P0316: 'Engine Misfire Detected on Startup (First 1000 Revolutions)',
  P0320: 'Ignition/Distributor Engine Speed Input Circuit',
  P0321: 'Ignition/Distributor Engine Speed Input Circuit Range/Performance',
  P0322: 'Ignition/Distributor Engine Speed Input Circuit No Signal',
  P0323: 'Ignition/Distributor Engine Speed Input Circuit Intermittent',
  P0324: 'Knock Control System Error',
  P0350: 'Ignition Coil Primary/Secondary Circuit',
  P0380: 'Glow Plug/Heater Circuit "A"',
  P0381: 'Glow Plug/Heater Indicator Circuit',
  P0382: 'Glow Plug/Heater Circuit "B"'
});
family('P0325', 'Knock Sensor 1 Circuit (Bank 1 or Single Sensor)', RLHI);
family('P0330', 'Knock Sensor 2 Circuit (Bank 2)', RLHI);
family('P0335', 'Crankshaft Position Sensor "A" Circuit', RLHI);
family('P0340', 'Camshaft Position Sensor "A" Circuit (Bank 1 or Single Sensor)', RLHI);
family('P0345', 'Camshaft Position Sensor "A" Circuit (Bank 2)', RLHI);
family('P0365', 'Camshaft Position Sensor "B" Circuit (Bank 1)', RLHI);
family('P0385', 'Crankshaft Position Sensor "B" Circuit', RLHI);
family('P0390', 'Camshaft Position Sensor "B" Circuit (Bank 2)', RLHI);
'ABCDEFGHIJKL'.split('').forEach(function (L, i) {
  D['P03' + (51 + i)] = 'Ignition Coil "' + L + '" Primary/Secondary Circuit (usually cylinder ' + (i + 1) + ')';
});

// ---------- P04xx ----------
put({
  P0400: 'Exhaust Gas Recirculation "A" Flow',
  P0401: 'Exhaust Gas Recirculation "A" Flow Insufficient Detected',
  P0402: 'Exhaust Gas Recirculation "A" Flow Excessive Detected',
  P0403: 'Exhaust Gas Recirculation "A" Control Circuit',
  P0404: 'Exhaust Gas Recirculation "A" Control Circuit Range/Performance',
  P0405: 'Exhaust Gas Recirculation Sensor "A" Circuit Low',
  P0406: 'Exhaust Gas Recirculation Sensor "A" Circuit High',
  P0407: 'Exhaust Gas Recirculation Sensor "B" Circuit Low',
  P0408: 'Exhaust Gas Recirculation Sensor "B" Circuit High',
  P0409: 'Exhaust Gas Recirculation Sensor "A" Circuit',
  P0410: 'Secondary Air Injection System',
  P0411: 'Secondary Air Injection System Incorrect Flow Detected',
  P0412: 'Secondary Air Injection System Switching Valve "A" Circuit',
  P0413: 'Secondary Air Injection System Switching Valve "A" Circuit Open',
  P0414: 'Secondary Air Injection System Switching Valve "A" Circuit Shorted',
  P0415: 'Secondary Air Injection System Switching Valve "B" Circuit',
  P0416: 'Secondary Air Injection System Switching Valve "B" Circuit Open',
  P0417: 'Secondary Air Injection System Switching Valve "B" Circuit Shorted',
  P0418: 'Secondary Air Injection System Control "A" Circuit',
  P0419: 'Secondary Air Injection System Control "B" Circuit',
  P0429: 'Catalyst Heater Control Circuit (Bank 1)',
  P0439: 'Catalyst Heater Control Circuit (Bank 2)',
  P0440: 'Evaporative Emission System',
  P0441: 'Evaporative Emission System Incorrect Purge Flow',
  P0442: 'Evaporative Emission System Leak Detected (Small Leak)',
  P0443: 'Evaporative Emission System Purge Control Valve Circuit',
  P0444: 'Evaporative Emission System Purge Control Valve Circuit Open',
  P0445: 'Evaporative Emission System Purge Control Valve Circuit Shorted',
  P0446: 'Evaporative Emission System Vent Control Circuit',
  P0447: 'Evaporative Emission System Vent Control Circuit Open',
  P0448: 'Evaporative Emission System Vent Control Circuit Shorted',
  P0449: 'Evaporative Emission System Vent Valve/Solenoid Circuit',
  P0455: 'Evaporative Emission System Leak Detected (Large Leak)',
  P0456: 'Evaporative Emission System Leak Detected (Very Small Leak)',
  P0457: 'Evaporative Emission System Leak Detected (Fuel Cap Loose/Off)',
  P0458: 'Evaporative Emission System Purge Control Valve Circuit Low',
  P0459: 'Evaporative Emission System Purge Control Valve Circuit High',
  P0480: 'Fan 1 Control Circuit',
  P0481: 'Fan 2 Control Circuit',
  P0482: 'Fan 3 Control Circuit',
  P0483: 'Fan Rationality Check',
  P0484: 'Fan Circuit Over Current',
  P0485: 'Fan Power/Ground Circuit',
  P0486: 'Exhaust Gas Recirculation Sensor "B" Circuit',
  P0487: 'Exhaust Gas Recirculation Throttle Control Circuit "A"',
  P0488: 'Exhaust Gas Recirculation Throttle Control Circuit "A" Range/Performance',
  P0489: 'Exhaust Gas Recirculation "A" Control Circuit Low',
  P0490: 'Exhaust Gas Recirculation "A" Control Circuit High',
  P0491: 'Secondary Air Injection System Insufficient Flow (Bank 1)',
  P0492: 'Secondary Air Injection System Insufficient Flow (Bank 2)',
  P0493: 'Fan Overspeed',
  P0494: 'Fan Speed Low',
  P0495: 'Fan Speed High',
  P0496: 'Evaporative Emission System High Purge Flow',
  P0497: 'Evaporative Emission System Low Purge Flow',
  P0498: 'Evaporative Emission System Vent Control Circuit Low',
  P0499: 'Evaporative Emission System Vent Control Circuit High'
});
[['P0420', 'Bank 1'], ['P0430', 'Bank 2']].forEach(function (x) {
  const n = parseInt(x[0].slice(1), 10);
  const b = ' (' + x[1] + ')';
  const p = function (i) { return 'P0' + (n + i); };
  D[p(0)] = 'Catalyst System Efficiency Below Threshold' + b;
  D[p(1)] = 'Warm Up Catalyst Efficiency Below Threshold' + b;
  D[p(2)] = 'Main Catalyst Efficiency Below Threshold' + b;
  D[p(3)] = 'Heated Catalyst Efficiency Below Threshold' + b;
  D[p(4)] = 'Heated Catalyst Temperature Below Threshold' + b;
  D[p(5)] = 'Catalyst Temperature Sensor' + b;
  D[p(6)] = 'Catalyst Temperature Sensor Range/Performance' + b;
  D[p(7)] = 'Catalyst Temperature Sensor Low' + b;
  D[p(8)] = 'Catalyst Temperature Sensor High' + b;
});
family('P0450', 'Evaporative Emission System Pressure Sensor/Switch', RLHI);
family('P0460', 'Fuel Level Sensor "A" Circuit', RLHI_E);
family('P0465', 'EVAP Purge Flow Sensor Circuit', RLHI);
family('P0470', 'Exhaust Pressure Sensor "A"', RLHI);
family('P0475', 'Exhaust Pressure Control Valve "A"', RLHI);

// ---------- P05xx ----------
put({
  P0500: 'Vehicle Speed Sensor "A"',
  P0501: 'Vehicle Speed Sensor "A" Range/Performance',
  P0502: 'Vehicle Speed Sensor "A" Circuit Low Input',
  P0503: 'Vehicle Speed Sensor "A" Intermittent/Erratic/High',
  P0504: 'Brake Switch "A" / "B" Correlation',
  P0505: 'Idle Air Control System',
  P0506: 'Idle Air Control System RPM Lower Than Expected',
  P0507: 'Idle Air Control System RPM Higher Than Expected',
  P0508: 'Idle Air Control System Circuit Low',
  P0509: 'Idle Air Control System Circuit High',
  P0510: 'Closed Throttle Position Switch',
  P0511: 'Idle Air Control Circuit',
  P0512: 'Starter Request Circuit',
  P0513: 'Invalid Immobilizer Key',
  P0515: 'Battery Temperature Sensor Circuit',
  P0516: 'Battery Temperature Sensor Circuit Low',
  P0517: 'Battery Temperature Sensor Circuit High',
  P0524: 'Engine Oil Pressure Too Low',
  P0534: 'Air Conditioner Refrigerant Charge Loss',
  P0540: 'Intake Air Heater "A" Circuit',
  P0544: 'Exhaust Gas Temperature Sensor Circuit (Bank 1 Sensor 1)',
  P0545: 'Exhaust Gas Temperature Sensor Circuit Low (Bank 1 Sensor 1)',
  P0546: 'Exhaust Gas Temperature Sensor Circuit High (Bank 1 Sensor 1)',
  P0555: 'Brake Booster Pressure Sensor Circuit',
  P0560: 'System Voltage',
  P0561: 'System Voltage Unstable',
  P0562: 'System Voltage Low',
  P0563: 'System Voltage High',
  P0564: 'Cruise Control Multi-Function Input "A" Circuit',
  P0565: 'Cruise Control On Signal',
  P0566: 'Cruise Control Off Signal',
  P0567: 'Cruise Control Resume Signal',
  P0568: 'Cruise Control Set Signal',
  P0569: 'Cruise Control Coast Signal',
  P0570: 'Cruise Control Accelerate Signal',
  P0571: 'Brake Switch "A" Circuit',
  P0572: 'Brake Switch "A" Circuit Low',
  P0573: 'Brake Switch "A" Circuit High',
  P0574: 'Cruise Control System - Vehicle Speed Too High',
  P0575: 'Cruise Control Input Circuit'
});
family('P0520', 'Engine Oil Pressure Sensor/Switch Circuit', ['', 'Range/Performance', 'Low', 'High']);
family('P0530', 'A/C Refrigerant Pressure Sensor "A" Circuit', ['', 'Range/Performance', 'Low', 'High']);
family('P0550', 'Power Steering Pressure Sensor/Switch Circuit', RLHI);

// ---------- P06xx ----------
put({
  P0600: 'Serial Communication Link',
  P0601: 'Internal Control Module Memory Check Sum Error',
  P0602: 'Control Module Programming Error',
  P0603: 'Internal Control Module Keep Alive Memory (KAM) Error',
  P0604: 'Internal Control Module Random Access Memory (RAM) Error',
  P0605: 'Internal Control Module Read Only Memory (ROM) Error',
  P0606: 'Control Module Processor',
  P0607: 'Control Module Performance',
  P0608: 'Control Module VSS Output "A"',
  P0609: 'Control Module VSS Output "B"',
  P0610: 'Control Module Vehicle Options Error',
  P0611: 'Fuel Injector Control Module Performance',
  P0612: 'Fuel Injector Control Module Relay Control',
  P0613: 'TCM Processor',
  P0614: 'ECM / TCM Incompatible',
  P0615: 'Starter Relay Circuit',
  P0616: 'Starter Relay Circuit Low',
  P0617: 'Starter Relay Circuit High',
  P0620: 'Generator Control Circuit',
  P0621: 'Generator Lamp/L Terminal Control Circuit',
  P0622: 'Generator Field/F Terminal Control Circuit',
  P0625: 'Generator Field/F Terminal Circuit Low',
  P0626: 'Generator Field/F Terminal Circuit High',
  P0627: 'Fuel Pump "A" Control Circuit/Open',
  P0628: 'Fuel Pump "A" Control Circuit Low',
  P0629: 'Fuel Pump "A" Control Circuit High',
  P0630: 'VIN Not Programmed or Incompatible - ECM/PCM',
  P0638: 'Throttle Actuator Control Range/Performance (Bank 1)',
  P0639: 'Throttle Actuator Control Range/Performance (Bank 2)',
  P0641: 'Sensor Reference Voltage "A" Circuit/Open',
  P0642: 'Sensor Reference Voltage "A" Circuit Low',
  P0643: 'Sensor Reference Voltage "A" Circuit High',
  P0645: 'A/C Clutch Relay Control Circuit',
  P0646: 'A/C Clutch Relay Control Circuit Low',
  P0647: 'A/C Clutch Relay Control Circuit High',
  P0650: 'Malfunction Indicator Lamp (MIL) Control Circuit',
  P0651: 'Sensor Reference Voltage "B" Circuit/Open',
  P0652: 'Sensor Reference Voltage "B" Circuit Low',
  P0653: 'Sensor Reference Voltage "B" Circuit High',
  P0654: 'Engine RPM Output Circuit',
  P0655: 'Engine Hot Lamp Output Control Circuit',
  P0656: 'Fuel Level Output Circuit',
  P0657: 'Actuator Supply Voltage "A" Circuit/Open',
  P0660: 'Intake Manifold Tuning Valve Control Circuit/Open (Bank 1)',
  P0661: 'Intake Manifold Tuning Valve Control Circuit Low (Bank 1)',
  P0662: 'Intake Manifold Tuning Valve Control Circuit High (Bank 1)',
  P0685: 'ECM/PCM Power Relay Control Circuit/Open',
  P0686: 'ECM/PCM Power Relay Control Circuit Low',
  P0687: 'ECM/PCM Power Relay Control Circuit High',
  P0688: 'ECM/PCM Power Relay Sense Circuit/Open',
  P0689: 'ECM/PCM Power Relay Sense Circuit Low',
  P0690: 'ECM/PCM Power Relay Sense Circuit High',
  P0691: 'Fan 1 Control Circuit Low',
  P0692: 'Fan 1 Control Circuit High',
  P0693: 'Fan 2 Control Circuit Low',
  P0694: 'Fan 2 Control Circuit High',
  P0697: 'Sensor Reference Voltage "C" Circuit/Open',
  P0698: 'Sensor Reference Voltage "C" Circuit Low',
  P0699: 'Sensor Reference Voltage "C" Circuit High'
});

// ---------- P07xx to P09xx (transmission) ----------
put({
  P0700: 'Transmission Control System (MIL Request)',
  P0701: 'Transmission Control System Range/Performance',
  P0702: 'Transmission Control System Electrical',
  P0703: 'Brake Switch "B" Circuit',
  P0704: 'Clutch Switch Input Circuit Malfunction',
  P0705: 'Transmission Range Sensor "A" Circuit (PRNDL Input)',
  P0706: 'Transmission Range Sensor "A" Circuit Range/Performance',
  P0707: 'Transmission Range Sensor "A" Circuit Low',
  P0708: 'Transmission Range Sensor "A" Circuit High',
  P0709: 'Transmission Range Sensor "A" Circuit Intermittent',
  P0715: 'Input/Turbine Speed Sensor "A" Circuit',
  P0716: 'Input/Turbine Speed Sensor "A" Circuit Range/Performance',
  P0717: 'Input/Turbine Speed Sensor "A" Circuit No Signal',
  P0718: 'Input/Turbine Speed Sensor "A" Circuit Intermittent',
  P0719: 'Torque Converter/Brake Switch "B" Circuit Low',
  P0720: 'Output Speed Sensor Circuit',
  P0721: 'Output Speed Sensor Circuit Range/Performance',
  P0722: 'Output Speed Sensor Circuit No Signal',
  P0723: 'Output Speed Sensor Circuit Intermittent',
  P0724: 'Torque Converter/Brake Switch "B" Circuit High',
  P0725: 'Engine Speed Input Circuit',
  P0726: 'Engine Speed Input Circuit Range/Performance',
  P0727: 'Engine Speed Input Circuit No Signal',
  P0728: 'Engine Speed Input Circuit Intermittent',
  P0729: 'Gear 6 Incorrect Ratio',
  P0730: 'Incorrect Gear Ratio',
  P0731: 'Gear 1 Incorrect Ratio',
  P0732: 'Gear 2 Incorrect Ratio',
  P0733: 'Gear 3 Incorrect Ratio',
  P0734: 'Gear 4 Incorrect Ratio',
  P0735: 'Gear 5 Incorrect Ratio',
  P0736: 'Reverse Incorrect Ratio',
  P0780: 'Shift Error',
  P0781: '1-2 Shift',
  P0782: '2-3 Shift',
  P0783: '3-4 Shift',
  P0784: '4-5 Shift',
  P0785: 'Shift/Timing Solenoid',
  P0787: 'Shift/Timing Solenoid Low',
  P0788: 'Shift/Timing Solenoid High',
  P0790: 'Normal/Performance Switch Circuit',
  P0805: 'Clutch Position Sensor Circuit',
  P0850: 'Park/Neutral Switch Input Circuit',
  P0868: 'Transmission Fluid Pressure Low',
  P0880: 'TCM Power Input Signal',
  P0882: 'TCM Power Input Signal Low',
  P0883: 'TCM Power Input Signal High',
  P0894: 'Transmission Component Slipping',
  P0897: 'Transmission Fluid Deteriorated',
  P0962: 'Pressure Control Solenoid "A" Control Circuit Low',
  P0963: 'Pressure Control Solenoid "A" Control Circuit High',
  P0966: 'Pressure Control Solenoid "B" Control Circuit Low',
  P0967: 'Pressure Control Solenoid "B" Control Circuit High',
  P0970: 'Pressure Control Solenoid "C" Control Circuit Low',
  P0971: 'Pressure Control Solenoid "C" Control Circuit High'
});
family('P0710', 'Transmission Fluid Temperature Sensor "A" Circuit', RLHI);
family('P0740', 'Torque Converter Clutch Circuit', ['', 'Performance or Stuck Off', 'Stuck On', 'Electrical', 'Intermittent']);
D.P0740 = 'Torque Converter Clutch Circuit/Open';
const SOL = ['', 'Performance or Stuck Off', 'Stuck On', 'Electrical', 'Intermittent'];
family('P0745', 'Pressure Control Solenoid "A"', SOL);
family('P0750', 'Shift Solenoid "A"', SOL);
family('P0755', 'Shift Solenoid "B"', SOL);
family('P0760', 'Shift Solenoid "C"', SOL);
family('P0765', 'Shift Solenoid "D"', SOL);
family('P0770', 'Shift Solenoid "E"', SOL);
family('P0775', 'Pressure Control Solenoid "B"', SOL);
family('P0795', 'Pressure Control Solenoid "C"', SOL);
family('P0840', 'Transmission Fluid Pressure Sensor/Switch "A" Circuit', ['', 'Range/Performance', 'Low', 'High']);
family('P0845', 'Transmission Fluid Pressure Sensor/Switch "B" Circuit', ['', 'Range/Performance', 'Low', 'High']);

// ---------- P0Axx hybrid propulsion ----------
family('P0A00', 'Motor Electronics Coolant Temperature Sensor Circuit', RLHI);
put({
  P0A05: 'Motor Electronics Coolant Pump Control Circuit/Open',
  P0A06: 'Motor Electronics Coolant Pump Control Circuit Low',
  P0A07: 'Motor Electronics Coolant Pump Control Circuit High',
  P0A08: 'DC/DC Converter Status Circuit',
  P0A09: 'DC/DC Converter Status Circuit Low',
  P0A10: 'DC/DC Converter Status Circuit High',
  P0A0A: 'High Voltage System Interlock Circuit',
  P0A0B: 'High Voltage System Interlock Circuit Performance',
  P0A0C: 'High Voltage System Interlock Circuit Low',
  P0A0D: 'High Voltage System Interlock Circuit High',
  P0A0E: 'High Voltage System Interlock Circuit Intermittent',
  P0A0F: 'Engine Failed to Start',
  P0A1D: 'Hybrid Powertrain Control Module',
  P0A1F: 'Battery Energy Control Module',
  P0A3F: 'Drive Motor "A" Position Sensor Circuit',
  P0A40: 'Drive Motor "A" Position Sensor Circuit Range/Performance',
  P0A4B: 'Generator Position Sensor Circuit',
  P0A51: 'Drive Motor "A" Current Sensor Circuit',
  P0A60: 'Drive Motor "A" Phase U Current',
  P0A63: 'Drive Motor "A" Phase V Current',
  P0A66: 'Drive Motor "A" Phase W Current',
  P0A72: 'Generator Phase U Current',
  P0A75: 'Generator Phase V Current',
  P0A78: 'Drive Motor "A" Inverter Performance',
  P0A7A: 'Generator Inverter Performance',
  P0A7F: 'Hybrid Battery Pack Deterioration',
  P0A80: 'Replace Hybrid Battery Pack',
  P0A81: 'Hybrid Battery Pack Cooling Fan 1 Control Circuit',
  P0A82: 'Hybrid Battery Pack Cooling Fan 1 Performance/Stuck Off',
  P0A84: 'Hybrid Battery Pack Cooling Fan 1 Control Circuit Low',
  P0A85: 'Hybrid Battery Pack Cooling Fan 1 Control Circuit High',
  P0A90: 'Drive Motor "A" Performance',
  P0A92: 'Hybrid Generator Performance',
  P0A93: 'Inverter "A" Cooling System Performance',
  P0A94: 'DC/DC Converter Performance',
  P0A95: 'High Voltage Fuse',
  P0AA1: 'Hybrid Battery Positive Contactor Circuit Stuck Closed',
  P0AA4: 'Hybrid Battery Negative Contactor Circuit Stuck Closed',
  P0AA6: 'Hybrid Battery Voltage System Isolation Fault',
  P0AC0: 'Hybrid Battery Pack Current Sensor Circuit'
});

// ---------- P2xxx ----------
put({
  P2002: 'Diesel Particulate Filter Efficiency Below Threshold (Bank 1)',
  P2004: 'Intake Manifold Runner Control Stuck Open (Bank 1)',
  P2006: 'Intake Manifold Runner Control Stuck Closed (Bank 1)',
  P2008: 'Intake Manifold Runner Control Circuit/Open (Bank 1)',
  P2014: 'Intake Manifold Runner Position Sensor/Switch Circuit (Bank 1)',
  P2015: 'Intake Manifold Runner Position Sensor/Switch Circuit Range/Performance (Bank 1)',
  P2016: 'Intake Manifold Runner Position Sensor/Switch Circuit Low (Bank 1)',
  P2017: 'Intake Manifold Runner Position Sensor/Switch Circuit High (Bank 1)',
  P2088: '"A" Camshaft Position Actuator Control Circuit Low (Bank 1)',
  P2089: '"A" Camshaft Position Actuator Control Circuit High (Bank 1)',
  P2090: '"B" Camshaft Position Actuator Control Circuit Low (Bank 1)',
  P2091: '"B" Camshaft Position Actuator Control Circuit High (Bank 1)',
  P2092: '"A" Camshaft Position Actuator Control Circuit Low (Bank 2)',
  P2093: '"A" Camshaft Position Actuator Control Circuit High (Bank 2)',
  P2094: '"B" Camshaft Position Actuator Control Circuit Low (Bank 2)',
  P2095: '"B" Camshaft Position Actuator Control Circuit High (Bank 2)',
  P2096: 'Post Catalyst Fuel Trim System Too Lean (Bank 1)',
  P2097: 'Post Catalyst Fuel Trim System Too Rich (Bank 1)',
  P2098: 'Post Catalyst Fuel Trim System Too Lean (Bank 2)',
  P2099: 'Post Catalyst Fuel Trim System Too Rich (Bank 2)',
  P2100: 'Throttle Actuator Control Motor Circuit/Open',
  P2101: 'Throttle Actuator Control Motor Circuit Range/Performance',
  P2102: 'Throttle Actuator Control Motor Circuit Low',
  P2103: 'Throttle Actuator Control Motor Circuit High',
  P2104: 'Throttle Actuator Control System - Forced Idle',
  P2105: 'Throttle Actuator Control System - Forced Engine Shutdown',
  P2106: 'Throttle Actuator Control System - Forced Limited Power',
  P2107: 'Throttle Actuator Control Module Processor',
  P2108: 'Throttle Actuator Control Module Performance',
  P2110: 'Throttle Actuator Control System - Forced Limited RPM',
  P2111: 'Throttle Actuator Control System - Stuck Open',
  P2112: 'Throttle Actuator Control System - Stuck Closed',
  P2118: 'Throttle Actuator Control Motor Current Range/Performance',
  P2119: 'Throttle Actuator Control Throttle Body Range/Performance',
  P2135: 'Throttle/Pedal Position Sensor/Switch "A" / "B" Voltage Correlation',
  P2138: 'Throttle/Pedal Position Sensor/Switch "D" / "E" Voltage Correlation',
  P2158: 'Vehicle Speed Sensor "B"',
  P2161: 'Vehicle Speed Sensor "B" Intermittent/Erratic',
  P2177: 'System Too Lean Off Idle (Bank 1)',
  P2178: 'System Too Rich Off Idle (Bank 1)',
  P2179: 'System Too Lean Off Idle (Bank 2)',
  P2180: 'System Too Rich Off Idle (Bank 2)',
  P2181: 'Cooling System Performance',
  P2187: 'System Too Lean at Idle (Bank 1)',
  P2188: 'System Too Rich at Idle (Bank 1)',
  P2189: 'System Too Lean at Idle (Bank 2)',
  P2190: 'System Too Rich at Idle (Bank 2)',
  P2195: 'O2 Sensor Signal Biased/Stuck Lean (Bank 1 Sensor 1)',
  P2196: 'O2 Sensor Signal Biased/Stuck Rich (Bank 1 Sensor 1)',
  P2197: 'O2 Sensor Signal Biased/Stuck Lean (Bank 2 Sensor 1)',
  P2198: 'O2 Sensor Signal Biased/Stuck Rich (Bank 2 Sensor 1)',
  P2227: 'Barometric Pressure Circuit Range/Performance',
  P2228: 'Barometric Pressure Circuit Low',
  P2229: 'Barometric Pressure Circuit High',
  P2237: 'O2 Sensor Positive Current Control Circuit/Open (Bank 1 Sensor 1)',
  P2240: 'O2 Sensor Positive Current Control Circuit/Open (Bank 2 Sensor 1)',
  P2251: 'O2 Sensor Negative Current Control Circuit/Open (Bank 1 Sensor 1)',
  P2262: 'Turbocharger/Supercharger Boost Pressure Not Detected - Mechanical',
  P2263: 'Turbocharger/Supercharger Boost System Performance',
  P2270: 'O2 Sensor Signal Biased/Stuck Lean (Bank 1 Sensor 2)',
  P2271: 'O2 Sensor Signal Biased/Stuck Rich (Bank 1 Sensor 2)',
  P2272: 'O2 Sensor Signal Biased/Stuck Lean (Bank 2 Sensor 2)',
  P2273: 'O2 Sensor Signal Biased/Stuck Rich (Bank 2 Sensor 2)',
  P2279: 'Intake Air System Leak',
  P2293: 'Fuel Pressure Regulator 2 Performance',
  P2400: 'Evaporative Emission System Leak Detection Pump Control Circuit/Open',
  P2401: 'Evaporative Emission System Leak Detection Pump Control Circuit Low',
  P2402: 'Evaporative Emission System Leak Detection Pump Control Circuit High',
  P2404: 'Evaporative Emission System Leak Detection Pump Sense Circuit Range/Performance',
  P2419: 'Evaporative Emission System Switching Valve Control Circuit Low',
  P2420: 'Evaporative Emission System Switching Valve Control Circuit High',
  P2422: 'Evaporative Emission System Vent Valve Stuck Closed',
  P2440: 'Secondary Air Injection System Switching Valve Stuck Open (Bank 1)',
  P2441: 'Secondary Air Injection System Switching Valve Stuck Closed (Bank 1)',
  P2444: 'Secondary Air Injection System Pump Stuck On (Bank 1)',
  P2453: 'Diesel Particulate Filter Pressure Sensor "A" Circuit Range/Performance',
  P2459: 'Diesel Particulate Filter Regeneration Frequency',
  P2463: 'Diesel Particulate Filter Restriction - Soot Accumulation',
  P2563: 'Turbocharger Boost Control Position Sensor "A" Circuit Range/Performance',
  P2610: 'ECM/PCM Internal Engine Off Timer Performance',
  P2646: '"A" Rocker Arm Actuator System Performance or Stuck Off (Bank 1)',
  P2647: '"A" Rocker Arm Actuator System Stuck On (Bank 1)',
  P2700: 'Transmission Friction Element "A" Apply Time Range/Performance',
  P2714: 'Pressure Control Solenoid "D" Performance or Stuck Off',
  P20EE: 'SCR NOx Catalyst Efficiency Below Threshold (Bank 1)',
  P2A00: 'O2 Sensor Circuit Range/Performance (Bank 1 Sensor 1)',
  P2A03: 'O2 Sensor Circuit Range/Performance (Bank 2 Sensor 1)'
});
family('P2120', 'Throttle/Pedal Position Sensor/Switch "D" Circuit', RLHI);
family('P2125', 'Throttle/Pedal Position Sensor/Switch "E" Circuit', RLHI);
'ABCDEFGHIJKL'.split('').forEach(function (L, i) {
  const n = 2300 + i * 3;
  D['P' + n] = 'Ignition Coil "' + L + '" Primary Control Circuit Low';
  D['P' + (n + 1)] = 'Ignition Coil "' + L + '" Primary Control Circuit High';
});

// ---------- P34xx ----------
put({
  P3400: 'Cylinder Deactivation System (Bank 1)',
  P3401: 'Cylinder 1 Deactivation/Intake Valve Control Circuit/Open'
});

// ---------- Toyota / Lexus hybrid (manufacturer specific, well known) ----------
const TOYOTA = {
  P3000: 'Hybrid battery control malfunction (Toyota/Lexus hybrid)',
  P3004: 'High voltage power cable malfunction (Toyota/Lexus hybrid)',
  P3006: 'Hybrid battery state of charge uneven between blocks (Toyota/Lexus hybrid)',
  P3009: 'High voltage insulation leak detected (Toyota/Lexus hybrid)',
  P3190: 'Poor engine power (Toyota/Lexus hybrid)',
  P3191: 'Engine does not start (Toyota/Lexus hybrid)',
  P3193: 'Fuel run out (Toyota/Lexus hybrid)'
};
for (let i = 1; i <= 14; i++) TOYOTA['P30' + (10 + i)] = 'Hybrid battery block ' + i + ' becomes weak (Toyota/Lexus hybrid)';
put(TOYOTA);

// ---------- U0xxx network ----------
put({
  U0001: 'High Speed CAN Communication Bus',
  U0002: 'High Speed CAN Communication Bus (Performance)',
  U0010: 'Medium Speed CAN Communication Bus',
  U0073: 'Control Module Communication Bus "A" Off',
  U0074: 'Control Module Communication Bus "B" Off',
  U0100: 'Lost Communication With ECM/PCM "A"',
  U0101: 'Lost Communication With TCM',
  U0102: 'Lost Communication With Transfer Case Control Module',
  U0103: 'Lost Communication With Gear Shift Control Module "A"',
  U0104: 'Lost Communication With Cruise Control Module',
  U0105: 'Lost Communication With Fuel Injector Control Module',
  U0106: 'Lost Communication With Glow Plug Control Module',
  U0107: 'Lost Communication With Throttle Actuator Control Module',
  U0108: 'Lost Communication With Alternative Fuel Control Module',
  U0109: 'Lost Communication With Fuel Pump Control Module',
  U0110: 'Lost Communication With Drive Motor Control Module "A"',
  U0111: 'Lost Communication With Battery Energy Control Module "A"',
  U0114: 'Lost Communication With Four-Wheel Drive Clutch Control Module',
  U0115: 'Lost Communication With ECM/PCM "B"',
  U0121: 'Lost Communication With Anti-Lock Brake System (ABS) Control Module',
  U0122: 'Lost Communication With Vehicle Dynamics Control Module',
  U0123: 'Lost Communication With Yaw Rate Sensor Module',
  U0124: 'Lost Communication With Lateral Acceleration Sensor Module',
  U0126: 'Lost Communication With Steering Angle Sensor Module',
  U0128: 'Lost Communication With Park Brake Control Module',
  U0129: 'Lost Communication With Brake System Control Module',
  U0131: 'Lost Communication With Power Steering Control Module',
  U0140: 'Lost Communication With Body Control Module',
  U0151: 'Lost Communication With Restraints Control Module',
  U0155: 'Lost Communication With Instrument Panel Cluster (IPC) Control Module',
  U0164: 'Lost Communication With HVAC Control Module',
  U0167: 'Lost Communication With Vehicle Immobilizer Control Module',
  U0168: 'Lost Communication With Vehicle Security Control Module',
  U0184: 'Lost Communication With Radio',
  U0293: 'Lost Communication With Hybrid Powertrain Control Module',
  U0300: 'Internal Control Module Software Incompatibility',
  U0401: 'Invalid Data Received From ECM/PCM "A"',
  U0402: 'Invalid Data Received From TCM',
  U0415: 'Invalid Data Received From Anti-Lock Brake System (ABS) Control Module',
  U0416: 'Invalid Data Received From Vehicle Dynamics Control Module',
  U0418: 'Invalid Data Received From Brake System Control Module',
  U0422: 'Invalid Data Received From Body Control Module',
  U0428: 'Invalid Data Received From Steering Angle Sensor Module'
});

// ---------- C0xxx chassis ----------
put({
  C0035: 'Left Front Wheel Speed Sensor Circuit',
  C0040: 'Right Front Wheel Speed Sensor Circuit',
  C0045: 'Left Rear Wheel Speed Sensor Circuit',
  C0050: 'Right Rear Wheel Speed Sensor Circuit',
  C0110: 'Pump Motor Circuit'
});

// ---------- B0xxx body ----------
put({
  B0001: 'Driver Frontal Stage 1 Deployment Control',
  B0002: 'Driver Frontal Stage 2 Deployment Control',
  B0010: 'Passenger Frontal Stage 1 Deployment Control',
  B0011: 'Passenger Frontal Stage 2 Deployment Control'
});

// ===================================================================
// Plain-English explanations and severity for the most common codes.
// severity: 'high' = stop or get it checked very soon, risk of damage or safety issue
//           'medium' = fix soon, may hurt economy, emissions or drivability
//           'low' = not urgent, usually emissions only
// ===================================================================
const E = {};
function ex(codes, sev, text) {
  codes.forEach(function (c) { E[c] = [sev, text]; });
}
function range(prefix, from, to, width) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(prefix + String(i).padStart(width || 2, '0'));
  return out;
}

ex(['P0300'], 'high',
  'The engine computer saw misfires in more than one cylinder, or could not tell which one. A misfire means fuel did not burn properly. Common causes are worn spark plugs, a bad ignition coil, a vacuum leak, or low fuel pressure. If the check engine light is flashing, drive gently and get it checked soon, because unburned fuel can overheat and ruin the catalytic converter.');
ex(range('P03', 1, 12), 'high',
  'One specific cylinder is misfiring (the last digits tell you which cylinder). Common causes are a worn spark plug, a failing ignition coil, or a clogged injector for that cylinder. A simple first test (for a mechanic or a confident DIYer) is to swap the coil with another cylinder and see if the misfire moves. If the check engine light flashes, avoid hard driving, because misfires can damage the catalytic converter.');
ex(['P0171', 'P0174'], 'medium',
  'The engine is getting too much air or too little fuel, and the computer has reached its limit trying to correct it. The most common cause is a vacuum leak (cracked hose, intake gasket). Other causes are a dirty mass air flow sensor, a weak fuel pump, or a clogged fuel filter. The car usually still drives fine, but it should be looked at soon because running lean can cause misfires and overheating of parts.');
ex(['P0172', 'P0175'], 'medium',
  'The engine is getting too much fuel or too little air. Common causes are a dirty or faulty mass air flow sensor, a leaking injector, a faulty fuel pressure regulator, or a very dirty air filter. Running rich wastes fuel and can damage the catalytic converter over time, so get it checked soon.');
ex(['P0420', 'P0430'], 'medium',
  'The catalytic converter is not cleaning the exhaust as well as it should. Sometimes the converter is worn out, but often the real cause is a faulty oxygen sensor, an exhaust leak, or an engine problem (misfires, running rich) that should be fixed first. The car is usually safe to drive, but it will likely fail an emissions inspection. Ask a mechanic to check the sensors and for exhaust leaks before replacing the converter, which is expensive.');
ex(['P0440', 'P0441', 'P0446', 'P0449', 'P0496', 'P0497'], 'low',
  'There is a fault in the evaporative emission (EVAP) system, which captures fuel vapour from the tank so it does not escape into the air. It does not affect how the car drives. Common causes are a faulty purge or vent valve, or a cracked hose. Get it fixed when convenient, mainly to pass an emissions inspection.');
ex(['P0442', 'P0456'], 'low',
  'The EVAP system found a small leak in the fuel vapour system. The most common cause is a fuel cap that is not tight or has a worn seal. Check the cap first (tighten it until it clicks). If the code comes back, a smoke test at a shop can find small cracked hoses or a leaking valve. It does not affect how the car drives.');
ex(['P0455', 'P0457'], 'low',
  'The EVAP system found a large leak, very often a loose, missing, or damaged fuel cap. Tighten the cap until it clicks and drive for a few days. The light may go off on its own. If not, a shop can smoke test the system. It does not affect how the car drives.');
ex(['P0443', 'P0444', 'P0445', 'P0458', 'P0459'], 'low',
  'There is an electrical problem with the EVAP purge valve, which lets fuel vapour from the charcoal canister be burned by the engine. Usually the valve itself or its connector is at fault. It rarely affects driving, but can cause rough idle or hard starting after refuelling in some cars.');
ex(['P0128'], 'low',
  'The engine is taking too long to warm up. The most common cause is a thermostat stuck open. You may notice weak cabin heat and slightly worse fuel economy. It is not urgent, but a thermostat is usually a modest repair, and a cold engine wears faster. In a hybrid, short trips in cold weather can sometimes trigger it too.');
ex(['P0125'], 'low',
  'The engine took too long to reach the temperature needed for normal fuel control. Often a thermostat stuck open or a faulty coolant temperature sensor. Not urgent, but get it checked.');
ex(['P0217'], 'high',
  'The engine is overheating. Stop as soon as it is safe, turn the engine off, and let it cool. Do not open the radiator cap while hot. Check the coolant level once cool. Driving an overheating engine can cause severe and expensive damage. Have it towed or checked before driving further if it overheats again.');
ex(['P0524'], 'high',
  'Engine oil pressure is too low. Stop as soon as it is safe and turn the engine off. Check the oil level. Running an engine with low oil pressure can destroy it within minutes. Do not keep driving until the cause is found.');
ex(['P0520', 'P0521', 'P0522', 'P0523'], 'medium',
  'There is a problem with the oil pressure sensor or its signal. It may be just the sensor, but check the oil level now. If the oil pressure warning light is on or the engine makes ticking or knocking noises, stop driving and get it checked.');
ex(['P0335', 'P0336', 'P0337', 'P0338', 'P0339', 'P0385', 'P0386', 'P0387', 'P0388', 'P0389'], 'high',
  'There is a problem with the crankshaft position sensor or its signal. The engine computer uses this to know engine speed and position. It can cause stalling, no start, or misfires. Get it checked soon, because the car may stall without warning.');
ex(['P0340', 'P0341', 'P0342', 'P0343', 'P0344', 'P0345', 'P0346', 'P0347', 'P0348', 'P0349', 'P0365', 'P0366', 'P0367', 'P0368', 'P0369', 'P0390', 'P0391', 'P0392', 'P0393', 'P0394'], 'medium',
  'There is a problem with a camshaft position sensor or its signal. It can cause hard starting, rough running, or reduced power. Causes include a faulty sensor, damaged wiring, or in some cases timing chain or belt problems. Get it checked soon.');
ex(['P0016', 'P0017', 'P0018', 'P0019'], 'high',
  'The crankshaft and camshaft signals do not line up as expected. This can mean a stretched timing chain, a jumped timing belt, a faulty variable valve timing part, or a sensor problem. A stretched chain can fail and cause serious engine damage, so have a mechanic check it soon. Also check that the oil is full and clean, as low or dirty oil affects valve timing.');
ex(['P0010', 'P0011', 'P0012', 'P0013', 'P0014', 'P0015', 'P0020', 'P0021', 'P0022', 'P0023', 'P0024', 'P0025'], 'medium',
  'There is a problem with the variable valve timing system, which adjusts the camshaft as you drive. Check the oil level and condition first, because low or dirty oil is a very common cause. Otherwise it is often the oil control solenoid or the cam phaser. Get it checked soon. Ignoring it can lead to rough running and engine wear.');
ex(['P0030', 'P0031', 'P0032', 'P0036', 'P0037', 'P0038', 'P0050', 'P0051', 'P0052', 'P0056', 'P0057', 'P0058', 'P0135', 'P0141', 'P0155', 'P0161'], 'low',
  'The heater inside an oxygen sensor is not working properly. The heater helps the sensor work quickly after a cold start. Usually the oxygen sensor itself needs replacing, sometimes it is a fuse or wiring. Not urgent, but it can increase emissions and fuel use slightly.');
ex(['P0130', 'P0131', 'P0132', 'P0133', 'P0134', 'P0150', 'P0151', 'P0152', 'P0153', 'P0154', 'P2195', 'P2196', 'P2197', 'P2198', 'P2A00', 'P2A03'], 'medium',
  'The upstream oxygen sensor (before the catalytic converter) is giving an unexpected signal. This sensor helps set the fuel mixture. Causes include a worn sensor, wiring damage, or an exhaust leak near the sensor. Sometimes a real fuel mixture problem shows up this way. Get it checked, because a bad reading can hurt fuel economy and damage the catalytic converter over time.');
ex(['P0136', 'P0137', 'P0138', 'P0139', 'P0140', 'P0156', 'P0157', 'P0158', 'P0159', 'P0160', 'P2270', 'P2271', 'P2272', 'P2273'], 'low',
  'The downstream oxygen sensor (after the catalytic converter) is giving an unexpected signal. This sensor mainly checks how well the catalytic converter works. Causes include a worn sensor, wiring, or an exhaust leak. Not urgent, but it will usually fail an emissions inspection.');
ex(['P0100', 'P0101', 'P0102', 'P0103', 'P0104'], 'medium',
  'There is a problem with the mass air flow (MAF) sensor or its signal. This sensor measures how much air enters the engine. Check for a loose or torn intake hose between the sensor and the engine and a dirty air filter. Cleaning the sensor with MAF cleaner spray sometimes helps. You may notice poor power, hesitation, or stalling.');
ex(['P0105', 'P0106', 'P0107', 'P0108', 'P0109'], 'medium',
  'There is a problem with the manifold pressure (MAP) sensor or its signal. It helps the engine work out how much air it is getting. Check the small vacuum hose to the sensor and the connector. It can cause rough running and poor fuel economy.');
ex(['P0110', 'P0111', 'P0112', 'P0113', 'P0114'], 'low',
  'There is a problem with the intake air temperature sensor or its signal. Often the sensor is part of the mass air flow sensor. A loose connector is a common cause. Usually a minor effect on how the car runs.');
ex(['P0115', 'P0116', 'P0117', 'P0118', 'P0119'], 'medium',
  'There is a problem with the engine coolant temperature sensor or its signal. The engine computer uses it for fuel, idle and cooling fan control. Check that the coolant level is correct. A faulty sensor can cause hard starting, poor economy, or the cooling fan running all the time. Watch the temperature gauge and stop if the engine overheats.');
ex(['P0120', 'P0121', 'P0122', 'P0123', 'P0124', 'P0220', 'P0221', 'P0222', 'P0223', 'P0224', 'P2120', 'P2121', 'P2122', 'P2123', 'P2124', 'P2125', 'P2126', 'P2127', 'P2128', 'P2129', 'P2135', 'P2138'], 'high',
  'There is a problem with a throttle or accelerator pedal position sensor. These tell the engine how much power you are asking for. The car may go into a reduced power (limp) mode. Because this affects how the car responds to the pedal, get it checked soon and drive carefully.');
ex(['P2100', 'P2101', 'P2102', 'P2103', 'P2104', 'P2105', 'P2106', 'P2107', 'P2108', 'P2110', 'P2111', 'P2112', 'P2118', 'P2119', 'P0638'], 'high',
  'There is a problem with the electronic throttle (the motor driven valve that controls engine air). The car will often go into reduced power mode. A dirty throttle body or a bad connector can cause it, but so can a failing throttle motor. Get it checked soon, as the car may lose power unexpectedly.');
ex(['P0087'], 'high',
  'Fuel pressure is lower than the engine computer expects. Causes include a weak fuel pump, a clogged filter, or a faulty pressure regulator or sensor. It can cause hesitation, loss of power, or stalling. Get it checked soon.');
ex(['P0088'], 'medium',
  'Fuel pressure is higher than expected. Often a fuel pressure regulator or sensor issue. Get it checked, especially on direct injection engines.');
ex(['P0190', 'P0191', 'P0192', 'P0193', 'P0194'], 'medium',
  'There is a problem with the fuel rail pressure sensor or its signal. It can cause hard starting, stalling or poor power. A mechanic should check the sensor, its wiring, and the actual fuel pressure.');
ex(range('P02', 0, 12), 'medium',
  'The engine computer found an electrical problem in a fuel injector circuit (the last digits usually give the cylinder). Causes include a faulty injector, a damaged connector or wiring. Expect misfires and rough running on that cylinder. Get it checked soon, because misfires can damage the catalytic converter.');
ex(['P0234'], 'high',
  'The turbocharger is making more boost than it should. This can damage the engine. Drive gently and have the wastegate and boost control checked soon.');
ex(['P0299'], 'medium',
  'The turbocharger is not making as much boost as expected. Common causes are a leaking intake or intercooler hose, a sticking wastegate, or a worn turbo. You will likely notice less power. Get it checked soon.');
ex(['P0325', 'P0326', 'P0327', 'P0328', 'P0329', 'P0330', 'P0331', 'P0332', 'P0333', 'P0334'], 'medium',
  'There is a problem with a knock sensor or its signal. The knock sensor listens for harmful pinging. With it faulty, the engine computer may reduce timing to be safe, which lowers power and economy. Often the sensor or its wiring. Get it checked when you can.');
ex(['P0350'].concat(range('P03', 51, 62)), 'medium',
  'There is a problem with an ignition coil circuit (the letter usually matches a cylinder). A faulty coil causes misfires and rough running. Coils are often easy to replace. Get it checked soon, because misfires can damage the catalytic converter.');
ex(['P0400', 'P0401', 'P0402', 'P0403', 'P0404', 'P0405', 'P0406', 'P0409'], 'medium',
  'There is a problem with the exhaust gas recirculation (EGR) system, which feeds a little exhaust back into the engine to lower emissions. Too little flow is often carbon blocking the EGR valve or passages. Too much flow can cause rough idle or stalling. Get it checked when convenient.');
ex(['P0410', 'P0411', 'P0412', 'P0418', 'P0491', 'P0492'], 'low',
  'There is a problem with the secondary air injection system, which pumps air into the exhaust during cold starts to warm the catalytic converter faster. Common causes are a failed air pump, a stuck valve, or a blown fuse. It does not usually affect driving, but it will fail an emissions inspection.');
ex(['P0460', 'P0461', 'P0462', 'P0463', 'P0464'], 'low',
  'There is a problem with the fuel level sensor or its signal. Your fuel gauge may be wrong, so keep an eye on the trip meter and do not run the tank too low. Usually the sender unit in the tank or its wiring.');
ex(['P0480', 'P0481', 'P0691', 'P0692', 'P0693', 'P0694'], 'medium',
  'There is a problem with a radiator cooling fan circuit. If the fan does not run, the engine can overheat in traffic or with the air conditioning on. Watch the temperature gauge and get it checked soon.');
ex(['P0500', 'P0501', 'P0502', 'P0503'], 'medium',
  'There is a problem with the vehicle speed sensor or its signal. Your speedometer, cruise control, ABS or transmission shifting may act strangely. Get it checked soon.');
ex(['P0505', 'P0506', 'P0507'], 'low',
  'The idle speed is not what the engine computer expects. Common causes are a dirty throttle body or idle air valve, or a vacuum leak. Cleaning the throttle body often helps. Not urgent unless the engine stalls.');
ex(['P0560', 'P0562'], 'medium',
  'The engine computer saw low or unstable system voltage. Check the 12 volt battery and its terminals, and have the charging system (alternator, or DC/DC converter on a hybrid) tested. A weak 12 volt battery can cause all sorts of strange warnings.');
ex(['P0563'], 'medium',
  'System voltage is too high. Usually a charging system fault (alternator voltage regulator). Overcharging can damage the battery and electronics, so get it checked soon.');
ex(['P0601', 'P0602', 'P0603', 'P0604', 'P0605', 'P0606', 'P0607'], 'medium',
  'The engine computer reported an internal fault. Sometimes a software update or a reprogram at a dealer fixes it. Before blaming the computer, have the battery, grounds, and power supply checked. A mechanic or dealer should diagnose this.');
ex(['P0641', 'P0642', 'P0643', 'P0651', 'P0652', 'P0653', 'P0697', 'P0698', 'P0699'], 'high',
  'A sensor reference voltage supply from the engine computer is out of range. Several sensors share this supply, so one shorted sensor or wire can affect many. The car may go into reduced power mode. Get it checked soon.');
ex(['P0700'], 'medium',
  'The transmission computer has found a fault and asked the engine computer to turn on the check engine light. This code alone does not say what is wrong. A scan tool that can read the transmission module directly is needed to see the actual transmission code. If shifting feels wrong, get it checked soon.');
ex(['P0705', 'P0706', 'P0707', 'P0708', 'P0709', 'P0850'], 'medium',
  'There is a problem with the gear selector position (range) sensor or switch. The car may not start in Park, may shift oddly, or reverse lights may not work. Get it checked soon.');
ex(['P0710', 'P0711', 'P0712', 'P0713', 'P0714', 'P0218'], 'medium',
  'There is a problem with the transmission fluid temperature reading, or the fluid is too hot. Check the fluid level if your car has a dipstick. Overheated fluid damages a transmission quickly. Avoid heavy loads and towing until it is checked.');
ex(['P0715', 'P0716', 'P0717', 'P0718', 'P0720', 'P0721', 'P0722', 'P0723'], 'medium',
  'There is a problem with a transmission speed sensor or its signal. Shifting may become harsh or the transmission may hold one gear (limp mode). Get it checked soon.');
ex(['P0730', 'P0731', 'P0732', 'P0733', 'P0734', 'P0735', 'P0736', 'P0729', 'P0894'], 'high',
  'The transmission is not in the gear ratio it expects, which usually means slipping. Check the fluid level and condition first. Slipping can get worse quickly, so have a transmission specialist look at it soon.');
ex(['P0740', 'P0741', 'P0742', 'P0743', 'P0744'], 'medium',
  'There is a problem with the torque converter clutch, which locks the engine to the transmission at cruising speed for economy. Causes include low or old fluid, a faulty solenoid, or internal wear. Get it checked soon.');
ex(['P0750', 'P0751', 'P0752', 'P0753', 'P0754', 'P0755', 'P0756', 'P0757', 'P0758', 'P0759', 'P0760', 'P0761', 'P0762', 'P0763', 'P0764', 'P0745', 'P0746', 'P0747', 'P0748', 'P0749'], 'medium',
  'There is a problem with a transmission solenoid, which controls shifting or line pressure. Shifting may become harsh, delayed or stuck in one gear. Sometimes a fluid change helps, often the solenoid or its wiring needs work. Get it checked soon.');
ex(['P0A80'], 'high',
  'The hybrid system has detected that the high voltage battery pack has weak cells and needs attention. The car may still drive, but power can drop and the hybrid system may shut down. Have a hybrid specialist or dealer test the battery blocks. Reconditioning or replacing weak modules is sometimes cheaper than a whole new pack.');
ex(['P0A7F'], 'high',
  'The high voltage hybrid battery is deteriorating. Expect lower fuel economy and less power. Have a dealer or hybrid specialist test the battery soon.');
ex(['P0A81', 'P0A82', 'P0A84', 'P0A85'], 'medium',
  'There is a problem with the hybrid battery cooling fan. A blocked intake vent (often near the rear seat) or a clogged fan is a common cause. An overheating hybrid battery wears out faster, so clean the vent and get it checked.');
ex(['P0A93'], 'high',
  'The cooling system for the hybrid inverter is not working properly. Often a failed inverter coolant pump or low inverter coolant. The inverter can overheat and the car may lose power. Get it checked soon.');
ex(['P0A94'], 'high',
  'The DC/DC converter, which charges the 12 volt battery from the high voltage system, is not working properly. The 12 volt battery can go flat and the car may shut down. Get it checked soon by a hybrid specialist or dealer.');
ex(['P0A0F'], 'high',
  'The hybrid system tried to start the petrol engine but it did not start. Causes include running out of fuel, a fuel pump or ignition problem. The car may run only on battery for a short time. Check you have fuel and get it checked soon.');
ex(['P0AA6'], 'high',
  'The hybrid system detected that high voltage may be leaking to the car body (an insulation fault). This is a safety issue. Do not touch any orange cables. Have a dealer or qualified hybrid technician inspect it soon.');
ex(['P0A0A', 'P0A0B', 'P0A0C', 'P0A0D', 'P0A0E'], 'high',
  'The high voltage safety interlock circuit is reporting a problem. The car may not enter READY mode. Do not try to work on high voltage parts yourself. Have a hybrid qualified technician check it.');
ex(['P3000', 'P3006', 'P3009', 'P3004'], 'high',
  'Toyota/Lexus hybrid code for a high voltage battery or wiring fault. The car may lose power or refuse to go into READY. Have a dealer or hybrid specialist check it. Do not touch orange high voltage cables.');
ex(range('P30', 11, 24), 'high',
  'Toyota/Lexus hybrid code meaning one block of cells in the high voltage battery is weaker than the others. Have the battery tested by a hybrid specialist. Replacing or reconditioning weak modules may be an option.');
ex(['P2096', 'P2098'], 'medium',
  'The sensor after the catalytic converter says the exhaust is still lean after the engine computer has corrected it. Common causes are an exhaust leak near the oxygen sensors, a faulty sensor, or a vacuum leak. Get it checked, especially if you also have P0171, P0174 or P0420.');
ex(['P2097', 'P2099'], 'medium',
  'The sensor after the catalytic converter says the exhaust is still rich. Causes include a worn catalytic converter, a faulty oxygen sensor, or a leaking injector. Get it checked.');
ex(['P2177', 'P2179', 'P2187', 'P2189'], 'medium',
  'The engine is running lean (too much air or too little fuel) at idle or while driving. Look for a vacuum leak, a dirty mass air flow sensor, or a weak fuel supply. Get it checked soon.');
ex(['P2178', 'P2180', 'P2188', 'P2190'], 'medium',
  'The engine is running rich (too much fuel). Causes include leaking injectors, a faulty mass air flow sensor or fuel pressure problems. Get it checked soon.');
ex(['P2181'], 'medium',
  'The cooling system is not performing as expected. Often a thermostat problem or low coolant. Check the coolant level when the engine is cold and watch the temperature gauge.');
ex(['P2004', 'P2006', 'P2008', 'P2014', 'P2015', 'P2016', 'P2017'], 'low',
  'There is a problem with the intake manifold runner control, flaps inside the intake that improve power at different speeds. Often carbon buildup or a broken linkage. Usually only a small effect on power. Get it checked when convenient.');
ex(['P2002', 'P2463', 'P2459', 'P2453'], 'medium',
  'There is a problem with the diesel particulate filter, which traps soot. A long drive at steady motorway speed can help it clean itself (regenerate). If the warning stays, a shop may need to force a regeneration or clean the filter. Ignoring it can lead to reduced power and expensive repairs.');
ex(['P2400', 'P2401', 'P2402', 'P2404', 'P2419', 'P2420', 'P2422'], 'low',
  'There is a fault in the EVAP leak check system. It does not affect driving. Usually a faulty leak detection pump, valve, or wiring. Get it fixed to pass emissions inspection.');
ex(['P2279'], 'medium',
  'The engine computer thinks unmeasured air is getting into the intake. Look for a loose or cracked intake hose, a leaking PCV hose, or a bad intake gasket. Get it checked soon.');
ex(['P2610'], 'low',
  'The engine computer internal timer that tracks engine off time is not working as expected. It can stop some emissions self tests from running. A software update sometimes fixes it. Not urgent.');
ex(['P0068', 'P0069'], 'medium',
  'Readings from the air flow, manifold pressure, or throttle sensors do not agree with each other. Often a vacuum or intake leak, or a faulty sensor. Get it checked.');
ex(['P0070', 'P0071', 'P0072', 'P0073', 'P0074'], 'low',
  'There is a problem with the outside air temperature sensor or its signal. Usually it only affects the temperature display and climate control. Not urgent.');
ex(['P0513'], 'medium',
  'The immobilizer did not recognize the key. Try your spare key. If the spare works, the original key may need reprogramming or a new battery. If not, a dealer or auto locksmith can help.');
ex(['P0534'], 'low',
  'The air conditioning has lost refrigerant. The AC may blow warm. Have an AC shop check for leaks and recharge it.');
ex(['P0615', 'P0616', 'P0617'], 'medium',
  'There is a problem with the starter relay circuit. The car may not crank or may crank unexpectedly. Get it checked soon.');
ex(['P0620', 'P0621', 'P0622', 'P0625', 'P0626'], 'medium',
  'There is a problem with the alternator (generator) control circuit. The battery may not charge properly. Watch for a battery warning light and get the charging system tested soon.');
ex(['P0627', 'P0628', 'P0629', 'P0230'], 'high',
  'There is an electrical problem with the fuel pump control circuit. The engine may stall or not start. Get it checked soon.');
ex(['P0650'], 'low',
  'The circuit that turns on the check engine light has a fault. You might not see warnings when there is a real problem, so have it checked.');
ex(['P0685', 'P0686', 'P0687', 'P0688', 'P0689', 'P0690'], 'medium',
  'There is a problem with the power relay that feeds the engine computer. It can cause no start or stalling. Check the 12 volt battery and fuses first, then have it diagnosed.');
ex(['P0868'], 'high',
  'Transmission fluid pressure is too low. Check the fluid level and look for leaks. Low pressure can cause slipping and damage, so drive gently and get it checked soon.');
ex(['P0897'], 'medium',
  'The transmission computer thinks the fluid is worn out. A fluid change by a shop usually fixes it.');
ex(['U0001', 'U0002', 'U0073', 'U0074'], 'high',
  'The main data network (CAN bus) between the car\'s computers has a fault. Many warning lights may come on at once. Causes include a damaged wire, a corroded connector, or a module that is jamming the bus. A weak 12 volt battery can also cause this. Get it checked soon.');
ex(['U0100', 'U0101', 'U0115', 'U0110', 'U0111', 'U0293'], 'high',
  'Another module on the car network could not hear from an important powertrain computer. The car may stall, not start, or run in limp mode. First check the 12 volt battery and its terminals. Then a mechanic should check wiring and connectors to the module named in the description.');
ex(['U0121', 'U0122', 'U0126', 'U0129', 'U0131', 'U0415', 'U0416', 'U0418', 'U0428'], 'high',
  'A module could not talk to (or got bad data from) a brake, stability or steering module. ABS, stability control, or power steering assist may be disabled. Brakes still work normally but without ABS support. Drive carefully and get it checked soon.');
ex(['U0140', 'U0155', 'U0164', 'U0184', 'U0151', 'U0422'], 'medium',
  'A module lost contact with (or got bad data from) a body or cabin module, such as the body controller, instrument cluster, climate control, radio or airbag module. Check the 12 volt battery first. If an airbag warning light is on, have it checked soon because airbags may not deploy.');
ex(['C0035', 'C0040', 'C0045', 'C0050'], 'medium',
  'There is a problem with a wheel speed sensor or its wiring. ABS and stability control are usually turned off, but normal braking still works. The sensor or its cable is often damaged by road debris or rust. Exact wording can vary by car maker. Get it checked soon.');
ex(['B0001', 'B0002', 'B0010', 'B0011'], 'high',
  'There is a fault in a front airbag deployment circuit. The airbag may not deploy in a crash. Do not try to repair airbag parts yourself. Have a dealer or qualified shop check it soon. Exact wording can vary by car maker.');

// ===================================================================
// Structure based fallback
// ===================================================================
const SYSTEMS = {
  P: 'Powertrain (engine/transmission)',
  C: 'Chassis (brakes, steering, suspension)',
  B: 'Body (airbags, seats, lights, comfort)',
  U: 'Network (communication between modules)'
};

const P_SUB = {
  '0': 'fuel and air metering and auxiliary emission controls',
  '1': 'fuel and air metering',
  '2': 'fuel and air metering, injector circuits',
  '3': 'ignition system or misfire',
  '4': 'auxiliary emission controls',
  '5': 'vehicle speed, idle control and auxiliary inputs',
  '6': 'computer and output circuits',
  '7': 'transmission',
  '8': 'transmission',
  '9': 'transmission',
  A: 'hybrid propulsion',
  B: 'hybrid propulsion',
  C: 'hybrid propulsion'
};
const P2_SUB = {
  '0': 'fuel and air metering and auxiliary emission controls',
  '1': 'fuel and air metering and auxiliary emission controls',
  '2': 'fuel and air metering and auxiliary emission controls',
  '3': 'ignition system or misfire',
  '4': 'auxiliary emission controls',
  '5': 'auxiliary inputs',
  '6': 'computer and output circuits',
  '7': 'transmission',
  '8': 'transmission',
  '9': 'transmission',
  A: 'fuel and air metering and auxiliary emission controls'
};
const U_SUB = {
  '0': 'network electrical',
  '1': 'network communication (lost communication)',
  '2': 'network communication (lost communication)',
  '3': 'network software',
  '4': 'network data (invalid data received)'
};

function isGeneric(letter, d1, d2) {
  if (letter === 'P') {
    if (d1 === '0' || d1 === '2') return true;
    if (d1 === '3') return parseInt(d2, 16) >= 4;
    return false;
  }
  return d1 === '0' || d1 === '3';
}

function subsystemOf(letter, d1, d2) {
  if (letter === 'P') {
    if (d1 === '0' || d1 === '1') return P_SUB[d2] || null;
    if (d1 === '2') return P2_SUB[d2] || null;
    if (d1 === '3' && d2 === '4') return 'cylinder deactivation';
    return null;
  }
  if (letter === 'U' && d1 === '0') return U_SUB[d2] || null;
  return null;
}

function capital(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function describeDtc(code) {
  const raw = String(code == null ? '' : code).trim().toUpperCase();
  const m = /^([PCBU])([0-3])([0-9A-F])([0-9A-F]{2})$/.exec(raw);
  if (!m) {
    return {
      code: raw,
      system: 'Unknown',
      description: 'Not a recognised trouble code format',
      explain: 'Trouble codes look like a letter (P, C, B or U) followed by four characters, for example P0301. This value does not match that pattern.',
      severity: null,
      generic: false,
      manufacturerSpecific: false
    };
  }
  const letter = m[1], d1 = m[2], d2 = m[3];
  const generic = isGeneric(letter, d1, d2);
  const isToyota = Object.prototype.hasOwnProperty.call(TOYOTA, raw);
  const manufacturerSpecific = !generic || isToyota;
  const system = SYSTEMS[letter];
  const sub = subsystemOf(letter, d1, d2);
  const known = Object.prototype.hasOwnProperty.call(D, raw) ? D[raw] : null;
  const e = Object.prototype.hasOwnProperty.call(E, raw) ? E[raw] : null;

  let description;
  if (known) {
    description = known;
  } else if (generic) {
    description = 'Generic ' + system.split(' (')[0].toLowerCase() + ' code' + (sub ? ' in the ' + sub + ' group' : '') + ' (no description in the built-in list)';
    description = capital(description);
  } else {
    description = 'Manufacturer specific ' + system.split(' (')[0].toLowerCase() + ' code' + (sub ? ' (likely ' + sub + ')' : '');
    description = capital(description);
  }

  let explain;
  let severity = null;
  if (e) {
    severity = e[0];
    explain = e[1];
  } else if (known && !manufacturerSpecific) {
    explain = 'This is a standard code' + (sub ? ' in the ' + sub + ' group' : '') + '. The description above is the official short wording. A mechanic, or a repair manual for your car, can explain the likely causes and tests. If the car drives differently, makes new noises, or a warning light is flashing, get it checked soon.';
  } else if (known && isToyota) {
    explain = 'This is a Toyota/Lexus hybrid specific code. On other makes it can mean something different. Have a dealer or hybrid specialist check it, and do not touch orange high voltage cables.';
  } else if (manufacturerSpecific) {
    explain = 'This code is defined by the car maker, so its exact meaning depends on the make and model. Search for the code together with your car make, or ask a dealer or a mechanic with a manufacturer level scan tool.' + (sub ? ' It most likely relates to ' + sub + '.' : '');
  } else {
    explain = 'This is a standard code that is not in the built-in list.' + (sub ? ' It belongs to the ' + sub + ' group.' : '') + ' Search for the code or ask a mechanic for the exact meaning. If the car drives differently or a warning light is flashing, get it checked soon.';
  }

  return {
    code: raw,
    system: system,
    description: description,
    explain: explain,
    severity: severity,
    generic: generic,
    manufacturerSpecific: manufacturerSpecific
  };
}

// Number of codes with a description (handy for tests and the About text).
export const DTC_COUNT = Object.keys(D).length;
export const EXPLAINED_COUNT = Object.keys(E).length;
