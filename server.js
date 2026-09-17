"use strict";
/**
 * Defi Insider Signal Bot 6.0 — research and forward PAPER signals only.
 * Node >=24. No exchange orders. No imports have network or timer side effects.
 * The pure engine below is shared by historical and forward replays.
 * See SIGNAL-BOT-FULL-CONTEXT.md for the execution contract and evidence limits.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { DatabaseSync } = require("node:sqlite");
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("node:worker_threads");

const VERSION = "6.0.0";
const HOUR = 3600;
const DAY = 86400;
const PAIRS = Object.freeze([
  "BTC",
  "ETH",
  "BNB",
  "SOL",
  "DOGE",
  "AVAX",
  "XRP",
  "NEAR",
  "UNI",
  "INJ",
  "SUI",
  "TAO",
]);
const LEGACY_BIASES = Object.freeze({
  NEAR: [1, -0.5],
  BTC: [0.5, -1.5],
  SOL: [0.5, -0.5],
  INJ: [0.5, -0.5],
  XRP: [0, 0],
  TAO: [0, -0.5],
  SUI: [0, -0.5],
  AVAX: [0, -1],
  DOGE: [0, -1],
  ETH: [0, -1.5],
  UNI: [-0.5, -1.5],
  BNB: [0, -1.5],
});
const STRATEGY_DEFAULTS = Object.freeze({
  lookback: 320,
  horizonHours: 24,
  rrMin: 2,
  rrMax: 5,
  weakRRMax: 3.5,
  regimeSlopePct: 0.15,
  allowNeutral: false,
  coinBias: false,
  strictQuality: true,
  actualSqueezeRelease: true,
  maxTargetATR: null,
  minStopATR: 0,
  rejectObstructed: false,
  exitMode: "chart",
  directions: ["BUY", "SELL"],
  feeBps: 5.5,
  slippageBps: 2,
  spreadBps: 2,
  fundingBpsPer8h: 1,
  ambiguity: "stop-first",
  minRatingSamples: 50,
  minRatingBlocks: 12,
  blockDays: 7,
});

// Recorder default preserves the corrected v5 price-only control. Candidate
// scoring/filter changes remain a separate, explicitly selected research policy.
const CORRECTED_CONTROL = Object.freeze({
  allowNeutral: true,
  coinBias: true,
  strictQuality: false,
  actualSqueezeRelease: false,
  maxTargetATR: null,
  rejectObstructed: false,
});

function invariant(ok, message) {
  if (!ok) throw new Error(message);
}
function finite(n) {
  return typeof n === "number" && Number.isFinite(n);
}
function round(n, digits = 6) {
  return finite(n) ? Number(n.toFixed(digits)) : null;
}
function sum(a) {
  return a.reduce((s, x) => s + x, 0);
}
function mean(a) {
  return a.length ? sum(a) / a.length : null;
}
function sign(dir) {
  invariant(dir === "BUY" || dir === "SELL", "Invalid direction");
  return dir === "BUY" ? 1 : -1;
}
function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stable(value[k]))
        .join(",") +
      "}"
    );
  invariant(value !== undefined, "Undefined cannot be hashed");
  return JSON.stringify(value);
}
function hash(value) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : stable(value))
    .digest("hex");
}
const ENGINE_HASH = hash(fs.readFileSync(__filename, "utf8"));
function strategyConfig(overrides = {}) {
  for (const k of Object.keys(overrides))
    invariant(
      Object.hasOwn(STRATEGY_DEFAULTS, k),
      "Unknown strategy option: " + k,
    );
  const c = { ...STRATEGY_DEFAULTS, ...overrides };
  for (const k of [
    "lookback",
    "horizonHours",
    "rrMin",
    "rrMax",
    "weakRRMax",
    "regimeSlopePct",
    "minStopATR",
    "feeBps",
    "slippageBps",
    "spreadBps",
    "fundingBpsPer8h",
    "minRatingSamples",
    "minRatingBlocks",
    "blockDays",
  ])
    invariant(finite(c[k]) && c[k] >= 0, "Invalid " + k);
  invariant(
    Number.isInteger(c.lookback) && c.lookback >= 240 && c.lookback <= 2000,
    "lookback must be 240..2000",
  );
  invariant(
    Number.isInteger(c.horizonHours) &&
      c.horizonHours >= 1 &&
      c.horizonHours <= 168,
    "horizonHours must be 1..168",
  );
  invariant(
    c.rrMin > 0 && c.rrMax >= c.rrMin && c.weakRRMax >= c.rrMin,
    "Invalid RR window",
  );
  invariant(
    c.maxTargetATR === null || (finite(c.maxTargetATR) && c.maxTargetATR > 0),
    "Invalid maxTargetATR",
  );
  for (const k of [
    "allowNeutral",
    "coinBias",
    "strictQuality",
    "actualSqueezeRelease",
    "rejectObstructed",
  ])
    invariant(typeof c[k] === "boolean", "Invalid " + k);
  invariant(["chart", "atr"].includes(c.exitMode), "Invalid exitMode");
  invariant(
    ["stop-first", "target-first"].includes(c.ambiguity),
    "Invalid ambiguity policy",
  );
  invariant(
    Array.isArray(c.directions) &&
      c.directions.length > 0 &&
      c.directions.every((x) => ["BUY", "SELL"].includes(x)),
    "Invalid directions",
  );
  invariant(
    c.feeBps <= 100 &&
      c.slippageBps <= 100 &&
      c.spreadBps <= 100 &&
      c.fundingBpsPer8h <= 100,
    "Cost assumption exceeds 100 bps",
  );
  invariant(
    Number.isInteger(c.blockDays) &&
      c.blockDays >= 1 &&
      c.minRatingSamples >= 10 &&
      c.minRatingBlocks >= 4,
    "Invalid calibration controls",
  );
  return Object.freeze({
    ...c,
    directions: Object.freeze([...new Set(c.directions)]),
  });
}
function policyHash(config) {
  return hash({ version: VERSION, engine: ENGINE_HASH, config });
}

// Canonical candle time is UTC OPEN time in seconds. Volume is quote currency.
function validateCandles(candles, interval = HOUR, { allowGaps = false } = {}) {
  invariant(
    Array.isArray(candles) && candles.length > 0,
    "Empty candle series",
  );
  let previous = null;
  for (const c of candles) {
    invariant(
      Number.isSafeInteger(c.time) && c.time >= 0 && c.time % interval === 0,
      "Unaligned candle timestamp",
    );
    invariant(
      ["open", "high", "low", "close"].every((k) => finite(c[k]) && c[k] > 0),
      "Invalid OHLC",
    );
    invariant(
      c.high >= Math.max(c.open, c.close, c.low) &&
        c.low <= Math.min(c.open, c.close, c.high),
      "Impossible OHLC",
    );
    invariant(finite(c.volume) && c.volume >= 0, "Invalid quote volume");
    if (previous !== null)
      invariant(
        c.time > previous && (allowGaps || c.time - previous === interval),
        "Duplicate, out-of-order, or missing candle",
      );
    previous = c.time;
  }
  return candles;
}
function aggregate4H(candles) {
  const buckets = new Map();
  for (const c of candles) {
    const key = Math.floor(c.time / (4 * HOUR)) * 4 * HOUR;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }
  const out = [];
  for (const [time, g] of buckets) {
    if (g.length !== 4 || !g.every((c, i) => c.time === time + i * HOUR))
      continue;
    out.push({
      time,
      open: g[0].open,
      high: Math.max(...g.map((c) => c.high)),
      low: Math.min(...g.map((c) => c.low)),
      close: g[3].close,
      volume: sum(g.map((c) => c.volume)),
    });
  }
  return out;
}
function ema(a, p) {
  invariant(a.length > 0, "Empty EMA");
  const k = 2 / (p + 1);
  return a.slice(1).reduce((e, x) => x * k + e * (1 - k), a[0]);
}
function rsiSimple(a, p = 14) {
  invariant(a.length > p, "Insufficient RSI history");
  let up = 0,
    down = 0;
  for (let i = a.length - p; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    up += Math.max(0, d);
    down += Math.max(0, -d);
  }
  if (up === 0 && down === 0) return 50;
  return down === 0 ? 100 : 100 - 100 / (1 + up / down);
}
function atr(c, p = 14) {
  invariant(c.length > p, "Insufficient ATR history");
  let total = 0;
  for (let i = c.length - p; i < c.length; i++)
    total += Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
  return total / p;
}
function bollinger(a, p = 20) {
  const v = a.slice(-p),
    m = mean(v),
    sd = Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
  const pctB = sd === 0 ? 0.5 : (a.at(-1) - (m - 2 * sd)) / (4 * sd);
  return {
    pctB,
    pct: round(pctB * 100, 2),
    pos: pctB > 0.7 ? "upper" : pctB < 0.3 ? "lower" : "mid",
  };
}
function priceStructure(candles) {
  const a = candles.slice(-30),
    highs = [],
    lows = [];
  for (let i = 1; i < a.length - 1; i++) {
    if (a[i].high > a[i - 1].high && a[i].high > a[i + 1].high)
      highs.push(a[i].high);
    if (a[i].low < a[i - 1].low && a[i].low < a[i + 1].low) lows.push(a[i].low);
  }
  if (highs.length < 2 || lows.length < 2)
    return { structure: "unclear", strength: "none" };
  const h = Math.sign(highs.at(-1) - highs.at(-2)),
    l = Math.sign(lows.at(-1) - lows.at(-2));
  if (h === 1 && l === 1) return { structure: "bull", strength: "confirmed" };
  if (h === -1 && l === -1) return { structure: "bear", strength: "confirmed" };
  // Conflicting extrema are neither partially bullish nor partially bearish.
  if (h * l < 0) return { structure: "unclear", strength: "mixed" };
  if (h > 0 || l > 0) return { structure: "bull", strength: "partial" };
  if (h < 0 || l < 0) return { structure: "bear", strength: "partial" };
  return { structure: "ranging", strength: "none" };
}
function squeezeState(candles, requireTransition = true) {
  const ratio = atr(candles, 5) / atr(candles, 20),
    previous = atr(candles.slice(0, -1), 5) / atr(candles.slice(0, -1), 20);
  return {
    ratio,
    previous,
    squeezed: ratio < 0.75,
    releasing: requireTransition
      ? previous < 0.75 && ratio >= 0.75
      : ratio >= 0.75 && ratio < 1.1,
    breakoutDir: candles.at(-1).close > candles.at(-3).open ? "bull" : "bear",
  };
}
function regimeOf(closes, price, threshold) {
  if (closes.length < 55)
    return { regime: "unknown", reason: "insufficient closed 4H candles" };
  const now = ema(closes, 50),
    before = ema(closes.slice(0, -3), 50),
    slopePct = ((now - before) / before) * 100;
  const regime =
    price > now && slopePct > threshold
      ? "bull"
      : price < now && slopePct < -threshold
        ? "bear"
        : "neutral";
  return {
    regime,
    ema50: now,
    slopePct,
    reason:
      regime === "neutral"
        ? "mixed or flat 4H trend"
        : "price and 4H EMA50 slope agree",
  };
}
function features(candles, cfg) {
  invariant(candles.length >= cfg.lookback, "Insufficient warm-up");
  const a = candles.slice(-cfg.lookback);
  validateCandles(a);
  const closes = a.map((c) => c.close),
    price = closes.at(-1),
    four = aggregate4H(a),
    c4 = four.map((c) => c.close),
    vol = atr(a);
  invariant(vol > 0, "Zero ATR");
  const slope = ema(closes, 20) - ema(closes.slice(0, -2), 20),
    older = ema(closes.slice(0, -6), 20) - ema(closes.slice(0, -8), 20);
  const spread = ema(closes.slice(-26), 12) - ema(closes.slice(-26), 26);
  const priorVolumes = a.slice(-21, -1).map((c) => c.volume),
    avgVolume = mean(priorVolumes);
  return {
    time: a.at(-1).time,
    decisionTime: a.at(-1).time + HOUR,
    price,
    rsi: Math.round(rsiSimple(closes)),
    // Preserve the original heuristic; do not mislabel it a standard MACD histogram.
    momentum: { value: spread, bull: spread > 0 },
    bb: bollinger(closes),
    atr: vol,
    trend1h: { trend: ema(closes, 9) > ema(closes, 21) ? "bull" : "bear" },
    trend4h: { trend: ema(c4, 20) > ema(c4, 50) ? "bull" : "bear" },
    regime: regimeOf(c4, price, cfg.regimeSlopePct),
    priceStruct: priceStructure(a),
    emaSlope: {
      direction: slope > 0 ? "up" : slope < 0 ? "down" : "flat",
      accelerating: Math.abs(slope) > Math.abs(older),
      slope,
    },
    squeeze: squeezeState(a, cfg.actualSqueezeRelease),
    volumeQuote: a.at(-1).volume,
    relativeVolume: avgVolume > 0 ? a.at(-1).volume / avgVolume : null,
    pct24h: (price / closes.at(-25) - 1) * 100,
  };
}
function chartLevels(candles, price, vol, dir, cfg) {
  const d = sign(dir),
    fallback = {
      sl: price - d * vol * 1.5,
      tp1: price + d * vol * 3,
      tp2: price + d * vol * 5,
      method: "atr",
    };
  const a = candles.slice(-100),
    highs = [],
    lows = [];
  for (let i = 3; i < a.length - 3; i++) {
    const neighbors = [...a.slice(i - 3, i), ...a.slice(i + 1, i + 4)];
    if (neighbors.every((c) => a[i].high > c.high))
      highs.push({ level: a[i].high, index: i });
    if (neighbors.every((c) => a[i].low < c.low))
      lows.push({ level: a[i].low, index: i });
  }
  function zones(points) {
    const z = [];
    for (const p of points.sort((a, b) => a.level - b.level)) {
      const last = z.at(-1);
      if (last && Math.abs(last.level - p.level) < vol * 0.5) {
        last.level = (last.level * last.touches + p.level) / (last.touches + 1);
        last.touches++;
        last.index = Math.max(last.index, p.index);
      } else z.push({ ...p, touches: 1 });
    }
    return z;
  }
  const support = zones(lows),
    resistance = zones(highs),
    stopZones = dir === "BUY" ? support : resistance,
    targetZones = dir === "BUY" ? resistance : support;
  const stop = stopZones
    .filter(
      (z) =>
        d * (price - z.level) > 0 && Math.abs(price - z.level) <= vol * 2.5,
    )
    .sort((a, b) => Math.abs(a.level - price) - Math.abs(b.level - price))[0];
  let levels = fallback;
  if (cfg.exitMode === "chart") {
    const sl = stop ? stop.level - d * vol * 0.25 : fallback.sl,
      risk = d * (price - sl);
    const candidates = targetZones
      .filter(
        (z) =>
          d * (z.level - price) > vol * 1.5 &&
          (d * (z.level - price)) / risk >= 1.5,
      )
      .sort((a, b) => d * (a.level - b.level));
    if (candidates.length) {
      const tp1 = candidates[0].level,
        next = candidates.find((z) => d * (z.level - tp1) > vol * 0.75);
      levels = {
        sl,
        tp1,
        tp2: next ? next.level : tp1 + d * Math.abs(tp1 - price),
        method: "chart",
      };
    }
  }
  const opposing = targetZones
    .filter(
      (z) =>
        z.touches >= 2 &&
        d * (z.level - price) > vol * 0.5 &&
        d * (levels.tp1 - z.level) > vol * 0.25,
    )
    .sort((a, b) => d * (a.level - b.level));
  const risk = d * (price - levels.sl),
    reward = d * (levels.tp1 - price);
  return {
    ...levels,
    rr: reward / risk,
    riskATR: risk / vol,
    targetATR: reward / vol,
    obstructed: opposing.length > 0,
    obstruction: opposing[0] || null,
  };
}
function scoreSetup(f, sym, cfg) {
  const dir = f.momentum.bull ? "BUY" : "SELL",
    buy = dir === "BUY",
    aligned = buy ? "bull" : "bear",
    slope = buy ? "up" : "down";
  const r = buy ? f.rsi : 100 - f.rsi,
    b = buy ? f.bb.pctB : 1 - f.bb.pctB,
    parts = { baseline: 5 };
  parts.rsi =
    r >= 60 && r <= 72
      ? 2.5
      : r >= 55 && r < 60
        ? 1.5
        : r > 72 && r <= 78
          ? 1
          : r >= 50 && r < 55
            ? 0.5
            : r > 78 || r < 45
              ? -1.5
              : -0.5;
  parts.bollinger =
    b >= 0.6 && b <= 0.85
      ? 1.5
      : b > 0.85
        ? 0.5
        : b >= 0.45 && b < 0.6
          ? 0.5
          : b < 0.3
            ? -1
            : 0;
  parts.trend4h = f.trend4h.trend === aligned ? 1.5 : -1;
  parts.trend1h = f.trend1h.trend === aligned ? 0.5 : -0.5;
  parts.structure =
    f.priceStruct.structure === aligned
      ? f.priceStruct.strength === "confirmed"
        ? 1.5
        : 0.5
      : ["bull", "bear"].includes(f.priceStruct.structure)
        ? f.priceStruct.strength === "confirmed"
          ? -2
          : -1
        : 0;
  parts.slope =
    f.emaSlope.direction === slope
      ? f.emaSlope.accelerating
        ? 1
        : 0.25
      : f.emaSlope.direction === "flat"
        ? 0
        : f.emaSlope.accelerating
          ? -1
          : -0.25;
  const releasing = f.squeeze.releasing && f.squeeze.breakoutDir === aligned;
  parts.squeeze = releasing
    ? 1.5
    : f.squeeze.squeezed
      ? 0.5
      : f.squeeze.releasing
        ? -1
        : 0;
  parts.coin = cfg.coinBias ? (LEGACY_BIASES[sym] || [0, 0])[buy ? 0 : 1] : 0;
  // No non-price or learned-score contribution. Snapshot those inputs separately.
  const rawScore = sum(Object.values(parts));
  return {
    dir,
    score: Math.max(0, Math.min(10, round(rawScore, 1))),
    rawScore,
    parts,
    releasing,
    structOk: f.priceStruct.structure === aligned,
    confirmed:
      f.priceStruct.structure === aligned &&
      f.priceStruct.strength === "confirmed",
  };
}
function evaluateSignal(candles, sym, cfg = strategyConfig()) {
  const f = features(candles, cfg),
    s = scoreSetup(f, sym, cfg),
    levels = chartLevels(candles, f.price, f.atr, s.dir, cfg),
    reasons = [];
  if (!cfg.directions.includes(s.dir)) reasons.push("direction disabled");
  if (f.regime.regime === "unknown") reasons.push("unknown regime");
  if (
    (f.regime.regime === "bull" && s.dir === "SELL") ||
    (f.regime.regime === "bear" && s.dir === "BUY")
  )
    reasons.push("opposes macro regime");
  if (f.regime.regime === "neutral" && !cfg.allowNeutral)
    reasons.push("neutral regime");
  if (f.emaSlope.direction !== (s.dir === "BUY" ? "up" : "down"))
    reasons.push("slope unconfirmed");
  if (levels.rr < cfg.rrMin || levels.rr > cfg.rrMax)
    reasons.push("RR outside window");
  if (cfg.maxTargetATR !== null && levels.targetATR > cfg.maxTargetATR)
    reasons.push("target too far in ATR");
  if (levels.riskATR < cfg.minStopATR) reasons.push("stop too tight in ATR");
  if (cfg.rejectObstructed && levels.obstructed)
    reasons.push("opposing zone before target");
  const strong = cfg.strictQuality
    ? s.score >= 7 && (s.confirmed || s.releasing)
    : (s.score >= 7 && (s.structOk || s.releasing)) || s.score >= 8;
  const solid = (s.score >= 6.5 && (s.structOk || s.releasing)) || s.score >= 7;
  let setupTier =
    strong && f.regime.regime !== "neutral"
      ? 3
      : solid && levels.rr <= cfg.weakRRMax
        ? 2
        : 1;
  if (!cfg.strictQuality && strong && f.regime.regime === "neutral")
    setupTier = 2;
  if (setupTier < 2) reasons.push("insufficient setup quality");
  if ([levels.sl, levels.tp1, levels.tp2].some((x) => !finite(x) || x <= 0))
    reasons.push("invalid exit level");
  return {
    sym,
    ...s,
    ...levels,
    setupTier,
    conf: 0,
    ratingStatus: "uncalibrated",
    eligible: reasons.length === 0,
    reasons,
    features: f,
    regime: f.regime.regime,
    decisionTime: f.decisionTime,
    policyHash: policyHash(cfg),
  };
}

// Fills and accounting. Full exit at TP1, initial stop, or the 24h boundary.
// TP2 is display context only; there are no hidden partial exits or breakeven moves.
function adverseFill(price, dir, cfg, entry) {
  return (
    price *
    (1 +
      (sign(dir) * (entry ? 1 : -1) * (cfg.slippageBps + cfg.spreadBps / 2)) /
        10000)
  );
}
function openTrade(signal, rawEntry, entryTime, cfg, extra = {}) {
  invariant(signal.eligible, "Cannot open a rejected signal");
  invariant(
    finite(rawEntry) && rawEntry > 0 && entryTime === signal.decisionTime,
    "Entry must be the next hourly open",
  );
  if (
    sign(signal.dir) * (rawEntry - signal.sl) <= 0 ||
    sign(signal.dir) * (signal.tp1 - rawEntry) <= 0
  )
    return {
      rejected: true,
      reason: "entry open already crossed planned stop/target",
    };
  const d = sign(signal.dir),
    entryPrice = adverseFill(rawEntry, signal.dir, cfg, true);
  // Mechanical ATR levels anchor to the modeled fill. Chart levels remain fixed.
  const exits =
    signal.method === "atr"
      ? {
          sl: entryPrice - d * 1.5 * signal.features.atr,
          tp1: entryPrice + d * 3 * signal.features.atr,
          tp2: entryPrice + d * 5 * signal.features.atr,
        }
      : signal;
  const risk = d * (entryPrice - exits.sl),
    reward = d * (exits.tp1 - entryPrice),
    rr = reward / risk;
  if (!(
    risk > 0 &&
    reward > 0 &&
    rr >= cfg.rrMin - 1e-10 &&
    rr <= cfg.rrMax + 1e-10
  ))
    return {
      rejected: true,
      reason: "entry gap/cost changed RR or crossed stop/target",
    };
  if (
    cfg.maxTargetATR !== null &&
    reward / signal.features.atr > cfg.maxTargetATR
  )
    return { rejected: true, reason: "entry target distance" };
  if (risk / signal.features.atr < cfg.minStopATR)
    return { rejected: true, reason: "entry stop distance" };
  const id = hash([signal.policyHash, signal.sym, signal.dir, entryTime]);
  return {
    ...extra,
    id,
    sym: signal.sym,
    dir: signal.dir,
    entryPrice,
    rawEntry,
    entryTime,
    decisionTime: signal.decisionTime,
    firedAt: extra.observedAt ?? entryTime * 1000,
    firedStr: new Date(extra.observedAt ?? entryTime * 1000).toISOString(),
    sl: exits.sl,
    tp1: exits.tp1,
    tp2: exits.tp2,
    rr,
    risk,
    score: signal.score,
    rawScore: signal.rawScore,
    setupTier: signal.setupTier,
    conf: signal.conf || 0,
    ratingStatus: signal.ratingStatus,
    regime: signal.regime,
    features: signal.features,
    levelMethod: signal.method,
    targetATR: signal.targetATR,
    policyHash: signal.policyHash,
    strategy: cfg,
    costs: {
      feeBps: cfg.feeBps,
      slippageBps: cfg.slippageBps,
      spreadBps: cfg.spreadBps,
      fundingBpsPer8h: cfg.fundingBpsPer8h,
    },
    deadline: entryTime + cfg.horizonHours * HOUR,
    entryModel: "next-hour-open-plus-costs PAPER",
    finalResult: "pending",
    check1H: null,
    check4H: null,
    check24H: null,
  };
}
function outcomeInBar(t, c, cfg) {
  const d = sign(t.dir),
    gapStop = d * (c.open - t.sl) <= 0,
    gapTarget = d * (c.open - t.tp1) >= 0;
  if (gapStop)
    return {
      reason: "stop",
      rawExit: c.open,
      gap: true,
      ambiguous: false,
      atOpen: true,
    };
  if (gapTarget)
    return {
      reason: "target",
      rawExit: t.tp1,
      gap: true,
      ambiguous: false,
      atOpen: true,
    };
  const stop = t.dir === "BUY" ? c.low <= t.sl : c.high >= t.sl,
    target = t.dir === "BUY" ? c.high >= t.tp1 : c.low <= t.tp1;
  if (stop && target)
    return {
      reason: cfg.ambiguity === "stop-first" ? "stop" : "target",
      rawExit: cfg.ambiguity === "stop-first" ? t.sl : t.tp1,
      gap: false,
      ambiguous: true,
      atOpen: false,
    };
  if (stop)
    return {
      reason: "stop",
      rawExit: t.sl,
      gap: false,
      ambiguous: false,
      atOpen: false,
    };
  if (target)
    return {
      reason: "target",
      rawExit: t.tp1,
      gap: false,
      ambiguous: false,
      atOpen: false,
    };
  return null;
}
function closeTrade(t, event, exitTime, cfg, fundingEvents = null) {
  const exitPrice =
      event.reason === "target"
        ? event.rawExit
        : adverseFill(event.rawExit, t.dir, cfg, false),
    d = sign(t.dir);
  const grossR = (d * (exitPrice - t.entryPrice)) / t.risk,
    fees = ((t.entryPrice + exitPrice) * cfg.feeBps) / 10000;
  let funding, costEvidence;
  if (fundingEvents !== null) {
    funding = 0;
    for (const e of fundingEvents) {
      invariant(
        finite(e.time) &&
          finite(e.rate) &&
          finite(e.markPrice) &&
          e.markPrice > 0,
        "Invalid funding settlement",
      );
      if (e.time > t.entryTime && e.time <= exitTime)
        funding += d * e.rate * e.markPrice;
    }
    costEvidence =
      "supplied settlements; intrabar exit timestamps are approximated";
  } else {
    funding =
      (((t.entryPrice * cfg.fundingBpsPer8h) / 10000) *
        Math.max(0, exitTime - t.entryTime)) /
      (8 * HOUR);
    costEvidence = "funding stress allowance, not historical funding";
  }
  const feeR = fees / t.risk,
    fundingR = funding / t.risk,
    netR = grossR - feeR - fundingR;
  return {
    ...t,
    exitPrice,
    rawExit: event.rawExit,
    exitTime,
    exitReason: event.reason,
    finalResult:
      event.reason === "target"
        ? "win"
        : event.reason === "stop"
          ? "loss"
          : "expired",
    resolvedAt: exitTime * 1000,
    grossR,
    feeR,
    fundingR,
    netR,
    ambiguous: event.ambiguous || false,
    gap: event.gap || false,
    costEvidence,
    exitTimePrecision: event.atOpen ? "bar-open" : "bar-end upper bound",
    hours: (exitTime - t.entryTime) / HOUR,
  };
}
function resolveTrade(
  t,
  candles,
  cfg,
  { interval = HOUR, until = Infinity, funding = null } = {},
) {
  if (t.finalResult !== "pending") return { ...t };
  const eligible = candles.filter(
    (c) =>
      c.time >= t.entryTime &&
      c.time < t.deadline &&
      c.time + interval <= until,
  );
  if (!eligible.length) return { ...t };
  validateCandles(eligible, interval);
  invariant(
    eligible[0].time === t.entryTime,
    "Missing entry-period outcome data",
  );
  let current = { ...t };
  for (const c of eligible) {
    const event = outcomeInBar(current, c, cfg),
      end = c.time + interval;
    if (event)
      return closeTrade(
        current,
        event,
        event.atOpen ? c.time : end,
        cfg,
        funding,
      );
    for (const h of [1, 4, 24]) {
      const key = "check" + h + "H";
      if (!current[key] && end === t.entryTime + h * HOUR)
        current[key] = {
          price: c.close,
          pnl: ((sign(t.dir) * (c.close - t.entryPrice)) / t.entryPrice) * 100,
          result: "pending",
          ts: end * 1000,
        };
    }
    if (end === t.deadline)
      return closeTrade(
        current,
        { reason: "time", rawExit: c.close, atOpen: false },
        end,
        cfg,
        funding,
      );
  }
  return current;
}
function tradeStats(trades) {
  const done = trades.filter((t) => finite(t.netR)),
    wins = done.filter((t) => t.netR > 0),
    losses = done.filter((t) => t.netR < 0),
    zeros = done.filter((t) => t.netR === 0);
  let equity = 0,
    peak = 0,
    dd = 0;
  for (const t of [...done].sort(
    (a, b) => a.exitTime - b.exitTime || a.id.localeCompare(b.id),
  )) {
    equity += t.netR;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  const profits = sum(wins.map((t) => t.netR)),
    negative = -sum(losses.map((t) => t.netR));
  return {
    total: trades.length,
    resolved: done.length,
    pending: trades.length - done.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: zeros.length,
    expired: done.filter((t) => t.exitReason === "time").length,
    targetHits: done.filter((t) => t.exitReason === "target").length,
    stopHits: done.filter((t) => t.exitReason === "stop").length,
    winRate: done.length ? round((wins.length / done.length) * 100, 2) : null,
    expectancy: mean(done.map((t) => t.netR)),
    grossExpectancy: mean(done.map((t) => t.grossR)),
    totalR: sum(done.map((t) => t.netR)),
    feeR: sum(done.map((t) => t.feeR)),
    fundingR: sum(done.map((t) => t.fundingR)),
    maxClosedTradeDrawdownR: dd,
    profitFactor: negative > 0 ? profits / negative : null,
    profitFactorStatus:
      negative === 0 ? "undefined: no negative trades" : "finite",
    ambiguous: done.filter((t) => t.ambiguous).length,
    avgRR: mean(done.map((t) => t.rr)),
    avgWinH: mean(wins.map((t) => t.hours)),
    avgLossH: mean(losses.map((t) => t.hours)),
  };
}
function breakdown(trades, key, values) {
  return Object.fromEntries(
    values.map((v) => [v, tradeStats(trades.filter((t) => t[key] === v))]),
  );
}
function reportTrades(trades) {
  return {
    overall: tradeStats(trades),
    byDir: breakdown(trades, "dir", ["BUY", "SELL"]),
    byStars: breakdown(trades, "conf", [0, 1, 2, 3]),
    bySetupTier: breakdown(trades, "setupTier", [1, 2, 3]),
    byRegime: breakdown(trades, "regime", ["bull", "bear", "neutral"]),
    byPair: breakdown(trades, "sym", PAIRS),
  };
}

// Reproducible lab: no network, no global pattern state, and no partial success.
function validateDataset(data, cfg) {
  invariant(
    data && data.schemaVersion === 1,
    "Dataset schemaVersion must be 1",
  );
  invariant(
    ["historical", "synthetic"].includes(data.kind),
    "Dataset kind must explicitly be historical or synthetic",
  );
  invariant(
    ["bybit-linear", "cryptocompare-cccagg", "synthetic"].includes(data.source),
    "Unrecognized candle source",
  );
  invariant(
    (data.kind === "synthetic") === (data.source === "synthetic"),
    "Synthetic provenance mismatch",
  );
  invariant(
    data.intervalSeconds === HOUR,
    "Dataset must contain hourly candles",
  );
  invariant(
    Number.isSafeInteger(data.testStart) &&
      Number.isSafeInteger(data.testEnd) &&
      data.testStart % HOUR === 0 &&
      data.testEnd % HOUR === 0 &&
      data.testEnd > data.testStart,
    "Invalid fixed test dates",
  );
  invariant(
    Array.isArray(data.symbols) &&
      data.symbols.length > 0 &&
      new Set(data.symbols).size === data.symbols.length &&
      data.symbols.every((s) => PAIRS.includes(s)),
    "Invalid symbols",
  );
  for (const sym of data.symbols) {
    const c = data.candles?.[sym];
    validateCandles(c);
    invariant(
      c[0].time <= data.testStart - cfg.lookback * HOUR,
      sym + ": missing warm-up",
    );
    invariant(
      c.at(-1).time + HOUR >= data.testEnd,
      sym + ": incomplete test coverage",
    );
    invariant(
      c.every((x) => x.time < data.testEnd),
      sym + ": candles beyond frozen test end",
    );
  }
  invariant(
    data.testEnd - data.testStart > cfg.horizonHours * HOUR,
    "Test window shorter than outcome horizon",
  );
  if (data.intrabars) {
    for (const sym of data.symbols) {
      const c = data.intrabars[sym];
      validateCandles(c, 60);
      invariant(
        c[0].time <= data.testStart && c.at(-1).time + 60 >= data.testEnd,
        sym + ": incomplete minute coverage",
      );
    }
  }
  if (data.funding) {
    for (const sym of data.symbols) {
      invariant(
        Array.isArray(data.funding[sym]),
        "Explicit settlement coverage required for every symbol",
      );
      invariant(
        data.fundingCoverage?.start <= data.testStart &&
          data.fundingCoverage?.end >= data.testEnd,
        "Missing funding coverage attestation",
      );
      let previousSettlement = -Infinity;
      for (const e of data.funding[sym]) {
        invariant(
          Number.isSafeInteger(e.time) &&
            e.time > previousSettlement &&
            e.time >= data.fundingCoverage.start &&
            e.time <= data.fundingCoverage.end &&
            finite(e.rate) &&
            finite(e.markPrice) &&
            e.markPrice > 0,
          "Invalid, duplicate or unordered settlement",
        );
        previousSettlement = e.time;
      }
    }
  }
  return data;
}
function backtest(data, overrides = {}, calibration = null) {
  const cfg = strategyConfig(overrides);
  validateDataset(data, cfg);
  const trades = [],
    alternates = [],
    decisions = [],
    blocked = {},
    coverage = {};
  const block = (reason) => {
    blocked[reason] = (blocked[reason] || 0) + 1;
  };
  for (const sym of data.symbols) {
    const c = data.candles[sym],
      outcomeBars = data.intrabars?.[sym] || c,
      interval = data.intrabars ? 60 : HOUR;
    let occupiedUntil = -Infinity,
      evaluated = 0;
    for (let i = cfg.lookback - 1; i < c.length - 1; i++) {
      const entryTime = c[i].time + HOUR;
      if (
        entryTime < data.testStart ||
        entryTime + cfg.horizonHours * HOUR > data.testEnd
      )
        continue;
      const sig = evaluateSignal(
        c.slice(i + 1 - cfg.lookback, i + 1),
        sym,
        cfg,
      );
      evaluated++;
      if (calibration)
        Object.assign(sig, ratingFor(sig, calibration, data.source));
      const record = {
        sym,
        time: entryTime,
        dir: sig.dir,
        setupTier: sig.setupTier,
        score: sig.score,
        eligible: sig.eligible,
        reasons: [...sig.reasons],
      };
      if (!sig.eligible) {
        for (const reason of sig.reasons) block(reason);
        decisions.push(record);
        continue;
      }
      if (entryTime < occupiedUntil) {
        block("position open");
        record.reasons.push("position open");
        record.eligible = false;
        decisions.push(record);
        continue;
      }
      const trade = openTrade(sig, c[i + 1].open, entryTime, cfg, {
        source: data.source,
        mode: "historical-paper",
      });
      if (trade.rejected) {
        block(trade.reason);
        record.eligible = false;
        record.reasons.push(trade.reason);
        decisions.push(record);
        continue;
      }
      const result = resolveTrade(trade, outcomeBars, cfg, {
        interval,
        until: data.testEnd,
        funding: data.funding?.[sym] ?? null,
      });
      invariant(
        finite(result.netR),
        sym + ": unresolved trade in complete historical window",
      );
      trades.push(result);
      occupiedUntil = result.exitTime;
      decisions.push(record);
      // Conditional exit comparison on identical accepted timestamps (not proof of full-policy superiority).
      const altSignal = { ...sig, method: "atr" };
      const alt = openTrade(altSignal, c[i + 1].open, entryTime, cfg, {
        source: data.source,
        mode: "matched-entry-atr",
      });
      if (!alt.rejected) {
        const result = resolveTrade(alt, outcomeBars, cfg, {
          interval,
          until: data.testEnd,
          funding: data.funding?.[sym] ?? null,
        });
        alternates.push(result);
      }
    }
    invariant(evaluated > 0, sym + ": no evaluable decision bars");
    coverage[sym] = {
      candles: c.length,
      evaluated,
      first: c[0].time,
      last: c.at(-1).time,
    };
  }
  trades.sort(
    (a, b) => a.entryTime - b.entryTime || a.sym.localeCompare(b.sym),
  );
  const pairedIDs = new Set(alternates.map((t) => t.id)),
    summary = reportTrades(trades),
    chart = tradeStats(trades.filter((t) => pairedIDs.has(t.id))),
    atrStats = tradeStats(alternates);
  return {
    schemaVersion: 1,
    version: VERSION,
    engineHash: ENGINE_HASH,
    policyHash: policyHash(cfg),
    config: cfg,
    dataHash: hash(data),
    kind: data.kind,
    source: data.source,
    testStart: data.testStart,
    testEnd: data.testEnd,
    symbols: data.symbols,
    complete: true,
    coverage,
    blocked,
    ...summary,
    trades,
    decisions,
    evidenceStatus:
      data.kind === "synthetic"
        ? "software verification only"
        : "historical research; not proof of future performance",
    costEvidence: data.funding
      ? "supplied funding settlements"
      : "configured funding stress allowance",
    exitComparison: {
      chartLevels: chart,
      atrLevels: atrStats,
      sameEntryCount: alternates.length,
      cohort:
        "accepted entries of this policy; selection is conditional on its exits",
      verdict:
        chart.expectancy === null || atrStats.expectancy === null
          ? "INSUFFICIENT DATA"
          : chart.expectancy > atrStats.expectancy
            ? "CHART HIGHER ON THIS COHORT"
            : chart.expectancy < atrStats.expectancy
              ? "ATR HIGHER ON THIS COHORT"
              : "EQUAL",
    },
  };
}
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function quantile(sorted, p) {
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
    : null;
}
function blockInterval(
  trades,
  { start, end, blockDays = 7, iterations = 1500, seed = 817 } = {},
) {
  const n = Math.ceil((end - start) / (blockDays * DAY)),
    blocks = Array.from({ length: n }, () => ({ r: 0, n: 0 }));
  for (const t of trades) {
    if (!finite(t.netR)) continue;
    const i = Math.floor((t.entryTime - start) / (blockDays * DAY));
    if (i >= 0 && i < n) {
      blocks[i].r += t.netR;
      blocks[i].n++;
    }
  }
  const nonempty = blocks.filter((b) => b.n > 0).length;
  if (n < 2 || nonempty < 2)
    return {
      low: null,
      high: null,
      blocks: n,
      nonemptyBlocks: nonempty,
      method: "calendar-block bootstrap",
    };
  const rand = seeded(seed),
    samples = [];
  for (let j = 0; j < iterations; j++) {
    let r = 0,
      k = 0;
    for (let i = 0; i < n; i++) {
      const b = blocks[Math.floor(rand() * n)];
      r += b.r;
      k += b.n;
    }
    if (k) samples.push(r / k);
  }
  samples.sort((a, b) => a - b);
  return {
    low: quantile(samples, 0.025),
    high: quantile(samples, 0.975),
    blocks: n,
    nonemptyBlocks: nonempty,
    method: "95% calendar-block bootstrap; all pairs grouped together",
    seed,
    iterations,
  };
}
function deltaInterval(base, candidate, options = {}) {
  invariant(
    base.testStart === candidate.testStart &&
      base.testEnd === candidate.testEnd &&
      base.dataHash === candidate.dataHash,
    "Comparisons require the identical frozen dataset",
  );
  const days = options.blockDays || 7,
    n = Math.ceil((base.testEnd - base.testStart) / (days * DAY)),
    b = Array.from({ length: n }, () => [0, 0, 0, 0]);
  for (const [report, rcol, ncol] of [
    [base, 0, 1],
    [candidate, 2, 3],
  ])
    for (const t of report.trades) {
      const i = Math.floor((t.entryTime - base.testStart) / (days * DAY));
      b[i][rcol] += t.netR;
      b[i][ncol]++;
    }
  if (n < 2) return { low: null, high: null, blocks: n };
  const random = seeded(817),
    samples = [];
  for (let j = 0; j < 1500; j++) {
    const v = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const row = b[Math.floor(random() * n)];
      for (let k = 0; k < 4; k++) v[k] += row[k];
    }
    if (v[1] && v[3]) samples.push(v[2] / v[3] - v[0] / v[1]);
  }
  samples.sort((a, b) => a - b);
  return {
    low: quantile(samples, 0.025),
    high: quantile(samples, 0.975),
    blocks: n,
    method: "paired calendar-block bootstrap delta in mean net R",
  };
}
function comparePolicies(base, candidate) {
  const ci = deltaInterval(base, candidate, {
      blockDays: candidate.config.blockDays,
    }),
    a = base.overall.expectancy,
    b = candidate.overall.expectancy;
  const missingPairs = candidate.symbols.filter(
    (sym) => !candidate.coverage[sym],
  );
  return {
    baseline: a,
    candidate: b,
    delta: a === null || b === null ? null : b - a,
    deltaCI: ci,
    decision:
      a === null || b === null
        ? "insufficient trades"
        : b < a
          ? "ROLL BACK STRATEGY CHANGE"
          : ci.low !== null &&
              ci.low > 0 &&
              ci.blocks >= candidate.config.minRatingBlocks &&
              missingPairs.length === 0
            ? "higher on this window; require untouched confirmation"
            : "inconclusive; do not promote",
    baselineTrades: base.trades.length,
    candidateTrades: candidate.trades.length,
  };
}
function experimentSuite(data, overrides = {}) {
  const candidateCfg = strategyConfig(overrides),
    controlCfg = strategyConfig({
      ...candidateCfg,
      ...CORRECTED_CONTROL,
    });
  const control = backtest(data, controlCfg);
  const variants = [
    ["no-coin-bias", { coinBias: false }],
    ["strict-quality", { strictQuality: true }],
    ["real-squeeze-release", { actualSqueezeRelease: true }],
    ["no-neutral", { allowNeutral: false }],
    ["target-max-3-ATR", { maxTargetATR: 3 }],
    ["target-max-4-ATR", { maxTargetATR: 4 }],
    ["reject-obstruction", { rejectObstructed: true }],
    ["ATR-exits", { exitMode: "atr" }],
  ];
  const experiments = variants.map(([name, patch]) => {
    const r = backtest(data, { ...controlCfg, ...patch });
    return {
      name,
      patch,
      policyHash: r.policyHash,
      ...reportTrades(r.trades),
      comparison: comparePolicies(control, r),
    };
  });
  const candidate = backtest(data, candidateCfg),
    optimistic = backtest(data, { ...candidateCfg, ambiguity: "target-first" });
  return {
    schemaVersion: 1,
    dataHash: control.dataHash,
    engineHash: ENGINE_HASH,
    kind: data.kind,
    controlLabel:
      "corrected price-only v5 control; NOT a reproduction of the broken original or live non-price layer",
    control,
    candidate,
    experiments,
    combinedComparison: comparePolicies(control, candidate),
    ambiguitySensitivity: {
      conservative: candidate.overall,
      optimistic: optimistic.overall,
      note: "Each policy is replayed completely; subsequent entries can change.",
    },
    unavailableExperiments: [
      "historical non-price score changes without point-in-time snapshots",
      "historical win-rate learner without point-in-time state",
    ],
    promotion: "NONE: this command never changes the live configuration",
  };
}
function makeCalibration(training, validation) {
  invariant(
    training.kind === "historical" && validation.kind === "historical",
    "Synthetic data cannot calibrate quality stars",
  );
  invariant(
    training.complete &&
      validation.complete &&
      training.engineHash === ENGINE_HASH &&
      validation.engineHash === ENGINE_HASH,
    "Incompatible or incomplete reports",
  );
  invariant(
    training.policyHash === validation.policyHash &&
      training.source === validation.source &&
      stable(training.symbols) === stable(validation.symbols),
    "Calibration policy/source/universe mismatch",
  );
  invariant(
    training.testEnd + validation.config.horizonHours * HOUR <=
      validation.testStart,
    "Need disjoint chronological validation with a full-horizon gap",
  );
  const groups = {},
    cfg = validation.config;
  for (const dir of ["BUY", "SELL"])
    for (const regime of ["bull", "bear", "neutral"]) {
      const key = dir + ":" + regime,
        cohort = validation.trades.filter(
          (t) => t.dir === dir && t.regime === regime,
        ),
        two = cohort.filter((t) => t.setupTier === 2),
        three = cohort.filter((t) => t.setupTier === 3);
      const s2 = tradeStats(two),
        s3 = tradeStats(three),
        args = {
          start: validation.testStart,
          end: validation.testEnd,
          blockDays: cfg.blockDays,
        },
        ci2 = blockInterval(two, args),
        ci3 = blockInterval(three, args);
      const trainingTwo = tradeStats(
          training.trades.filter(
            (t) => t.dir === dir && t.regime === regime && t.setupTier === 2,
          ),
        ),
        trainingThree = tradeStats(
          training.trades.filter(
            (t) => t.dir === dir && t.regime === regime && t.setupTier === 3,
          ),
        );
      const supported =
        two.length >= cfg.minRatingSamples &&
        three.length >= cfg.minRatingSamples &&
        ci2.nonemptyBlocks >= cfg.minRatingBlocks &&
        ci3.nonemptyBlocks >= cfg.minRatingBlocks &&
        ci2.low > 0 &&
        ci3.low > ci2.high &&
        trainingTwo.expectancy > 0 &&
        trainingThree.expectancy > trainingTwo.expectancy;
      groups[key] = {
        supported,
        stars: supported ? { 2: 2, 3: 3 } : {},
        tier2: { ...s2, ci: ci2 },
        tier3: { ...s3, ci: ci3 },
      };
    }
  return {
    schemaVersion: 1,
    engineHash: ENGINE_HASH,
    policyHash: validation.policyHash,
    source: validation.source,
    symbols: validation.symbols,
    knownThrough: validation.testEnd,
    trainingDataHash: training.dataHash,
    validationDataHash: validation.dataHash,
    groups,
    status: Object.values(groups).some((g) => g.supported)
      ? "evidence-supported cohorts"
      : "insufficient evidence",
    caveat:
      "Requires genuinely untouched validation chosen before seeing its results. This software cannot verify that human research history.",
  };
}
function ratingFor(signal, calibration, source) {
  const unrated = { conf: 0, ratingStatus: "uncalibrated" };
  if (
    !calibration ||
    calibration.schemaVersion !== 1 ||
    calibration.engineHash !== ENGINE_HASH ||
    calibration.policyHash !== signal.policyHash ||
    calibration.source !== source ||
    !calibration.symbols?.includes(signal.sym) ||
    !(signal.decisionTime > calibration.knownThrough)
  )
    return unrated;
  const g = calibration.groups?.[signal.dir + ":" + signal.regime];
  if (!g?.supported) return unrated;
  const conf = g.stars?.[signal.setupTier];
  return conf === 2 || conf === 3
    ? {
        conf,
        ratingStatus: "historically calibrated; paper",
        calibrationKnownThrough: calibration.knownThrough,
      }
    : unrated;
}

// Durable SQLite journal/outbox. Supabase is the permanent mirror across deployments.
// All writes precede notifications. A failed remote write remains in the outbox.
class Store {
  constructor(filename, { clock = Date.now } = {}) {
    if (filename !== ":memory:")
      fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.clock = clock;
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS records_kind ON records(kind); CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, version INTEGER NOT NULL);",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS candle_lookup ON records(json_extract(payload,'$.source'),json_extract(payload,'$.sym'),json_extract(payload,'$.interval'),json_extract(payload,'$.time')) WHERE kind='candle'",
    );
  }
  get(id) {
    const r = this.db.prepare("SELECT payload FROM records WHERE id=?").get(id);
    return r ? JSON.parse(r.payload) : null;
  }
  list(kind) {
    return this.db
      .prepare("SELECT payload FROM records WHERE kind=? ORDER BY id")
      .all(kind)
      .map((r) => JSON.parse(r.payload));
  }
  row(id) {
    return this.db.prepare("SELECT * FROM records WHERE id=?").get(id);
  }
  put(id, kind, payload) {
    return this.putMany([{ id, kind, payload }]);
  }
  putMany(items) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of items) {
        const text = stable(item.payload),
          previous = this.row(item.id);
        if (previous?.payload === text) continue;
        const version = Math.max(this.clock(), (previous?.updated_at || 0) + 1);
        this.db
          .prepare(
            "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,updated_at=excluded.updated_at",
          )
          .run(item.id, item.kind, text, version);
        this.db
          .prepare(
            "INSERT INTO outbox(id,version) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version",
          )
          .run(item.id, version);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  pending(limit = 200) {
    return this.db
      .prepare(
        "SELECT r.* FROM outbox o JOIN records r ON r.id=o.id ORDER BY r.updated_at,r.id LIMIT ?",
      )
      .all(limit)
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  acknowledge(rows) {
    const q = this.db.prepare("DELETE FROM outbox WHERE id=? AND version=?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of rows) q.run(r.id, r.updated_at);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  dirty(id) {
    return !!this.db.prepare("SELECT id FROM outbox WHERE id=?").get(id);
  }
  pendingCount() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n;
  }
  mergeRemote(rows) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of rows) {
        invariant(
          typeof r.id === "string" &&
            typeof r.kind === "string" &&
            finite(Number(r.updated_at)) &&
            r.payload &&
            typeof r.payload === "object",
          "Invalid recovered record",
        );
        const local = this.row(r.id),
          localPayload = local ? JSON.parse(local.payload) : null;
        const terminalRemote =
          (r.kind === "signal" &&
            r.payload.finalResult !== "pending" &&
            localPayload?.finalResult === "pending") ||
          (r.kind === "notification" &&
            ["sent", "unknown", "skipped"].includes(r.payload.status) &&
            ["queued", "sending"].includes(localPayload?.status));
        const newerRemote = local && Number(r.updated_at) > local.updated_at;
        if (terminalRemote || newerRemote)
          this.db.prepare("DELETE FROM outbox WHERE id=?").run(r.id);
        else if (this.dirty(r.id)) continue;
        if (terminalRemote || !local || Number(r.updated_at) > local.updated_at)
          this.db
            .prepare(
              "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,updated_at=excluded.updated_at",
            )
            .run(r.id, r.kind, stable(r.payload), Number(r.updated_at));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  archive(source, sym, candles, interval = HOUR) {
    this.putMany(
      candles.map((c) => ({
        id: "c:" + source + ":" + sym + ":" + interval + ":" + c.time,
        kind: "candle",
        payload: { source, sym, interval, ...c },
      })),
    );
  }
  candles(source, sym, start, end, interval = HOUR) {
    return this.db
      .prepare(
        "SELECT payload FROM records WHERE kind='candle' AND json_extract(payload,'$.source')=? AND json_extract(payload,'$.sym')=? AND json_extract(payload,'$.interval')=? AND json_extract(payload,'$.time')>=? AND json_extract(payload,'$.time')<? ORDER BY json_extract(payload,'$.time')",
      )
      .all(source, sym, interval, start, end)
      .map((r) => {
        const { source, sym, interval, ...c } = JSON.parse(r.payload);
        return c;
      });
  }
  close() {
    this.db.close();
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function requestJSON(
  url,
  {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 10000,
    retries = 2,
    fetchImpl = fetch,
    wait = sleep,
  } = {},
) {
  const safeURL = new URL(url);
  invariant(["https:", "http:"].includes(safeURL.protocol), "Invalid HTTP URL");
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (!response.ok) {
        const e = new Error(
          safeURL.hostname + safeURL.pathname + " HTTP " + response.status,
        );
        e.retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
        e.status = response.status;
        const ra = Number(response.headers?.get("retry-after"));
        e.retryMs = finite(ra) && ra > 0 ? Math.min(ra * 1000, 10000) : null;
        throw e;
      }
      return await response.json();
    } catch (e) {
      last = e;
      if (attempt === retries || e.retryable === false) break;
      await wait(e.retryMs || Math.min(250 * 2 ** attempt, 2000));
    }
  }
  // Do not expose URLs containing tokens, authorization headers, or response bodies.
  const safePath =
    safeURL.hostname === "api.telegram.org"
      ? "/bot[redacted]/sendMessage"
      : safeURL.pathname;
  const error = new Error(
    safeURL.hostname +
      safePath +
      ": " +
      (last?.status
        ? "HTTP " + last.status
        : last?.name === "TimeoutError"
          ? "request timeout"
          : "request failed"),
  );
  error.status = last?.status;
  throw error;
}
class RemoteStore {
  constructor(url, key, { fetchImpl = fetch } = {}) {
    this.url = url.replace(/\/$/, "");
    this.key = key;
    this.fetchImpl = fetchImpl;
    this.ok = false;
    this.lastError = null;
    this.lastSync = null;
    this.recovered = false;
    this.inFlight = null;
  }
  headers() {
    return {
      apikey: this.key,
      ...(this.key.startsWith("eyJ")
        ? { Authorization: "Bearer " + this.key }
        : {}),
    };
  }
  async call(route, options = {}) {
    try {
      const result = await requestJSON(this.url + "/rest/v1/" + route, {
        ...options,
        headers: { ...this.headers(), ...options.headers },
        fetchImpl: this.fetchImpl,
      });
      this.ok = true;
      this.lastError = null;
      return result;
    } catch (e) {
      this.ok = false;
      this.lastError = e.message;
      throw e;
    }
  }
  async recover(store) {
    let after = null,
      count = 0;
    while (true) {
      const query = new URLSearchParams({
        select: "id,kind,payload,updated_at",
        kind: "neq.candle",
        order: "id.asc",
        limit: "1000",
      });
      if (after) query.set("id", "gt." + after);
      const rows = await this.call("bot_v6_records?" + query);
      invariant(Array.isArray(rows), "Invalid Supabase response");
      if (!rows.length) break;
      invariant(rows.at(-1).id !== after, "Recovery cursor did not advance");
      store.mergeRemote(rows);
      count += rows.length;
      after = rows.at(-1).id;
    }
    this.recovered = true;
    return count;
  }
  async flush(store) {
    invariant(this.holder, "Acquire recorder lease before writeback");
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      let batches = 0;
      while (batches++ < 20) {
        const rows = store.pending(200);
        if (!rows.length) break;
        const accepted = await this.call("rpc/bot_v6_write_records", {
          method: "POST",
          body: { p_holder: this.holder, p_rows: rows },
        });
        invariant(
          Array.isArray(accepted) && accepted.length === rows.length,
          "Incomplete Supabase acknowledgement",
        );
        store.acknowledge(rows);
      }
      this.lastSync = Date.now();
      return store.pendingCount();
    })();
    try {
      return await this.inFlight;
    } catch (e) {
      // Reconcile remote terminal/newer revisions before retrying a rejected batch.
      this.recovered = false;
      throw e;
    } finally {
      this.inFlight = null;
    }
  }
  async lease(holder) {
    const granted = await this.call("rpc/bot_v6_acquire_lease", {
      method: "POST",
      body: { p_holder: holder, p_ttl_seconds: 180 },
    });
    this.holder = granted === true ? holder : null;
    return granted;
  }
  async restoreCandles(store, source, sym, start, end, interval = HOUR) {
    let after = null,
      total = 0;
    while (true) {
      const query = new URLSearchParams({
        select: "id,kind,payload,updated_at",
        kind: "eq.candle",
        "payload->>source": "eq." + source,
        "payload->>sym": "eq." + sym,
        "payload->interval": "eq." + interval,
        and: "(payload->time.gte." + start + ",payload->time.lt." + end + ")",
        order: "id.asc",
        limit: "1000",
      });
      if (after) query.set("id", "gt." + after);
      const rows = await this.call("bot_v6_records?" + query);
      invariant(Array.isArray(rows), "Invalid archive response");
      if (!rows.length) break;
      store.mergeRemote(rows);
      total += rows.length;
      invariant(rows.at(-1).id !== after, "Archive cursor did not advance");
      after = rows.at(-1).id;
    }
    return total;
  }
}
function parseBybit(rows) {
  return rows
    .map((x) => ({
      time: Number(x[0]) / 1000,
      open: Number(x[1]),
      high: Number(x[2]),
      low: Number(x[3]),
      close: Number(x[4]),
      volume: Number(x[6]),
    }))
    .sort((a, b) => a.time - b.time);
}
function parseCC(rows) {
  return rows
    .map((x) => ({
      time: Number(x.time),
      open: Number(x.open),
      high: Number(x.high),
      low: Number(x.low),
      close: Number(x.close),
      volume: Number(x.volumeto),
    }))
    .sort((a, b) => a.time - b.time);
}
class MarketData {
  constructor({
    source = "cryptocompare-cccagg",
    ccKey = "",
    fetchImpl = fetch,
    clock = Date.now,
    bybitBase = "https://api.bybit.com",
  } = {}) {
    invariant(
      ["cryptocompare-cccagg", "bybit-linear"].includes(source),
      "Unsupported market source",
    );
    this.source = source;
    this.ccKey = ccKey;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.bybitBase = bybitBase.replace(/\/$/, "");
    this.current = new Map();
    this.contextCache = new Map();
  }
  async bybit(route, params) {
    const j = await requestJSON(
      this.bybitBase +
        "/v5/market/" +
        route +
        "?" +
        new URLSearchParams(params),
      { fetchImpl: this.fetchImpl },
    );
    invariant(
      j.retCode === 0,
      "Bybit " + route + " rejected request (" + j.retCode + ")",
    );
    return j;
  }
  async candlePage(sym, interval, limit, end) {
    invariant(PAIRS.includes(sym), "Unknown symbol");
    if (this.source === "bybit-linear") {
      const j = await this.bybit("kline", {
        category: "linear",
        symbol: sym + "USDT",
        interval: String(interval / 60),
        limit: String(Math.min(limit, 1000)),
        ...(end === undefined ? {} : { end: String(end * 1000) }),
      });
      return parseBybit(j.result.list);
    }
    invariant(this.ccKey, "CC_API_KEY is required for CryptoCompare");
    const endpoint = interval === HOUR ? "histohour" : "histominute";
    const query = new URLSearchParams({
      fsym: sym,
      tsym: "USD",
      e: "CCCAGG",
      limit: String(Math.min(limit, 2000)),
      ...(end === undefined ? {} : { toTs: String(end) }),
    });
    const j = await requestJSON(
      "https://min-api.cryptocompare.com/data/v2/" + endpoint + "?" + query,
      {
        headers: { authorization: "Apikey " + this.ccKey },
        fetchImpl: this.fetchImpl,
      },
    );
    invariant(
      j.Response === "Success" && Array.isArray(j.Data?.Data),
      "CryptoCompare returned invalid candles",
    );
    return parseCC(j.Data.Data);
  }
  async latest(sym, lookback) {
    const now = Math.floor(this.clock() / 1000),
      boundary = Math.floor(now / HOUR) * HOUR,
      cached = this.current.get(sym);
    if (cached?.boundary === boundary) return cached.value;
    const all = await this.candlePage(sym, HOUR, lookback + 5),
      closed = all.filter((c) => c.time + HOUR <= now).slice(-lookback);
    validateCandles(closed);
    invariant(
      closed.length === lookback && closed.at(-1).time + HOUR === boundary,
      sym + ": stale or insufficient candles",
    );
    const forming = all.find((c) => c.time === boundary);
    invariant(
      forming && finite(forming.open) && forming.open > 0,
      sym + ": next open unavailable",
    );
    const value = {
      closed,
      nextOpen: forming.open,
      boundary,
      observedAt: now,
      source: this.source,
    };
    this.current.set(sym, { boundary, value });
    return value;
  }
  async history(sym, start, end, interval = HOUR) {
    invariant(
      start < end && start % interval === 0 && end % interval === 0,
      "Invalid historical bounds",
    );
    const byTime = new Map();
    let cursor = end - 1;
    for (let pages = 0; cursor >= start && pages < 2000; pages++) {
      const limit = Math.min(
          this.source === "bybit-linear" ? 1000 : 2000,
          Math.ceil((cursor - start + 1) / interval) + 1,
        ),
        page = await this.candlePage(sym, interval, limit, cursor);
      invariant(page.length > 0, sym + ": empty history page");
      const first = page[0].time;
      invariant(first <= cursor, sym + ": history did not advance");
      for (const c of page)
        if (c.time >= start && c.time < end) byTime.set(c.time, c);
      cursor = first - 1;
    }
    const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
    validateCandles(candles, interval);
    invariant(
      candles[0].time === start && candles.at(-1).time + interval === end,
      sym + ": missing requested history",
    );
    return candles;
  }
  async context(sym) {
    const now = Math.floor(this.clock() / 1000),
      key = sym + ":" + Math.floor(now / HOUR);
    if (this.contextCache.has(key)) return this.contextCache.get(key);
    const params = { category: "linear", symbol: sym + "USDT" };
    const tasks = [
      ["ticker", () => this.bybit("tickers", params)],
      [
        "openInterest",
        () =>
          this.bybit("open-interest", {
            ...params,
            intervalTime: "1h",
            limit: "2",
          }),
      ],
      [
        "longShort",
        () =>
          this.bybit("account-ratio", { ...params, period: "1h", limit: "1" }),
      ],
      ["book", () => this.bybit("orderbook", { ...params, limit: "50" })],
      [
        "trades",
        () => this.bybit("recent-trade", { ...params, limit: "1000" }),
      ],
    ];
    const settled = await Promise.allSettled(tasks.map(([, fn]) => fn())),
      out = { sym, observedAt: now, scoringContribution: 0, errors: {} };
    for (let i = 0; i < tasks.length; i++) {
      const name = tasks[i][0],
        r = settled[i];
      if (r.status === "rejected") {
        out.errors[name] = r.reason.message;
        continue;
      }
      const j = r.value;
      out[name] = { exchangeTime: Number(j.time) / 1000, data: j.result };
    }
    const t = out.ticker?.data?.list?.[0];
    out.fundingRate = t ? Number(t.fundingRate) : null;
    out.fundingPct = finite(out.fundingRate) ? out.fundingRate * 100 : null;
    const prints = out.trades?.data?.list || [],
      buy = prints
        .filter((x) => x.side === "Buy")
        .reduce((a, x) => a + Number(x.size) * Number(x.price), 0),
      sell = prints
        .filter((x) => x.side === "Sell")
        .reduce((a, x) => a + Number(x.size) * Number(x.price), 0);
    out.takerFlow = {
      buyQuote: buy,
      sellQuote: sell,
      buyShare: buy + sell > 0 ? buy / (buy + sell) : null,
      tradeCount: prints.length,
      oldestTime: prints.length
        ? Math.min(...prints.map((x) => Number(x.time) / 1000))
        : null,
      note: "actual recent trade taker side; variable coverage, context only",
    };
    // Bound this in-memory convenience cache; snapshots themselves remain durable.
    if (this.contextCache.size > PAIRS.length * 3) this.contextCache.clear();
    this.contextCache.set(key, out);
    return out;
  }
}
async function mapLimit(values, limit, fn) {
  const results = new Array(values.length);
  let next = 0;
  async function run() {
    while (next < values.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(values[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, run),
  );
  return results;
}
async function downloadDataset(
  market,
  { start, end, symbols = PAIRS, lookback = 320, minutes = false },
) {
  invariant(
    Number.isSafeInteger(start) && Number.isSafeInteger(end),
    "Fixed start and end timestamps required",
  );
  const result = await mapLimit(symbols, 2, async (sym) => ({
    sym,
    hourly: await market.history(sym, start - lookback * HOUR, end),
    minute: minutes ? await market.history(sym, start, end, 60) : null,
  }));
  const failures = result
    .map((r, i) =>
      r.status === "rejected" ? symbols[i] + ": " + r.reason.message : null,
    )
    .filter(Boolean);
  invariant(!failures.length, "Dataset incomplete: " + failures.join("; "));
  const data = {
    schemaVersion: 1,
    kind: "historical",
    source: market.source,
    intervalSeconds: HOUR,
    testStart: start,
    testEnd: end,
    symbols: [...symbols],
    capturedAt: new Date().toISOString(),
    candles: {},
  };
  if (minutes) data.intrabars = {};
  for (const r of result) {
    data.candles[r.value.sym] = r.value.hourly;
    if (minutes) data.intrabars[r.value.sym] = r.value.minute;
  }
  validateDataset(data, strategyConfig({ lookback }));
  return data;
}

function boolEnv(env, key, fallback) {
  if (env[key] === undefined || env[key] === "") return fallback;
  invariant(
    ["true", "false"].includes(env[key]),
    key + " must be true or false",
  );
  return env[key] === "true";
}
function numberEnv(env, key, fallback, min, max) {
  const v = env[key] === undefined ? fallback : Number(env[key]);
  invariant(finite(v) && v >= min && v <= max, key + " out of range");
  return v;
}
function readJSON(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}
function writeJSON(filename, value) {
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const temp = filename + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(temp, filename);
}
function runtimeConfig(env = process.env) {
  const cfg = {
    port: numberEnv(env, "PORT", 3000, 0, 65535),
    host: env.HOST || "0.0.0.0",
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, "data")),
    source: env.MARKET_SOURCE || "cryptocompare-cccagg",
    ccKey: env.CC_API_KEY || "",
    supabaseURL: env.SUPABASE_URL || "",
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY || "",
    scanEnabled: boolEnv(env, "SCAN_ENABLED", true),
    scanMs: numberEnv(env, "SCAN_INTERVAL_MS", 30000, 1000, 300000),
    maxEntryLag: numberEnv(env, "MAX_ENTRY_LAG_SECONDS", 120, 0, 300),
    requireRemote: boolEnv(env, "REQUIRE_REMOTE_STORAGE", true),
    recordContext: boolEnv(env, "RECORD_MARKET_CONTEXT", true),
    tgEnabled: boolEnv(env, "TG_ENABLED", false),
    tgToken: env.TG_TOKEN || "",
    tgChat: env.TG_CHAT_ID || "",
    tgUnrated: boolEnv(env, "TG_PAPER_UNRATED", false),
    tgSell: boolEnv(env, "TG_PAPER_SELL", false),
    adminToken: env.ADMIN_TOKEN || "",
    readToken: env.READ_TOKEN || "",
    allowedOrigin: env.ALLOWED_ORIGIN || "",
    datasetFile: env.BACKTEST_DATASET
      ? path.resolve(env.BACKTEST_DATASET)
      : null,
    calibrationFile: env.CALIBRATION_FILE
      ? path.resolve(env.CALIBRATION_FILE)
      : null,
    publicDir: path.resolve(env.PUBLIC_DIR || path.join(__dirname, "public")),
    strategy: strategyConfig(
      env.STRATEGY_FILE ? readJSON(env.STRATEGY_FILE) : CORRECTED_CONTROL,
    ),
  };
  invariant(
    ["cryptocompare-cccagg", "bybit-linear"].includes(cfg.source),
    "Invalid MARKET_SOURCE",
  );
  invariant(
    !!cfg.supabaseURL === !!cfg.supabaseKey,
    "Set Supabase URL and server-side key together",
  );
  if (cfg.supabaseURL)
    invariant(
      new URL(cfg.supabaseURL).protocol === "https:",
      "Supabase URL must use HTTPS",
    );
  if (cfg.tgEnabled)
    invariant(
      cfg.tgToken && cfg.tgChat,
      "TG_ENABLED requires TG_TOKEN and TG_CHAT_ID",
    );
  return cfg;
}
function escapeHTML(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function telegramEntry(t) {
  return (
    "<b>PAPER " +
    t.dir +
    " " +
    t.sym +
    "</b>\n" +
    (t.conf
      ? "★".repeat(t.conf) + " Historically calibrated cohort"
      : "Unrated research signal") +
    "\nEntry model: next hourly open + configured costs\nEntry: " +
    t.entryPrice +
    "\nStop: " +
    t.sl +
    "\nTP1 (full exit): " +
    t.tp1 +
    "\nRR: " +
    round(t.rr, 2) +
    "\nTime exit: " +
    new Date(t.deadline * 1000).toISOString() +
    "\nObserved " +
    t.alertDelaySeconds +
    "s after boundary. Actual fills can differ.\nNo leverage recommendation."
  );
}
class Bot {
  constructor(
    cfg,
    {
      store,
      market,
      remote,
      clock = Date.now,
      fetchImpl = fetch,
      logger = console,
    } = {},
  ) {
    this.cfg = cfg;
    this.clock = clock;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.store =
      store || new Store(path.join(cfg.dataDir, "bot.sqlite"), { clock });
    this.market =
      market ||
      new MarketData({
        source: cfg.source,
        ccKey: cfg.ccKey,
        clock,
        fetchImpl,
      });
    this.remote =
      remote === undefined
        ? cfg.supabaseURL
          ? new RemoteStore(cfg.supabaseURL, cfg.supabaseKey, { fetchImpl })
          : null
        : remote;
    this.holder = crypto.randomUUID();
    this.calibration = cfg.calibrationFile
      ? readJSON(cfg.calibrationFile)
      : null;
    this.scanPromise = null;
    this.timer = null;
    this.stopped = false;
    this.lastScan = null;
    this.lastError = null;
    this.pairs = [];
    this.ready = false;
    this.backtestJob = { status: "idle" };
    this.worker = null;
    this.ownsLease = false;
    this.leaseCheckedAt = null;
  }
  async initialize() {
    if (this.remote) {
      try {
        await this.remote.recover(this.store);
      } catch (e) {
        this.lastError = e.message;
        this.logger.error("Persistence recovery: " + e.message);
      }
    }
    // A crash after sending but before acknowledgement is indeterminate; never blindly resend.
    for (const n of this.store.list("notification"))
      if (n.status === "sending")
        this.store.put(n.id, "notification", {
          ...n,
          status: "unknown",
          error:
            "process stopped during Telegram delivery; not retried automatically",
        });
    this.ready = true;
  }
  storageReady() {
    return (
      !this.cfg.requireRemote || !!(this.remote?.ok && this.remote.recovered)
    );
  }
  async sync() {
    if (!this.remote) return;
    try {
      if (!this.remote.recovered) await this.remote.recover(this.store);
      if (this.ownsLease) await this.remote.flush(this.store);
    } catch (e) {
      this.lastError = e.message;
    }
  }
  async acquireLease() {
    if (!this.remote) return !this.cfg.requireRemote;
    const wasOwner = this.ownsLease;
    try {
      this.ownsLease = (await this.remote.lease(this.holder)) === true;
      this.leaseCheckedAt = this.clock();
      if (this.ownsLease && !wasOwner) this.remote.recovered = false;
      return this.ownsLease;
    } catch (e) {
      this.ownsLease = false;
      this.lastError = e.message;
      return false;
    }
  }
  async ensureLease() {
    if (!this.remote) return !this.cfg.requireRemote;
    if (
      !this.ownsLease ||
      this.leaseCheckedAt === null ||
      this.clock() - this.leaseCheckedAt >= 60000
    ) {
      if (!(await this.acquireLease())) return false;
      await this.sync();
    }
    return this.ownsLease && this.storageReady();
  }
  async scan() {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.scanOnce();
    try {
      return await this.scanPromise;
    } finally {
      this.scanPromise = null;
    }
  }
  async scanOnce() {
    invariant(this.ready, "Bot initialization incomplete");
    await this.sync();
    this.ownsLease = await this.acquireLease();
    if (!this.ownsLease) {
      this.lastError = "No recorder lease or remote persistence unavailable";
      return this.snapshot();
    }
    this.lastError = null;
    await this.sync();
    const start = this.clock(),
      results = await mapLimit(PAIRS, 3, (sym) => this.scanPair(sym));
    this.pairs = results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : {
            sym: PAIRS[i],
            status: "unavailable",
            error: r.reason.message,
            signals: [],
            conf: 0,
            swing: "HOLD",
            scalp: "HOLD",
          },
    );
    this.lastScan = {
      startedAt: start,
      finishedAt: this.clock(),
      available: this.pairs.filter((p) => p.status === "ok").length,
      total: PAIRS.length,
    };
    await this.sync();
    // Renew before external notifications; another process must not take over mid-send.
    this.ownsLease = await this.acquireLease();
    if (this.ownsLease) await this.deliverNotifications();
    // Context has zero scoring weight; slow context feeds must not delay entries/alerts.
    if (this.cfg.recordContext && this.ownsLease)
      await mapLimit(
        this.pairs.filter((p) => p.status === "ok"),
        3,
        async (pair) => {
          const context = await this.market.context(pair.sym);
          if (!(await this.ensureLease())) return;
          const id =
            "x:" + this.cfg.source + ":" + pair.sym + ":" + pair.decisionTime;
          const snapshot = this.store.get(id);
          if (snapshot)
            this.store.put(id, "snapshot", { ...snapshot, context });
          pair.context = context;
        },
      );
    await this.sync();
    return this.snapshot();
  }
  async scanPair(sym) {
    const packet = await this.market.latest(sym, this.cfg.strategy.lookback),
      { closed, boundary, nextOpen } = packet;
    invariant(await this.ensureLease(), "Recorder lease unavailable");
    validateCandles(closed);
    invariant(closed.at(-1).time + HOUR === boundary, "Stale closed candle");
    this.store.archive(this.cfg.source, sym, closed);
    // Recover outcomes from true candle times even after a long process outage.
    const open = this.store
      .list("signal")
      .filter((t) => t.sym === sym && t.finalResult === "pending");
    for (const t of open) {
      try {
        const cfg = strategyConfig(t.strategy),
          end = Math.min(boundary, t.deadline);
        if (end <= t.entryTime || end <= (t.checkedThrough || 0)) continue;
        const source = t.source;
        invariant(
          source === this.cfg.source,
          "Pending trade belongs to a different source; use its original source to reconcile",
        );
        let bars = this.store.candles(source, sym, t.entryTime, end);
        if (bars.length !== (end - t.entryTime) / HOUR) {
          if (this.remote?.ok) {
            await this.remote.restoreCandles(
              this.store,
              source,
              sym,
              t.entryTime,
              end,
            );
            bars = this.store.candles(source, sym, t.entryTime, end);
          }
          if (bars.length !== (end - t.entryTime) / HOUR)
            bars = await this.market.history(sym, t.entryTime, end);
          this.store.archive(source, sym, bars);
        }
        let updated = resolveTrade(t, bars, cfg, { until: end });
        // The current bar's OPEN is known now; its later high/low is not.
        // Resolve opening gaps immediately, matching the historical event order.
        if (updated.finalResult === "pending" && boundary < updated.deadline) {
          const gap = outcomeInBar(
            updated,
            { open: nextOpen, high: nextOpen, low: nextOpen },
            cfg,
          );
          if (gap?.atOpen) updated = closeTrade(updated, gap, boundary, cfg);
        }
        updated.checkedThrough = end;
        if (updated.finalResult !== "pending")
          updated.observedResolvedAt = this.clock();
        delete updated.outcomeError;
        const items = [{ id: t.id, kind: "signal", payload: updated }];
        if (
          updated.finalResult !== "pending" &&
          this.notificationAllowed(updated)
        )
          items.push(this.notificationRecord(updated, "result"));
        this.store.putMany(items);
      } catch (e) {
        this.store.put(t.id, "signal", { ...t, outcomeError: e.message });
      }
    }
    const signal = evaluateSignal(closed, sym, this.cfg.strategy);
    Object.assign(signal, ratingFor(signal, this.calibration, this.cfg.source));
    const decisionID = "d:" + signal.policyHash + ":" + sym + ":" + boundary,
      processed = this.store.get(decisionID);
    let disposition = processed?.disposition || null;
    if (!processed) {
      const lag = Math.max(0, Math.floor(this.clock() / 1000) - boundary),
        occupied = this.store
          .list("signal")
          .some((t) => t.sym === sym && t.finalResult === "pending");
      disposition = !signal.eligible
        ? "filtered"
        : occupied
          ? "position open"
          : lag > this.cfg.maxEntryLag
            ? "missed entry window"
            : !this.storageReady()
              ? "storage unavailable"
              : "accepted";
      const items = [];
      if (disposition === "accepted") {
        const t = openTrade(signal, nextOpen, boundary, this.cfg.strategy, {
          source: this.cfg.source,
          mode: "forward-paper",
          observedAt: this.clock(),
          alertDelaySeconds: lag,
        });
        if (t.rejected) disposition = t.reason;
        else {
          items.push({ id: t.id, kind: "signal", payload: t });
          if (this.notificationAllowed(t))
            items.push(this.notificationRecord(t, "entry"));
        }
      }
      // A transient storage failure may retry before the entry window closes.
      if (disposition !== "storage unavailable")
        items.push({
          id: decisionID,
          kind: "meta",
          payload: {
            id: decisionID,
            sym,
            decisionTime: boundary,
            policyHash: signal.policyHash,
            disposition,
            reasons: signal.reasons,
          },
        });
      this.store.putMany(items);
    }
    let context = null;
    if (this.cfg.recordContext) {
      this.store.put(
        "x:" + this.cfg.source + ":" + sym + ":" + boundary,
        "snapshot",
        {
          sym,
          observedAt: Math.floor(this.clock() / 1000),
          scoringContribution: 0,
          source: this.cfg.source,
          decisionTime: boundary,
          features: signal.features,
          setup: {
            score: signal.score,
            rawScore: signal.rawScore,
            parts: signal.parts,
            setupTier: signal.setupTier,
            eligible: signal.eligible,
            reasons: signal.reasons,
          },
          policyHash: signal.policyHash,
        },
      );
    }
    const f = signal.features;
    return {
      sym,
      status: "ok",
      source: this.cfg.source,
      price: f.price,
      pct24h: f.pct24h,
      rsi: f.rsi,
      atr: f.atr,
      bb: f.bb,
      macd: {
        hist: f.momentum.value,
        bull: f.momentum.bull,
        label: "legacy EMA-spread heuristic",
      },
      trend1h: f.trend1h,
      trend4h: f.trend4h,
      priceStruct: f.priceStruct,
      emaSlope: f.emaSlope,
      squeeze: f.squeeze,
      regime: f.regime.regime,
      regimeReason: f.regime.reason,
      conf: signal.conf,
      score: signal.score,
      ratingStatus: signal.ratingStatus,
      swing: signal.eligible ? "PAPER " + signal.dir : "HOLD",
      scalp: "HOLD",
      signals: signal.eligible ? [{ ...signal, features: undefined }] : [],
      reasons: signal.reasons,
      disposition,
      decisionTime: boundary,
      context,
    };
  }
  notificationAllowed(t) {
    return (
      this.cfg.tgEnabled &&
      (t.conf >= 2 || this.cfg.tgUnrated) &&
      (t.dir !== "SELL" || this.cfg.tgSell)
    );
  }
  notificationRecord(t, type) {
    const id = "n:" + type + ":" + t.id;
    return {
      id,
      kind: "notification",
      payload: {
        id,
        tradeId: t.id,
        type,
        status: "queued",
        createdAt: this.clock(),
        text:
          type === "entry"
            ? telegramEntry(t)
            : "PAPER " +
              t.dir +
              " " +
              t.sym +
              " resolved: " +
              t.exitReason +
              "\nNet result: " +
              round(t.netR, 3) +
              "R\nFees and configured financing included.\n" +
              (t.ambiguous
                ? "Both levels touched: conservative stop-first resolution."
                : ""),
      },
    };
  }
  async deliverNotifications() {
    if (!this.cfg.tgEnabled || !this.storageReady()) return;
    for (const n of this.store
      .list("notification")
      .filter((n) => n.status === "queued")) {
      if (!(await this.ensureLease())) break;
      if (
        this.remote &&
        (this.store.dirty(n.id) || this.store.dirty(n.tradeId))
      )
        continue;
      const t = this.store.get(n.tradeId);
      if (
        n.type === "entry" &&
        (t.finalResult !== "pending" ||
          this.clock() / 1000 - t.entryTime > this.cfg.maxEntryLag)
      ) {
        this.store.put(n.id, "notification", {
          ...n,
          status: "skipped",
          error: "entry alert would be stale",
        });
        continue;
      }
      const sending = { ...n, status: "sending", attemptedAt: this.clock() };
      this.store.put(n.id, "notification", sending);
      await this.sync();
      if (this.remote && this.store.dirty(n.id)) continue;
      try {
        const j = await requestJSON(
          "https://api.telegram.org/bot" + this.cfg.tgToken + "/sendMessage",
          {
            method: "POST",
            body: {
              chat_id: this.cfg.tgChat,
              text: n.text,
              parse_mode: "HTML",
            },
            retries: 0,
            fetchImpl: this.fetchImpl,
          },
        );
        invariant(j.ok === true, "Telegram rejected notification");
        this.store.put(n.id, "notification", {
          ...sending,
          status: "sent",
          messageId: j.result?.message_id ?? null,
        });
      } catch (e) {
        this.store.put(n.id, "notification", {
          ...sending,
          status: "unknown",
          error:
            "Telegram delivery not confirmed; inspect channel before retrying",
        });
      }
      await this.sync();
    }
  }
  snapshot() {
    const signals = this.store
        .list("signal")
        .sort((a, b) => a.entryTime - b.entryTime),
      current = signals.filter(
        (s) =>
          s.policyHash === policyHash(this.cfg.strategy) &&
          s.source === this.cfg.source,
      );
    return {
      ok: true,
      version: VERSION,
      mode: "paper",
      data: this.pairs,
      history: current.slice(-100).reverse(),
      signalLog: current.slice(-100).reverse(),
      stats: reportTrades(current).overall,
      timestamp: new Date(this.clock()).toISOString(),
      lastScan: this.lastScan,
      stale:
        !this.lastScan ||
        this.clock() - this.lastScan.finishedAt > this.cfg.scanMs * 3,
      policyHash: policyHash(this.cfg.strategy),
    };
  }
  health() {
    return {
      ok: this.ready,
      ready:
        this.ready &&
        this.storageReady() &&
        !!this.lastScan &&
        this.ownsLease &&
        this.clock() - this.lastScan.finishedAt <= this.cfg.scanMs * 3 &&
        this.lastScan.available === PAIRS.length,
      version: VERSION,
      mode: "paper",
      source: this.cfg.source,
      engineHash: ENGINE_HASH,
      policyHash: policyHash(this.cfg.strategy),
      scanEnabled: this.cfg.scanEnabled,
      lastScan: this.lastScan,
      persistence: {
        configured: !!this.remote,
        connected: this.remote?.ok || false,
        recovered: this.remote?.recovered || false,
        pendingWrites: this.store.pendingCount(),
        required: this.cfg.requireRemote,
      },
      ccKeySet: !!this.cfg.ccKey,
      telegramEnabled: this.cfg.tgEnabled,
      recorderLease: this.ownsLease,
      lastError: this.lastError,
      validation: {
        profitability: "not established by software tests",
        stars: this.calibration?.status || "uncalibrated",
        sell: "research only",
      },
      pairs: PAIRS,
    };
  }
  async start() {
    await this.initialize();
    if (this.cfg.scanEnabled) this.schedule(0);
  }
  schedule(ms = this.cfg.scanMs) {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        await this.scan();
      } catch (e) {
        this.lastError = e.message;
        this.logger.error("Scan: " + e.message);
      } finally {
        this.schedule();
      }
    }, ms);
    this.timer.unref();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.scanPromise) await this.scanPromise.catch(() => {});
    if (this.worker) await this.worker.terminate();
    await this.sync();
    this.store.close();
  }
}

function tokenMatches(actual, expected) {
  if (!expected || !actual) return false;
  return crypto.timingSafeEqual(
    crypto.createHash("sha256").update(actual).digest(),
    crypto.createHash("sha256").update(expected).digest(),
  );
}
function authorized(req, token) {
  const value = req.headers.authorization || "";
  return value.startsWith("Bearer ") && tokenMatches(value.slice(7), token);
}
async function requestBody(req, max = 65536) {
  let size = 0,
    chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    invariant(size <= max, "Request body too large");
    chunks.push(chunk);
  }
  return chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
    : {};
}
function publicTradeStats(bot) {
  const all = bot.store.list("signal"),
    current = all.filter(
      (t) =>
        t.policyHash === policyHash(bot.cfg.strategy) &&
        t.source === bot.cfg.source,
    );
  return {
    ok: true,
    mode: "forward-paper",
    policyHash: policyHash(bot.cfg.strategy),
    ...reportTrades(current),
    excludedOtherVersions: all.length - current.length,
    note: "Modeled fills, conservative OHLC outcomes and configured costs; not exchange execution P&L.",
  };
}
function patternInsights(bot) {
  const groups = new Map();
  for (const t of bot.store
    .list("signal")
    .filter(
      (t) => t.policyHash === policyHash(bot.cfg.strategy) && finite(t.netR),
    )) {
    const bucket =
        t.features.rsi < 45
          ? "below45"
          : t.features.rsi < 55
            ? "45to55"
            : t.features.rsi < 70
              ? "55to70"
              : "70plus",
      key = [
        t.sym,
        t.dir,
        t.regime,
        bucket,
        t.features.priceStruct.structure,
      ].join(":");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return {
    ok: true,
    scoringContribution: 0,
    note: "Descriptive net-R cohorts only. No automatic learning or suppression.",
    patterns: [...groups]
      .map(([pattern, trades]) => ({ pattern, ...tradeStats(trades) }))
      .sort((a, b) => b.total - a.total),
  };
}
function startLabJob(bot, options = {}) {
  invariant(!bot.worker, "A backtest is already running");
  invariant(
    bot.cfg.datasetFile && fs.existsSync(bot.cfg.datasetFile),
    "Configure BACKTEST_DATASET to a frozen dataset file",
  );
  invariant(
    options.mode === undefined || ["single", "suite"].includes(options.mode),
    "Unknown backtest mode",
  );
  const config = strategyConfig({
      ...bot.cfg.strategy,
      ...(options.config || {}),
    }),
    id = crypto.randomUUID();
  bot.backtestJob = { status: "running", id, startedAt: Date.now() };
  const worker = new Worker(__filename, {
    workerData: {
      task: "backtest",
      file: bot.cfg.datasetFile,
      config,
      suite: options.mode === "suite",
    },
    resourceLimits: { maxOldGenerationSizeMb: 512 },
  });
  bot.worker = worker;
  worker.once("message", (message) => {
    if (message.error)
      bot.backtestJob = {
        ...bot.backtestJob,
        status: "failed",
        error: message.error,
      };
    else {
      bot.backtestJob = {
        ...bot.backtestJob,
        status: "complete",
        results: message.result,
        completedAt: Date.now(),
      };
      writeJSON(
        path.join(bot.cfg.dataDir, "last-backtest.json"),
        message.result,
      );
    }
  });
  worker.once("error", (e) => {
    bot.backtestJob = {
      ...bot.backtestJob,
      status: "failed",
      error: e.message,
    };
  });
  worker.once("exit", (code) => {
    if (code !== 0 && bot.backtestJob.status === "running")
      bot.backtestJob = {
        ...bot.backtestJob,
        status: "failed",
        error: "Backtest worker exited " + code,
      };
    bot.worker = null;
  });
  return { ok: true, status: "running", id };
}
function createServer(bot) {
  const cfg = bot.cfg;
  return http.createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (cfg.allowedOrigin && req.headers.origin === cfg.allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", cfg.allowedOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    try {
      const url = new URL(req.url, "http://localhost"),
        p = url.pathname;
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
      if (p === "/api/health" && req.method === "GET")
        return reply(200, bot.health());
      if (p.startsWith("/api/")) {
        if (
          req.method === "GET" &&
          cfg.readToken &&
          !authorized(req, cfg.readToken) &&
          !authorized(req, cfg.adminToken)
        )
          return reply(401, { ok: false, error: "Read token required" });
        if (req.method === "POST" && !authorized(req, cfg.adminToken))
          return reply(401, {
            ok: false,
            error:
              "Admin token required; mutations are disabled without ADMIN_TOKEN",
          });
        if (p === "/api/scan" && req.method === "GET")
          return reply(200, bot.snapshot());
        if (p === "/api/scan" && req.method === "POST")
          return reply(200, await bot.scan());
        if (p === "/api/live-stats" && req.method === "GET")
          return reply(200, publicTradeStats(bot));
        if (p === "/api/patterns" && req.method === "GET")
          return reply(200, patternInsights(bot));
        if (p === "/api/config" && req.method === "GET")
          return reply(200, {
            ok: true,
            version: VERSION,
            source: cfg.source,
            strategy: cfg.strategy,
            policyHash: policyHash(cfg.strategy),
            engineHash: ENGINE_HASH,
            stars: bot.calibration?.status || "uncalibrated",
            mode: "paper",
          });
        if (p === "/api/full-log" && req.method === "GET") {
          const limit = Number(url.searchParams.get("limit") || 100),
            offset = Number(url.searchParams.get("offset") || 0);
          invariant(
            Number.isInteger(limit) &&
              limit >= 1 &&
              limit <= 1000 &&
              Number.isInteger(offset) &&
              offset >= 0,
            "Invalid pagination",
          );
          const rows = bot.store
            .list("signal")
            .sort(
              (a, b) => a.entryTime - b.entryTime || a.id.localeCompare(b.id),
            );
          return reply(200, {
            ok: true,
            totalStored: rows.length,
            signals: rows.slice(offset, offset + limit),
            nextOffset: offset + limit < rows.length ? offset + limit : null,
          });
        }
        if (p === "/api/backtest" && req.method === "GET")
          return reply(200, { ok: true, ...bot.backtestJob });
        if (p === "/api/backtest" && req.method === "POST")
          return reply(202, startLabJob(bot, await requestBody(req)));
        if (p === "/api/trade-alert")
          return reply(410, {
            ok: false,
            error:
              "Arbitrary relay removed. Paper notifications are generated from persisted engine events.",
          });
        return reply(404, { ok: false, error: "Unknown endpoint" });
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        return reply(405, { ok: false, error: "Method not allowed" });
      const decoded = decodeURIComponent(p),
        relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, ""),
        filename = path.resolve(cfg.publicDir, relative);
      if (
        !filename.startsWith(cfg.publicDir + path.sep) ||
        relative.split("/").some((x) => x.startsWith("."))
      )
        return reply(404, { ok: false, error: "Not found" });
      if (!fs.existsSync(filename) || !fs.statSync(filename).isFile())
        return reply(404, { ok: false, error: "Not found" });
      const real = fs.realpathSync(filename);
      if (!real.startsWith(fs.realpathSync(cfg.publicDir) + path.sep))
        return reply(404, { ok: false, error: "Not found" });
      const mime =
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
        }[path.extname(filename)] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Security-Policy":
          "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(filename)
        .on("error", () => res.destroy())
        .pipe(res);
    } catch (e) {
      if (!res.headersSent) reply(400, { ok: false, error: e.message });
      else res.destroy();
    }
  });
}
function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    invariant(key.startsWith("--"), "Unexpected argument " + key);
    const name = key.slice(2);
    invariant(!Object.hasOwn(out, name), "Duplicate option " + key);
    out[name] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  }
  return out;
}
function timestamp(text) {
  const ms = Date.parse(text);
  invariant(
    Number.isFinite(ms) && ms % 3600000 === 0,
    "Timestamp must be an exact UTC hour, e.g. 2026-06-01T00:00:00Z",
  );
  return ms / 1000;
}
function allowedFlags(flags, names) {
  for (const name of Object.keys(flags))
    invariant(names.includes(name), "Unknown option --" + name);
}
async function main(args = process.argv.slice(2)) {
  const command = args[0] || "serve";
  if (command === "serve") {
    const cfg = runtimeConfig(),
      bot = new Bot(cfg),
      server = createServer(bot);
    await bot.start();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(cfg.port, cfg.host, resolve);
    });
    console.log(
      "Defi Insider " +
        VERSION +
        " PAPER server listening on " +
        server.address().port,
    );
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      server.close();
      try {
        await bot.stop();
      } finally {
        server.closeAllConnections();
      }
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return;
  }
  if (command === "download") {
    const output = args[1];
    invariant(
      output,
      "Usage: node server.js download dataset.json --start ISO --end ISO",
    );
    const flags = parseFlags(args.slice(2));
    allowedFlags(flags, ["start", "end", "source", "pairs", "minutes"]);
    invariant(
      typeof flags.start === "string" && typeof flags.end === "string",
      "Fixed --start and --end are required",
    );
    const cfg = runtimeConfig(),
      source = flags.source || cfg.source,
      symbols = flags.pairs ? flags.pairs.split(",") : PAIRS;
    invariant(
      symbols.every((s) => PAIRS.includes(s)),
      "Unknown pair",
    );
    const data = await downloadDataset(
      new MarketData({ source, ccKey: cfg.ccKey }),
      {
        start: timestamp(flags.start),
        end: timestamp(flags.end),
        symbols,
        lookback: cfg.strategy.lookback,
        minutes: flags.minutes === true,
      },
    );
    writeJSON(output, data);
    console.log(
      JSON.stringify({
        saved: output,
        dataHash: hash(data),
        symbols: data.symbols,
        testStart: data.testStart,
        testEnd: data.testEnd,
      }),
    );
    return;
  }
  if (command === "backtest") {
    invariant(
      args[1] && args[2],
      "Usage: node server.js backtest dataset.json report.json [--suite] [--config policy.json]",
    );
    const flags = parseFlags(args.slice(3));
    allowedFlags(flags, ["suite", "config", "calibration"]);
    const data = readJSON(args[1]),
      cfg = flags.config ? readJSON(flags.config) : {},
      cal = flags.calibration ? readJSON(flags.calibration) : null;
    const report = flags.suite
      ? experimentSuite(data, cfg)
      : backtest(data, cfg, cal);
    writeJSON(args[2], report);
    console.log(
      JSON.stringify({
        saved: args[2],
        kind: data.kind,
        summary: flags.suite ? report.combinedComparison : report.overall,
      }),
    );
    return;
  }
  if (command === "calibrate") {
    invariant(
      args.length === 4,
      "Usage: node server.js calibrate training-report.json validation-report.json calibration.json",
    );
    const artifact = makeCalibration(readJSON(args[1]), readJSON(args[2]));
    writeJSON(args[3], artifact);
    console.log(JSON.stringify({ saved: args[3], status: artifact.status }));
    return;
  }
  if (command === "export") {
    invariant(
      args[1],
      "Usage: node server.js export dataset.json --start ISO --end ISO",
    );
    const flags = parseFlags(args.slice(2));
    allowedFlags(flags, ["start", "end", "pairs"]);
    const cfg = runtimeConfig(),
      start = timestamp(flags.start),
      end = timestamp(flags.end),
      symbols = flags.pairs ? flags.pairs.split(",") : PAIRS;
    const store = new Store(path.join(cfg.dataDir, "bot.sqlite")),
      data = {
        schemaVersion: 1,
        kind: "historical",
        source: cfg.source,
        intervalSeconds: HOUR,
        testStart: start,
        testEnd: end,
        symbols,
        candles: {},
        capturedAt: new Date().toISOString(),
      };
    try {
      const archiveStart = start - cfg.strategy.lookback * HOUR;
      const remote = cfg.supabaseURL
        ? new RemoteStore(cfg.supabaseURL, cfg.supabaseKey)
        : null;
      invariant(
        start < end &&
          symbols.length &&
          new Set(symbols).size === symbols.length &&
          symbols.every((s) => PAIRS.includes(s)),
        "Invalid archive bounds or pairs",
      );
      for (const sym of symbols) {
        let bars = store.candles(cfg.source, sym, archiveStart, end);
        if (bars.length !== (end - archiveStart) / HOUR && remote) {
          await remote.restoreCandles(
            store,
            cfg.source,
            sym,
            archiveStart,
            end,
          );
          bars = store.candles(cfg.source, sym, archiveStart, end);
        }
        data.candles[sym] = bars;
      }
      validateDataset(data, cfg.strategy);
      writeJSON(args[1], data);
    } finally {
      store.close();
    }
    console.log("Saved complete candle archive to " + args[1]);
    return;
  }
  throw new Error("Commands: serve, download, backtest, calibrate, export");
}

module.exports = {
  VERSION,
  ENGINE_HASH,
  HOUR,
  DAY,
  PAIRS,
  STRATEGY_DEFAULTS,
  CORRECTED_CONTROL,
  hash,
  stable,
  strategyConfig,
  policyHash,
  validateCandles,
  aggregate4H,
  rsiSimple,
  ema,
  atr,
  bollinger,
  priceStructure,
  squeezeState,
  regimeOf,
  features,
  chartLevels,
  scoreSetup,
  evaluateSignal,
  adverseFill,
  openTrade,
  outcomeInBar,
  closeTrade,
  resolveTrade,
  tradeStats,
  reportTrades,
  validateDataset,
  backtest,
  blockInterval,
  deltaInterval,
  comparePolicies,
  experimentSuite,
  makeCalibration,
  ratingFor,
  Store,
  RemoteStore,
  requestJSON,
  parseBybit,
  parseCC,
  MarketData,
  downloadDataset,
  runtimeConfig,
  Bot,
  createServer,
  patternInsights,
  writeJSON,
  readJSON,
  main,
};
if (!isMainThread && workerData?.task === "backtest") {
  try {
    const data = readJSON(workerData.file);
    parentPort.postMessage({
      result: workerData.suite
        ? experimentSuite(data, workerData.config)
        : backtest(data, workerData.config),
    });
  } catch (e) {
    parentPort.postMessage({ error: e.message });
  }
} else if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
