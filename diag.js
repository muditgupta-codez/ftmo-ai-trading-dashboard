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
        _h: undefined, _t: undefined, style: {},
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
  ["objPanel", "posPanel", "trigPanel", "tradePanel", "feed", "shadowPanel", "blockedPanel", "newsPanel", "sessPanel"].forEach(k => {
    const ok = els[k] && els[k]._h !== undefined && els[k]._h.length > 0;
    if (!ok) fail++;
    console.log(" ", k, "| html set:", ok, "| len:", ((els[k] && els[k]._h) || "").length);
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
  const mbarCount = (objHtml.match(/class="mbar"/g) || []).length;
  const objMetrics = objHtml.includes("Phase 1 target · +6%") && objHtml.includes("Max loss") && objHtml.includes("Daily loss") && objHtml.includes("Floating cap");
  console.log("  objectives: per-metric bars:", mbarCount, "| all metric rows:", objMetrics,
    "| shadow daily usage:", shadowObj.includes("Daily loss"));
  if (mbarCount < 12 || !objMetrics) fail++;
  const oldDaily = objHtml.includes("daily-loss used");
  console.log("  objectives: old text layout gone:", !oldDaily);
  if (oldDaily) fail++;
  if (d.shadow_account && d.shadow_account.balance && !hasToday) fail++;
  if (d.shadow_account && d.shadow_account.balance && !shadowObj.includes("Daily loss")) fail++;
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
  console.log("  Exit button rendered:", hasBtn, "| exitbtn class:", pp2.includes("exitbtn"), "| Exit th:", pp2.includes("<th>Exit</th>"), "| trigger cell:", pp2.includes('data-l="trigger"'));
  if (!hasBtn || !pp2.includes("exitbtn") || !pp2.includes("<th>Exit</th>") || !pp2.includes('data-l="trigger"')) fail++;
  const hasResolved = (d.shadow || []).some(s => s.status === "resolved");
  const winBadges = (sp.match(/b-buy">WIN/g) || []).length;
  const lossBadges = (sp.match(/b-rej">LOSS/g) || []).length;
  console.log("  shadow WIN badges green:", winBadges, "| LOSS badges red:", lossBadges, "| resolved rows exist:", hasResolved);
  if (hasResolved && (winBadges + lossBadges) === 0) fail++;
  if (hasResolved && /badge" style="background:var\(--line\)[^>]*>(WIN|LOSS)/.test(sp)) { console.log("  GRAY win/loss badge still present!"); fail++; }
  const iOpen = sp.indexOf('b-close">OPEN'), iWin = sp.indexOf('b-buy">WIN'), iLoss = sp.indexOf('b-rej">LOSS');
  console.log("  shadow sort (open<wins<losses): positions", iOpen, iWin, iLoss);
  if (iOpen > -1 && iWin > -1 && iOpen > iWin) fail++;
  if (iWin > -1 && iLoss > -1 && iWin > iLoss) fail++;
  const usdCount = (sp.match(/R \([+−]\$/g) || []).length;
  console.log("  shadow $ amounts shown:", usdCount, "(badges + open Now cells)");
  if (hasResolved && usdCount === 0) fail++;
  // open shadow rows must be sorted by unrealized R (profitable first)
  // read each row's own entry/sl/action attributes — symbols can repeat (buy+sell)
  const openRows = [...sp.matchAll(/<td data-ssym="[^"]+" data-entry="([^"]+)" data-sl="([^"]+)" data-act="([^"]+)"/g)]
    .map(m => {
      const entry = parseFloat(m[1]), sl = parseFloat(m[2]);
      const sym = m[0].match(/data-ssym="([^"]+)"/)[1];
      const px = (d.prices || {})[sym];
      const risk = Math.abs(entry - sl);
      if (px == null || !risk) return -999;
      return m[3] === "buy" ? (px - entry) / risk : (entry - px) / risk;
    });
  const sorted = openRows.every((v, i) => i === 0 || openRows[i - 1] + 1e-9 >= v);
  console.log("  open Now rows profit-sorted:", sorted, "| unrealized R order:", openRows.map(v => v === -999 ? "?" : v.toFixed(2)).join(", "));
  if (!sorted) fail++;
  const wideCells = (sp.match(/class="wide"/g) || []).length;
  console.log("  wide cells (plan/why/reason/event):", wideCells, "in shadow |",
    tp.includes('class="wide"') ? "trig ✓" : "trig ✗");
  if (sp.match(/data-l="why" style/) && !sp.includes('class="wide" data-l="why"')) fail++;
  if (tp.includes('max-width:340px') && !tp.includes('class="wide"')) fail++;
  const tKeysLen = (d.triggers && d.triggers.triggers) ? Object.keys(d.triggers.triggers).length : 0;
  const confTxt = (els["confV"] && els["confV"]._t) || "";
  const confMeters = (tp.match(/class="conf"/g) || []).length;
  console.log("  confidence card:", confTxt || "(empty)", "| trigger meters:", confMeters);
  if (!/^\d+$/.test(confTxt)) fail++;
  if (tKeysLen > 0 && confMeters === 0) fail++;
  const trigConfs = [...tp.matchAll(/<div class="conf"[^>]*>[\s\S]*?<span>(\d+)<\/span>/g)].map(m => +m[1]);
  const trigSorted = trigConfs.every((v, i) => i === 0 || trigConfs[i - 1] >= v);
  console.log("  triggers conf-sorted high→low:", trigSorted, "| order:", trigConfs.join(","));
  if (trigConfs.length > 1 && !trigSorted) fail++;
  const sessHtml = (els["sessPanel"] && els["sessPanel"]._h) || "";
  console.log("  sessions panel: names:", ["London", "New York"].every(n => sessHtml.includes(n)),
    "| productivity table:", sessHtml.includes("Most productive"), "| cnt:", (els["cntSess"] && els["cntSess"]._t) || "-");
  if (!sessHtml.includes("London") || !sessHtml.includes("New York")) fail++;
  const hEq = (els["hEquity"] && els["hEquity"]._t) || "";
  console.log("  sticky header equity:", hEq, "| today:", (els["hToday"] && els["hToday"]._t) || "?", "| cnt badges:", ["cntTrig", "cntShadow", "cntFeed", "cntNews"].map(id => (els[id] && els[id]._t) || "-").join(" "));
  if (!/\$[\d,]/.test(hEq)) fail++;
  if (d.equity_lows && d.equity_lows.day_low) {
    const okLow = objHtml.includes("day low") && objHtml.includes("equity-based");
    console.log("  equity lows shown:", okLow, "| day low:", d.equity_lows.day_low);
    if (!okLow) fail++;
  }
  console.log(useLocal ? "LOCAL GATE: " + (fail ? "FAIL (" + fail + ")" : "PASS") : "VERIFY DONE, failures: " + fail);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log("HARNESS ERROR:", e.message); process.exitCode = 1; });
