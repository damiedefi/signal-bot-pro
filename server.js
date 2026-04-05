const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.static('public'));

// ── 4 PAIRS ONLY ──────────────────────────────────────────
const PAIRS = [
  { sym: 'BTC', cc: 'BTC', mcap: 1.32e12 },
  { sym: 'ETH', cc: 'ETH', mcap: 382e9 },
  { sym: 'SOL', cc: 'SOL', mcap: 77e9 },
  { sym: 'BNB', cc: 'BNB', mcap: 61e9 }
];

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
  const pctB = range === 0 ? 0.5 : (last - lower) / range;
  const pct = Math.max(0, Math.min(100, Math.round(pctB * 100)));
  return { pos: pct > 70 ? 'upper' : pct < 30 ? 'lower' : 'mid', pct, pctB, upper, lower, mid };
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return candles[candles.length - 1].close * 0.02;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close)
    );
    trs.push(tr);
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let e = closes[0];
  for (let i = 1; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

// ── 4H TREND CONTEXT ──────────────────────────────────────
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

// ── SCORING ───────────────────────────────────────────────
// Score 0–10. Both bull and bear directions scored.
// Active mode: lower thresholds so signals fire regularly.

function scoreDirection(rsi, macd, bb, pct24h, volRatio, trend4h, dir) {
  let score = 5;

  if (dir === 'bull') {
    // RSI — oversold = strong bull signal
    if      (rsi < 25) score += 3.5;
    else if (rsi < 30) score += 3.0;
    else if (rsi < 38) score += 2.0;
    else if (rsi < 45) score += 0.5;
    else if (rsi > 60) score -= 1.5;
    else if (rsi > 70) score -= 2.5;

    // MACD
    if (macd.bull) score += 2.0; else score -= 1.5;

    // BB — lower band = bullish
    if      (bb.pctB < 0.1) score += 2.5;
    else if (bb.pctB < 0.2) score += 2.0;
    else if (bb.pctB < 0.3) score += 1.0;
    else if (bb.pctB > 0.8) score -= 1.5;

    // 24h momentum
    if      (pct24h > 3)  score += 1.0;
    else if (pct24h > 1)  score += 0.5;
    else if (pct24h < -3) score -= 1.0;

    // 4H soft bias
    if (trend4h) {
      if (trend4h.trend === 'bull') score += 1.0;
      else score -= 0.5;
    }

  } else { // bear
    // RSI — overbought = strong bear signal
    if      (rsi > 75) score += 3.5;
    else if (rsi > 70) score += 3.0;
    else if (rsi > 62) score += 2.0;
    else if (rsi > 55) score += 0.5;
    else if (rsi < 40) score -= 1.5;
    else if (rsi < 30) score -= 2.5;

    // MACD
    if (!macd.bull) score += 2.0; else score -= 1.5;

    // BB — upper band = bearish
    if      (bb.pctB > 0.9) score += 2.5;
    else if (bb.pctB > 0.8) score += 2.0;
    else if (bb.pctB > 0.7) score += 1.0;
    else if (bb.pctB < 0.2) score -= 1.5;

    // 24h momentum
    if      (pct24h < -3) score += 1.0;
    else if (pct24h < -1) score += 0.5;
    else if (pct24h > 3)  score -= 1.0;

    // 4H soft bias
    if (trend4h) {
      if (trend4h.trend === 'bear') score += 1.0;
      else score -= 0.5;
    }
  }

  // Volume
  if (volRatio < 0.005) score -= 1.5;
  else if (volRatio < 0.01) score -= 0.5;
  else if (volRatio > 0.05) score += 0.5;

  return Math.max(0, Math.min(10, +score.toFixed(1)));
}

// ── SIGNAL DECISION ───────────────────────────────────────
// Active thresholds: score >= 6 = signal fires
// ★★★ = score >= 7.5 + 4H aligned
// ★★  = score >= 6 (including counter-trend)

function getSignals(rsi, macd, bb, pct24h, volRatio, trend4h, atr, price) {
  const bullScore = scoreDirection(rsi, macd, bb, pct24h, volRatio, trend4h, 'bull');
  const bearScore = scoreDirection(rsi, macd, bb, pct24h, volRatio, trend4h, 'bear');

  const results = [];

  // BUY signal
  if (bullScore >= 6) {
    const aligned = !trend4h || trend4h.trend === 'bull';
    const conf = (bullScore >= 7.5 && aligned) ? 3 : 2;
    const trendNote = aligned
      ? (trend4h ? `Trend-confirmed — 4H is BULL.` : '')
      : `Counter-trend — 4H is BEAR. Capped at ★★.`;
    results.push({
      dir: 'BUY', score: bullScore, conf,
      swing: bullScore >= 6.5 ? 'BUY' : 'WATCH',
      scalp: 'BUY',
      sl:  +(price - atr * 1.5).toFixed(4),
      tp1: +(price + atr * 2.0).toFixed(4),
      tp2: +(price + atr * 3.5).toFixed(4),
      aligned, trendNote
    });
  }

  // SELL signal
  if (bearScore >= 6) {
    const aligned = !trend4h || trend4h.trend === 'bear';
    const conf = (bearScore >= 7.5 && aligned) ? 3 : 2;
    const trendNote = aligned
      ? (trend4h ? `Trend-confirmed — 4H is BEAR.` : '')
      : `Counter-trend — 4H is BULL. Capped at ★★.`;
    results.push({
      dir: 'SELL', score: bearScore, conf,
      swing: bearScore >= 6.5 ? 'SELL' : 'WATCH',
      scalp: 'SELL',
      sl:  +(price + atr * 1.5).toFixed(4),
      tp1: +(price - atr * 2.0).toFixed(4),
      tp2: +(price - atr * 3.5).toFixed(4),
      aligned, trendNote
    });
  }

  return results;
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

async function processPairData(pair, candles1h, candles4h) {
  if (candles1h.length < 26) throw new Error('Insufficient candles');

  const closes1h = candles1h.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);
  const price    = closes1h[closes1h.length - 1];

  const rsi     = calcRSI(closes1h, 14);
  const macd    = calcMACD(closes1h);
  const bb      = calcBB(closes1h, 20);
  const atr     = calcATR(candles1h, 14);
  const trend4h = get4HTrend(closes4h);

  const price24hAgo = closes1h.length >= 24 ? closes1h[closes1h.length - 24] : closes1h[0];
  const pct24h = ((price - price24hAgo) / price24hAgo) * 100;

  const lastCandle = candles1h[candles1h.length - 1];
  const vol      = lastCandle.volumeto || 0;
  const mcap     = pair.mcap || 0;
  const volRatio = mcap > 0 ? vol / mcap : 0;

  const signals = getSignals(rsi, macd, bb, pct24h, volRatio, trend4h, atr, price);
  const topSignal = [...signals].sort((a, b) => b.score - a.score)[0];

  console.log(
    `${pair.sym}: RSI=${rsi} MACD=${macd.bull?'BULL':'BEAR'} BB=${bb.pct}% ` +
    `4H=${trend4h?trend4h.trend:'?'} Bull=${scoreDirection(rsi,macd,bb,pct24h,volRatio,trend4h,'bull')} ` +
    `Bear=${scoreDirection(rsi,macd,bb,pct24h,volRatio,trend4h,'bear')} → ${topSignal?topSignal.dir:'HOLD'}`
  );

  return {
    sym:      pair.sym,
    price,    pct24h, vol, mcap, volRatio,
    rsi,      macd,   bb,  atr,  trend4h,
    score:    topSignal ? topSignal.score : 5,
    swing:    topSignal ? topSignal.swing : 'HOLD',
    scalp:    topSignal ? topSignal.scalp : 'HOLD',
    conf:     topSignal ? topSignal.conf  : 1,
    aligned:  topSignal ? topSignal.aligned   : null,
    trendNote:topSignal ? topSignal.trendNote : '',
    signals
  };
}

// ── CACHE ─────────────────────────────────────────────────
let cache = { data: null, ts: 0 };
const CACHE_TTL = 60 * 1000;

// ── SIGNAL HISTORY (last 4 hours) ────────────────────────
let signalHistory = []; // { sym, dir, score, conf, sl, tp1, tp2, trendNote, aligned, price, ts }
const HISTORY_TTL = 4 * 60 * 60 * 1000; // 4 hours

function addToHistory(pairResults) {
  const now = Date.now();
  // Remove signals older than 4 hours
  signalHistory = signalHistory.filter(h => (now - h.ts) < HISTORY_TTL);
  // Add new signals
  pairResults.forEach(s => {
    if (s.signals) {
      s.signals.forEach(sig => {
        // Avoid exact duplicates (same pair + direction within 5 minutes)
        const isDupe = signalHistory.some(h =>
          h.sym === s.sym && h.dir === sig.dir && (now - h.ts) < 5 * 60 * 1000
        );
        if (!isDupe) {
          signalHistory.push({
            sym:       s.sym,
            price:     s.price,
            dir:       sig.dir,
            score:     sig.score,
            conf:      sig.conf,
            sl:        sig.sl,
            tp1:       sig.tp1,
            tp2:       sig.tp2,
            swing:     sig.swing,
            scalp:     sig.scalp,
            aligned:   sig.aligned,
            trendNote: sig.trendNote,
            rsi:       s.rsi,
            atr:       s.atr,
            ts:        now,
            timeStr:   new Date(now).toUTCString().slice(17, 25)
          });
        }
      });
    }
  });
}

async function buildSignals() {
  console.log('Scanning BTC, ETH, SOL, BNB — sequential fetches...');
  const data = [];

  for (const pair of PAIRS) {
    try {
      // Sequential with delay — guarantees CryptoCompare never rate-limits us
      const data1h = await ccFetch(`/data/v2/histohour?fsym=${pair.cc}&tsym=USDT&limit=100`);
      await new Promise(r => setTimeout(r, 500));
      const data4h = await ccFetch(`/data/v2/histohour?fsym=${pair.cc}&tsym=USDT&limit=200&aggregate=4`);
      await new Promise(r => setTimeout(r, 500));

      const candles1h = data1h.Response === 'Success' ? data1h.Data.Data : [];
      const candles4h = data4h.Response === 'Success' ? data4h.Data.Data : [];

      if (candles1h.length < 26) {
        console.error(`${pair.sym}: only ${candles1h.length} candles returned`);
        continue;
      }

      const result = await processPairData(pair, candles1h, candles4h);
      data.push(result);
    } catch (e) {
      console.error(`${pair.sym} failed: ${e.message}`);
    }
  }

  console.log(`Scan complete: ${data.length}/4 pairs loaded`);
  if (data.length === 0) throw new Error('All requests failed');
  addToHistory(data);
  return data;
}

// ── ROUTES ────────────────────────────────────────────────
app.get('/api/scan', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.data && (now - cache.ts) < CACHE_TTL) {
      return res.json({
        ok: true,
        data: cache.data,
        history: signalHistory.slice().reverse(),
        cached: true,
        timestamp: new Date().toISOString()
      });
    }
    const data = await buildSignals();
    cache = { data, ts: Date.now() };
    res.json({
      ok: true,
      data,
      history: signalHistory.slice().reverse(), // newest first
      cached: false,
      timestamp: new Date().toISOString()
    });
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
      pairs: PAIRS.map(p => p.sym),
      scoring: 'weighted 0-10, active thresholds (>=6)',
      atr: 'real 14-period from OHLC'
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Defi Insider Signal Bot running on port ${PORT}`));
