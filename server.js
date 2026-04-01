const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.static('public'));

const PAIRS = [
  { sym: 'BTC',   cc: 'BTC' },
  { sym: 'ETH',   cc: 'ETH' },
  { sym: 'BNB',   cc: 'BNB' },
  { sym: 'SOL',   cc: 'SOL' },
  { sym: 'XRP',   cc: 'XRP' },
  { sym: 'DOGE',  cc: 'DOGE' },
  { sym: 'ADA',   cc: 'ADA' },
  { sym: 'AVAX',  cc: 'AVAX' },
  { sym: 'LINK',  cc: 'LINK' },
  { sym: 'DOT',   cc: 'DOT' },
  { sym: 'MATIC', cc: 'MATIC' },
  { sym: 'UNI',   cc: 'UNI' },
  { sym: 'LTC',   cc: 'LTC' },
  { sym: 'ATOM',  cc: 'ATOM' },
  { sym: 'NEAR',  cc: 'NEAR' },
  { sym: 'FIL',   cc: 'FIL' },
  { sym: 'ARB',   cc: 'ARB' },
  { sym: 'OP',    cc: 'OP' },
  { sym: 'INJ',   cc: 'INJ' },
  { sym: 'SUI',   cc: 'SUI' }
];

const MCAPS = {
  BTC:1.32e12, ETH:382e9,  BNB:61e9,   SOL:77e9,
  XRP:58e9,    DOGE:23e9,  ADA:16e9,   AVAX:14e9,
  LINK:8.5e9,  DOT:9.8e9,  MATIC:7.1e9, UNI:5.9e9,
  LTC:6.1e9,   ATOM:3.2e9, NEAR:6.8e9,  FIL:3.1e9,
  ARB:3.6e9,   OP:2.9e9,   INJ:2.4e9,   SUI:2.1e9
};

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
  if (closes.length < period) return { pos: 'mid', pct: 50 };
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mid, 2), 0) / period);
  const upper = mid + 2 * std, lower = mid - 2 * std;
  const last = closes[closes.length - 1];
  const range = upper - lower;
  const pct = range === 0 ? 50 : Math.round(((last - lower) / range) * 100);
  const c = Math.max(0, Math.min(100, pct));
  return { pos: c > 70 ? 'upper' : c < 30 ? 'lower' : 'mid', pct: c };
}

function getSignal(rsi, macd, bb, pct7d, vol, mcap) {
  let bull = 0, bear = 0;
  if (rsi < 38) bull++; else if (rsi > 62) bear++;
  if (macd.bull) bull++; else bear++;
  if (bb.pos === 'lower') bull++; else if (bb.pos === 'upper') bear++;
  if (typeof pct7d === 'number') {
    if (pct7d > 2) bull++; else if (pct7d < -2) bear++;
  }
  const hasVol = vol && mcap && (vol / mcap) > 0.01;
  if (!hasVol) bull = Math.max(0, bull - 1);
  if (bull >= 3 && hasVol) return { swing: 'BUY',  scalp: 'BUY',  conf: Math.min(3, bull) };
  if (bull >= 2 && hasVol) return { swing: rsi < 40 ? 'BUY' : 'WATCH', scalp: 'BUY', conf: 2 };
  if (bear >= 3 && hasVol) return { swing: 'SELL', scalp: 'SELL', conf: Math.min(3, bear) };
  if (bear >= 2 && hasVol) return { swing: rsi > 60 ? 'SELL' : 'WATCH', scalp: 'SELL', conf: 2 };
  return { swing: 'HOLD', scalp: 'HOLD', conf: 1 };
}

// ── CRYPTOCOMPARE FETCH — no API key needed ───────────────
async function ccFetch(path) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch('https://min-api.cryptocompare.com' + path, {
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`CryptoCompare ${res.status}`);
  return res.json();
}

async function processPair(pair) {
  // Fetch 50 hourly candles — real OHLCV data, no API key required
  const data = await ccFetch(
    `/data/v2/histohour?fsym=${pair.cc}&tsym=USDT&limit=50`
  );
  if (data.Response !== 'Success') throw new Error(data.Message || 'API error');
  const candles = data.Data.Data;
  if (!candles || candles.length < 20) throw new Error('Insufficient candles');

  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];

  const rsi  = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const bb   = calcBB(closes, 20);

  // 24h and 7d change
  const price24hAgo = closes.length >= 24 ? closes[closes.length - 24] : closes[0];
  const price7dAgo  = closes.length >= 48  ? closes[0] : closes[0];
  const pct24h = ((price - price24hAgo) / price24hAgo) * 100;
  const pct7d  = ((price - price7dAgo)  / price7dAgo)  * 100;

  // Volume from last candle (in USD)
  const lastCandle = candles[candles.length - 1];
  const vol = lastCandle.volumeto || 0;
  const mcap = MCAPS[pair.sym] || 0;

  const sig = getSignal(rsi, macd, bb, pct7d, vol, mcap);

  console.log(`${pair.sym}: RSI=${rsi} MACD=${macd.bull?'BULL':'BEAR'} BB=${bb.pos} → ${sig.swing}`);

  return {
    sym: pair.sym, price, pct24h, pct7d,
    vol, mcap, rsi, macd, bb, ...sig
  };
}

// ── CACHE ─────────────────────────────────────────────────
let cache = { data: null, ts: 0 };
const CACHE_TTL = 60 * 1000;

async function buildSignals() {
  console.log('Starting CryptoCompare scan...');
  // CryptoCompare free tier is generous — run all in parallel
  const results = await Promise.allSettled(PAIRS.map(processPair));
  const data = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
  const failed = results.filter(r => r.status === 'rejected').length;
  console.log(`Scan complete: ${data.length} success, ${failed} failed`);
  if (data.length === 0) throw new Error('All CryptoCompare requests failed');
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
    const data = await ccFetch('/data/price?fsym=BTC&tsyms=USDT');
    res.json({
      ok: true,
      cryptocompare: data.USDT ? 'connected' : 'error',
      btcPrice: data.USDT ? '$' + data.USDT.toLocaleString() : null,
      apiKey: 'none required',
      pairs: PAIRS.length
    });
  } catch (e) {
    res.json({ ok: false, cryptocompare: 'error', error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Signal Bot Pro running on port ${PORT}`));
