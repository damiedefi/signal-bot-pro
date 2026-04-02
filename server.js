const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.static('public'));

// ── DYNAMIC PAIRS (cached 4 hours) ───────────────────────
let pairsCache = { pairs: null, ts: 0 };
const PAIRS_TTL = 4 * 60 * 60 * 1000; // 4 hours

async function getTop20Pairs() {
  const now = Date.now();
  if (pairsCache.pairs && (now - pairsCache.ts) < PAIRS_TTL) {
    return pairsCache.pairs;
  }
  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false',
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) throw new Error('CoinGecko ' + res.status);
    const coins = await res.json();
    const pairs = coins.map(c => ({
      sym:  c.symbol.toUpperCase(),
      cc:   c.symbol.toUpperCase(),
      mcap: c.market_cap || 0,
      cgId: c.id
    }));
    pairsCache = { pairs, ts: now };
    console.log(`Top 20 pairs loaded: ${pairs.map(p => p.sym).join(', ')}`);
    return pairs;
  } catch (e) {
    console.error('Failed to fetch top 20 from CoinGecko:', e.message);
    // Fallback to hardcoded list if CoinGecko fails
    return [
      { sym:'BTC',  cc:'BTC',  mcap:1.32e12 },
      { sym:'ETH',  cc:'ETH',  mcap:382e9 },
      { sym:'BNB',  cc:'BNB',  mcap:61e9 },
      { sym:'SOL',  cc:'SOL',  mcap:77e9 },
      { sym:'XRP',  cc:'XRP',  mcap:58e9 },
      { sym:'DOGE', cc:'DOGE', mcap:23e9 },
      { sym:'ADA',  cc:'ADA',  mcap:16e9 },
      { sym:'AVAX', cc:'AVAX', mcap:14e9 },
      { sym:'LINK', cc:'LINK', mcap:8.5e9 },
      { sym:'DOT',  cc:'DOT',  mcap:9.8e9 },
      { sym:'MATIC',cc:'MATIC',mcap:7.1e9 },
      { sym:'UNI',  cc:'UNI',  mcap:5.9e9 },
      { sym:'LTC',  cc:'LTC',  mcap:6.1e9 },
      { sym:'ATOM', cc:'ATOM', mcap:3.2e9 },
      { sym:'NEAR', cc:'NEAR', mcap:6.8e9 },
      { sym:'FIL',  cc:'FIL',  mcap:3.1e9 },
      { sym:'ARB',  cc:'ARB',  mcap:3.6e9 },
      { sym:'OP',   cc:'OP',   mcap:2.9e9 },
      { sym:'INJ',  cc:'INJ',  mcap:2.4e9 },
      { sym:'SUI',  cc:'SUI',  mcap:2.1e9 }
    ];
  }
}

// ── INDICATORS ────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  return Math.round(100 - (100 / (1 + avgG / avgL)));
}

function calcMACD(closes) {
  function ema(arr, p) {
    const k = 2 / (p + 1); let e = arr[0];
    for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
    return e;
  }
  if (closes.length < 26) return { hist: 0, bull: false };
  const hist = ema(closes.slice(-12), 12) - ema(closes.slice(-26), 26);
  return { hist, bull: hist > 0 };
}

function calcBB(closes, period = 20) {
  if (closes.length < period) return { pos: 'mid', pct: 50, pctB: 0.5 };
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mid, 2), 0) / period);
  const upper = mid + 2 * std, lower = mid - 2 * std;
  const last = closes[closes.length - 1];
  const range = upper - lower;
  const pctB = range === 0 ? 0.5 : (last - lower) / range; // 0-1 raw value
  const pct = Math.round(pctB * 100);
  const c = Math.max(0, Math.min(100, pct));
  return { pos: c > 70 ? 'upper' : c < 30 ? 'lower' : 'mid', pct: c, pctB };
}

// ── REAL ATR (14-period) ──────────────────────────────────
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) {
    // Fallback: use last close * 2.5%
    return candles[candles.length - 1].close * 0.025;
  }
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high  = candles[i].high;
    const low   = candles[i].low;
    const close = candles[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - close),
      Math.abs(low  - close)
    );
    trueRanges.push(tr);
  }
  const recent = trueRanges.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

// ── 4H TREND (soft filter) ────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function get4HTrend(closes4h) {
  if (!closes4h || closes4h.length < 50) return null;
  const ema20 = calcEMA(closes4h, 20);
  const ema50 = calcEMA(closes4h, 50);
  const price = closes4h[closes4h.length - 1];
  return {
    trend:        ema20 > ema50 ? 'bull' : 'bear',
    priceVsEMA20: price > ema20 ? 'above' : 'below',
    ema20:        +ema20.toFixed(4),
    ema50:        +ema50.toFixed(4)
  };
}

