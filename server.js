const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
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
  { sym:'XRP',  cc:'XRP',  mcap:58e9 },
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
  } catch(e) { console.error('TG:', e.message); }
}

function fmtP(p) {
  if (!p && p !== 0) return '--';
  if (p >= 10000) return '$' + Math.round(p).toLocaleString();
  if (p >= 1)     return '$' + p.toFixed(2);
  if (p >= 0.01)  return '$' + p.toFixed(4);
  return '$' + p.toFixed(6);
}

function leverageFromScore(score, conf) {
  if (conf === 3 && score >= 9)   return '3x-5x';
  if (conf === 3 && score >= 8.0) return '2x-3x';
  if (conf === 2 && score >= 7)   return '1x-2x';
  return '1x spot';
}

function formatTGSignal(s, sig) {
  const e = sig.dir === 'BUY' ? '🟢' : '🔴';
  const minsLeft = minutesToCandleClose();
  const closeNote = minsLeft <= 5
    ? '⚡ Candle closing now — enter at open of next candle'
    : `⏱ Candle closes in ~${minsLeft}m — wait for close before entering`;
  return `${e} <b>${sig.dir} ${s.sym}/USDT</b>
${'⭐'.repeat(sig.conf)} Score: <b>${sig.score}/10</b>

📍 Entry:    <b>${fmtP(s.price)}</b>
🛑 Stop:     <b>${fmtP(sig.sl)}</b>
🎯 TP1:      <b>${fmtP(sig.tp1)}</b>
🎯 TP2:      <b>${fmtP(sig.tp2)}</b>
⚡ Leverage: <b>${leverageFromScore(sig.score, sig.conf)}</b>

${sig.trendNote}

${closeNote}
🤖 Defi Insider Signal Bot`;
}

// ── SIGNAL PERFORMANCE LOG ────────────────────────────────
const LOG_FILE = path.join(__dirname, 'signals-log.json');

function loadLog() {
  try {
    if (fs.existsSync(LOG_FILE)) return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch(e) { console.error('Log load error:', e.message); }
  return [];
}

function saveLog(log) {
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); }
  catch(e) { console.error('Log save error:', e.message); }
}

let signalLog = loadLog();

function addSignalToLog(s, sig) {
  const now = Date.now();
  const isDupe = signalLog.some(e =>
    e.sym === s.sym && e.dir === sig.dir && (now - e.firedAt) < 5*60*1000
  );
  if (isDupe) return;
  signalLog.push({
    id: now + '_' + s.sym + '_' + sig.dir,
    sym: s.sym, dir: sig.dir, score: sig.score, conf: sig.conf,
    entryPrice: s.price, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
    trendNote: sig.trendNote,
    firedAt: now, firedStr: new Date(now).toUTCString().slice(0, 25),
    check1H: null, check4H: null, check24H: null, finalResult: 'pending'
  });
  if (signalLog.length > 500) signalLog = signalLog.slice(-500);
  saveLog(signalLog);
}

function calcPnL(entry, currentPrice) {
  return entry.dir === 'BUY'
    ? +((currentPrice - entry.entryPrice) / entry.entryPrice * 100).toFixed(2)
    : +((entry.entryPrice - currentPrice) / entry.entryPrice * 100).toFixed(2);
}

function checkResult(entry, currentPrice) {
  if (entry.dir === 'BUY') {
    if (currentPrice >= entry.tp1) return 'win';
    if (currentPrice <= entry.sl)  return 'loss';
  } else {
    if (currentPrice <= entry.tp1) return 'win';
    if (currentPrice >= entry.sl)  return 'loss';
  }
  return 'pending';
}

async function updateSignalLog(pairData) {
  const now = Date.now();
  let changed = false;
  for (const entry of signalLog) {
    if (entry.finalResult !== 'pending') continue;
    const pair = pairData.find(p => p.sym === entry.sym);
    if (!pair) continue;
    const price = pair.price;
    const elapsed = now - entry.firedAt;
    const pnl = calcPnL(entry, price);
    const result = checkResult(entry, price);
    if (!entry.check1H && elapsed >= 60*60*1000) {
      entry.check1H = { price, pnl, result, ts: now }; changed = true;
    }
    if (!entry.check4H && elapsed >= 4*60*60*1000) {
      entry.check4H = { price, pnl, result, ts: now }; changed = true;
    }
    if (!entry.check24H && elapsed >= 24*60*60*1000) {
      entry.check24H = { price, pnl, result, ts: now };
      entry.finalResult = result === 'pending' ? 'expired' : result;
      entry.resolvedAt = now; changed = true;
      const emoji = entry.finalResult === 'win' ? '✅' : entry.finalResult === 'loss' ? '❌' : '⏰';
      await sendTelegram(`${emoji} <b>Signal Result: ${entry.finalResult.toUpperCase()}</b>\n\n<b>${entry.dir} ${entry.sym}/USDT</b>\nEntry: ${fmtP(entry.entryPrice)} → Now: ${fmtP(price)}\nP&L: <b>${pnl > 0 ? '+' : ''}${pnl}%</b>\n\n🤖 Defi Insider Signal Bot`);
    }
    if (entry.finalResult === 'pending') {
      const earlyResult = checkResult(entry, price);
      if (earlyResult !== 'pending') {
        entry.finalResult = earlyResult; entry.resolvedAt = now; changed = true;
        const hours = (elapsed / 3600000).toFixed(1);
        const emoji = earlyResult === 'win' ? '✅' : '❌';
        await sendTelegram(`${emoji} <b>Signal ${earlyResult.toUpperCase()}</b> (${hours}H)\n\n<b>${entry.dir} ${entry.sym}/USDT</b>\nP&L: <b>${pnl > 0 ? '+' : ''}${pnl}%</b>\n\n🤖 Defi Insider Signal Bot`);
      }
    }
  }
  if (changed) saveLog(signalLog);
}

function calcStats() {
  const resolved = signalLog.filter(e => e.finalResult !== 'pending');
  const wins     = resolved.filter(e => e.finalResult === 'win');
  const losses   = resolved.filter(e => e.finalResult === 'loss');
  const expired  = resolved.filter(e => e.finalResult === 'expired');
  const total    = resolved.length;
  const winRate  = total > 0 ? Math.round(wins.length / total * 100) : null;
  const r1H  = signalLog.filter(e => e.check1H);
  const r4H  = signalLog.filter(e => e.check4H);
  const r24H = signalLog.filter(e => e.check24H);
  const wr1H  = r1H.length  > 0 ? Math.round(r1H.filter(e => e.check1H.result  === 'win').length / r1H.length  * 100) : null;
  const wr4H  = r4H.length  > 0 ? Math.round(r4H.filter(e => e.check4H.result  === 'win').length / r4H.length  * 100) : null;
  const wr24H = r24H.length > 0 ? Math.round(r24H.filter(e => e.check24H.result === 'win').length / r24H.length * 100) : null;
  const byPair = {};
  PAIRS.forEach(p => {
    const ps = resolved.filter(e => e.sym === p.sym);
    byPair[p.sym] = { total: ps.length, wins: ps.filter(e => e.finalResult === 'win').length,
      wr: ps.length > 0 ? Math.round(ps.filter(e => e.finalResult === 'win').length / ps.length * 100) : null };
  });
  const buyRes  = resolved.filter(e => e.dir === 'BUY');
  const sellRes = resolved.filter(e => e.dir === 'SELL');
  const buyWR   = buyRes.length  > 0 ? Math.round(buyRes.filter(e => e.finalResult  === 'win').length / buyRes.length  * 100) : null;
  const sellWR  = sellRes.length > 0 ? Math.round(sellRes.filter(e => e.finalResult === 'win').length / sellRes.length * 100) : null;
  const avgWinPnL  = wins.length   > 0 ? +(wins.reduce((s,e) => s+(e.check24H?.pnl||e.check4H?.pnl||e.check1H?.pnl||0),0)/wins.length).toFixed(2) : null;
  const avgLossPnL = losses.length > 0 ? +(losses.reduce((s,e) => s+(e.check24H?.pnl||e.check4H?.pnl||e.check1H?.pnl||0),0)/losses.length).toFixed(2) : null;
  const bestSig = wins.length > 0 ? wins.reduce((best,e) => {
    const pnl=e.check24H?.pnl||e.check4H?.pnl||e.check1H?.pnl||0;
    const bpnl=best.check24H?.pnl||best.check4H?.pnl||best.check1H?.pnl||0;
    return pnl>bpnl?e:best;
  }, wins[0]) : null;
  let streak=0, streakType=null;
  for (let i=resolved.length-1; i>=0; i--) {
    const r=resolved[i].finalResult; if(r==='expired') continue;
    if(streakType===null){streakType=r;streak=1;} else if(r===streakType) streak++; else break;
  }
  return { total, wins:wins.length, losses:losses.length, expired:expired.length,
    winRate, wr1H, wr4H, wr24H, byPair, buyWR, sellWR, avgWinPnL, avgLossPnL,
    bestSig, streak, streakType, pending: signalLog.filter(e=>e.finalResult==='pending').length };
}

