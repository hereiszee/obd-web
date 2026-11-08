// Plain-English explainer text for every section of the app.
// Rules: no em dashes or en dashes, short sentences, say what to do next.

export const TEXT = {
  connect: {
    lead: 'Link this page to your OBD adapter over Bluetooth, or try a pretend car to see how everything works.',
    what: [
      'Your adapter (for example the Vgate vLinker MC+) plugs into the OBD port of the car. On most cars the port is under the dashboard, near the driver\'s knees.',
      'This page talks to the adapter directly over Bluetooth. You connect from inside this page by tapping "Connect adapter". You do not pair it in the iPhone Settings app. If it is already paired there, that is fine, but it is not needed.',
      'The simulated car lets you explore every feature with fake data, with no adapter and no car.'
    ],
    means: [
      'Connected to the car: the adapter is linked and the car answered. Everything below is ready to use.',
      'Adapter connected, car not answering: Bluetooth works, but the car is asleep. This is almost always because the ignition is off.',
      'Disconnected: nothing is linked. Nothing is being read from the car.'
    ],
    next: [
      'Plug the adapter into the OBD port firmly. A light on the adapter should come on.',
      'Turn the ignition ON. On a hybrid or push-button car, press the start button with your foot on the brake until the READY light shows. For a normal engine car you can also just start the engine.',
      'On iPhone, open this page in the Bluefy browser (Safari cannot use Bluetooth). On a computer, use Chrome or Edge.',
      'Tap "Connect adapter" and pick your vLinker (or similar name such as "vLinker", "OBDII", "IOS-Vlink") from the list that appears.',
      'If the adapter does not show up, close any other app that might be connected to it (for example Car Scanner), then try again.'
    ]
  },

  probe: {
    lead: 'Probe asks the adapter to describe itself. It is mainly useful when something is not working.',
    help: 'The results show the adapter chip version, the protocol it found, the car battery voltage, and whether the car answered a basic request. Everything is also written to the debug console at the bottom.'
  },

  noBluetooth: {
    title: 'Bluetooth is not available in this browser',
    text: 'On iPhone, open this page in the free Bluefy browser from the App Store (Safari and Chrome on iPhone cannot use Bluetooth adapters). On a computer, use Chrome or Edge. You can still try the simulated car right here.'
  },

  check: {
    lead: 'One tap runs the checks that matter most when you are looking at a used car.',
    what: [
      'Reads the VIN the car reports, the check engine light status, stored, pending and permanent trouble codes, and the readiness monitors.',
      'Reads how far the car has driven and how long it has run since the trouble codes were last cleared, and how many warm-ups it has done since then.',
      'Turns all of that into a short list of plain-English findings.'
    ],
    means: [
      'Red items are worth a serious question to the seller or a mechanic.',
      'Yellow items are things to be aware of or ask about.',
      'Green items look good.',
      '"Codes were probably cleared recently" is the big one. Sellers sometimes clear codes right before a viewing to hide a problem. The car keeps counting distance and warm-ups since the last clear, and it also has "readiness monitors" that reset when codes are cleared. Low numbers and many "not ready" monitors suggest a recent clear.',
      'Items marked "not supported by this car" are not errors. Different cars report different things.'
    ],
    next: [
      'If the codes look recently cleared, ask the seller why, and ask to come back after the car has been driven for a few days.',
      'If there are trouble codes, look at the Trouble codes section below for what each one means.',
      'Compare the VIN shown here with the VIN on the windscreen and the registration papers. They should match.',
      'Build a report at the bottom of the page to save or share the results.'
    ]
  },

  codes: {
    lead: 'Read the fault codes the car has stored, and clear them once a problem is fixed.',
    what: [
      'Reads three kinds of codes from every module that answers.',
      'Stored (confirmed) codes are faults the car is sure about. These usually turn on the check engine light.',
      'Pending codes are faults seen once but not yet confirmed. They can become stored codes if the problem happens again.',
      'Permanent codes cannot be cleared with a scan tool. The car erases them itself after it has driven enough to confirm the fault is fixed. Not all cars support them.'
    ],
    means: [
      'Each code has a letter and 4 digits. P is engine and transmission, C is chassis (brakes, steering), B is body (airbags, seats), U is network communication between modules.',
      'A second digit of 0 means a standard code shared by all makers. 1 usually means a code specific to the maker, so the description may be general.',
      'Severity is a rough guide. High means get it checked soon and avoid hard driving. Medium means book a check. Low means keep an eye on it.',
      'No codes is good news, but it does not prove the car is perfect. Check the readiness monitors too.'
    ],
    next: [
      'Write down or share the codes before doing anything else. A report keeps them safe.',
      'Fix the cause first, then clear the codes. Clearing a code does not fix anything.',
      'If the same code comes back after clearing, the fault is still there.'
    ],
    stored: 'Stored codes (confirmed faults, usually light on)',
    pending: 'Pending codes (seen once, not confirmed yet)',
    permanent: 'Permanent codes (only the car can erase these)',
    none: 'No codes found.',
    notSupported: 'Not supported by this car.'
  },

  clear: {
    title: 'Clear trouble codes?',
    intro: 'This erases the fault memory in the car. Please read what happens before you continue.',
    consequences: [
      'The check engine light turns off, but it will come back on if the fault is still there. Clearing does not repair anything.',
      'All readiness monitors reset to "not ready". The car may fail an emissions inspection or MOT style check until it has been driven normally for a few days (often 50 to 150 km of mixed driving).',
      'The freeze frame snapshot (the sensor readings saved when the fault happened) is erased for good. A mechanic will no longer be able to see it.',
      'Learned fuel trims and some adaptive values may reset, so the car can feel slightly different for a short while.',
      'Permanent codes, if your car has them, will not be removed by this. The car clears them itself after it confirms the repair.'
    ],
    before: 'Tip: build and save a report first, so you keep a record of the codes and freeze frame.',
    safety: 'The engine is OFF and the ignition is ON. (Hybrid or push-button car: press the start button twice without touching the brake, so the dashboard lights are on but READY is off.)',
    typePrompt: 'Type CLEAR to confirm',
    confirm: 'Clear codes now',
    cancel: 'Cancel, keep the codes',
    success: 'The car accepted the clear command. Codes are being read again to confirm.',
    afterwards: 'Drive normally for a few days so the readiness monitors can complete. If a code returns, the fault is still present.'
  },

  readiness: {
    lead: 'Readiness monitors are self-tests the car runs while driving. They show whether the emission systems have been checked since the codes were last cleared.',
    ready: 'Ready',
    notReady: 'Not ready yet',
    notUsed: 'Not used on this car',
    help: 'A few "not ready" monitors are normal on a car that has only done short trips. Many "not ready" monitors usually means the codes were cleared recently or the battery was disconnected. Inspections usually allow at most one not ready (some allow two on older cars).'
  },

  freeze: {
    lead: 'A freeze frame is a snapshot of the sensor readings at the moment a fault code was stored.',
    what: [
      'When the car stores a fault, it also saves readings like engine speed, temperature, load and road speed at that moment.',
      'This tells a mechanic the conditions when the fault happened, for example cold engine at idle, or hot engine at motorway speed.'
    ],
    means: [
      'The code at the top is the fault that caused the snapshot. Usually there is only one snapshot, for the first or most serious fault.',
      'No freeze frame usually just means there are no stored codes right now.'
    ],
    next: [
      'Share it with your mechanic along with the codes. It is erased when codes are cleared.'
    ],
    none: 'No freeze frame is saved. This is normal when there are no stored codes.'
  },

  live: {
    lead: 'Watch live sensor readings from the engine and hybrid system.',
    what: [
      'Reads the selected sensors over and over, as fast as the adapter allows (usually a few updates per second).',
      'Only sensors this car actually reports are offered. Use "Choose readings" to add or remove tiles.',
      'Tap any tile to learn what that reading means.'
    ],
    means: [
      'The bar shows where the value sits in its normal range. It is a rough guide, not a pass or fail.',
      'A dash (--) means the car did not answer that reading this time. An occasional dash is normal.',
      'On a hybrid, engine speed is often 0 when the petrol engine is off. That is normal.'
    ],
    next: [
      'Do not watch the screen while driving. Have a passenger look, or park first.',
      'Tap Stop when you are done so the other buttons work again.'
    ],
    stopFirst: 'Live data is running. Tap "Stop live data" before using the other tools.'
  },

  report: {
    lead: 'Turn everything you have read into a plain-text summary you can save, send or print.',
    what: [
      'Collects the connection details, used car findings, trouble codes, readiness, freeze frame and the latest live readings you have looked at.',
      'Only things you have already read are included. Run the sections above first.'
    ],
    means: [
      'The text is built on your phone. Nothing is uploaded. You choose where it goes when you tap Share or Copy.',
      'The VIN is left out unless you tick the box, because it identifies the car.'
    ],
    next: [
      'Tap Share to send it by message or email, or save it to Notes or Files. You can edit the text in the box before sharing.'
    ]
  },

  console: {
    lead: 'Every message sent to and received from the adapter, for troubleshooting.',
    help: 'TX lines are commands this page sent. RX lines are raw replies from the adapter (⏎ marks a line break). If something does not work, tap "Copy log" and include it when asking for help. The log stays on this device and is lost when you close the page.'
  },

  about: {
    title: 'What is this?',
    paras: [
      'OBD Web is a free car diagnostic page. It reads the standard OBD-II data every petrol car since about 2001 (Europe) or 1996 (USA) and most diesels since about 2004 provide. It works with Bluetooth Low Energy adapters that use the ELM327 command set, such as the Vgate vLinker MC+.',
      'It is a helpful first look, not a replacement for a professional inspection. Manufacturer-specific systems (airbags, ABS, hybrid battery details) are often only partly visible through standard OBD-II.'
    ]
  },

  privacy: {
    title: 'Privacy',
    paras: [
      'Nothing leaves your phone. This page has no accounts, no analytics, no tracking and no server. It never sends your car data anywhere.',
      'All readings live in memory only and disappear when you close or reload the page. The only way data leaves is if you choose Copy or Share yourself.'
    ]
  }
};

// Friendly labels for the three code types, used by the UI and the report.
export const CODE_KINDS = [
  { key: 'stored', mode: '03', title: TEXT.codes.stored, short: 'Stored' },
  { key: 'pending', mode: '07', title: TEXT.codes.pending, short: 'Pending' },
  { key: 'permanent', mode: '0A', title: TEXT.codes.permanent, short: 'Permanent' }
];

export const SEVERITY_LABEL = {
  high: 'High: get it checked soon',
  medium: 'Medium: book a check',
  low: 'Low: keep an eye on it'
};
