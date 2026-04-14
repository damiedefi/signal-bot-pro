const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── PAIRS ─────────────────────────────────────────────────
const PAIRS = [
  { sym:'BTC',  cc:'BTC',  mcap:1.32e12 },
  { sym:'ETH',  cc:'ETH',  mcap:382e9 },
  { sym:'BNB',  cc:'BNB',  mcap:61e9 },
  { sym:'SOL',  cc:'SOL',  mcap:77e9 },
  { sym:'DOGE', cc:'DOGE', mcap:23e9 },
  { sym:'AVAX', cc:'AVAX', mcap:14e9 },
  { sym:'LINK', cc:'LINK', mcap:8.5e9 },
  { sym:'NEAR', cc:'NEAR', mcap:6.8e9 },
  { sym:'UNI',  cc:'UNI',  mcap:5.9e9 },
  { sym:'INJ',  cc:'INJ',  mcap:2.4e9 },
  { sym:'SUI',  cc:'SUI',  mcap:2.1e9 },
  { sym:'TAO',  cc:'TAO',  mcap:1.8e9 }
];

// ── TELEGRAM ──────────────────────────────────────────────
const TG_TOKEN   = process.env.TG_TOKEN   || '8657562447:AAGGn9GzBf8mHyP44ZAukdM702ls_NlboDI';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '5337031418';

async function sendTelegram(text) {
  try {
    const { default: fetch } = await import('node-fetch');
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('TG error:', e.message); }
}

function fmtP(p) {
  if (!p) return '--';
  if (p >= 10000) return '$' + Math.round(p).toLocaleString();
  if (p >= 1)     return '$' + p.toFixed(2);
  if (p >= 0.01)  return '$' + p.toFixed(4);
  return '$' + p.toFixed(6);
}

function leverageFromScore(score, conf) {
  if (conf === 3 && score >= 9)   return '3x-5x';
  if (conf === 3 && score >= 8.5) return '2x-3x';
  if (conf === 2 && score >= 7)   return '1x-2x';
  return '1x spot';
}

function formatTGSignal(s, sig) {
  const e = sig.dir === 'BUY' ? '🟢' : '🔴';
  return `${e} <b>${sig.dir} ${s.sym}/USDT</b>
${'⭐'.repeat(sig.conf)} Score: <b>${sig.score}/10</b>

📍 Entry:    <b>${fmtP(s.price)}</b>
🛑 Stop:     <b>${fmtP(sig.sl)}</b>
🎯 TP1:      <b>${fmtP(sig.tp1)}</b>
🎯 TP2:      <b>${fmtP(sig.tp2)}</b>
⚡ Leverage: <b>${leverageFromScore(sig.score, sig.conf)}</b>

${sig.trendNote}
🤖 Defi Insider Signal Bot`;
}

// ── DATA FETCHING ─────────────────────────────────────────
// One CryptoCompare call per pair, 4H derived from 1H grouping
// Per-pair cache so failed fetches use last good data

const pairCache = {};

async function fetchCC(sym) {
  const { default: fetch } = await import('node-fetch');
  const url = `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${sym}&tsym=USD&limit=200`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.Response !== 'Success') throw new Error(json.Message || 'CC error');
  // Drop last candle (open/incomplete), filter zeroes
  return json.Data.Data
    .slice(0, -1)
    .map(c => ({ time:c.time, open:c.open, high:c.high, low:c.low, close:c.close, volume:c.volumeto||0 }))
    .filter(c => c.close > 0);
}