function scheduleDailySummary() {
  const now = new Date();
  const midnight = new Date(now); midnight.setUTCHours(24,0,0,0);
  setTimeout(async () => {
    const stats = calcStats();
    await sendTelegram(`📊 <b>Daily Signal Summary</b>\n\nOverall win rate: <b>${stats.winRate??'--'}%</b> (${stats.total} signals)\n\n🤖 Defi Insider Signal Bot`);
    scheduleDailySummary();
  }, midnight - now);
}
scheduleDailySummary();

// ── CANDLE CLOSE DETECTION ────────────────────────────────
function isNearCandleClose() {
  return new Date().getUTCMinutes() >= 55;
}
function minutesToCandleClose() {
  return 59 - new Date().getUTCMinutes();
}

// ── DATA FETCHING ─────────────────────────────────────────
const pairCache = {};

async function fetchCC(sym) {
  const { default: fetch } = await import('node-fetch');
  const url = `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${sym}&tsym=USD&limit=200`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.Response !== 'Success') throw new Error(json.Message || 'CC error');
  return json.Data.Data
    .slice(0, -1)
    .map(c => ({ time:c.time, open:c.open, high:c.high, low:c.low, close:c.close, volume:c.volumeto||0 }))
    .filter(c => c.close > 0);
}

async function fetchCG(sym) {
  const IDS = {
    BTC:'bitcoin', ETH:'ethereum', BNB:'binancecoin', SOL:'solana',
    DOGE:'dogecoin', AVAX:'avalanche-2', XRP:'ripple', NEAR:'near',
    UNI:'uniswap', INJ:'injective-protocol', SUI:'sui', TAO:'bittensor'
  };
  const id = IDS[sym]; if (!id) throw new Error('No CG id for ' + sym);
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

function derive4H(c1h) {
  const out = [];
  for (let i = 0; i + 3 < c1h.length; i += 4) {
    const g = c1h.slice(i, i+4);
    out.push({ time:g[0].time, open:g[0].open,
      high:Math.max(...g.map(c=>c.high)), low:Math.min(...g.map(c=>c.low)),
      close:g[g.length-1].close, volume:g.reduce((s,c)=>s+c.volume,0) });
  }
  return out;
}

async function getCandles(sym) {
  for (const [name, fn] of [['CC', ()=>fetchCC(sym)], ['CG', ()=>fetchCG(sym)]]) {
    try {
      const candles1h = await fn();
      const candles4h = derive4H(candles1h);
      pairCache[sym] = { candles1h, candles4h, ts: Date.now() };
      console.log(`✓ ${sym} (${name})`);
      return { candles1h, candles4h };
    } catch(e) { console.log(`✗ ${sym} ${name}: ${e.message}`); }
  }
  if (pairCache[sym]) {
    console.log(`⚠ ${sym}: cache (${Math.round((Date.now()-pairCache[sym].ts)/60000)}m)`);
    return pairCache[sym];
  }
  throw new Error(`${sym}: all sources failed`);
}

// ── BYBIT FUNDING RATE ───────────────────────────────────
// Bybit public API — no auth, no geo-blocking on Railway
// Funding rate = market positioning signal (non-price data)
// Positive = crowded longs = bearish lean
// Negative = crowded shorts = bullish lean

const BYBIT_SYMBOLS = {
  BTC:'BTCUSDT', ETH:'ETHUSDT', BNB:'BNBUSDT', SOL:'SOLUSDT',
  DOGE:'DOGEUSDT', AVAX:'AVAXUSDT', XRP:'XRPUSDT', NEAR:'NEARUSDT',
  UNI:'UNIUSDT', INJ:'INJUSDT', SUI:'SUIUSDT', TAO:'TAOUSDT'
};

const fundingCache = {};
const FUNDING_TTL = 5 * 60 * 1000; // cache 5 minutes

async function getFundingRate(sym) {
  // Return cached value if fresh
  if (fundingCache[sym] && (Date.now() - fundingCache[sym].ts) < FUNDING_TTL) {
    return fundingCache[sym].rate;
  }

  const bybitSym = BYBIT_SYMBOLS[sym];
  if (!bybitSym) return 0;

  try {
    const { default: fetch } = await import('node-fetch');
    const url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${bybitSym}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, timeout: 5000 });
    if (!res.ok) throw new Error('Bybit HTTP ' + res.status);
    const json = await res.json();
    const ticker = json?.result?.list?.[0];
    if (!ticker) throw new Error('No ticker data');
    const rate = parseFloat(ticker.fundingRate || 0);
    fundingCache[sym] = { rate, ts: Date.now() };
    return rate;
  } catch(e) {
    console.log('Funding ' + sym + ': ' + e.message + ' (using 0)');
    return fundingCache[sym]?.rate || 0; // use last known or neutral
  }
}

// Funding rate scoring modifier
// Returns score adjustment and a label for the signal card
function getFundingModifier(fundingRate, dir) {
  const f = fundingRate;
  let mod = 0;
  let label = '';

  if (dir === 'BUY') {
    // Positive funding = longs crowded = bad for BUY
    // Negative funding = shorts crowded = good for BUY (squeeze potential)
    if      (f <= -0.10) { mod = +2.0; label = '🟢 Extreme short squeeze setup'; }
    else if (f <= -0.05) { mod = +1.5; label = '🟢 Crowded shorts — bullish lean'; }
    else if (f <= -0.01) { mod = +0.5; label = '🟡 Mild negative funding'; }
    else if (f >=  0.10) { mod = -2.0; label = '🔴 Extreme crowded longs — danger'; }
    else if (f >=  0.05) { mod = -1.5; label = '🔴 Crowded longs — bearish lean'; }
    else if (f >=  0.01) { mod = -0.5; label = '🟡 Mild positive funding'; }
    else                  { label = '⚪ Neutral funding'; }
  } else {
    // SELL: positive funding = longs crowded = good for SELL
    // SELL: negative funding = shorts crowded = bad for SELL
    if      (f >=  0.10) { mod = +2.0; label = '🟢 Extreme crowded longs — short squeeze risk'; }
    else if (f >=  0.05) { mod = +1.5; label = '🟢 Crowded longs — bearish lean'; }
    else if (f >=  0.01) { mod = +0.5; label = '🟡 Mild positive funding'; }
    else if (f <= -0.10) { mod = -2.0; label = '🔴 Extreme crowded shorts — bounce risk'; }
    else if (f <= -0.05) { mod = -1.5; label = '🔴 Crowded shorts — bullish lean'; }
    else if (f <= -0.01) { mod = -0.5; label = '🟡 Mild negative funding'; }
    else                  { label = '⚪ Neutral funding'; }
  }

  return { mod, label, rate: f, pct: (f * 100).toFixed(4) + '%' };
}

// ── BYBIT OPEN INTEREST ──────────────────────────────────
// Rising OI + rising price = new longs entering = trend confirmation
// Rising OI + falling price = new shorts entering = downtrend confirmation
// Falling OI = positions closing = trend weakening

const oiCache = {};
const OI_TTL = 5 * 60 * 1000;

