const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.static('public'));

const PAIRS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT',
  'MATICUSDT','UNIUSDT','LTCUSDT','ATOMUSDT','NEARUSDT',
  'FILUSDT','ARBUSDT','OPUSDT','INJUSDT','SUIUSDT'
];

const MCAPS = {
  BTCUSDT:1.32e12, ETHUSDT:382e9,  BNBUSDT:61e9,   SOLUSDT:77e9,
  XRPUSDT:58e9,    DOGEUSDT:23e9,  ADAUSDT:16e9,   AVAXUSDT:14e9,
  LINKUSDT:8.5e9,  DOTUSDT:9.8e9,  MATICUSDT:7.1e9, UNIUSDT:5.9e9,
  LTCUSDT:6.1e9,   ATOMUSDT:3.2e9, NEARUSDT:6.8e9,  FILUSDT:3.1e9,
  ARBUSDT:3.6e9,   OPUSDT:2.9e9,   INJUSDT:2.4e9,   SUIUSDT:2.1e9
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
  const fast = ema(closes.slice(-12), 12);
  const slow = ema(closes.slice(-26), 26);
  const hist = fast - slow;
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
  const clamped = Math.max(0, Math.min(100, pct));
  return { pos: clamped > 70 ? 'upper' : clamped < 30 ? 'lower' : 'mid', pct: clamped };
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

// ── BINANCE FETCH ─────────────────────────────────────────
async function fetchBinance(path) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch('https://api.binance.com' + path);
  if (!res.ok) throw new Error('Binance error: ' + res.status);
  return res.json();
}

async function processPair(symbol) {
  const [klines, ticker] = await Promise.all([
    fetchBinance(`/api/v3/klines?symbol=${symbol}&interval=1h&limit=50`),
    fetchBinance(`/api/v3/ticker/24hr?symbol=${symbol}`)
  ]);
  const closes = klines.map(k => parseFloat(k[4]));
  const rsi  = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const bb   = calcBB(closes, 20);
  const price  = parseFloat(ticker.lastPrice);
  const pct24h = parseFloat(ticker.priceChangePercent);
  const vol    = parseFloat(ticker.quoteVolume);
  const open   = parseFloat(ticker.openPrice);
  const pct7d  = ((price - open) / open) * 100;
  const sig = getSignal(rsi, macd, bb, pct7d, vol, MCAPS[symbol]);
  return {
    sym: symbol.replace('USDT', ''),
    symbol, price, pct24h, pct7d,
    vol, mcap: MCAPS[symbol],
    rsi, macd, bb, ...sig
  };
}

// ── API ENDPOINT ──────────────────────────────────────────
app.get('/api/scan', async (req, res) => {
  try {
    const results = await Promise.allSettled(PAIRS.map(processPair));
    const data = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);
    res.json({ ok: true, data, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Signal Bot Pro backend running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Signal Bot running on port ${PORT}`));
