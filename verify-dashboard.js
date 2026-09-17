"use strict";
// Optional DOM integration check: pass an externally installed jsdom module path.
// No third-party package is needed to run the bot or its core tests.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const e = require("../server");
async function main() {
  const { JSDOM } = require(path.resolve(process.argv[2]));
  const checks = [];
  let protectedReads = false,
    healthy = true,
    requests = [];
  const dir = path.join(__dirname, "..", "public");
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const config = {
    version: e.VERSION,
    source: "bybit-linear",
    strategy: e.strategyConfig(),
  };
  const scan = {
    data: e.PAIRS.map((sym) => ({
      sym,
      source: "bybit-linear",
      status: "ok",
      price: 100,
      pct24h: 1.1,
      regime: "bull",
      conf: 0,
      signals: [],
      reasons: ["slope unconfirmed"],
      disposition: "filtered",
    })),
    history: [],
    lastScan: { available: 12, finishedAt: Date.now() },
    stale: false,
  };
  const health = {
    ready: true,
    scanEnabled: true,
    persistence: {
      connected: true,
      recovered: true,
      configured: true,
      required: true,
      pendingWrites: 0,
    },
    validation: { stars: "uncalibrated" },
    telegramEnabled: false,
  };
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const win = dom.window;
  win.fetch = async (route, options) => {
    requests.push({ route, options });
    if (!healthy) throw new Error("Test offline");
    if (
      protectedReads &&
      route !== "/api/health" &&
      options.headers.Authorization !== "Bearer test-reader"
    )
      return { ok: false, status: 401 };
    const data = {
      "/api/health": health,
      "/api/config": config,
      "/api/scan": scan,
      "/api/live-stats": e.reportTrades([]),
      "/api/backtest": { status: "idle" },
    }[route];
    return { ok: true, status: 200, json: async () => structuredClone(data) };
  };
  async function settled() {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 2));
      if (!win.document.getElementById("refresh").disabled) return;
    }
    throw new Error("Dashboard did not settle");
  }
  const el = (id) => win.document.getElementById(id);
  try {
    win.eval(fs.readFileSync(path.join(dir, "app.js"), "utf8"));
    await settled();
    assert.equal(el("pairs").children.length, 12);
    assert.equal(el("pending").textContent, "0");
    assert.equal(el("expectancy").textContent, "—");
    assert.match(el("notice").textContent, /Profitability remains unvalidated/);
    assert.match(el("trades").textContent, /No paper trades/);
    checks.push(
      "all 12 pairs, empty history and unknown expectancy display correctly",
    );
    assert.ok(!el("pairs").textContent.includes("★"));
    checks.push("uncalibrated setups never display quality stars");
    el("pair-filter").value = "BUY";
    el("pair-filter").dispatchEvent(new win.Event("change"));
    assert.match(el("pairs").textContent, /No pairs match/);
    el("pair-filter").value = "all";
    el("pair-filter").dispatchEvent(new win.Event("change"));
    checks.push("filters preserve an explicit empty state");
    scan.data[0].reasons = ["<img src=x onerror=alert(1)>"];
    el("refresh").click();
    await settled();
    assert.match(el("pairs").textContent, /<img src/);
    assert.equal(el("pairs").querySelectorAll("img").length, 0);
    checks.push("API text renders without HTML execution");
    protectedReads = true;
    el("refresh").click();
    await settled();
    assert.equal(el("access").hidden, false);
    el("read-token").value = "test-reader";
    el("access").dispatchEvent(new win.Event("submit", { cancelable: true }));
    await settled();
    assert.equal(el("access").hidden, true);
    assert.equal(el("read-token").value, "");
    assert.equal(win.localStorage.length, 0);
    assert.equal(win.sessionStorage.length, 0);
    checks.push("read authentication works without storing tokens");
    healthy = false;
    el("refresh").click();
    await settled();
    assert.match(el("updated").textContent, /may be stale/);
    checks.push("connection failures clearly mark retained data stale");
    assert.ok(
      requests.every((r) => !r.options.method || r.options.method === "GET"),
    );
    checks.push("dashboard requests are read-only");
    const report = {
      kind: "dashboard-DOM-verification",
      passed: checks.length,
      failed: 0,
      checks,
      visualBrowserTested: false,
    };
    if (process.argv[3]) e.writeJSON(process.argv[3], report);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    win.close();
  }
}
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