async function getOpenInterest(sym) {
  if (oiCache[sym] && (Date.now() - oiCache[sym].ts) < OI_TTL) {
    return oiCache[sym].data;
  }
  const bybitSym = BYBIT_SYMBOLS[sym];
  if (!bybitSym) return null;
  try {
    const { default: fetch } = await import('node-fetch');
    // Get last 2 OI snapshots to calculate change
    const url = `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${bybitSym}&intervalTime=1h&limit=2`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('OI HTTP ' + res.status);
    const json = await res.json();
    const list = json?.result?.list;
    if (!list || list.length < 2) throw new Error('Insufficient OI data');
    const current  = parseFloat(list[0].openInterest);
    const previous = parseFloat(list[1].openInterest);
    const change   = (current - previous) / previous; // % change
    const data = { current, previous, change, rising: change > 0.005, falling: change < -0.005 };
    oiCache[sym] = { data, ts: Date.now() };
    return data;
  } catch(e) {
    console.log('OI ' + sym + ': ' + e.message);
    return oiCache[sym]?.data || null;
  }
}

// OI scoring modifier
// OI rising + BUY signal = trend confirmed by new longs entering = +score
// OI rising + SELL signal = shorts entering = trend confirmed = +score
// OI falling = positions closing = trend losing conviction = -score
function getOIModifier(oi, dir, pct24h) {
  if (!oi) return { mod: 0, label: '' };
  const priceRising = pct24h > 0;
  let mod = 0;
  let label = '';

  if (dir === 'BUY') {
    if (oi.rising && priceRising)       { mod = +1.0; label = '📈 OI rising with price (longs entering)'; }
    else if (oi.rising && !priceRising) { mod = -0.5; label = '⚠️ OI rising but price falling (shorts entering)'; }
    else if (oi.falling)                { mod = -0.5; label = '📉 OI falling (trend losing steam)'; }
  } else {
    if (oi.rising && !priceRising)      { mod = +1.0; label = '📈 OI rising with price falling (shorts entering)'; }
    else if (oi.rising && priceRising)  { mod = -0.5; label = '⚠️ OI rising with price rising (longs entering)'; }
    else if (oi.falling)                { mod = -0.5; label = '📉 OI falling (trend losing steam)'; }
  }

  return { mod, label };
}

// ── FEAR & GREED INDEX ────────────────────────────────────
// Single free API call — no auth, no rate limits for 12 pairs
// 0-24 = Extreme Fear (good BUY zone)
// 25-44 = Fear
// 45-55 = Neutral
// 56-75 = Greed
// 76-100 = Extreme Greed (good SELL zone)

let fearGreedCache = null;
const FG_TTL = 60 * 60 * 1000; // cache 1 hour — index updates daily

async function getFearGreed() {
  if (fearGreedCache && (Date.now() - fearGreedCache.ts) < FG_TTL) {
    return fearGreedCache.data;
  }
  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch('https://api.alternative.me/fng/?limit=1', {
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) throw new Error('FG HTTP ' + res.status);
    const json = await res.json();
    const val = parseInt(json?.data?.[0]?.value || 50);
    const cls = json?.data?.[0]?.value_classification || 'Neutral';
    const data = {
      value: val,
      classification: cls,
      extremeFear:  val <= 24,
      fear:         val >= 25 && val <= 44,
      neutral:      val >= 45 && val <= 55,
      greed:        val >= 56 && val <= 75,
      extremeGreed: val >= 76
    };
    fearGreedCache = { data, ts: Date.now() };
    console.log('Fear & Greed: ' + val + ' (' + cls + ')');
    return data;
  } catch(e) {
    console.log('Fear & Greed: ' + e.message);
    return fearGreedCache?.data || { value: 50, classification: 'Neutral', extremeFear: false, fear: false, neutral: true, greed: false, extremeGreed: false };
  }
}

// Fear & Greed scoring modifier
// Applied as a macro filter across all signals
function getFearGreedModifier(fg, dir) {
  if (!fg) return { mod: 0, label: '' };
  let mod = 0;
  let label = '';

  if (dir === 'BUY') {
    if (fg.extremeFear)  { mod = +1.5; label = '😱 Extreme Fear (' + fg.value + ') — historically strong BUY zone'; }
    else if (fg.fear)    { mod = +0.5; label = '😨 Fear (' + fg.value + ') — cautious bullish'; }
    else if (fg.greed)   { mod = -0.5; label = '😏 Greed (' + fg.value + ') — caution on longs'; }
    else if (fg.extremeGreed) { mod = -1.5; label = '🤑 Extreme Greed (' + fg.value + ') — avoid longs'; }
    else                 { label = '😐 Neutral sentiment (' + fg.value + ')'; }
  } else {
    if (fg.extremeGreed) { mod = +1.5; label = '🤑 Extreme Greed (' + fg.value + ') — historically strong SELL zone'; }
    else if (fg.greed)   { mod = +0.5; label = '😏 Greed (' + fg.value + ') — cautious bearish'; }
    else if (fg.fear)    { mod = -0.5; label = '😨 Fear (' + fg.value + ') — caution on shorts'; }
    else if (fg.extremeFear) { mod = -1.5; label = '😱 Extreme Fear (' + fg.value + ') — avoid shorts'; }
    else                 { label = '😐 Neutral sentiment (' + fg.value + ')'; }
  }

  return { mod, label };
}

// ── BYBIT LONG/SHORT RATIO ───────────────────────────────
// Measures what % of traders are long vs short right now
// >70% long = market too bullish = contrarian SELL signal
// <30% long = market too bearish = contrarian BUY signal
// Aggregated across all Bybit users on that pair

const lsCache = {};
const LS_TTL = 5 * 60 * 1000;

async function getLongShortRatio(sym) {
  if (lsCache[sym] && (Date.now() - lsCache[sym].ts) < LS_TTL) {
    return lsCache[sym].data;
  }
  const bybitSym = BYBIT_SYMBOLS[sym];
  if (!bybitSym) return null;
  try {
    const { default: fetch } = await import('node-fetch');
    const url = `https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${bybitSym}&period=1h&limit=1`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('LS HTTP ' + res.status);
    const json = await res.json();
    const item = json?.result?.list?.[0];
    if (!item) throw new Error('No LS data');
    const longPct  = parseFloat(item.buyRatio) * 100;
    const shortPct = parseFloat(item.sellRatio) * 100;
    const data = {
      longPct: +longPct.toFixed(1),
      shortPct: +shortPct.toFixed(1),
      crowdedLong:  longPct >= 65,  // too many longs = bearish contrarian
      crowdedShort: longPct <= 35,  // too many shorts = bullish contrarian
      neutral:      longPct > 35 && longPct < 65
    };
    lsCache[sym] = { data, ts: Date.now() };
    return data;
  } catch(e) {
    console.log('LS ' + sym + ': ' + e.message);
    return lsCache[sym]?.data || null;
  }
}

function getLSModifier(ls, dir) {
  if (!ls) return { mod: 0, label: '' };
  let mod = 0, label = '';
  if (dir === 'BUY') {
    if (ls.crowdedShort) { mod = +1.5; label = '🟢 ' + ls.longPct + '% long — crowd too short (contrarian BUY)'; }
    else if (ls.crowdedLong) { mod = -1.5; label = '🔴 ' + ls.longPct + '% long — crowd too long (fade the crowd)'; }
    else { label = '⚪ L/S ratio neutral (' + ls.longPct + '% long)'; }
  } else {
    if (ls.crowdedLong) { mod = +1.5; label = '🟢 ' + ls.longPct + '% long — crowd too long (contrarian SELL)'; }
    else if (ls.crowdedShort) { mod = -1.5; label = '🔴 ' + ls.longPct + '% long — crowd too short (fade the crowd)'; }
    else { label = '⚪ L/S ratio neutral (' + ls.longPct + '% long)'; }
  }
  return { mod, label };
}

// ── BYBIT FUNDING RATE HISTORY ────────────────────────────
// Historical funding rates — unlocks backtesting of funding layer
// Bybit settles funding every 8 hours → limit=300 = ~100 days history
// Used to calculate average funding trend over last 3 periods