async function fetchCG(sym) {
  const IDS = {
    BTC:'bitcoin', ETH:'ethereum', BNB:'binancecoin', SOL:'solana',
    DOGE:'dogecoin', AVAX:'avalanche-2', LINK:'chainlink', NEAR:'near',
    UNI:'uniswap', INJ:'injective-protocol', SUI:'sui', TAO:'bittensor'
  };
  const id = IDS[sym];
  if (!id) throw new Error('No CG id for ' + sym);
  const { default: fetch } = await import('node-fetch');
  const url = `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=7`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`CG HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length < 10) throw new Error('CG insufficient data');
  return data
    .map(c => ({ time:Math.floor(c[0]/1000), open:c[1], high:c[2], low:c[3], close:c[4], volume:0 }))
    .filter(c => c.close > 0);
}

function derive4H(candles1h) {
  const out = [];
  for (let i = 0; i + 3 < candles1h.length; i += 4) {
    const g = candles1h.slice(i, i + 4);
    out.push({
      time:   g[0].time,
      open:   g[0].open,
      high:   Math.max(...g.map(c => c.high)),
      low:    Math.min(...g.map(c => c.low)),
      close:  g[g.length - 1].close,
      volume: g.reduce((s, c) => s + c.volume, 0)
    });
  }
  return out;
}

async function getCandles(sym) {
  // Try CC first, then CG, then cache
  for (const [name, fn] of [['CC', () => fetchCC(sym)], ['CG', () => fetchCG(sym)]]) {
    try {
      const candles1h = await fn();
      const candles4h = derive4H(candles1h);
      pairCache[sym] = { candles1h, candles4h, ts: Date.now() };
      console.log(`✓ ${sym} (${name})`);
      return { candles1h, candles4h };
    } catch (e) {
      console.log(`✗ ${sym} ${name}: ${e.message}`);
    }
  }
  if (pairCache[sym]) {
    const age = Math.round((Date.now() - pairCache[sym].ts) / 60000);
    console.log(`⚠ ${sym}: using cache (${age}m old)`);
    return pairCache[sym];
  }
  throw new Error(`${sym}: all sources failed`);
}

// ── INDICATORS ────────────────────────────────────────────
function calcRSI(closes, p = 14) {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) g += d; else l += Math.abs(d);
  }
  const ag = g/p, al = l/p;
  return al === 0 ? 100 : Math.round(100 - 100/(1 + ag/al));
}

function calcMACD(closes) {
  function ema(arr, p) {
    const k = 2/(p+1); let e = arr[0];
    for (let i = 1; i < arr.length; i++) e = arr[i]*k + e*(1-k);
    return e;
  }
  if (closes.length < 26) return { hist:0, bull:false };
  const hist = ema(closes.slice(-26), 12) - ema(closes.slice(-26), 26);
  return { hist, bull: hist > 0 };
}

function calcBB(closes, p = 20) {
  if (closes.length < p) return { pos:'mid', pct:50, pctB:0.5 };
  const sl = closes.slice(-p);
  const mid = sl.reduce((a,b) => a+b, 0) / p;
  const std = Math.sqrt(sl.reduce((s,v) => s + Math.pow(v-mid,2), 0) / p);
  const upper = mid + 2*std, lower = mid - 2*std;
  const last = closes[closes.length-1];
  const range = upper - lower;
  const pctB = range === 0 ? 0.5 : (last - lower) / range;
  const pct = Math.max(0, Math.min(100, Math.round(pctB*100)));
  return { pos: pct>70?'upper':pct<30?'lower':'mid', pct, pctB };
}

function calcATR(candles, p = 14) {
  if (candles.length < p+1) return candles[candles.length-1].close * 0.02;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low  - candles[i-1].close)
    ));
  }
  return trs.slice(-p).reduce((a,b) => a+b, 0) / p;
}

function calcEMA(closes, p) {
  const k = 2/(p+1); let e = closes[0];
  for (let i = 1; i < closes.length; i++) e = closes[i]*k + e*(1-k);
  return e;
}

function getTrend(closes, fast, slow) {
  if (closes.length < slow) return null;
  return { trend: calcEMA(closes, fast) > calcEMA(closes, slow) ? 'bull' : 'bear' };
}

// ── SIGNAL LOGIC — SEQUENTIAL HIERARCHY ──────────────────
function getSignals(rsi, macd, bb, volRatio, trend1h, trend4h, atr, price) {
  // Step 1: 1H and 4H must agree — if not, no signal
  if (trend1h && trend4h && trend1h.trend !== trend4h.trend) return [];
  const trendDir = trend4h?.trend || trend1h?.trend || null;
  if (!trendDir) return [];

  // Step 2: MACD must align with trend
  if (trendDir === 'bull' && !macd.bull) return [];
  if (trendDir === 'bear' &&  macd.bull) return [];

  // Step 3: BB sanity — ignore corrupted readings
  const bbB = (bb.pctB > 0.05 && bb.pctB < 0.95) ? bb.pctB : 0.5;

  // Step 4: Score the setup quality
  let score = 6.0; // baseline: trend + MACD confirmed

  if (trendDir === 'bull') {
    if      (rsi < 30) score += 2.5;
    else if (rsi < 38) score += 1.5;
    else if (rsi < 45) score += 0.5;
    else if (rsi > 65) score -= 1.5;
    else if (rsi > 55) score -= 0.5;
    if      (bbB < 0.20) score += 1.5;
    else if (bbB < 0.35) score += 0.5;
    else if (bbB > 0.80) score -= 1.0;
  } else {
    if      (rsi > 70) score += 2.5;
    else if (rsi > 62) score += 1.5;
    else if (rsi > 55) score += 0.5;
    else if (rsi < 35) score -= 1.5;
    else if (rsi < 45) score -= 0.5;
    if      (bbB > 0.80) score += 1.5;
    else if (bbB > 0.65) score += 0.5;
    else if (bbB < 0.20) score -= 1.0;
  }

  // Step 5: Volume
  if      (volRatio > 0.05) score += 0.5;
  else if (volRatio < 0.005) score -= 1.0;

  score = Math.max(0, Math.min(10, +score.toFixed(1)));
  const conf = score >= 8.5 ? 3 : score >= 6.5 ? 2 : 1;
  const trendNote = `1H: ${trend1h?.trend?.toUpperCase()||'?'} · 4H: ${trend4h?.trend?.toUpperCase()||'?'} · MACD: ${macd.bull?'BULL':'BEAR'}`;

  if (trendDir === 'bull') {
    return [{
      dir:'BUY', score, conf, aligned:true, trendNote,
      swing: score >= 7.0 ? 'BUY' : 'WATCH',
      scalp: score >= 6.5 ? 'BUY' : 'WATCH',
      sl:  +(price - atr*1.5).toFixed(4),
      tp1: +(price + atr*2.0).toFixed(4),
      tp2: +(price + atr*3.5).toFixed(4)
    }];
  } else {
    return [{
      dir:'SELL', score, conf, aligned:true, trendNote,
      swing: score >= 7.0 ? 'SELL' : 'WATCH',
      scalp: score >= 6.5 ? 'SELL' : 'WATCH',
      sl:  +(price + atr*1.5).toFixed(4),
      tp1: +(price - atr*2.0).toFixed(4),
      tp2: +(price - atr*3.5).toFixed(4)
    }];
  }
}

// ── PROCESS PAIR ──────────────────────────────────────────
async function processPair(pair) {
  const { candles1h, candles4h } = await getCandles(pair.sym);
  if (candles1h.length < 26) throw new Error('Insufficient candles');

  const closes1h = candles1h.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);
  const price    = closes1h[closes1h.length - 1];

  const rsi     = calcRSI(closes1h, 14);
  const macd    = calcMACD(closes1h);
  const bb      = calcBB(closes1h, 20);
  const atr     = calcATR(candles1h, 14);
  const trend1h = getTrend(closes1h, 9, 21);
  const trend4h = getTrend(closes4h, 20, 50);

  const price24hAgo = closes1h.length >= 24 ? closes1h[closes1h.length-24] : closes1h[0];
  const pct24h = ((price - price24hAgo) / price24hAgo) * 100;
  const lastC  = candles1h[candles1h.length-1];
  const vol    = lastC.volume || 0;
  const mcap   = pair.mcap || 0;
  const volRatio = mcap > 0 ? (vol * price) / mcap : 0;

  const signals  = getSignals(rsi, macd, bb, volRatio, trend1h, trend4h, atr, price);
  const topSig   = signals[0];

  console.log(`${pair.sym}: RSI=${rsi} MACD=${macd.bull?'B':'b'} 1H=${trend1h?.trend||'?'} 4H=${trend4h?.trend||'?'} → ${topSig?topSig.dir+' '+topSig.score:'HOLD'}`);

  return {
    sym:pair.sym, price, pct24h, vol:vol*price, mcap, volRatio,
    rsi, macd, bb, atr, trend1h, trend4h,
    score:   topSig?.score  || 5,
    swing:   topSig?.swing  || 'HOLD',
    scalp:   topSig?.scalp  || 'HOLD',
    conf:    topSig?.conf   || 1,
    aligned: topSig?.aligned || null,
    trendNote: topSig?.trendNote || '',
    signals
  };
}

// ── SIGNAL HISTORY ────────────────────────────────────────
let signalHistory = [];
const HISTORY_TTL = 4 * 60 * 60 * 1000;

function addToHistory(results) {
  const now = Date.now();
  signalHistory = signalHistory.filter(h => (now - h.ts) < HISTORY_TTL);
  results.forEach(s => {
    if (!s.signals) return;
    s.signals.forEach(sig => {
      const isDupe = signalHistory.some(h =>
        h.sym === s.sym && h.dir === sig.dir && (now - h.ts) < 5*60*1000
      );
      if (!isDupe) {
        if (sig.conf === 3) sendTelegram(formatTGSignal(s, sig));
        signalHistory.push({
          sym:s.sym, price:s.price, dir:sig.dir, score:sig.score,
          conf:sig.conf, sl:sig.sl, tp1:sig.tp1, tp2:sig.tp2,
          swing:sig.swing, scalp:sig.scalp, aligned:sig.aligned,
          trendNote:sig.trendNote, rsi:s.rsi, atr:s.atr,
          ts:now, timeStr:new Date(now).toUTCString().slice(17,25)
        });
      }
    });
  });
}

// ── SCAN ─────────────────────────────────────────────────
let cache = { data:null, ts:0 };
const CACHE_TTL = 60*1000;

async function buildSignals() {
  console.log('Starting scan...');
  const data = [];
  for (const pair of PAIRS) {
    try {
      const result = await processPair(pair);
      data.push(result);
    } catch(e) {
      console.error(`${pair.sym}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  console.log(`Scan done: ${data.length}/${PAIRS.length}`);
  if (data.length === 0) throw new Error('All requests failed');
  addToHistory(data);
  return data;
}

