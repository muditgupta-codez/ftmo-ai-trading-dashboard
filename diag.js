(async () => {
  const fs = require("fs");
  const local = fs.readFileSync("index.html", "utf8");
  const useLocal = process.argv[2] === "local";
  const h = useLocal ? local : await (await fetch("https://ftmo.falcon.zoophost.com/")).text();
  console.log("mode:", useLocal ? "LOCAL (pre-deploy gate)" : "DEPLOYED (post-deploy verify)");
  console.log("deployed==local script:", h === local);

  const script = h.match(/<script>([\s\S]*?)<\/script>/)[1];
  const d = await (await fetch("https://ftmo.falcon.zoophost.com/api/data")).json();
  global.setInterval = () => {};

  async function run(payload) {
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
    global.fetch = async () => ({ json: async () => payload });
    try { new Function(script)(); } catch (e) { return { els, err: e.message }; }
    await new Promise(r => setTimeout(r, 900));
    return { els };
  }

  let fail = 0;
  const r1 = await run(d);
  if (r1.err) { console.log("SYNC ERROR:", r1.err); fail++; }
  const els = r1.els;
  console.log("--- rendered sections after refresh ---");
  ["objPanel", "posPanel", "trigPanel", "tradePanel", "feed", "shadowPanel", "blockedPanel", "newsPanel"].forEach(k => {
    const ok = els[k] && els[k]._h !== undefined && els[k]._h.length > 0;
    if (!ok) fail++;
    console.log(" ", k, "| html set:", ok, "| len:", (els[k]._h || "").length);
  });
  const live = els["liveTxt"] ? els["liveTxt"].textContent : "(never touched)";
  console.log("liveTxt:", live);
  if (live.startsWith("ERR") || /error/i.test(live)) fail++;

  // --- feature assertions: pass 1 (live payload) ---
  const sp = (els["shadowPanel"] && els["shadowPanel"]._h) || "";
  const tp = (els["trigPanel"] && els["trigPanel"]._h) || "";
  const pp = (els["posPanel"] && els["posPanel"]._h) || "";
  console.log("--- feature checks ---");
  console.log("  shadow: When column removed:", !sp.includes("<th>When</th>"));
  if (sp.includes("<th>When</th>")) fail++;
  const ssymCells = (sp.match(/data-ssym=/g) || []).length;
  const coloredNow = (sp.match(/data-l="now"><span class="(pos|neg)"/g) || []).length;
  console.log("  shadow Now cells:", ssymCells, "| color-coded:", coloredNow);
  if (ssymCells > 0 && coloredNow === 0) fail++;
  const trigColored = (tp.match(/<span class="(pos|neg)">/g) || []).length;
  console.log("  trigger colored spans:", trigColored);
  if (tp.includes("data-sym=") && trigColored === 0) fail++;
  const hasToday = sp.includes("today +$") || sp.includes("today −$") || sp.includes("today -$");
  console.log("  shadow strip daily P/L shown:", hasToday, "| server account:", !!(d.shadow_account && d.shadow_account.balance));
  const objHtml = (els["objPanel"] && els["objPanel"]._h) || "";
  const shadowObj = objHtml.split("Shadow account")[1] || "";
  console.log("  objectives: shadow daily-loss usage shown:", shadowObj.includes("daily-loss used"));
  if (d.shadow_account && d.shadow_account.balance && !hasToday) fail++;
  if (d.shadow_account && d.shadow_account.balance && !shadowObj.includes("daily-loss used")) fail++;
  console.log("  exit plumbing in script:", script.includes("/api/command") && script.includes("manualExit"));
  if (!(script.includes("/api/command") && script.includes("manualExit"))) fail++;

  // --- pass 2: synthetic open position -> Exit button must render ---
  const d2 = JSON.parse(JSON.stringify(d));
  d2.watcher = d2.watcher || {};
  d2.watcher.position_rows = [{ symbol: "EURUSD", type: "buy", volume: 0.14,
    open_price: 1.1, current_price: 1.105, profit: 35.2, sl: 1.09, tp: 1.13, ticket: 123456 }];
  const r2 = await run(d2);
  if (r2.err) { console.log("PASS2 SYNC ERROR:", r2.err); fail++; }
  const pp2 = (r2.els["posPanel"] && r2.els["posPanel"]._h) || "";
  const hasBtn = pp2.includes("manualExit(&#39;EURUSD&#39;)") || pp2.includes("manualExit('EURUSD')") || /manualExit\(.?EURUSD/.test(pp2);
  console.log("--- pass 2: synthetic position ---");
  console.log("  Exit button rendered:", hasBtn, "| exitbtn class:", pp2.includes("exitbtn"), "| Exit th:", pp2.includes("<th>Exit</th>"));
  if (!hasBtn || !pp2.includes("exitbtn") || !pp2.includes("<th>Exit</th>")) fail++;
  const hasResolved = (d.shadow || []).some(s => s.status === "resolved");
  const winBadges = (sp.match(/b-buy">WIN/g) || []).length;
  const lossBadges = (sp.match(/b-rej">LOSS/g) || []).length;
  console.log("  shadow WIN badges green:", winBadges, "| LOSS badges red:", lossBadges, "| resolved rows exist:", hasResolved);
  if (hasResolved && (winBadges + lossBadges) === 0) fail++;
  if (hasResolved && /badge" style="background:var\(--line\)[^>]*>(WIN|LOSS)/.test(sp)) { console.log("  GRAY win/loss badge still present!"); fail++; }
  console.log(useLocal ? "LOCAL GATE: " + (fail ? "FAIL (" + fail + ")" : "PASS") : "VERIFY DONE, failures: " + fail);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log("HARNESS ERROR:", e.message); process.exitCode = 1; });