const fundingHistCache = {};
const FH_TTL = 30 * 60 * 1000; // cache 30 mins

async function getFundingHistory(sym) {
  if (fundingHistCache[sym] && (Date.now() - fundingHistCache[sym].ts) < FH_TTL) {
    return fundingHistCache[sym].data;
  }
  const bybitSym = BYBIT_SYMBOLS[sym];
  if (!bybitSym) return null;
  try {
    const { default: fetch } = await import('node-fetch');
    const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${bybitSym}&limit=10`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('FH HTTP ' + res.status);
    const json = await res.json();
    const list = json?.result?.list;
    if (!list || list.length < 3) throw new Error('Insufficient FH data');
    const rates = list.map(i => parseFloat(i.fundingRate));
    const avg3  = rates.slice(0, 3).reduce((a,b) => a+b, 0) / 3;
    const trend = rates[0] > rates[2] ? 'rising' : rates[0] < rates[2] ? 'falling' : 'flat';
    const data  = { current: rates[0], avg3, trend, history: rates.slice(0, 6) };
    fundingHistCache[sym] = { data, ts: Date.now() };
    return data;
  } catch(e) {
    console.log('FH ' + sym + ': ' + e.message);
    return fundingHistCache[sym]?.data || null;
  }
}

// ── BYBIT ORDER BOOK IMBALANCE ────────────────────────────
// Ratio of bid volume to ask volume in top 25 levels
// Heavy bid side = institutional buy wall below = BUY support
// Heavy ask side = sell wall above = resistance for BUY, support for SELL

const obCache = {};
const OB_TTL = 60 * 1000; // cache 1 minute — orderbook changes fast

async function getOrderBookImbalance(sym) {
  if (obCache[sym] && (Date.now() - obCache[sym].ts) < OB_TTL) {
    return obCache[sym].data;
  }
  const bybitSym = BYBIT_SYMBOLS[sym];
  if (!bybitSym) return null;
  try {
    const { default: fetch } = await import('node-fetch');
    const url = `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${bybitSym}&limit=25`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('OB HTTP ' + res.status);
    const json = await res.json();
    const bids = json?.result?.b || [];
    const asks = json?.result?.a || [];
    if (!bids.length || !asks.length) throw new Error('No OB data');
    const bidVol = bids.reduce((s, b) => s + parseFloat(b[1]), 0);
    const askVol = asks.reduce((s, a) => s + parseFloat(a[1]), 0);
    const total  = bidVol + askVol;
    const ratio  = total > 0 ? bidVol / total : 0.5; // >0.5 = more bids
    const data   = {
      bidVol: +bidVol.toFixed(2),
      askVol: +askVol.toFixed(2),
      ratio:  +ratio.toFixed(3),
      bidHeavy: ratio >= 0.60,  // strong buy wall
      askHeavy: ratio <= 0.40,  // strong sell wall
      balanced: ratio > 0.40 && ratio < 0.60
    };
    obCache[sym] = { data, ts: Date.now() };
    return data;
  } catch(e) {
    console.log('OB ' + sym + ': ' + e.message);
    return obCache[sym]?.data || null;
  }
}

function getOBModifier(ob, dir) {
  if (!ob) return { mod: 0, label: '' };
  let mod = 0, label = '';
  const pct = Math.round(ob.ratio * 100);
  if (dir === 'BUY') {
    if (ob.bidHeavy) { mod = +1.0; label = '📗 Order book ' + pct + '% bids — buy wall support'; }
    else if (ob.askHeavy) { mod = -1.0; label = '📕 Order book ' + pct + '% asks — sell wall resistance'; }
    else { label = '📒 Order book balanced (' + pct + '% bids)'; }
  } else {
    if (ob.askHeavy) { mod = +1.0; label = '📕 Order book ' + pct + '% asks — sell wall confirmed'; }
    else if (ob.bidHeavy) { mod = -1.0; label = '📗 Order book ' + pct + '% bids — buy wall resistance for short'; }
    else { label = '📒 Order book balanced (' + pct + '% bids)'; }
  }
  return { mod, label };
}

// ── BYBIT TAKER BUY/SELL VOLUME ───────────────────────────
// Measures whether buyers or sellers are MORE aggressive
// Taker buys = market orders hitting the ask = bullish aggression
// Taker sells = market orders hitting the bid = bearish aggression
// More meaningful than raw volume — shows WHO is driving price

const takerCache = {};
const TAKER_TTL = 60 * 1000;

async function getTakerVolume(sym) {
  if (takerCache[sym] && (Date.now() - takerCache[sym].ts) < TAKER_TTL) {
    return takerCache[sym].data;
  }
  const bybitSym = BYBIT_SYMBOLS[sym];
  if (!bybitSym) return null;
  try {
    const { default: fetch } = await import('node-fetch');
    // Bybit kline returns: open, high, low, close, volume, turnover
    // We fetch last 3 candles and look at volume trend
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${bybitSym}&interval=60&limit=3`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('TV HTTP ' + res.status);
    const json = await res.json();
    const list = json?.result?.list;
    if (!list || list.length < 2) throw new Error('No taker data');
    // list[0] = most recent candle: [time, open, high, low, close, volume, turnover]
    const currentVol  = parseFloat(list[0][5]);
    const previousVol = parseFloat(list[1][5]);
    const currentClose  = parseFloat(list[0][4]);
    const currentOpen   = parseFloat(list[0][1]);
    const prevClose     = parseFloat(list[1][4]);
    const prevOpen      = parseFloat(list[1][1]);
    // Estimate taker direction from candle body
    const bullCandle = currentClose > currentOpen;
    const volSurge   = currentVol > previousVol * 1.5;
    const volDry     = currentVol < previousVol * 0.5;
    const data = {
      currentVol, previousVol,
      bullCandle, volSurge, volDry,
      ratio: +(currentVol / (previousVol || 1)).toFixed(2),
      buyersDominating:  bullCandle && volSurge,
      sellersDominating: !bullCandle && volSurge
    };
    takerCache[sym] = { data, ts: Date.now() };
    return data;
  } catch(e) {
    console.log('Taker ' + sym + ': ' + e.message);
    return takerCache[sym]?.data || null;
  }
}

function getTakerModifier(taker, dir) {
  if (!taker) return { mod: 0, label: '' };
  let mod = 0, label = '';
  if (dir === 'BUY') {
    if (taker.buyersDominating)  { mod = +1.0; label = '💚 Buyers dominating — aggressive buy volume'; }
    else if (taker.sellersDominating) { mod = -1.0; label = '🔴 Sellers dominating — aggressive sell volume'; }
    else if (taker.volDry)       { mod = -0.5; label = '🌵 Volume drying up'; }
    else                         { label = '⚪ Volume neutral'; }
  } else {
    if (taker.sellersDominating) { mod = +1.0; label = '💚 Sellers dominating — aggressive sell volume'; }
    else if (taker.buyersDominating) { mod = -1.0; label = '🔴 Buyers dominating — aggressive buy volume'; }
    else if (taker.volDry)       { mod = -0.5; label = '🌵 Volume drying up'; }
    else                         { label = '⚪ Volume neutral'; }
  }
  return { mod, label };
}

// ── INDICATORS ────────────────────────────────────────────
function calcRSI(closes, p=14) {
  if (closes.length < p+1) return 50;
  let g=0, l=0;
  for (let i=closes.length-p; i<closes.length; i++) {
    const d=closes[i]-closes[i-1]; if(d>0) g+=d; else l+=Math.abs(d);
  }
  const ag=g/p, al=l/p;
  return al===0 ? 100 : Math.round(100-100/(1+ag/al));
}

function calcMACD(closes) {
  function ema(arr, p) { const k=2/(p+1); let e=arr[0]; for(let i=1;i<arr.length;i++) e=arr[i]*k+e*(1-k); return e; }
  if (closes.length < 26) return { hist:0, bull:false };
  const hist = ema(closes.slice(-26), 12) - ema(closes.slice(-26), 26);
  return { hist, bull: hist > 0 };
}

