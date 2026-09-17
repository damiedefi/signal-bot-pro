"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const e = require("../server");
const { candles, dataset, random } = require("./fixtures");
const zero = () =>
  e.strategyConfig({
    feeBps: 0,
    slippageBps: 0,
    spreadBps: 0,
    fundingBpsPer8h: 0,
  });
function setup(dir = "BUY", cfg = zero()) {
  return {
    eligible: true,
    sym: "BTC",
    dir,
    sl: dir === "BUY" ? 99 : 101,
    tp1: dir === "BUY" ? 103 : 97,
    tp2: dir === "BUY" ? 105 : 95,
    method: "chart",
    features: { atr: 1 },
    decisionTime: 0,
    score: 8,
    rawScore: 8,
    setupTier: 3,
    conf: 0,
    ratingStatus: "uncalibrated",
    regime: dir === "BUY" ? "bull" : "bear",
    policyHash: e.policyHash(cfg),
  };
}
function trade(dir = "BUY", cfg = zero()) {
  return e.openTrade(setup(dir, cfg), 100, 0, cfg);
}
function bar(open = 100, high = 102, low = 99.5, close = 101, time = 0) {
  return { time, open, high, low, close, volume: 1000 };
}

test("ATR fallback works in both directions with no pivots", () => {
  const cfg = zero(),
    a = Array.from({ length: 100 }, (_, i) => bar(100, 101, 99, 100, i * 3600));
  for (const dir of ["BUY", "SELL"]) {
    const l = e.chartLevels(a, 100, 1, dir, cfg);
    assert.equal(l.method, "atr");
    assert.equal(l.rr, 2);
  }
});
test("4H aggregation anchors UTC and excludes incomplete edge groups", () => {
  const a = candles(8, { start: 1704070800 });
  const f = e.aggregate4H(a);
  assert.equal(f.length, 1);
  assert.equal(f[0].time % 14400, 0);
  assert.equal(f[0].open, a[3].open);
  assert.equal(f[0].close, a[6].close);
});
test("duplicates, gaps, inverted OHLC and invalid volume fail closed", () => {
  const a = candles(4);
  for (const mutate of [
    (b) => (b[1].time = b[0].time),
    (b) => (b[1].time += 60),
    (b) => (b[1].high = 0),
    (b) => (b[1].volume = NaN),
  ]) {
    const b = structuredClone(a);
    mutate(b);
    assert.throws(() => e.validateCandles(b));
  }
});
test("flat RSI is neutral; pure increases/decreases reach endpoints", () => {
  assert.equal(e.rsiSimple(Array(20).fill(100)), 50);
  assert.equal(e.rsiSimple(Array.from({ length: 20 }, (_, i) => 100 + i)), 100);
  assert.equal(e.rsiSimple(Array.from({ length: 20 }, (_, i) => 100 - i)), 0);
});
test("mixed extrema are neutral in BOTH configurations", () => {
  for (const [h1, h2, l1, l2] of [
    [12, 13, 8, 7],
    [13, 12, 7, 8],
  ]) {
    const a = Array.from({ length: 20 }, () => ({ high: 11, low: 9 }));
    a[2].high = h1;
    a[8].high = h2;
    a[5].low = l1;
    a[11].low = l2;
    assert.equal(e.priceStructure(a).structure, "unclear");
  }
});
test("extreme Bollinger positions are retained", () => {
  const b = e.bollinger([...Array(19).fill(100), 130]);
  assert.ok(b.pctB > 1);
});
test("feature calculation uses exactly the same fixed lookback", () => {
  const a = candles(500),
    cfg = zero();
  assert.deepEqual(e.features(a, cfg), e.features(a.slice(-320), cfg));
});
test("future data never enters an earlier decision", () => {
  const a = candles(500),
    cfg = zero(),
    before = e.evaluateSignal(a.slice(0, 400), "BTC", cfg);
  a[450].close *= 2;
  assert.deepEqual(e.evaluateSignal(a.slice(0, 400), "BTC", cfg), before);
});
test("quiet normal ATR ratio is not automatically a squeeze release", () => {
  const a = Array.from({ length: 60 }, (_, i) =>
    bar(100, 101, 99, 100, i * 3600),
  );
  assert.equal(e.squeezeState(a, true).releasing, false);
  assert.equal(e.squeezeState(a, false).releasing, true);
});
test("insufficient 4H data is unknown, not neutral permission", () => {
  assert.equal(e.regimeOf(Array(30).fill(100), 101, 0.15).regime, "unknown");
});
test("both touched defaults to stop first for long and short", () => {
  const cfg = zero();
  for (const dir of ["BUY", "SELL"]) {
    const r = e.resolveTrade(trade(dir), [bar(100, 104, 96, 100)], cfg);
    assert.equal(r.exitReason, "stop");
    assert.equal(r.netR, -1);
    assert.equal(r.ambiguous, true);
  }
});
test("optimistic ambiguity is explicit and distinct", () => {
  const cfg = e.strategyConfig({ ...zero(), ambiguity: "target-first" }),
    r = e.resolveTrade(trade("BUY", cfg), [bar(100, 104, 98, 100)], cfg);
  assert.equal(r.netR, 3);
  assert.equal(r.ambiguous, true);
});
test("gap through stop fills at gap price, worse than -1R", () => {
  const r = e.resolveTrade(trade(), [bar(97, 98, 96, 97)], zero());
  assert.equal(r.netR, -3);
  assert.equal(r.gap, true);
  assert.equal(r.exitTime, 0);
});
test("short stop gap mirrors long stop accounting", () => {
  assert.equal(
    e.resolveTrade(trade("SELL"), [bar(104, 105, 103, 104)], zero()).netR,
    -4,
  );
});
test("gap over target receives target price conservatively", () => {
  const r = e.resolveTrade(trade(), [bar(105, 106, 104, 105)], zero());
  assert.equal(r.netR, 3);
  assert.equal(r.rawExit, 103);
});
test("24-hour expiry realizes mark-to-market R and stays in denominator", () => {
  const a = Array.from({ length: 24 }, (_, i) =>
      bar(100, 102, 99.5, 101.5, i * 3600),
    ),
    r = e.resolveTrade(trade(), a, zero());
  assert.equal(r.finalResult, "expired");
  assert.equal(r.netR, 1.5);
  const s = e.tradeStats([r]);
  assert.equal(s.total, 1);
  assert.equal(s.resolved, 1);
  assert.equal(s.expectancy, 1.5);
});
test("unfinished outcome candles cannot resolve a trade", () => {
  assert.equal(
    e.resolveTrade(trade(), [bar(100, 104, 98, 100)], zero(), { until: 3599 })
      .finalResult,
    "pending",
  );
});
test("missing beginning of outcome history cannot fabricate expiry", () => {
  assert.throws(
    () => e.resolveTrade(trade(), [bar(100, 102, 99.5, 101, 3600)], zero()),
    /Missing entry/,
  );
});
test("minute ordering resolves a target before a later stop", () => {
  const a = [bar(100, 103.1, 99.5, 102, 0), bar(102, 102, 98, 99, 60)];
  assert.equal(
    e.resolveTrade(trade(), a, zero(), { interval: 60 }).exitReason,
    "target",
  );
});
test("fees and financing reduce R using initial risk", () => {
  const cfg = e.strategyConfig({
      slippageBps: 0,
      spreadBps: 0,
      feeBps: 10,
      fundingBpsPer8h: 1,
    }),
    t = trade("BUY", cfg),
    r = e.closeTrade(t, { reason: "target", rawExit: 103 }, 86400, cfg);
  assert.ok(Math.abs(r.netR - (3 - 0.203 - 0.03)) < 1e-10);
});
test("supplied funding settlement sign differs between long and short", () => {
  const f = [{ time: 100, rate: 0.001, markPrice: 100 }];
  const a = e.closeTrade(
      trade(),
      { reason: "time", rawExit: 100 },
      3600,
      zero(),
      f,
    ),
    b = e.closeTrade(
      trade("SELL"),
      { reason: "time", rawExit: 100 },
      3600,
      zero(),
      f,
    );
  assert.equal(a.netR, -0.1);
  assert.equal(b.netR, 0.1);
});
test("slippage on entry and stop are adverse", () => {
  const cfg = e.strategyConfig();
  assert.ok(e.adverseFill(100, "BUY", cfg, true) > 100);
  assert.ok(e.adverseFill(100, "BUY", cfg, false) < 100);
  assert.ok(e.adverseFill(100, "SELL", cfg, true) < 100);
});
test("ATR exits anchor to fill and survive a nonzero cost model", () => {
  const cfg = e.strategyConfig(),
    s = { ...setup("BUY", cfg), method: "atr" },
    t = e.openTrade(s, 100, 0, cfg);
  assert.equal(t.rejected, undefined);
  assert.ok(Math.abs(t.rr - 2) < 1e-10);
});
test("entry gaps past planned exits are rejected", () => {
  assert.equal(e.openTrade(setup(), 104, 0, zero()).rejected, true);
  assert.equal(
    e.openTrade({ ...setup(), method: "atr" }, 104, 0, zero()).rejected,
    true,
  );
});
test("incorrect historical RR average regression: true mean is 0.5R", () => {
  const a = e.closeTrade(
      trade(),
      { reason: "target", rawExit: 102 },
      3600,
      zero(),
    ),
    b = e.closeTrade(
      { ...trade(), rr: 5 },
      { reason: "stop", rawExit: 99 },
      3600,
      zero(),
    );
  assert.equal(e.tradeStats([a, b]).expectancy, 0.5);
});
test("breakdowns use disjoint star cohorts", () => {
  const a = e.closeTrade(
      trade(),
      { reason: "target", rawExit: 103 },
      3600,
      zero(),
    ),
    b = e.closeTrade(trade(), { reason: "stop", rawExit: 99 }, 3600, zero());
  a.conf = 2;
  b.conf = 3;
  const r = e.reportTrades([a, b]);
  assert.equal(r.byStars[3].total, 1);
  assert.equal(r.byStars[3].expectancy, -1);
  assert.equal(r.byStars[2].expectancy, 3);
});
test("unresolved positions are disclosed, never reported as wins", () => {
  const s = e.tradeStats([trade()]);
  assert.equal(s.expectancy, null);
  assert.equal(s.pending, 1);
});
test("invalid strategy keys and costs fail loudly", () => {
  assert.throws(() => e.strategyConfig({ typo: true }));
  assert.throws(() => e.strategyConfig({ feeBps: -1 }));
  assert.throws(() => e.strategyConfig({ directions: [] }));
});
test("frozen dataset requires complete requested symbols and dates", () => {
  const d = dataset();
  delete d.candles.ETH;
  assert.throws(() => e.backtest(d));
  const x = dataset();
  x.candles.BTC.pop();
  assert.throws(() => e.backtest(x), /incomplete/);
});
test("hourly replay is deterministic and all exits have net R", () => {
  const d = dataset(),
    a = e.backtest(d),
    b = e.backtest(d);
  assert.deepEqual(a, b);
  assert.ok(a.trades.length > 0);
  assert.ok(a.trades.every((t) => Number.isFinite(t.netR)));
  assert.equal(a.byStars[3].total, 0);
  assert.equal(a.overall.total, a.overall.resolved);
});
test("only one position per pair; no reentry before prior exit", () => {
  const r = e.backtest(dataset());
  for (const sym of r.symbols) {
    let end = -Infinity;
    for (const t of r.trades.filter((t) => t.sym === sym)) {
      assert.ok(t.entryTime >= end);
      end = t.exitTime;
    }
  }
});
test("non-price inputs and current pattern state cannot influence historical replay", () => {
  const d = dataset(),
    before = e.backtest(d);
  global.patternDB = { BTC: { wins: 999, losses: 0 } };
  d.currentFunding = -0.1;
  const after = e.backtest(d);
  assert.deepEqual(before.trades, after.trades);
  delete global.patternDB;
});
test("different frozen data cannot be called the same comparison", () => {
  const a = e.backtest(dataset()),
    b = e.backtest(dataset({ seed: 18 }));
  assert.throws(() => e.comparePolicies(a, b), /identical frozen/);
});
test("synthetic profitability cannot unlock stars", () => {
  const r = e.backtest(dataset());
  assert.throws(() => e.makeCalibration(r, r), /Synthetic/);
});
test("calibration cannot look forward or cross versions", () => {
  const s = setup();
  const fake = {
    schemaVersion: 1,
    engineHash: e.ENGINE_HASH,
    policyHash: s.policyHash,
    source: "synthetic",
    symbols: ["BTC"],
    knownThrough: 1,
    groups: { "BUY:bull": { supported: true, stars: { 3: 3 } } },
  };
  assert.equal(e.ratingFor(s, fake, "synthetic").conf, 0);
  assert.equal(
    e.ratingFor({ ...s, decisionTime: 2 }, fake, "synthetic").conf,
    3,
  );
  fake.engineHash = "other";
  assert.equal(
    e.ratingFor({ ...s, decisionTime: 2 }, fake, "synthetic").conf,
    0,
  );
});
test("expiry and costs remain finite across 500 varied long/short paths", () => {
  const rng = random(11),
    cfg = e.strategyConfig();
  for (let i = 0; i < 500; i++) {
    const dir = i % 2 ? "BUY" : "SELL",
      t = trade(dir, cfg),
      o = 96 + rng() * 8,
      h = o + rng() * 4,
      l = o - rng() * 4,
      c = l + rng() * (h - l),
      r = e.resolveTrade(t, [bar(o, h, l, c)], cfg);
    if (r.finalResult !== "pending") {
      assert.ok(Number.isFinite(r.netR));
      assert.ok(r.netR <= r.grossR);
      assert.ok(r.risk > 0);
    }
  }
});

