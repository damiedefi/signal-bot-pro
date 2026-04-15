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

// ── CANDLE CLOSE DETECTION ───────────────────────────────
// Returns true if we are within the last 5 minutes of the
// current 1H candle — i.e. minutes 55-59 of any hour.
// Signals are only fired during this window to ensure they
// are based on nearly-confirmed candle data.

function isNearCandleClose() {
  const minute = new Date().getUTCMinutes();
  return minute >= 55; // last 5 minutes of the hour
}

function minutesToCandleClose() {
  const minute = new Date().getUTCMinutes();
  const second = new Date().getUTCSeconds();
  return 59 - minute + (second === 0 ? 0 : 1);
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

// ── NEW INDICATOR 1: PRICE STRUCTURE ─────────────────────
// Identifies swing highs and lows from OHLC candles.
// Higher highs + higher lows = bullish structure (early uptrend)
// Lower highs + lower lows = bearish structure (early downtrend)
// Fires BEFORE RSI/MACD confirm — genuinely leading.
function getPriceStructure(candles) {
  if (candles.length < 20) return null;
  const recent = candles.slice(-30); // last 30 candles

  // Find swing highs — candle where high > both neighbours
  const swingHighs = [];
  for (let i = 1; i < recent.length - 1; i++) {
    if (recent[i].high > recent[i-1].high && recent[i].high > recent[i+1].high) {
      swingHighs.push(recent[i].high);
    }
  }

  // Find swing lows — candle where low < both neighbours
  const swingLows = [];
  for (let i = 1; i < recent.length - 1; i++) {
    if (recent[i].low < recent[i-1].low && recent[i].low < recent[i+1].low) {
      swingLows.push(recent[i].low);
    }
  }

  if (swingHighs.length < 2 || swingLows.length < 2) return { structure: 'unclear' };

  const lastHH = swingHighs[swingHighs.length - 1];
  const prevHH = swingHighs[swingHighs.length - 2];
  const lastLL = swingLows[swingLows.length - 1];
  const prevLL = swingLows[swingLows.length - 2];

  const higherHighs = lastHH > prevHH;
  const higherLows  = lastLL > prevLL;
  const lowerHighs  = lastHH < prevHH;
  const lowerLows   = lastLL < prevLL;

  if (higherHighs && higherLows)  return { structure: 'bull', strength: 'confirmed' };
  if (lowerHighs  && lowerLows)   return { structure: 'bear', strength: 'confirmed' };
  if (higherHighs || higherLows)  return { structure: 'bull', strength: 'partial' };
  if (lowerHighs  || lowerLows)   return { structure: 'bear', strength: 'partial' };
  return { structure: 'ranging' };
}

// ── NEW INDICATOR 2: EMA SLOPE ACCELERATION ──────────────
// Measures how fast EMA20 is rising or falling.
// Accelerating upward slope = trend strengthening = good entry
// Decelerating slope = trend weakening = avoid entry
// More leading than EMA crossover alone.
function getEMASlope(closes) {
  if (closes.length < 25) return null;
  const period = 20;

  // Calculate EMA20 at 5 points over last 10 candles
  function emaAt(arr) { return calcEMA(arr, period); }

  const e1 = emaAt(closes.slice(0, -8));
  const e2 = emaAt(closes.slice(0, -6));
  const e3 = emaAt(closes.slice(0, -4));
  const e4 = emaAt(closes.slice(0, -2));
  const e5 = emaAt(closes);

  const slope1 = e2 - e1; // older slope
  const slope2 = e5 - e4; // recent slope

  const direction  = slope2 > 0 ? 'up' : 'down';
  const accelerating = Math.abs(slope2) > Math.abs(slope1);
  const slopeStrength = Math.abs(slope2) / (closes[closes.length-1] * 0.001); // normalise

  return {
    direction,
    accelerating,
    slopeStrength: +slopeStrength.toFixed(2),
    slope: +slope2.toFixed(4)
  };
}

// ── NEW INDICATOR 3: VOLATILITY SQUEEZE ──────────────────
// Detects when price is compressed (coiling) before a breakout.
// Current ATR < 75% of 20-period average ATR = squeeze active
// When squeeze releases with directional move = catch trend start
function getVolatilitySqueeze(candles) {
  if (candles.length < 25) return null;

  // Current ATR (last 5 candles)
  const recentATR = calcATR(candles.slice(-6), 5);

  // Average ATR over last 20 candles
  const avgATR = calcATR(candles.slice(-21), 20);

  if (avgATR === 0) return null;

  const ratio = recentATR / avgATR;
  const squeezed = ratio < 0.75; // compressed below 75% of average

  // Direction of breakout — which way did price move in last 3 candles?
  const last3 = candles.slice(-3);
  const priceMove = last3[last3.length-1].close - last3[0].open;
  const breakoutDir = priceMove > 0 ? 'bull' : 'bear';

  return {
    squeezed,
    ratio: +ratio.toFixed(2),
    breakoutDir,
    releasing: squeezed === false && ratio < 1.1 // just came out of squeeze
  };
}

// ── INDICATOR 4: VOLUME SURGE ────────────────────────────
// Measures whether current volume is significantly above average.
// 2x average = institutional participation = strong confirmation.
// Uses volumeto (USD volume) from candles.
function getVolumeSurge(candles) {
  if (candles.length < 21) return null;
  const recent = candles.slice(-21);
  const avgVol = recent.slice(0, 20).reduce((s, c) => s + c.volume, 0) / 20;
  const curVol = recent[recent.length - 1].volume;
  if (avgVol === 0) return null;
  const ratio = curVol / avgVol;
  return {
    ratio: +ratio.toFixed(2),
    surge: ratio >= 2.0,      // strong surge
    elevated: ratio >= 1.5,   // above average
    weak: ratio < 0.5         // very low volume
  };
}

// ── INDICATOR 5: RSI DIVERGENCE ──────────────────────────
// Bullish divergence: price makes lower low, RSI makes higher low
// Bearish divergence: price makes higher high, RSI makes lower high
// One of the most reliable reversal signals — genuinely leading.
function getRSIDivergence(candles, rsiSeries) {
  if (candles.length < 20 || rsiSeries.length < 20) return null;

  const lookback = 15;
  const priceSlice = candles.slice(-lookback);
  const rsiSlice   = rsiSeries.slice(-lookback);

  // Find price swing lows and highs
  let priceLow1Idx = 0, priceLow2Idx = 0;
  let priceHigh1Idx = 0, priceHigh2Idx = 0;

  for (let i = 1; i < priceSlice.length - 1; i++) {
    if (priceSlice[i].low < priceSlice[priceLow1Idx].low) {
      priceLow2Idx = priceLow1Idx;
      priceLow1Idx = i;
    }
    if (priceSlice[i].high > priceSlice[priceHigh1Idx].high) {
      priceHigh2Idx = priceHigh1Idx;
      priceHigh1Idx = i;
    }
  }

  // Bullish divergence: price lower low, RSI higher low
  const bullDiv = priceLow1Idx > priceLow2Idx &&
    priceSlice[priceLow1Idx].low < priceSlice[priceLow2Idx].low &&
    rsiSlice[priceLow1Idx] > rsiSlice[priceLow2Idx];

  // Bearish divergence: price higher high, RSI lower high
  const bearDiv = priceHigh1Idx > priceHigh2Idx &&
    priceSlice[priceHigh1Idx].high > priceSlice[priceHigh2Idx].high &&
    rsiSlice[priceHigh1Idx] < rsiSlice[priceHigh2Idx];

  return { bullDiv, bearDiv };
}

// Helper: calculate RSI series (array of RSI values over time)
function calcRSISeries(closes, period = 14) {
  const series = [];
  for (let i = period; i < closes.length; i++) {
    series.push(calcRSI(closes.slice(0, i + 1), period));
  }
  return series;
}

// ── INDICATOR 6: MULTI-TIMEFRAME RSI ─────────────────────
// RSI oversold/overbought on BOTH 1H and 4H = much stronger signal
// than 1H alone. Confluence across timeframes = higher conviction.
function getMTFRSI(closes1h, closes4h) {
  if (closes1h.length < 15 || closes4h.length < 15) return null;
  const rsi1h = calcRSI(closes1h, 14);
  const rsi4h = calcRSI(closes4h, 14);
  return {
    rsi1h, rsi4h,
    bothOversold:   rsi1h < 40 && rsi4h < 40,
    bothOverbought: rsi1h > 60 && rsi4h > 60,
    deeplyBothOversold:   rsi1h < 30 && rsi4h < 35,
    deeplyBothOverbought: rsi1h > 70 && rsi4h > 65
  };
}

// ── INDICATOR 7: CANDLE PATTERN RECOGNITION ──────────────
// Detects high-probability reversal candle patterns from OHLC.
// Hammer, bullish engulfing, doji, shooting star, bearish engulfing.
function getCandlePattern(candles) {
  if (candles.length < 3) return null;
  const c  = candles[candles.length - 1]; // current (just closed)
  const p  = candles[candles.length - 2]; // previous
  const pp = candles[candles.length - 3]; // two back

  const body    = Math.abs(c.close - c.open);
  const range   = c.high - c.low;
  const upperW  = c.high - Math.max(c.open, c.close);
  const lowerW  = Math.min(c.open, c.close) - c.low;
  const isBullC = c.close > c.open;
  const isBearC = c.close < c.open;
  const pbody   = Math.abs(p.close - p.open);
  const isBearP = p.close < p.open;
  const isBullP = p.close > p.open;

  const patterns = [];

  // Hammer — bullish reversal: small body, long lower wick, tiny upper wick
  if (lowerW > body * 2 && upperW < body * 0.5 && range > 0) {
    patterns.push({ name: 'hammer', bias: 'bull', strength: 'moderate' });
  }

  // Shooting star — bearish reversal: small body, long upper wick, tiny lower wick
  if (upperW > body * 2 && lowerW < body * 0.5 && range > 0) {
    patterns.push({ name: 'shooting_star', bias: 'bear', strength: 'moderate' });
  }

  // Bullish engulfing — current bull candle body engulfs previous bear body
  if (isBullC && isBearP && c.open < p.close && c.close > p.open && body > pbody) {
    patterns.push({ name: 'bull_engulfing', bias: 'bull', strength: 'strong' });
  }

  // Bearish engulfing — current bear candle body engulfs previous bull body
  if (isBearC && isBullP && c.open > p.close && c.close < p.open && body > pbody) {
    patterns.push({ name: 'bear_engulfing', bias: 'bear', strength: 'strong' });
  }

  // Doji — indecision: very small body relative to range
  if (body < range * 0.1 && range > 0) {
    patterns.push({ name: 'doji', bias: 'neutral', strength: 'weak' });
  }

  // Morning star — 3-candle bullish reversal
  if (isBearP && body < pbody * 0.5 && pp && pp.close < pp.open && isBullC) {
    patterns.push({ name: 'morning_star', bias: 'bull', strength: 'strong' });
  }

  // Evening star — 3-candle bearish reversal
  if (isBullP && body < pbody * 0.5 && pp && pp.close > pp.open && isBearC) {
    patterns.push({ name: 'evening_star', bias: 'bear', strength: 'strong' });
  }

  const bullPatterns = patterns.filter(p => p.bias === 'bull');
  const bearPatterns = patterns.filter(p => p.bias === 'bear');
  const hasBull = bullPatterns.length > 0;
  const hasBear = bearPatterns.length > 0;
  const strongBull = bullPatterns.some(p => p.strength === 'strong');
  const strongBear = bearPatterns.some(p => p.strength === 'strong');

  return { patterns, hasBull, hasBear, strongBull, strongBear };
}

// ── INDICATOR 8: SESSION TIMING ───────────────────────────
// High-volume trading sessions produce more reliable signals.
// London: 07:00-12:00 UTC | NY: 13:00-20:00 UTC | Asia: 00:00-06:00 UTC
// Dead zones: 20:00-00:00 UTC and 06:00-07:00 UTC
function getSessionTiming() {
  const hour = new Date().getUTCHours();
  if (hour >= 7  && hour < 12) return { session: 'london',    quality: 'high' };
  if (hour >= 13 && hour < 20) return { session: 'newyork',   quality: 'high' };
  if (hour >= 0  && hour < 6)  return { session: 'asia',      quality: 'medium' };
  if (hour >= 12 && hour < 13) return { session: 'overlap',   quality: 'high' }; // London/NY overlap
  return { session: 'dead',      quality: 'low' };
}

// ── INDICATOR 9: SUPPORT & RESISTANCE ────────────────────
// Identifies key S/R levels from recent swing highs and lows.
// Entering near support on BUY or resistance on SELL = better RR.
// Distance from S/R level tells us how much room the trade has.
function getSupportResistance(candles) {
  if (candles.length < 50) return null;
  const recent = candles.slice(-50);
  const price  = recent[recent.length - 1].close;

  // Collect all swing highs and lows
  const swingHighs = [], swingLows = [];
  for (let i = 2; i < recent.length - 2; i++) {
    const isHigh = recent[i].high > recent[i-1].high && recent[i].high > recent[i-2].high &&
                   recent[i].high > recent[i+1].high && recent[i].high > recent[i+2].high;
    const isLow  = recent[i].low  < recent[i-1].low  && recent[i].low  < recent[i-2].low  &&
                   recent[i].low  < recent[i+1].low  && recent[i].low  < recent[i+2].low;
    if (isHigh) swingHighs.push(recent[i].high);
    if (isLow)  swingLows.push(recent[i].low);
  }

  if (!swingHighs.length || !swingLows.length) return null;

  // Nearest resistance (swing high above price)
  const resistances = swingHighs.filter(h => h > price).sort((a,b) => a - b);
  const supports    = swingLows.filter(l => l < price).sort((a,b) => b - a);

  const nearestResistance = resistances[0] || null;
  const nearestSupport    = supports[0]    || null;

  // Distance as percentage from current price
  const distToResistance = nearestResistance ? ((nearestResistance - price) / price * 100) : null;
  const distToSupport    = nearestSupport    ? ((price - nearestSupport)    / price * 100) : null;

  // Near support = within 1% = good BUY entry
  // Near resistance = within 1% = good SELL entry
  const nearSupport    = distToSupport    !== null && distToSupport    < 1.5;
  const nearResistance = distToResistance !== null && distToResistance < 1.5;

  return {
    nearestResistance, nearestSupport,
    distToResistance: distToResistance ? +distToResistance.toFixed(2) : null,
    distToSupport:    distToSupport    ? +distToSupport.toFixed(2)    : null,
    nearSupport, nearResistance
  };
}

// ── INDICATOR 10: TREND AGE ───────────────────────────────
// Counts how many consecutive candles the current trend has been active.
// Young trend (< 8 candles) = early = more room. Good for entries.
// Old trend (> 24 candles) = mature = likely near reversal. Avoid.
function getTrendAge(closes, trendDir) {
  if (!closes || closes.length < 10 || !trendDir) return null;
  let age = 0;
  const ema9  = (arr) => calcEMA(arr, 9);
  const ema21 = (arr) => calcEMA(arr, 21);

  for (let i = closes.length - 1; i >= 1; i--) {
    const slice = closes.slice(0, i + 1);
    const e9    = ema9(slice);
    const e21   = ema21(slice);
    const curDir = e9 > e21 ? 'bull' : 'bear';
    if (curDir === trendDir) age++;
    else break;
  }

  return {
    age, // candles in current trend
    young:  age <= 8,           // fresh trend, most room
    mature: age > 8 && age <= 24, // established
    old:    age > 24             // extended, reversal risk
  };
}

// ══════════════════════════════════════════════════════════
// SIGNAL LOGIC v4 — BACKTEST-INFORMED
//
// KEY LESSON FROM BACKTEST:
//   ★ signals (47% WR) outperformed ★★★ (29% WR) because
//   they fired EARLIER with less filtering.
//   Old ★★★ required full trend alignment = fired late.
//
// v4 FIX:
//   ★★★ = MACD confirmed + RSI extreme + BB extreme
//   This fires early, at compressed price levels,
//   with maximum room to reach TP1 before reversal.
//   Trend alignment adds bonus points — never required.
//
//   Quality AND quantity — not one or the other.
//
// SCORING (baseline 6.0 — MACD confirmed):
//   RSI extreme:     up to +2.5  (primary driver)
//   BB extreme:      up to +2.0  (entry timing)
//   4H aligned:      +1.5 bonus  (never required)
//   4H counter:      -0.5 only   (small penalty)
//   1H modifier:     ±0.5        (very light)
//   Low volume:      -0.5        (extreme only)
//
// THRESHOLDS:
//   ★★★ = score ≥ 8.0  (RSI+BB both extreme = frequent)
//   ★★  = score ≥ 6.5  (one extreme or 4H aligned)
//   ★   = score ≥ 5.5  (MACD only, neutral conditions)
//
// RR: TP1=3x ATR (2:1 RR), TP2=5x ATR (3.3:1 RR)
//     Break-even at 33% win rate — achievable at all tiers
// ══════════════════════════════════════════════════════════

function getSignals(rsi, macd, bb, volRatio, trend1h, trend4h, atr, price,
  priceStruct, emaSlope, squeeze,
  volSurge, rsiDiv, mtfRsi, candlePattern, session, snr, trendAge) {
  const results = [];
  const bbB = (bb.pctB > 0.05 && bb.pctB < 0.95) ? bb.pctB : 0.5;
  const trend4hDir = trend4h?.trend || null;
  const trend1hDir = trend1h?.trend || null;

  // ── BUY: MACD bullish is only hard requirement ────────
  if (macd.bull) {
    let score = 6.0; // MACD bullish = meaningful baseline

    // RSI — PRIMARY driver. Oversold = room to TP1.
    if      (rsi < 30) score += 2.5;
    else if (rsi < 38) score += 1.5;
    else if (rsi < 45) score += 0.5;
    else if (rsi > 70) score -= 1.5;
    else if (rsi > 60) score -= 0.5;

    // BB — ENTRY TIMING. Lower band = compressed, max upside.
    if      (bbB < 0.20) score += 2.0;
    else if (bbB < 0.35) score += 1.0;
    else if (bbB > 0.80) score -= 1.5;
    else if (bbB > 0.65) score -= 0.5;

    // 4H — bonus only, never blocks
    if      (trend4hDir === 'bull') score += 1.5;
    else if (trend4hDir === 'bear') score -= 0.5;

    // 1H — very light
    if      (trend1hDir === 'bull') score += 0.5;
    else if (trend1hDir === 'bear') score -= 0.5;

    // Volume — only penalise extreme lows
    if (volRatio < 0.005) score -= 0.5;

    // ── NEW INDICATOR BONUSES (BUY) ────────────────────
    // Price Structure — early trend confirmation
    if (priceStruct) {
      if (priceStruct.structure === 'bull' && priceStruct.strength === 'confirmed') score += 1.5;
      else if (priceStruct.structure === 'bull' && priceStruct.strength === 'partial')  score += 0.75;
      else if (priceStruct.structure === 'bear' && priceStruct.strength === 'confirmed') score -= 1.5;
      else if (priceStruct.structure === 'bear' && priceStruct.strength === 'partial')   score -= 0.75;
    }

    // EMA Slope — trend acceleration
    if (emaSlope) {
      if (emaSlope.direction === 'up'   && emaSlope.accelerating) score += 1.0;
      else if (emaSlope.direction === 'up' && !emaSlope.accelerating) score += 0.25;
      else if (emaSlope.direction === 'down' && emaSlope.accelerating) score -= 1.0;
      else if (emaSlope.direction === 'down') score -= 0.25;
    }

    // Volatility Squeeze — catch trend at start of breakout
    if (squeeze) {
      if (squeeze.releasing && squeeze.breakoutDir === 'bull') score += 1.5; // squeeze firing bullish
      else if (squeeze.squeezed) score += 0.5; // coiling — potential incoming move
      else if (squeeze.releasing && squeeze.breakoutDir === 'bear') score -= 1.0; // firing bearish
    }

    // ── NEW INDICATORS: BUY ───────────────────────────────
    // Volume surge — institutional participation
    if (volSurge) {
      if (volSurge.surge)    score += 1.0;
      else if (volSurge.elevated) score += 0.5;
      else if (volSurge.weak)     score -= 0.5;
    }

    // RSI Divergence — bullish divergence = strong reversal signal
    if (rsiDiv) {
      if (rsiDiv.bullDiv) score += 2.0; // most reliable leading signal
      if (rsiDiv.bearDiv) score -= 1.0; // bearish divergence on BUY = bad
    }

    // Multi-timeframe RSI — 1H+4H agreement
    if (mtfRsi) {
      if (mtfRsi.deeplyBothOversold)  score += 2.0;
      else if (mtfRsi.bothOversold)   score += 1.0;
      else if (mtfRsi.bothOverbought) score -= 1.5;
    }

    // Candle patterns
    if (candlePattern) {
      if (candlePattern.strongBull) score += 1.5;
      else if (candlePattern.hasBull) score += 0.75;
      if (candlePattern.strongBear) score -= 1.5;
      else if (candlePattern.hasBear) score -= 0.75;
    }

    // Session timing
    if (session) {
      if (session.quality === 'high')   score += 0.5;
      else if (session.quality === 'low') score -= 0.5;
    }

    // Support & Resistance — near support = good BUY entry
    if (snr) {
      if (snr.nearSupport)    score += 1.5; // price at support = ideal long entry
      if (snr.nearResistance) score -= 1.0; // buying into resistance = bad entry
    }

    // Trend age — young trend has most room
    if (trendAge && trend1hDir === 'bull') {
      if (trendAge.young)   score += 0.5;  // fresh uptrend
      else if (trendAge.old) score -= 1.0; // extended, reversal risk
    }

    score = Math.max(0, Math.min(10, +score.toFixed(1)));
    const conf = score >= 8.0 ? 3 : score >= 6.5 ? 2 : score >= 5.5 ? 1 : 0;

    if (conf > 0) {
      const aligned = trend4hDir === 'bull';
      const extras = [
        priceStruct?.structure === 'bull' ? 'Structure ↑' : '',
        emaSlope?.accelerating && emaSlope?.direction === 'up' ? 'Slope ↑acc' : '',
        squeeze?.releasing && squeeze?.breakoutDir === 'bull' ? 'Squeeze ↑' : '',
        rsiDiv?.bullDiv ? '📈 Bull divergence' : '',
        mtfRsi?.bothOversold ? 'MTF oversold' : '',
        candlePattern?.strongBull ? `${candlePattern.patterns.find(p=>p.bias==='bull')?.name}` : '',
        snr?.nearSupport ? `Near support` : '',
        trendAge?.young ? 'Young trend' : trendAge?.old ? 'Old trend' : ''
      ].filter(Boolean).join(' · ');
      const trendNote = `${trend4hDir ? (aligned ? '4H aligned' : '4H counter — reduce size') : 'No 4H'} · MACD bull · RSI ${rsi} · BB ${bb.pct}%${extras ? ' · ' + extras : ''}`;
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

  // ── SELL: MACD bearish is only hard requirement ───────
  if (!macd.bull) {
    let score = 6.0;

    // RSI — overbought = room to TP1 on short
    if      (rsi > 70) score += 2.5;
    else if (rsi > 62) score += 1.5;
    else if (rsi > 55) score += 0.5;
    else if (rsi < 30) score -= 1.5;
    else if (rsi < 40) score -= 0.5;

    // BB — upper band = compressed, max downside
    if      (bbB > 0.80) score += 2.0;
    else if (bbB > 0.65) score += 1.0;
    else if (bbB < 0.20) score -= 1.5;
    else if (bbB < 0.35) score -= 0.5;

    // 4H — bonus only
    if      (trend4hDir === 'bear') score += 1.5;
    else if (trend4hDir === 'bull') score -= 0.5;

    // 1H
    if      (trend1hDir === 'bear') score += 0.5;
    else if (trend1hDir === 'bull') score -= 0.5;

    if (volRatio < 0.005) score -= 0.5;

    // ── NEW INDICATOR BONUSES (SELL) ───────────────────
    if (priceStruct) {
      if (priceStruct.structure === 'bear' && priceStruct.strength === 'confirmed') score += 1.5;
      else if (priceStruct.structure === 'bear' && priceStruct.strength === 'partial')   score += 0.75;
      else if (priceStruct.structure === 'bull' && priceStruct.strength === 'confirmed') score -= 1.5;
      else if (priceStruct.structure === 'bull' && priceStruct.strength === 'partial')   score -= 0.75;
    }

    if (emaSlope) {
      if (emaSlope.direction === 'down' && emaSlope.accelerating) score += 1.0;
      else if (emaSlope.direction === 'down' && !emaSlope.accelerating) score += 0.25;
      else if (emaSlope.direction === 'up' && emaSlope.accelerating) score -= 1.0;
      else if (emaSlope.direction === 'up') score -= 0.25;
    }

    if (squeeze) {
      if (squeeze.releasing && squeeze.breakoutDir === 'bear') score += 1.5;
      else if (squeeze.squeezed) score += 0.5;
      else if (squeeze.releasing && squeeze.breakoutDir === 'bull') score -= 1.0;
    }

    // ── NEW INDICATORS: SELL ──────────────────────────────
    if (volSurge) {
      if (volSurge.surge)         score += 1.0;
      else if (volSurge.elevated) score += 0.5;
      else if (volSurge.weak)     score -= 0.5;
    }
    if (rsiDiv) {
      if (rsiDiv.bearDiv) score += 2.0;
      if (rsiDiv.bullDiv) score -= 1.0;
    }
    if (mtfRsi) {
      if (mtfRsi.deeplyBothOverbought)  score += 2.0;
      else if (mtfRsi.bothOverbought)   score += 1.0;
      else if (mtfRsi.bothOversold)     score -= 1.5;
    }
    if (candlePattern) {
      if (candlePattern.strongBear) score += 1.5;
      else if (candlePattern.hasBear) score += 0.75;
      if (candlePattern.strongBull) score -= 1.5;
      else if (candlePattern.hasBull) score -= 0.75;
    }
    if (session) {
      if (session.quality === 'high')   score += 0.5;
      else if (session.quality === 'low') score -= 0.5;
    }
    if (snr) {
      if (snr.nearResistance) score += 1.5; // shorting at resistance = ideal
      if (snr.nearSupport)    score -= 1.0; // shorting into support = bad
    }
    if (trendAge && trend1hDir === 'bear') {
      if (trendAge.young)    score += 0.5;
      else if (trendAge.old) score -= 1.0;
    }

    score = Math.max(0, Math.min(10, +score.toFixed(1)));
    const conf = score >= 8.0 ? 3 : score >= 6.5 ? 2 : score >= 5.5 ? 1 : 0;

    if (conf > 0) {
      const aligned = trend4hDir === 'bear';
      const extras = [
        priceStruct?.structure === 'bear' ? 'Structure ↓' : '',
        emaSlope?.accelerating && emaSlope?.direction === 'down' ? 'Slope ↓acc' : '',
        squeeze?.releasing && squeeze?.breakoutDir === 'bear' ? 'Squeeze ↓' : '',
        rsiDiv?.bearDiv ? '📉 Bear divergence' : '',
        mtfRsi?.bothOverbought ? 'MTF overbought' : '',
        candlePattern?.strongBear ? `${candlePattern.patterns.find(p=>p.bias==='bear')?.name}` : '',
        snr?.nearResistance ? 'Near resistance' : '',
        trendAge?.young ? 'Young trend' : trendAge?.old ? 'Old trend' : ''
      ].filter(Boolean).join(' · ');
      const trendNote = `${trend4hDir ? (aligned ? '4H aligned' : '4H counter — reduce size') : 'No 4H'} · MACD bear · RSI ${rsi} · BB ${bb.pct}%${extras ? ' · ' + extras : ''}`;
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
  // Original leading indicators
  const priceStruct = getPriceStructure(candles1h);
  const emaSlope    = getEMASlope(closes1h);
  const squeeze     = getVolatilitySqueeze(candles1h);

  // New indicators
  const volSurge      = getVolumeSurge(candles1h);
  const rsiSeries     = calcRSISeries(closes1h, 14);
  const rsiDiv        = getRSIDivergence(candles1h, rsiSeries);
  const mtfRsi        = getMTFRSI(closes1h, closes4h);
  const candlePattern = getCandlePattern(candles1h);
  const session       = getSessionTiming();
  const snr           = getSupportResistance(candles1h);
  const trendAge      = getTrendAge(closes1h, trend1h?.trend);

  const signals = getSignals(
    rsi, macd, bb, volRatio, trend1h, trend4h, atr, price,
    priceStruct, emaSlope, squeeze,
    volSurge, rsiDiv, mtfRsi, candlePattern, session, snr, trendAge
  );
  const topSig   = signals[0];
  console.log(`${pair.sym}: RSI=${rsi} MACD=${macd.bull?'B':'b'} BB=${bb.pct}% 1H=${trend1h?.trend||'?'} 4H=${trend4h?.trend||'?'} → ${topSig?topSig.dir+' '+topSig.score+' ★'.repeat(topSig.conf):'HOLD'}`);
  return {
    sym:pair.sym, price, pct24h, vol, mcap, volRatio,
    rsi, macd, bb, atr, trend1h, trend4h,
    priceStruct, emaSlope, squeeze,
    volSurge, rsiDiv, mtfRsi, candlePattern, session, snr, trendAge,
    score:    topSig?.score    || 5,
    swing:    topSig?.swing    || 'HOLD',
    scalp:    topSig?.scalp    || 'HOLD',
    conf:     topSig?.conf     || 1,
    aligned:  topSig?.aligned  || null,
    trendNote:topSig?.trendNote|| '',
    signals
  };
}

// ── SIGNAL HISTORY (4H window) ────────────────────────────
let signalHistory = [];
const HISTORY_TTL = 4*60*60*1000;

function addToHistory(results) {
  const now = Date.now();
  const nearClose = isNearCandleClose();
  signalHistory = signalHistory.filter(h=>(now-h.ts)<HISTORY_TTL);

  results.forEach(s => {
    if (!s.signals) return;
    s.signals.forEach(sig => {
      const isDupe = signalHistory.some(h=>h.sym===s.sym&&h.dir===sig.dir&&(now-h.ts)<5*60*1000);

      if (!isDupe) {
        // Always add to history so table shows current state
        signalHistory.push({
          sym:s.sym, price:s.price, dir:sig.dir, score:sig.score,
          conf:sig.conf, sl:sig.sl, tp1:sig.tp1, tp2:sig.tp2,
          swing:sig.swing, scalp:sig.scalp, aligned:sig.aligned,
          trendNote:sig.trendNote, rsi:s.rsi, atr:s.atr,
          ts:now, timeStr:new Date(now).toUTCString().slice(17,25),
          confirmedAtClose: nearClose // flag whether this fired near close
        });

        // Only log to performance tracker and send Telegram near candle close
        // This ensures signals are based on nearly-confirmed candle data
        if (sig.conf === 3 && nearClose) {
          addSignalToLog(s, sig);
          sendTelegram(formatTGSignal(s, sig));
          console.log(`🔔 CONFIRMED SIGNAL (near candle close): ${sig.dir} ${s.sym} ${sig.score}/10 ★★★`);
        } else if (sig.conf === 3 && !nearClose) {
          const minsLeft = minutesToCandleClose();
          console.log(`⏳ ${sig.dir} ${s.sym} ${sig.score}/10 ★★★ — waiting for candle close (${minsLeft}m left)`);
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
      signalLogic:'v4 — MACD gate + RSI/BB scoring + 4H bonus',
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
        const price = w1h[w1h.length-1].close;
        const ps   = getPriceStructure(w1h);
        const es   = getEMASlope(c1h);
        const sq   = getVolatilitySqueeze(w1h);
        const vs   = getVolumeSurge(w1h);
        const rsiS = calcRSISeries(c1h, 14);
        const rd   = getRSIDivergence(w1h, rsiS);
        const mtr  = getMTFRSI(c1h, c4h);
        const cp   = getCandlePattern(w1h);
        const sess = getSessionTiming();
        const snrB = getSupportResistance(w1h);
        const ta   = getTrendAge(c1h, t1h?.trend);
        const sigs = getSignals(rsi, macd, bb, 0.02, t1h, t4h, atr, price,
          ps, es, sq, vs, rd, mtr, cp, sess, snrB, ta);
        if (!sigs.length) continue;
        const sig = sigs[0];
        const outcome = checkOutcome(candles, idx, sig);
        allResults.push({ sym:pair.sym, dir:sig.dir, conf:sig.conf, score:sig.score,
          price, sl:sig.sl, tp1:sig.tp1, time:candles[idx].time, ...outcome });
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
      avgLossH:losses.length>0?+(losses.reduce((s,x)=>s+x.hours,0)/losses.length).toFixed(1):null };
  }

  backtestResults = {
    overall:  stats(allResults),
    byStars:  { 3:stats(allResults.filter(s=>s.conf===3)), 2:stats(allResults.filter(s=>s.conf===2)), 1:stats(allResults.filter(s=>s.conf===1)) },
    byPair:   Object.fromEntries(PAIRS.map(p=>[p.sym, stats(allResults.filter(s=>s.sym===p.sym))])),
    byDir:    { BUY:stats(allResults.filter(s=>s.dir==='BUY')), SELL:stats(allResults.filter(s=>s.dir==='SELL')) },
    totalSignals: allResults.length, daysBack:83,
    ranAt: new Date().toISOString(),
    recentSignals: allResults.slice(-50).reverse()
  };

  console.log(`✅ Backtest done: ${allResults.length} signals`);
  console.log(`★★★ ${backtestResults.byStars[3].winRate}% | ★★ ${backtestResults.byStars[2].winRate}% | ★ ${backtestResults.byStars[1].winRate}%`);
  backtestRunning = false;
}

app.get('/api/backtest', (req, res) => {
  if (!backtestResults && !backtestRunning) runBacktest();
  if (backtestRunning) return res.json({ ok:true, status:'running' });
  if (!backtestResults) return res.json({ ok:true, status:'running' });
  res.json({ ok:true, status:'complete', results:backtestResults });
});

setTimeout(()=>{ console.log('Scheduling backtest...'); runBacktest(); }, 10000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Defi Insider Signal Bot v4 on port ${PORT}`));