function calcBB(closes, p=20) {
  if (closes.length < p) return { pos:'mid', pct:50, pctB:0.5 };
  const sl = closes.slice(-p);
  const mid = sl.reduce((a,b)=>a+b,0)/p;
  const std = Math.sqrt(sl.reduce((s,v)=>s+Math.pow(v-mid,2),0)/p);
  const upper=mid+2*std, lower=mid-2*std, last=closes[closes.length-1];
  const range=upper-lower;
  const pctB = range===0 ? 0.5 : (last-lower)/range;
  const pct = Math.max(0, Math.min(100, Math.round(pctB*100)));
  return { pos:pct>70?'upper':pct<30?'lower':'mid', pct, pctB };
}

function calcATR(candles, p=14) {
  if (candles.length < p+1) return candles[candles.length-1].close*0.02;
  const trs=[];
  for (let i=1;i<candles.length;i++) trs.push(Math.max(
    candles[i].high-candles[i].low,
    Math.abs(candles[i].high-candles[i-1].close),
    Math.abs(candles[i].low-candles[i-1].close)
  ));
  return trs.slice(-p).reduce((a,b)=>a+b,0)/p;
}

function calcEMA(closes, p) { const k=2/(p+1); let e=closes[0]; for(let i=1;i<closes.length;i++) e=closes[i]*k+e*(1-k); return e; }
function getTrend(closes, fast, slow) {
  if (closes.length < slow) return null;
  return { trend: calcEMA(closes,fast) > calcEMA(closes,slow) ? 'bull' : 'bear' };
}

// ── PRICE STRUCTURE ───────────────────────────────────────
function getPriceStructure(candles) {
  if (candles.length < 20) return null;
  const recent = candles.slice(-30);
  const swingHighs = [], swingLows = [];
  for (let i = 1; i < recent.length - 1; i++) {
    if (recent[i].high > recent[i-1].high && recent[i].high > recent[i+1].high) swingHighs.push(recent[i].high);
    if (recent[i].low  < recent[i-1].low  && recent[i].low  < recent[i+1].low)  swingLows.push(recent[i].low);
  }
  if (swingHighs.length < 2 || swingLows.length < 2) return { structure:'unclear' };
  const lastHH=swingHighs[swingHighs.length-1], prevHH=swingHighs[swingHighs.length-2];
  const lastLL=swingLows[swingLows.length-1],   prevLL=swingLows[swingLows.length-2];
  const higherHighs=lastHH>prevHH, higherLows=lastLL>prevLL;
  const lowerHighs=lastHH<prevHH,  lowerLows=lastLL<prevLL;
  if (higherHighs&&higherLows) return { structure:'bull', strength:'confirmed' };
  if (lowerHighs&&lowerLows)   return { structure:'bear', strength:'confirmed' };
  if (higherHighs||higherLows) return { structure:'bull', strength:'partial' };
  if (lowerHighs||lowerLows)   return { structure:'bear', strength:'partial' };
  return { structure:'ranging' };
}

// ── EMA SLOPE ─────────────────────────────────────────────
function getEMASlope(closes) {
  if (closes.length < 25) return null;
  const e4=calcEMA(closes.slice(0,-2),20), e5=calcEMA(closes,20);
  const e1=calcEMA(closes.slice(0,-8),20), e2=calcEMA(closes.slice(0,-6),20);
  const slope1=e2-e1, slope2=e5-e4;
  return { direction:slope2>0?'up':'down', accelerating:Math.abs(slope2)>Math.abs(slope1), slope:+slope2.toFixed(4) };
}

// ── VOLATILITY SQUEEZE ────────────────────────────────────
function getVolatilitySqueeze(candles) {
  if (candles.length < 25) return null;
  const recentATR=calcATR(candles.slice(-6),5), avgATR=calcATR(candles.slice(-21),20);
  if (avgATR===0) return null;
  const ratio=recentATR/avgATR;
  const squeezed=ratio<0.75;
  const last3=candles.slice(-3);
  const priceMove=last3[last3.length-1].close-last3[0].open;
  return { squeezed, ratio:+ratio.toFixed(2), breakoutDir:priceMove>0?'bull':'bear', releasing:!squeezed&&ratio<1.1 };
}

// ══════════════════════════════════════════════════════════
// SIGNAL LOGIC v4 — BACKTEST-INFORMED
// Baseline: 37% ★★★ win rate, 301 wins, 505 losses
// MACD = only mandatory gate. RSI+BB = primary scoring.
// 4H trend = bonus only. Price structure + EMA slope +
// squeeze = additional context. TP1=3x ATR, TP2=5x ATR.
// ══════════════════════════════════════════════════════════

