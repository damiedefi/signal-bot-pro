"use strict";
// SYNTHETIC integration fixture. It tests parity, not a trading edge.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const e = require("../server");
const { dataset } = require("../test/fixtures");
async function verifyReplay({
  count = 600,
  symbols = e.PAIRS,
  strategy = e.CORRECTED_CONTROL,
} = {}) {
  const data = dataset({ count, symbols }),
    cfg = e.strategyConfig(strategy);
  // Explicit gaps test the open-before-intrabar event ordering.
  for (const sym of symbols)
    for (let i = 350; i < count; i += 67) {
      const factor = i % 2 ? 1.05 : 0.95;
      for (const k of ["open", "high", "low", "close"])
        data.candles[sym][i][k] *= factor;
    }
  const expected = e.backtest(data, cfg),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-replay-"));
  let index = 320,
    now = (data.testStart + 10) * 1000;
  const runtime = {
    ...e.runtimeConfig({
      SCAN_ENABLED: "false",
      REQUIRE_REMOTE_STORAGE: "false",
      RECORD_MARKET_CONTEXT: "false",
    }),
    source: "bybit-linear",
    dataDir: dir,
    strategy: cfg,
  };
  const market = {
    latest: async (sym) => {
      if (!data.candles[sym]) throw new Error("Fixture excludes pair");
      const c = data.candles[sym];
      return {
        closed: c.slice(index - cfg.lookback, index),
        nextOpen: index < count ? c[index].open : c.at(-1).close,
        boundary: c[0].time + index * 3600,
        source: "bybit-linear",
      };
    },
    history: async (sym, start, end) =>
      data.candles[sym].filter((c) => c.time >= start && c.time < end),
  };
  const create = () =>
    new e.Bot(runtime, {
      market,
      remote: null,
      clock: () => now,
      logger: { error() {}, log() {} },
    });
  let bot = create(),
    restarts = 0;
  try {
    await bot.initialize();
    for (index = 320; index <= count; index++) {
      now = (data.candles[symbols[0]][0].time + index * 3600 + 10) * 1000;
      if (index === Math.floor((count + 320) / 2)) {
        await bot.stop();
        bot = create();
        await bot.initialize();
        restarts++;
      }
      await bot.scan();
      if (index % 7 === 0) await bot.scan();
      const failed = bot.pairs.filter(
        (p) => symbols.includes(p.sym) && p.status !== "ok",
      );
      assert.equal(failed.length, 0, JSON.stringify(failed));
    }
    const actual = bot.store
      .list("signal")
      .filter((t) => t.entryTime + cfg.horizonHours * 3600 <= data.testEnd)
      .sort((a, b) => a.entryTime - b.entryTime || a.sym.localeCompare(b.sym));
    assert.equal(
      new Set(actual.map((t) => t.id)).size,
      actual.length,
      "Duplicate trades",
    );
    const fields = [
      "id",
      "sym",
      "dir",
      "entryTime",
      "entryPrice",
      "sl",
      "tp1",
      "setupTier",
      "score",
      "regime",
      "exitTime",
      "exitReason",
      "netR",
      "grossR",
      "feeR",
      "fundingR",
    ];
    const normalize = (a) =>
      a.map((t) => Object.fromEntries(fields.map((k) => [k, t[k]])));
    assert.deepEqual(normalize(actual), normalize(expected.trades));
    assert.ok(actual.length > 0);
    return {
      kind: "synthetic-software-verification",
      engineHash: e.ENGINE_HASH,
      policyHash: e.policyHash(cfg),
      policy:
        e.policyHash(cfg) ===
        e.policyHash(e.strategyConfig(e.CORRECTED_CONTROL))
          ? "corrected recorder control"
          : "research policy",
      pairs: symbols.length,
      decisionBoundaries: count - 319,
      matchedTrades: actual.length,
      duplicateTrades: 0,
      restarts,
      matchingFields: fields,
      parity: "exact",
      profitabilityConclusion: "none",
    };
  } finally {
    await bot.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
module.exports = { verifyReplay };
if (require.main === module)
  verifyReplay()
    .then((report) => {
      if (process.argv[2]) e.writeJSON(process.argv[2], report);
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
