(async () => {
  const fs = require("fs");
  const local = fs.readFileSync("index.html", "utf8");
  const useLocal = process.argv[2] === "local";
  const h = useLocal ? local : await (await fetch("https://ftmo.falcon.zoophost.com/")).text();
  console.log("mode:", useLocal ? "LOCAL (pre-deploy gate)" : "DEPLOYED (post-deploy verify)");
  console.log("deployed==local script:", h === local);

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
  let fail = 0;
  ["objPanel", "posPanel", "trigPanel", "tradePanel", "feed", "shadowPanel", "blockedPanel", "newsPanel"].forEach(k => {
    const ok = els[k] && els[k]._h !== undefined && els[k]._h.length > 0;
    if (!ok) fail++;
    console.log(" ", k, "| html set:", ok, "| len:", (els[k]._h || "").length);
  });
  const live = els["liveTxt"] ? els["liveTxt"].textContent : "(never touched)";
  console.log("liveTxt:", live);
  if (live.startsWith("ERR") || /error/i.test(live)) fail++;

  // --- feature assertions ---
  const sp = (els["shadowPanel"] && els["shadowPanel"]._h) || "";
  const tp = (els["trigPanel"] && els["trigPanel"]._h) || "";
  const pp = (els["posPanel"] && els["posPanel"]._h) || "";
  console.log("--- feature checks ---");
  const noWhen = !sp.includes("<th>When</th>") && !sp.includes('data-l="">+' );
  console.log("  shadow: When column removed:", noWhen, "| still present:", sp.includes("<th>When</th>"));
  if (sp.includes("<th>When</th>")) fail++;
  const ssymCells = (sp.match(/data-ssym=/g) || []).length;
  const coloredNow = (sp.match(/data-l="now"><span class="(pos|neg)"/g) || []).length;
  console.log("  shadow Now cells:", ssymCells, "| color-coded:", coloredNow);
  if (ssymCells > 0 && coloredNow === 0) fail++;
  const trigColored = (tp.match(/<span class="(pos|neg)">/g) || []).length;
  console.log("  trigger colored spans:", trigColored);
  if (tp.includes("data-sym=") && trigColored === 0) fail++;
  if (pp.includes("data-l=\"now\"")) {
    const posColored = (pp.match(/data-l="now" class="(pos|neg)"/g) || []).length;
    console.log("  open-positions Now colored:", posColored);
    if (posColored === 0) fail++;
  } else console.log("  open-positions: no rows (flat) — render path still color-safe");
  console.log(useLocal ? "LOCAL GATE: " + (fail ? "FAIL (" + fail + ")" : "PASS") : "VERIFY DONE, failures: " + fail);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log("HARNESS ERROR:", e.message); process.exitCode = 1; });