// ── ROUTES ────────────────────────────────────────────────
app.get('/api/scan', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.data && (now - cache.ts) < CACHE_TTL) {
      return res.json({ ok:true, data:cache.data, history:signalHistory.slice().reverse(), cached:true, timestamp:new Date().toISOString() });
    }
    const data = await buildSignals();
    cache = { data, ts:Date.now() };
    res.json({ ok:true, data, history:signalHistory.slice().reverse(), cached:false, timestamp:new Date().toISOString() });
  } catch(e) {
    console.error('Scan error:', e.message);
    // Return cached data if available rather than error
    if (cache.data) {
      return res.json({ ok:true, data:cache.data, history:signalHistory.slice().reverse(), cached:true, stale:true, timestamp:new Date().toISOString() });
    }
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post('/api/trade-alert', async (req, res) => {
  const { sym, dir, entry, sl, tp1, tp2, score, conf, type } = req.body;
  const msgs = {
    entered: `📥 <b>TRADE ENTERED</b>\n\n${dir==='BUY'?'🟢':'🔴'} <b>${sym}/USDT ${dir}</b>\nScore: ${score}/10 ${'⭐'.repeat(conf)}\n\n📍 Entry: ${entry}\n🛑 Stop:  ${sl}\n🎯 TP1:   ${tp1}\n🎯 TP2:   ${tp2}\n\n🤖 Defi Insider Signal Bot`,
    sl_hit:  `🚨 <b>STOP LOSS HIT</b>\n\n<b>${sym}/USDT ${dir}</b>\nEntry: ${entry} → Stop: ${sl}\n\n🤖 Defi Insider Signal Bot`,
    tp1_hit: `🎯 <b>TP1 REACHED</b>\n\n<b>${sym}/USDT ${dir}</b>\nTP1: ${tp1} hit ✅\nConsider moving stop to breakeven.\n\n🤖 Defi Insider Signal Bot`
  };
  if (msgs[type]) await sendTelegram(msgs[type]);
  res.json({ ok:true });
});

app.get('/api/health', async (req, res) => {
  try {
    const candles = await fetchCC('BTC');
    const price = candles[candles.length-1]?.close;
    res.json({ ok:true, source:'CryptoCompare', btcPrice:'$'+price?.toLocaleString(), pairs:PAIRS.map(p=>p.sym), cached:Object.keys(pairCache) });
  } catch(e) {
    res.json({ ok:false, error:e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Defi Insider Signal Bot on port ${PORT}`));
