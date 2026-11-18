// The browser version's page script: all it does is ask for the app, unless
// the gate that ran before it (gate.js) stopped this visitor. Kept this
// small on purpose — everything else is one import away, so a visitor the
// gate stopped downloads none of it.
if (!document.documentElement.dataset.gate) void import("./start");