test("calibration requires positive and separated expectancy in supported cohorts", () => {
  const cfg = e.strategyConfig(),
    block = 7 * e.DAY;
  function report(start, two, three) {
    const trades = [];
    for (let w = 0; w < 13; w++)
      for (let i = 0; i < 4; i++)
        for (const tier of [2, 3]) {
          const entryTime = start + w * block + i * e.HOUR;
          trades.push({
            id: `${w}:${i}:${tier}`,
            sym: "BTC",
            dir: "BUY",
            regime: "bull",
            setupTier: tier,
            entryTime,
            exitTime: entryTime + e.HOUR,
            netR: tier === 2 ? two : three,
            grossR: tier === 2 ? two : three,
            feeR: 0,
            fundingR: 0,
            hours: 1,
            rr: 2,
            exitReason: "time",
          });
        }
    // Hand-built report fixtures test the evidence gate; no market result is claimed.
    return {
      kind: "historical",
      complete: true,
      engineHash: e.ENGINE_HASH,
      policyHash: e.policyHash(cfg),
      source: "bybit-linear",
      symbols: ["BTC"],
      config: cfg,
      testStart: start,
      testEnd: start + 13 * block,
      dataHash: String(start),
      trades,
    };
  }
  const training = report(0, 0.2, 0.8),
    validation = report(14 * block, 0.3, 0.9);
  const artifact = e.makeCalibration(training, validation);
  assert.equal(artifact.groups["BUY:bull"].supported, true);
  assert.equal(artifact.groups["SELL:bear"].supported, false);
  const signal = {
    ...setup("BUY", cfg),
    decisionTime: validation.testEnd + e.HOUR,
  };
  assert.equal(e.ratingFor(signal, artifact, "bybit-linear").conf, 3);
  assert.equal(
    e.ratingFor({ ...signal, setupTier: 2 }, artifact, "bybit-linear").conf,
    2,
  );
  assert.equal(
    e.ratingFor(
      { ...signal, dir: "SELL", regime: "bear" },
      artifact,
      "bybit-linear",
    ).conf,
    0,
  );
  const inverted = report(14 * block, 0.9, 0.3);
  assert.equal(
    e.makeCalibration(training, inverted).groups["BUY:bull"].supported,
    false,
  );
  assert.throws(
    () =>
      e.makeCalibration(training, {
        ...validation,
        testStart: training.testEnd,
      }),
    /full-horizon gap/,
  );
});

test("duplicate funding settlements cannot be charged twice in a dataset", () => {
  const data = dataset({ count: 400, symbols: ["BTC"] });
  const event = { time: data.testStart + 3600, rate: 0.0001, markPrice: 100 };
  data.fundingCoverage = { start: data.testStart, end: data.testEnd };
  data.funding = { BTC: [event, { ...event }] };
  assert.throws(
    () => e.validateDataset(data, e.strategyConfig()),
    /duplicate or unordered/,
  );
  data.funding.BTC.pop();
  assert.doesNotThrow(() => e.validateDataset(data, e.strategyConfig()));
});
