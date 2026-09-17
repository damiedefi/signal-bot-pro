"use strict";
const { HOUR, PAIRS } = require("../server");
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
function candles(
  count = 900,
  { start = 1704067200, seed = 17, scale = 100 } = {},
) {
  const rng = random(seed);
  let price = scale;
  return Array.from({ length: count }, (_, i) => {
    const phase = Math.floor(i / 160) % 4,
      drift = [0.0012, -0.0013, 0, 0.0005][phase];
    const open = price,
      move = drift + Math.sin(i * 0.57) * 0.0025 + (rng() - 0.5) * 0.006;
    price = Math.max(0.00001, open * (1 + move));
    const wick = (0.001 + rng() * 0.005) * open;
    return {
      time: start + i * HOUR,
      open,
      high: Math.max(open, price) + wick,
      low: Math.min(open, price) - wick,
      close: price,
      volume: 1e6 * (0.4 + rng() * 1.6),
    };
  });
}
function dataset({ count = 900, symbols = ["BTC", "ETH"], seed = 17 } = {}) {
  const all = {};
  for (const [i, sym] of symbols.entries())
    all[sym] = candles(count, { seed: seed + i * 19, scale: 100 / (i + 1) });
  return {
    schemaVersion: 1,
    kind: "synthetic",
    source: "synthetic",
    intervalSeconds: HOUR,
    testStart: all[symbols[0]][320].time,
    testEnd: all[symbols[0]].at(-1).time + HOUR,
    symbols,
    candles: all,
    capturedAt: "2026-09-17T00:00:00Z",
  };
}
module.exports = { candles, dataset, random, PAIRS };