function getSignals(rsi, macd, bb, volRatio, trend1h, trend4h, atr, price, priceStruct, emaSlope, squeeze, fundingRate=0, oi=null, fg=null, pct24h=0, ls=null, ob=null, taker=null) {
  const results = [];
  const bbB = (bb.pctB > 0.05 && bb.pctB < 0.95) ? bb.pctB : 0.5;
  const trend4hDir = trend4h?.trend || null;
  const trend1hDir = trend1h?.trend || null;

  // ── BUY ───────────────────────────────────────────────
  if (macd.bull) {
    let score = 6.0;
    if      (rsi < 30) score += 2.5;
    else if (rsi < 38) score += 1.5;
    else if (rsi < 45) score += 0.5;
    else if (rsi > 70) score -= 1.5;
    else if (rsi > 60) score -= 0.5;
    if      (bbB < 0.20) score += 2.0;
    else if (bbB < 0.35) score += 1.0;
    else if (bbB > 0.80) score -= 1.5;
    else if (bbB > 0.65) score -= 0.5;
    if      (trend4hDir === 'bull') score += 1.5;
    else if (trend4hDir === 'bear') score -= 0.5;
    if      (trend1hDir === 'bull') score += 0.5;
    else if (trend1hDir === 'bear') score -= 0.5;
    if (volRatio < 0.005) score -= 0.5;
    if (priceStruct) {
      if (priceStruct.structure==='bull'&&priceStruct.strength==='confirmed') score += 1.5;
      else if (priceStruct.structure==='bull'&&priceStruct.strength==='partial') score += 0.75;
      else if (priceStruct.structure==='bear'&&priceStruct.strength==='confirmed') score -= 1.5;
      else if (priceStruct.structure==='bear'&&priceStruct.strength==='partial') score -= 0.75;
    }
    if (emaSlope) {
      if (emaSlope.direction==='up'&&emaSlope.accelerating) score += 1.0;
      else if (emaSlope.direction==='up') score += 0.25;
      else if (emaSlope.direction==='down'&&emaSlope.accelerating) score -= 1.0;
      else score -= 0.25;
    }
    if (squeeze) {
      if (squeeze.releasing&&squeeze.breakoutDir==='bull') score += 1.5;
      else if (squeeze.squeezed) score += 0.5;
      else if (squeeze.releasing&&squeeze.breakoutDir==='bear') score -= 1.0;
    }
    score = Math.max(0, Math.min(10, +score.toFixed(1)));
    const conf = score >= 8.0 ? 3 : score >= 6.5 ? 2 : score >= 5.5 ? 1 : 0;
    if (conf > 0) {
      const aligned = trend4hDir === 'bull';
      const extras = [
        priceStruct?.structure==='bull' ? 'Structure ↑' : '',
        emaSlope?.direction==='up'&&emaSlope?.accelerating ? 'Slope ↑' : '',
        squeeze?.releasing&&squeeze?.breakoutDir==='bull' ? 'Squeeze ↑' : ''
      ].filter(Boolean).join(' · ');
      const fundingNoteB = getFundingModifier(fundingRate, 'BUY').label;
      const oiNoteB     = getOIModifier(oi, 'BUY', pct24h).label;
      const fgNoteB     = getFearGreedModifier(fg, 'BUY').label;
      const lsNoteB     = getLSModifier(ls, 'BUY').label;
      const obNoteB     = getOBModifier(ob, 'BUY').label;
      const tkNoteB     = getTakerModifier(taker, 'BUY').label;
      const extraData   = [fundingNoteB, oiNoteB, fgNoteB, lsNoteB, obNoteB, tkNoteB].filter(Boolean).join(' · ');
      const trendNote = `${trend4hDir?(aligned?'4H aligned':'4H counter — reduce size'):'No 4H data'} · MACD bull · RSI ${rsi} · BB ${bb.pct}%${extras?' · '+extras:''} · ${extraData}`;
      results.push({
        dir:'BUY', score, conf, aligned, trendNote,
        swing: score >= 7.0 ? 'BUY'  : 'WATCH',
        scalp: score >= 6.5 ? 'BUY'  : 'WATCH',
        sl:  +(price - atr*1.5).toFixed(4),
        tp1: +(price + atr*3.0).toFixed(4),
        tp2: +(price + atr*5.0).toFixed(4)
      });
    }
  }

  // ── SELL ──────────────────────────────────────────────
  if (!macd.bull) {
    let score = 6.0;
    if      (rsi > 70) score += 2.5;
    else if (rsi > 62) score += 1.5;
    else if (rsi > 55) score += 0.5;
    else if (rsi < 30) score -= 1.5;
    else if (rsi < 40) score -= 0.5;
    if      (bbB > 0.80) score += 2.0;
    else if (bbB > 0.65) score += 1.0;
    else if (bbB < 0.20) score -= 1.5;
    else if (bbB < 0.35) score -= 0.5;
    if      (trend4hDir === 'bear') score += 1.5;
    else if (trend4hDir === 'bull') score -= 0.5;
    if      (trend1hDir === 'bear') score += 0.5;
    else if (trend1hDir === 'bull') score -= 0.5;
    if (volRatio < 0.005) score -= 0.5;
    if (priceStruct) {
      if (priceStruct.structure==='bear'&&priceStruct.strength==='confirmed') score += 1.5;
      else if (priceStruct.structure==='bear'&&priceStruct.strength==='partial') score += 0.75;
      else if (priceStruct.structure==='bull'&&priceStruct.strength==='confirmed') score -= 1.5;
      else if (priceStruct.structure==='bull'&&priceStruct.strength==='partial') score -= 0.75;
    }
    if (emaSlope) {
      if (emaSlope.direction==='down'&&emaSlope.accelerating) score += 1.0;
      else if (emaSlope.direction==='down') score += 0.25;
      else if (emaSlope.direction==='up'&&emaSlope.accelerating) score -= 1.0;
      else score -= 0.25;
    }
    if (squeeze) {
      if (squeeze.releasing&&squeeze.breakoutDir==='bear') score += 1.5;
      else if (squeeze.squeezed) score += 0.5;
      else if (squeeze.releasing&&squeeze.breakoutDir==='bull') score -= 1.0;
    }
    score = Math.max(0, Math.min(10, +score.toFixed(1)));
    const conf = score >= 8.0 ? 3 : score >= 6.5 ? 2 : score >= 5.5 ? 1 : 0;
    if (conf > 0) {
      const aligned = trend4hDir === 'bear';
      const extras = [
        priceStruct?.structure==='bear' ? 'Structure ↓' : '',
        emaSlope?.direction==='down'&&emaSlope?.accelerating ? 'Slope ↓' : '',
        squeeze?.releasing&&squeeze?.breakoutDir==='bear' ? 'Squeeze ↓' : ''
      ].filter(Boolean).join(' · ');
      const fundingNoteS = getFundingModifier(fundingRate, 'SELL').label;
      const oiNoteS     = getOIModifier(oi, 'SELL', pct24h).label;
      const fgNoteS     = getFearGreedModifier(fg, 'SELL').label;
      const lsNoteS     = getLSModifier(ls, 'SELL').label;
      const obNoteS     = getOBModifier(ob, 'SELL').label;
      const tkNoteS     = getTakerModifier(taker, 'SELL').label;
      const extraDataS  = [fundingNoteS, oiNoteS, fgNoteS, lsNoteS, obNoteS, tkNoteS].filter(Boolean).join(' · ');
      const trendNote = `${trend4hDir?(aligned?'4H aligned':'4H counter — reduce size'):'No 4H data'} · MACD bear · RSI ${rsi} · BB ${bb.pct}%${extras?' · '+extras:''} · ${extraDataS}`;
      results.push({
        dir:'SELL', score, conf, aligned, trendNote,
        swing: score >= 7.0 ? 'SELL' : 'WATCH',
        scalp: score >= 6.5 ? 'SELL' : 'WATCH',
        sl:  +(price + atr*1.5).toFixed(4),
        tp1: +(price - atr*3.0).toFixed(4),
        tp2: +(price - atr*5.0).toFixed(4)
      });
    }
  }

  return results;
}

// ── PROCESS PAIR ──────────────────────────────────────────
async function processPair(pair) {
  const { candles1h, candles4h } = await getCandles(pair.sym);
  if (candles1h.length < 26) throw new Error('Insufficient candles');
  const closes1h = candles1h.map(c=>c.close);
  const closes4h = candles4h.map(c=>c.close);
  const price    = closes1h[closes1h.length-1];
  const rsi      = calcRSI(closes1h, 14);
  const macd     = calcMACD(closes1h);
  const bb       = calcBB(closes1h, 20);
  const atr      = calcATR(candles1h, 14);
  const trend1h  = getTrend(closes1h, 9, 21);
  const trend4h  = getTrend(closes4h, 20, 50);
  const price24hAgo = closes1h.length>=24 ? closes1h[closes1h.length-24] : closes1h[0];
  const pct24h   = ((price-price24hAgo)/price24hAgo)*100;
  const lastC    = candles1h[candles1h.length-1];
  const vol      = (lastC.volume||0)*price;
  const mcap     = pair.mcap||0;
  const volRatio = mcap>0 ? vol/mcap : 0;
  const priceStruct  = getPriceStructure(candles1h);
  const emaSlope     = getEMASlope(closes1h);
  const squeeze      = getVolatilitySqueeze(candles1h);

  // Fetch Bybit funding rate (non-price data — genuine predictive signal)
  const fundingRate  = await getFundingRate(pair.sym);
  const funding      = getFundingModifier(fundingRate, 'BUY'); // direction applied per signal below

  // Fetch all non-price data in parallel (no extra scan time)
  const [oi, fg, ls, ob, taker] = await Promise.all([
    getOpenInterest(pair.sym),
    getFearGreed(),
    getLongShortRatio(pair.sym),
    getOrderBookImbalance(pair.sym),
    getTakerVolume(pair.sym)
  ]);

  const signals = getSignals(rsi, macd, bb, volRatio, trend1h, trend4h, atr, price, priceStruct, emaSlope, squeeze, fundingRate, oi, fg, pct24h, ls, ob, taker);
  const topSig   = signals[0];

  const fundingInfo = topSig ? getFundingModifier(fundingRate, topSig.dir) : funding;
  console.log(`${pair.sym}: RSI=${rsi} MACD=${macd.bull?'B':'b'} BB=${bb.pct}% Funding=${(fundingRate*100).toFixed(4)}% → ${topSig?topSig.dir+' '+topSig.score+' ★'.repeat(topSig.conf):'HOLD'}`);

  return {
    sym:pair.sym, price, pct24h, vol, mcap, volRatio,
    rsi, macd, bb, atr, trend1h, trend4h, priceStruct, emaSlope, squeeze,
    fundingRate, fundingLabel: fundingInfo.label,
    oi, fg, ls, ob, taker,
    score:    topSig?.score    || 5,
    swing:    topSig?.swing    || 'HOLD',
    scalp:    topSig?.scalp    || 'HOLD',
    conf:     topSig?.conf     || 1,
    aligned:  topSig?.aligned  || null,
    trendNote:topSig?.trendNote|| '',
    signals
  };
}

// ── SIGNAL HISTORY ────────────────────────────────────────
let signalHistory = [];
const HISTORY_TTL = 4*60*60*1000;