// ── WEIGHTED 0-10 SCORING SYSTEM ─────────────────────────
// Replaces the old 4-point binary system.
// Starts neutral at 5, each indicator adds or subtracts weight.
// More nuanced — a deeply oversold RSI still scores even in a bear market.

function calcWeightedScore(rsi, macd, bb, pct7d, volRatio, trend4h) {
  let score = 5; // neutral starting point

  // RSI — stronger weight for extremes
  if      (rsi < 25) score += 3.5;
  else if (rsi < 30) score += 3.0;
  else if (rsi < 38) score += 2.0;
  else if (rsi < 45) score += 0.5;
  else if (rsi > 75) score -= 3.5;
  else if (rsi > 70) score -= 3.0;
  else if (rsi > 62) score -= 2.0;
  else if (rsi > 55) score -= 0.5;

  // MACD histogram direction
  if (macd.bull) score += 2.0;
  else           score -= 2.0;

  // BB %B position (0-1 scale)
  if      (bb.pctB < 0.1) score += 2.5;
  else if (bb.pctB < 0.2) score += 2.0;
  else if (bb.pctB < 0.3) score += 1.0;
  else if (bb.pctB > 0.9) score -= 2.5;
  else if (bb.pctB > 0.8) score -= 2.0;
  else if (bb.pctB > 0.7) score -= 1.0;

  // 7d momentum (lighter weight)
  if      (pct7d > 10) score += 1.5;
  else if (pct7d > 5)  score += 1.0;
  else if (pct7d > 2)  score += 0.5;
  else if (pct7d < -10) score -= 1.5;
  else if (pct7d < -5)  score -= 1.0;
  else if (pct7d < -2)  score -= 0.5;

  // Volume filter
  if (volRatio < 0.005) score -= 1.5;
  else if (volRatio < 0.01) score -= 0.5;

  // 4H trend — soft bias only, small weight
  if (trend4h) {
    if (trend4h.trend === 'bull') score += 1.0;
    else                          score -= 0.5; // smaller penalty than bonus
  }

  return Math.max(0, Math.min(10, +score.toFixed(1)));
}

// ── SIGNAL DECISION ───────────────────────────────────────
// Score-based thresholds replace old 3-point binary logic.
// Swing = trend-following (higher bar, 4H alignment for ★★★)
// Scalp = mean-reversion (lower bar, allows counter-trend on extremes)

function getSignal(score, rsi, macd, bb, trend4h, volRatio) {
  const hasVol = volRatio > 0.005;
  const isBull = score >= 6;   // net bullish
  const isBear = score <= 4;   // net bearish
  const strongBull = score >= 7;
  const strongBear = score <= 3;

  // 4H alignment check
  const aligned4H = trend4h
    ? (isBull && trend4h.trend === 'bull') || (isBear && trend4h.trend === 'bear')
    : true;

  let swing, scalp, conf, aligned, trendNote;

  if (strongBull && hasVol) {
    scalp = 'BUY';
    swing = isBull ? 'BUY' : 'WATCH';
    // ★★★ requires score ≥ 7.5 AND 4H aligned
    conf = (score >= 7.5 && aligned4H) ? 3 : 2;
    aligned = aligned4H;
  } else if (isBull && hasVol) {
    scalp = 'BUY';
    swing = 'WATCH';
    conf = 2;
    aligned = aligned4H;
  } else if (strongBear && hasVol) {
    scalp = 'SELL';
    swing = isBear ? 'SELL' : 'WATCH';
    conf = (score <= 2.5 && aligned4H) ? 3 : 2;
    aligned = aligned4H;
  } else if (isBear && hasVol) {
    scalp = 'SELL';
    swing = 'WATCH';
    conf = 2;
    aligned = aligned4H;
  } else {
    swing = 'HOLD'; scalp = 'HOLD'; conf = 1; aligned = null;
  }

  if (aligned === false && trend4h) {
    trendNote = `Counter-trend — 4H is ${trend4h.trend.toUpperCase()}. Confidence capped at ★★.`;
    conf = Math.min(conf, 2);
  } else if (aligned === true && trend4h) {
    trendNote = `Trend-confirmed — 4H is ${trend4h.trend.toUpperCase()}. Full confidence.`;
  } else {
    trendNote = '';
  }

  return { swing, scalp, conf, aligned, trendNote };
}

// ── CRYPTOCOMPARE FETCH ───────────────────────────────────
async function ccFetch(path) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch('https://min-api.cryptocompare.com' + path, {
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`CryptoCompare ${res.status}`);
  return res.json();
}

