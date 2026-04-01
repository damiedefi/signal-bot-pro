const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.static('public'));

const PAIRS = [
  { sym: 'BTC',   id: 'bitcoin' },
  { sym: 'ETH',   id: 'ethereum' },
  { sym: 'BNB',   id: 'binancecoin' },
  { sym: 'SOL',   id: 'solana' },
  { sym: 'XRP',   id: 'ripple' },
  { sym: 'DOGE',  id: 'dogecoin' },
  { sym: 'ADA',   id: 'cardano' },
  { sym: 'AVAX',  id: 'avalanche-2' },
  { sym: 'LINK',  id: 'chainlink' },
  { sym: 'DOT',   id: 'polkadot' },
  { sym: 'MATIC', id: 'matic-network' },
  { sym: 'UNI',   id: 'uniswap' },
  { sym: 'LTC',   id: 'litecoin' },
  { sym: 'ATOM',  id: 'cosmos' },
  { sym: 'NEAR',  id: 'near' },
  { sym: 'FIL',   id: 'filecoin' },
  { sym: 'ARB',   id: 'arbitrum' },
  { sym: 'OP',    id: 'optimism' },
  { sym: 'INJ',   id: 'injective-protocol' },
  { sym: 'SUI',   id: 'sui' }
];

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

async function cgFetch(path) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch('https://api.coingecko.com/api/v3' + path, {
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error('CoinGecko ' + res.status);
  return res.json();
}

let cache = { data: null, ts: 0 };
const CACHE_TTL = 90 * 1000;

async function buildSignals() {
  const ids = PAIRS.map(p => p.id).join(',');
  const markets = await cgFetch(
    `/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=25&price_change_percentage=24h,7d`
  );
  const mktMap = {};
  markets.forEach(c => { mktMap[c.id] = c; });

  const results = [];
  for (const pair of PAIRS) {
    try {
      const ohlc = await cgFetch(`/coins/${pair.id}/ohlc?vs_currency=usd&days=30`);
      const closes = ohlc.map(d => d[4]);
      if (closes.length < 20) continue;
      const rsi  = calcRSI(closes, 14);
      const macd = calcMACD(closes);
      const bb   = calcBB(closes, 20);
      const m    = mktMap[pair.id] || {};
      const vol  = m.total_volume || 0;
      const mcap = m.market_cap   || 0;
      const pct7d = m.price_change_percentage_7d_in_currency || 0;
      const sig  = getSignal(rsi, macd, bb, pct7d, vol, mcap);
      results.push({
        sym: pair.sym, price: m.current_price || 0,
        pct24h: m.price_change_percentage_24h || 0,
        pct7d, vol, mcap, rsi, macd, bb, ...sig
      });
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.error(`${pair.sym}: ${e.message}`);
    }
  }
  return results;
}

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

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Signal Bot Pro running', pairs: PAIRS.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Signal Bot Pro running on port ${PORT}`));