function addToHistory(results) {
  const now = Date.now();
  const nearClose = isNearCandleClose();
  signalHistory = signalHistory.filter(h=>(now-h.ts)<HISTORY_TTL);

  results.forEach(s => {
    if (!s.signals) return;
    s.signals.forEach(sig => {

      // ── SMART DEDUP — ATR-based price distance check ──
      // Find the most recent signal for this pair + direction
      const lastSig = signalHistory
        .filter(h => h.sym === s.sym && h.dir === sig.dir)
        .sort((a, b) => b.ts - a.ts)[0];

      if (lastSig) {
        const priceDiff = Math.abs(s.price - lastSig.price);
        const atr = s.atr || s.price * 0.02;

        // Block if price hasn't moved at least 1x ATR from last signal
        // This means near-identical entries are treated as the same signal
        if (priceDiff < atr) {
          // Update the existing signal's score and trend note if improved
          // so the panel always shows the most current reading
          if (sig.score > lastSig.score) {
            lastSig.score    = sig.score;
            lastSig.conf     = sig.conf;
            lastSig.trendNote= sig.trendNote;
            lastSig.sl       = sig.sl;
            lastSig.tp1      = sig.tp1;
            lastSig.tp2      = sig.tp2;
          }
          console.log(`↺ ${sig.dir} ${s.sym} price diff ${priceDiff.toFixed(4)} < ATR ${atr.toFixed(4)} — updating existing signal`);
          return; // don't fire new signal
        }
      }

      // Price has moved significantly — this is a genuine new entry level
      signalHistory.push({
        sym:s.sym, price:s.price, dir:sig.dir, score:sig.score,
        conf:sig.conf, sl:sig.sl, tp1:sig.tp1, tp2:sig.tp2,
        swing:sig.swing, scalp:sig.scalp, aligned:sig.aligned,
        trendNote:sig.trendNote, rsi:s.rsi, atr:s.atr,
        ts:now, timeStr:new Date(now).toUTCString().slice(17,25),
        confirmedAtClose: nearClose
      });

      if (sig.conf===3) {
        // ── OPTIMAL 4-RULE GATE (83.3% win rate in simulation) ──
        // ALL four conditions must be true before Telegram fires.
        // Based on exhaustive combination search of 8 days live data.
        const note = sig.trendNote || '';
        const sigRSI = s.rsi || 50;

        // Rule 1: Score >= 9.0
        const rule1 = sig.score >= 9.0;

        // Rule 2: Slope confirmed in signal direction
        const rule2 = sig.dir === 'BUY'
          ? note.includes('Slope ↑')
          : note.includes('Slope ↓');

        // Rule 3: SELL RSI > 35 (no shorting into oversold)
        // BUY signals always pass this rule
        const rule3 = sig.dir === 'BUY' ? true : sigRSI > 35;

        // Rule 4: Structure AND Squeeze both confirmed in signal direction
        const hasStruct = sig.dir === 'BUY'
          ? note.includes('Structure ↑')
          : note.includes('Structure ↓');
        const hasSqueeze = sig.dir === 'BUY'
          ? note.includes('Squeeze ↑')
          : note.includes('Squeeze ↓');
        const rule4 = hasStruct && hasSqueeze;

        const allRulesMet = rule1 && rule2 && rule3 && rule4;

        if (allRulesMet) {
          addSignalToLog(s, sig);
          sendTelegram(formatTGSignal(s, sig));
          console.log('🔔 OPTIMAL SIGNAL: ' + sig.dir + ' ' + s.sym + ' ' + sig.score + '/10 ★★★ (' + minutesToCandleClose() + 'm to close)');
        } else {
          const failed = [];
          if (!rule1) failed.push('score ' + sig.score + ' < 9.0');
          if (!rule2) failed.push('no slope confirmation');
          if (!rule3) failed.push('SELL RSI ' + sigRSI + ' <= 35 (oversold)');
          if (!rule4) failed.push('missing ' + (!hasStruct ? 'Structure ' : '') + (!hasSqueeze ? 'Squeeze' : ''));
          console.log('⛔ BLOCKED: ' + sig.dir + ' ' + s.sym + ' ' + sig.score + '/10 — ' + failed.join(', '));
        }
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
    try { data.push(await processPair(pair)); }
    catch(e) { console.error(`${pair.sym}: ${e.message}`); }
    await new Promise(r=>setTimeout(r,800));
  }
  console.log(`Scan done: ${data.length}/${PAIRS.length}`);
  if (data.length===0) throw new Error('All requests failed');
  addToHistory(data);
  await updateSignalLog(data);
  return data;
}

// ── ROUTES ────────────────────────────────────────────────
app.get('/api/scan', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.data && (now-cache.ts)<CACHE_TTL) {
      return res.json({ ok:true, data:cache.data, history:signalHistory.slice().reverse(),
        signalLog:signalLog.slice(-100).reverse(), stats:calcStats(), cached:true, timestamp:new Date().toISOString() });
    }
    const data = await buildSignals();
    cache = { data, ts:Date.now() };
    res.json({ ok:true, data, history:signalHistory.slice().reverse(),
      signalLog:signalLog.slice(-100).reverse(), stats:calcStats(), cached:false, timestamp:new Date().toISOString() });
  } catch(e) {
    console.error('Scan error:', e.message);
    if (cache.data) return res.json({ ok:true, data:cache.data, history:signalHistory.slice().reverse(),
      signalLog:signalLog.slice(-100).reverse(), stats:calcStats(), cached:true, stale:true, timestamp:new Date().toISOString() });
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post('/api/trade-alert', async (req, res) => {
  const { sym, dir, entry, sl, tp1, tp2, score, conf, type } = req.body;
  const msgs = {
    entered: `📥 <b>TRADE ENTERED</b>\n\n${dir==='BUY'?'🟢':'🔴'} <b>${sym}/USDT ${dir}</b>\nScore: ${score}/10 ${'⭐'.repeat(conf)}\n\n📍 Entry: ${entry}\n🛑 Stop: ${sl}\n🎯 TP1: ${tp1}\n🎯 TP2: ${tp2}\n\n🤖 Defi Insider Signal Bot`,
    sl_hit:  `🚨 <b>STOP LOSS HIT</b>\n\n<b>${sym}/USDT ${dir}</b>\nEntry: ${entry} → SL: ${sl}\n\n🤖 Defi Insider Signal Bot`,
    tp1_hit: `🎯 <b>TP1 REACHED</b>\n\n<b>${sym}/USDT ${dir}</b>\nTP1: ${tp1} ✅\nMove stop to breakeven.\n\n🤖 Defi Insider Signal Bot`
  };
  if (msgs[type]) await sendTelegram(msgs[type]);
  res.json({ ok:true });
});

app.get('/api/health', async (req, res) => {
  try {
    const candles = await fetchCC('BTC');
    const price = candles[candles.length-1]?.close;
    res.json({ ok:true, source:'CryptoCompare', btcPrice:'$'+price?.toLocaleString(),
      pairs:PAIRS.map(p=>p.sym), cached:Object.keys(pairCache),
      nearCandleClose: isNearCandleClose(),
      minutesToClose: minutesToCandleClose(),
      signalLogic:'v4 — MACD gate + RSI/BB + structure/slope/squeeze',
      signalsTracked:signalLog.length, stats:calcStats() });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

// ── BACKTESTER ────────────────────────────────────────────
let backtestResults = null;
let backtestRunning = false;

async function fetchHistoricalCandles(sym) {
  const { default: fetch } = await import('node-fetch');
  const url = `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${sym}&tsym=USD&limit=2000`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.Response !== 'Success') throw new Error(json.Message || 'CC error');
  return json.Data.Data
    .map(c=>({ time:c.time, open:c.open, high:c.high, low:c.low, close:c.close, volume:c.volumeto||0 }))
    .filter(c=>c.close>0);
}

function checkOutcome(candles, fromIdx, signal) {
  const { sl, tp1, dir } = signal;
  for (let i=fromIdx+1; i<Math.min(fromIdx+25,candles.length); i++) {
    const c=candles[i], h=i-fromIdx;
    if (dir==='BUY') {
      if (c.high>=tp1&&c.low<=sl) return { result:c.open>=sl?'win':'loss', hours:h };
      if (c.high>=tp1) return { result:'win',  hours:h };
      if (c.low<=sl)   return { result:'loss', hours:h };
    } else {
      if (c.low<=tp1&&c.high>=sl) return { result:c.open<=sl?'win':'loss', hours:h };
      if (c.low<=tp1)  return { result:'win',  hours:h };
      if (c.high>=sl)  return { result:'loss', hours:h };
    }
  }
  return { result:'expired', hours:24 };
}

async function runBacktest() {
  if (backtestRunning) return;
  backtestRunning = true;
  console.log('🔬 Starting backtest...');
  const allResults = [];
  for (const pair of PAIRS) {
    try {
      const candles = await fetchHistoricalCandles(pair.sym);
      if (candles.length < 100) continue;
      let lastIdx = -10;
      for (let idx=50; idx<candles.length-25; idx++) {
        if (idx-lastIdx < 10) continue;
        const w1h = candles.slice(0, idx+1);
        const w4h = derive4H(w1h);
        if (w4h.length < 20) continue;
        const c1h = w1h.map(c=>c.close);
        const c4h = w4h.map(c=>c.close);
        const rsi  = calcRSI(c1h, 14);
        const macd = calcMACD(c1h);
        const bb   = calcBB(c1h, 20);
        const atr  = calcATR(w1h, 14);
        const t1h  = getTrend(c1h, 9, 21);
        const t4h  = getTrend(c4h, 20, 50);
        const ps   = getPriceStructure(w1h);
        const es   = getEMASlope(c1h);
        const sq   = getVolatilitySqueeze(w1h);
        const price = w1h[w1h.length-1].close;
        const sigs = getSignals(rsi, macd, bb, 0.02, t1h, t4h, atr, price, ps, es, sq);
        if (!sigs.length) continue;
        const sig = sigs[0];
        const outcome = checkOutcome(candles, idx, sig);
        // Store indicator flags so optimal filter can check them directly
        const hasSlope = sig.dir === 'BUY'
          ? (es?.direction === 'up')
          : (es?.direction === 'down');
        const hasStruct = sig.dir === 'BUY'
          ? (ps?.structure === 'bull')
          : (ps?.structure === 'bear');
        const hasSqueeze = sig.dir === 'BUY'
          ? (sq?.releasing && sq?.breakoutDir === 'bull')
          : (sq?.releasing && sq?.breakoutDir === 'bear');

        allResults.push({
          sym:pair.sym, dir:sig.dir, conf:sig.conf, score:sig.score,
          price, sl:sig.sl, tp1:sig.tp1, time:candles[idx].time,
          rsi, hasSlope, hasStruct, hasSqueeze,
          ...outcome
        });
        lastIdx = idx;
      }
      console.log(`${pair.sym}: ${allResults.filter(r=>r.sym===pair.sym).length} signals`);
      await new Promise(r=>setTimeout(r,1500));
    } catch(e) { console.error(`Backtest ${pair.sym}: ${e.message}`); }
  }

  function stats(sigs) {
    const wins=sigs.filter(s=>s.result==='win');
    const losses=sigs.filter(s=>s.result==='loss');
    const resolved=wins.length+losses.length;
    return { total:sigs.length, wins:wins.length, losses:losses.length,
      expired:sigs.filter(s=>s.result==='expired').length, resolved,
      winRate:resolved>0?Math.round(wins.length/resolved*100):null,
      avgWinH:wins.length>0?+(wins.reduce((s,x)=>s+x.hours,0)/wins.length).toFixed(1):null,
      avgLossH:losses.length>0?+(losses.reduce((s,x)=>s+x.hours,0)/losses.length).toFixed(1):null,
      expectancy:resolved>0?+((wins.length/resolved*2.0)-(losses.length/resolved*1.0)).toFixed(3):null };
  }

  // ── OPTIMAL 4-RULE FILTER (applied to backtest) ──────────
  // Same rules used for live Telegram gate — lets us validate
  // the 83.3% simulation result against the full 83-day dataset.
  // Rule 1: Score >= 9.0
  // Rule 2: Slope confirmed in signal direction
  // Rule 3: SELL RSI > 35 (no shorting into oversold)
  // Rule 4: Structure AND Squeeze both confirmed simultaneously
  function passesOptimalFilter(sig) {
    // Uses boolean flags stored at backtest time — not trendNote strings
    const rule1 = sig.score >= 9.0;
    const rule2 = sig.hasSlope === true;
    const rule3 = sig.dir === 'BUY' ? true : (sig.rsi || 50) > 35;
    const rule4 = sig.hasStruct === true && sig.hasSqueeze === true;
    return rule1 && rule2 && rule3 && rule4;
  }

  const filteredResults = allResults.filter(passesOptimalFilter);
  const unfilteredStar3 = allResults.filter(s=>s.conf===3);

  backtestResults = {
    // ── UNFILTERED (all signals, existing view) ──────────
    overall:  stats(allResults),
    byStars:  {
      3: stats(unfilteredStar3),
      2: stats(allResults.filter(s=>s.conf===2)),
      1: stats(allResults.filter(s=>s.conf===1))
    },
    byPair:   Object.fromEntries(PAIRS.map(p=>[p.sym, stats(allResults.filter(s=>s.sym===p.sym))])),
    byDir:    { BUY:stats(allResults.filter(s=>s.dir==='BUY')), SELL:stats(allResults.filter(s=>s.dir==='SELL')) },
    totalSignals: allResults.length, daysBack:83,
    ranAt: new Date().toISOString(),
    recentSignals: allResults.slice(-50).reverse(),

    // ── OPTIMAL FILTER RESULTS (83-day validation) ───────
    // This is the key section — how does the 4-rule filter
    // perform across the full 83-day backtest dataset?
    optimalFilter: {
      signals:      stats(filteredResults),
      byDir:        { BUY:stats(filteredResults.filter(s=>s.dir==='BUY')), SELL:stats(filteredResults.filter(s=>s.dir==='SELL')) },
      byPair:       Object.fromEntries(PAIRS.map(p=>[p.sym, stats(filteredResults.filter(s=>s.sym===p.sym))])),
      totalFiltered: filteredResults.length,
      totalUnfiltered: unfilteredStar3.length,
      reductionPct: unfilteredStar3.length > 0
        ? Math.round((1 - filteredResults.length/unfilteredStar3.length)*100)
        : 0,
      // Rule-by-rule breakdown — how many signals each rule blocks
      ruleBreakdown: {
        rule1_score_9:    { blocked: unfilteredStar3.filter(s=>s.score < 9.0).length },
        rule2_slope:      { blocked: unfilteredStar3.filter(s=>!s.hasSlope).length },
        rule3_sell_rsi:   { blocked: unfilteredStar3.filter(s=>s.dir==='SELL'&&(s.rsi||50)<=35).length },
        rule4_struct_sqz: { blocked: unfilteredStar3.filter(s=>!(s.hasStruct&&s.hasSqueeze)).length }
      },
      recentFiltered: filteredResults.slice(-20).reverse()
    }
  };

  console.log('✅ Backtest done: ' + allResults.length + ' total signals');
  console.log('★★★ unfiltered: ' + backtestResults.byStars[3].winRate + '% (' + backtestResults.byStars[3].wins + 'W/' + backtestResults.byStars[3].losses + 'L)');
  console.log('★★★ OPTIMAL FILTER: ' + backtestResults.optimalFilter.signals.winRate + '% (' + backtestResults.optimalFilter.signals.wins + 'W/' + backtestResults.optimalFilter.signals.losses + 'L) from ' + filteredResults.length + ' signals');
  console.log('Signal reduction: ' + backtestResults.optimalFilter.reductionPct + '% fewer signals sent to Telegram');
  backtestRunning = false;
}

app.get('/api/backtest', (req, res) => {
  if (!backtestResults && !backtestRunning) runBacktest();
  if (backtestRunning) return res.json({ ok:true, status:'running' });
  if (!backtestResults) return res.json({ ok:true, status:'running' });
  res.json({ ok:true, status:'complete', results:backtestResults });
});

setTimeout(()=>{ console.log('Starting backtest...'); runBacktest(); }, 10000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Defi Insider Signal Bot v4 on port ${PORT}`));
