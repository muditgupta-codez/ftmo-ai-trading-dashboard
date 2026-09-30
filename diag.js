(async () => {
  const fs = require("fs");
  const local = fs.readFileSync("index.html", "utf8");
  const h = await (await fetch("https://ftmo.falcon.zoophost.com/")).text();
  console.log("--- deployed script markers ---");
  ["flat.slice(0, 10)", "Array.isArray(x.decisions)", "applyTick", "renderPositions", "connectWS", 'join("")).join'].forEach(k => {
    console.log("  deployed has", JSON.stringify(k), ":", h.includes(k), "| local:", local.includes(k));
  });
  console.log("deployed size:", h.length, "| local size:", local.length);

  const script = h.match(/<script>([\s\S]*?)<\/script>/)[1];
  const d = await (await fetch("https://ftmo.falcon.zoophost.com/api/data")).json();
  const els = {};
  global.document = {
    getElementById: (id) => (els[id] = els[id] || {
      _h: undefined, _t: undefined,
      set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; },
      set textContent(v) { this._t = v; }, get textContent() { return this._t; },
      classList: { add() {}, toggle() {}, remove() {} }
    }),
    querySelector: () => null, querySelectorAll: () => []
  };
  global.fetch = async () => ({ json: async () => d });
  global.setInterval = () => {};
  try { new Function(script)(); } catch (e) { console.log("SYNC ERROR:", e.message); }
  await new Promise(r => setTimeout(r, 900));
  console.log("--- rendered sections after refresh ---");
  Object.keys(els).forEach(k => console.log(" ", k, "| html set:", els[k]._h !== undefined, "| len:", (els[k]._h || "").length));
  console.log("liveTxt:", els["liveTxt"] ? els["liveTxt"].textContent : "(never touched)");
  console.log("d.empty in payload:", d.empty);
})().catch(e => console.log("HARNESS ERROR:", e.message));