async function processPair(pair) {
  const [data1h, data4h] = await Promise.all([
    ccFetch(`/data/v2/histohour?fsym=${pair.cc}&tsym=USDT&limit=50`),
    ccFetch(`/data/v2/histohour?fsym=${pair.cc}&tsym=USDT&limit=200&aggregate=4`)
  ]);

  if (data1h.Response !== 'Success') throw new Error(data1h.Message || '1H error');

  const candles1h = data1h.Data.Data;
  const candles4h = data4h.Response === 'Success' ? data4h.Data.Data : [];

  if (candles1h.length < 20) throw new Error('Insufficient candles');

  const closes1h = candles1h.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);
  const price    = closes1h[closes1h.length - 1];

  // Indicators
  const rsi     = calcRSI(closes1h, 14);
  const macd    = calcMACD(closes1h);
  const bb      = calcBB(closes1h, 20);
  const atr     = calcATR(candles1h, 14); // real ATR from OHLC
  const trend4h = get4HTrend(closes4h);

  // Price changes
  const price24hAgo = closes1h.length >= 24 ? closes1h[closes1h.length - 24] : closes1h[0];
  const price7dAgo  = closes1h.length >= 48  ? closes1h[0] : closes1h[0];
  const pct24h = ((price - price24hAgo) / price24hAgo) * 100;
  const pct7d  = ((price - price7dAgo)  / price7dAgo)  * 100;

  const lastCandle = candles1h[candles1h.length - 1];
  const vol     = lastCandle.volumeto || 0;
  const mcap    = pair.mcap || 0;
  const volRatio = mcap > 0 ? vol / mcap : 0;

  // Weighted score
  const score = calcWeightedScore(rsi, macd, bb, pct7d, volRatio, trend4h);

  // Signal decision
  const sig = getSignal(score, rsi, macd, bb, trend4h, volRatio);

  console.log(
    `${pair.sym}: RSI=${rsi} MACD=${macd.bull?'BULL':'BEAR'} BB=${bb.pct}% ` +
    `pctB=${bb.pctB.toFixed(2)} 7d=${pct7d.toFixed(1)}% ` +
    `vol=${volRatio.toFixed(3)} 4H=${trend4h?trend4h.trend:'?'} ` +
    `Score=${score} → ${sig.swing}(${sig.conf}★) ATR=${atr.toFixed(4)}`
  );

  return {
    sym: pair.sym, price, pct24h, pct7d,
    vol, mcap, volRatio, rsi, macd, bb,
    atr, trend4h, score, ...sig
  };
}

// ── CACHE ─────────────────────────────────────────────────
let cache = { data: null, ts: 0 };
const CACHE_TTL = 60 * 1000;

async function buildSignals() {
  const pairs = await getTop20Pairs();
  console.log(`Starting scan for ${pairs.length} pairs...`);

  const batchSize = 4;
  const allResults = [];
  for (let i = 0; i < pairs.length; i += batchSize) {
    const batch = pairs.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(processPair));
    batchResults.forEach((r, idx) => {
      if (r.status === 'rejected') {
        console.error(`${batch[idx].sym}: ${r.reason.message}`);
      }
      allResults.push(r);
    });
    if (i + batchSize < pairs.length) {
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  const data = allResults.filter(r => r.status === 'fulfilled').map(r => r.value);
  console.log(`Scan complete: ${data.length}/${pairs.length} pairs`);
  if (data.length === 0) throw new Error('All requests failed');
  return data;
}

// ── ROUTES ────────────────────────────────────────────────
app.get('/api/scan', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.data && (now - cache.ts) < CACHE_TTL) {
      return res.json({ ok: true, data: cache.data, cached: true, timestamp: new Date().toISOString() });
    }
    const data = await buildSignals();
    cache = { data, ts: Date.now() };
    res.json({ ok: true, data, cached: false, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('Scan error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const { default: fetch } = await import('node-fetch');
    const r = await fetch('https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USDT');
    const d = await r.json();
    res.json({
      ok: true,
      cryptocompare: d.USDT ? 'connected' : 'error',
      btcPrice: d.USDT ? '$' + d.USDT.toLocaleString() : null,
      scoring: 'weighted 0-10 system',
      atr: 'real 14-period ATR from OHLC',
      pairs: 'dynamic top-20 from CoinGecko',
      pairsCacheAge: pairsCache.ts ? Math.round((Date.now() - pairsCache.ts) / 60000) + 'min ago' : 'not loaded'
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Defi Insider Signal Bot running on port ${PORT}`));
