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
  { sym:'XRP',  cc:'XRP',  mcap:58e9  },
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

// ── SIGNAL PERFORMANCE LOG ────────────────────────────────
const LOG_FILE = path.join(__dirname, 'signals-log.json');

function loadLog() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    }
  } catch(e) { console.error('Log load error:', e.message); }
  return [];
}

function saveLog(log) {
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  } catch(e) { console.error('Log save error:', e.message); }
}

let signalLog = loadLog();

function addSignalToLog(s, sig) {
  // Avoid duplicates within 5 minutes
  const now = Date.now();
  const isDupe = signalLog.some(e =>
    e.sym === s.sym && e.dir === sig.dir && (now - e.firedAt) < 5*60*1000
  );
  if (isDupe) return;

  const entry = {
    id:         now + '_' + s.sym + '_' + sig.dir,
    sym:        s.sym,
    dir:        sig.dir,
    score:      sig.score,
    conf:       sig.conf,
    entryPrice: s.price,
    sl:         sig.sl,
    tp1:        sig.tp1,
    tp2:        sig.tp2,
    trendNote:  sig.trendNote,
    firedAt:    now,
    firedStr:   new Date(now).toUTCString().slice(0, 25),
    check1H:    null,
    check4H:    null,
    check24H:   null,
    finalResult:'pending'
  };

  signalLog.push(entry);
  // Keep last 500 signals
  if (signalLog.length > 500) signalLog = signalLog.slice(-500);
  saveLog(signalLog);
  console.log(`📝 Signal logged: ${sig.dir} ${s.sym} @ ${fmtP(s.price)}`);
}

function calcPnL(entry, currentPrice) {
  if (entry.dir === 'BUY') {
    return +((currentPrice - entry.entryPrice) / entry.entryPrice * 100).toFixed(2);
  } else {
    return +((entry.entryPrice - currentPrice) / entry.entryPrice * 100).toFixed(2);
  }
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

    const price   = pair.price;
    const elapsed = now - entry.firedAt;
    const pnl     = calcPnL(entry, price);
    const result  = checkResult(entry, price);

    // 1H checkpoint
    if (!entry.check1H && elapsed >= 60*60*1000) {
      entry.check1H = { price, pnl, result, ts: now };
      changed = true;
      console.log(`1H check ${entry.sym} ${entry.dir}: ${result} (${pnl}%)`);
    }

    // 4H checkpoint
    if (!entry.check4H && elapsed >= 4*60*60*1000) {
      entry.check4H = { price, pnl, result, ts: now };
      changed = true;
      console.log(`4H check ${entry.sym} ${entry.dir}: ${result} (${pnl}%)`);
    }

    // 24H checkpoint — final
    if (!entry.check24H && elapsed >= 24*60*60*1000) {
      entry.check24H = { price, pnl, result, ts: now };
      entry.finalResult = result === 'pending' ? 'expired' : result;
      entry.resolvedAt = now;
      changed = true;
      console.log(`24H FINAL ${entry.sym} ${entry.dir}: ${entry.finalResult} (${pnl}%)`);

      // Telegram final result
      const emoji = entry.finalResult === 'win' ? '✅' : entry.finalResult === 'loss' ? '❌' : '⏰';
      await sendTelegram(
        `${emoji} <b>Signal Result: ${entry.finalResult.toUpperCase()}</b>\n\n` +
        `<b>${entry.dir} ${entry.sym}/USDT</b>\n` +
        `Entry: ${fmtP(entry.entryPrice)} → Now: ${fmtP(price)}\n` +
        `P&L: <b>${pnl > 0 ? '+' : ''}${pnl}%</b>\n` +
        `Score was: ${entry.score}/10 ${'⭐'.repeat(entry.conf)}\n\n` +
        `🤖 Defi Insider Signal Bot`
      );
    }

    // Resolve early if TP1 or SL hit before checkpoints
    if (entry.finalResult === 'pending') {
      const earlyResult = checkResult(entry, price);
      if (earlyResult !== 'pending') {
        entry.finalResult = earlyResult;
        entry.resolvedAt = now;
        changed = true;
        const emoji = earlyResult === 'win' ? '✅' : '❌';
        const hours = (elapsed / 3600000).toFixed(1);
        console.log(`Early resolve ${entry.sym} ${entry.dir}: ${earlyResult} in ${hours}H`);

        await sendTelegram(
          `${emoji} <b>Signal ${earlyResult.toUpperCase()}</b> (${hours}H)\n\n` +
          `<b>${entry.dir} ${entry.sym}/USDT</b>\n` +
          `Entry: ${fmtP(entry.entryPrice)} → ${earlyResult === 'win' ? 'TP1' : 'SL'}: ${fmtP(earlyResult === 'win' ? entry.tp1 : entry.sl)}\n` +
          `P&L: <b>${pnl > 0 ? '+' : ''}${pnl}%</b>\n\n` +
          `🤖 Defi Insider Signal Bot`
        );
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
  const winRate  = total > 0 ? Math.round((wins.length / total) * 100) : null;

  // Win rate by checkpoint
  const r1H  = signalLog.filter(e => e.check1H);
  const r4H  = signalLog.filter(e => e.check4H);
  const r24H = signalLog.filter(e => e.check24H);
  const wr1H  = r1H.length  > 0 ? Math.round(r1H.filter(e => e.check1H.result  === 'win').length / r1H.length  * 100) : null;
  const wr4H  = r4H.length  > 0 ? Math.round(r4H.filter(e => e.check4H.result  === 'win').length / r4H.length  * 100) : null;
  const wr24H = r24H.length > 0 ? Math.round(r24H.filter(e => e.check24H.result === 'win').length / r24H.length * 100) : null;

  // By pair
  const byPair = {};
  PAIRS.forEach(p => {
    const ps = resolved.filter(e => e.sym === p.sym);
    byPair[p.sym] = {
      total: ps.length,
      wins:  ps.filter(e => e.finalResult === 'win').length,
      wr:    ps.length > 0 ? Math.round(ps.filter(e => e.finalResult === 'win').length / ps.length * 100) : null
    };
  });

  // By direction
  const buyRes  = resolved.filter(e => e.dir === 'BUY');
  const sellRes = resolved.filter(e => e.dir === 'SELL');
  const buyWR   = buyRes.length  > 0 ? Math.round(buyRes.filter(e => e.finalResult  === 'win').length / buyRes.length  * 100) : null;
  const sellWR  = sellRes.length > 0 ? Math.round(sellRes.filter(e => e.finalResult === 'win').length / sellRes.length * 100) : null;

  // Avg pnl
  const avgWinPnL  = wins.length   > 0 ? +(wins.reduce((s, e) => s + (e.check24H?.pnl || e.check4H?.pnl || e.check1H?.pnl || 0), 0) / wins.length).toFixed(2) : null;
  const avgLossPnL = losses.length > 0 ? +(losses.reduce((s, e) => s + (e.check24H?.pnl || e.check4H?.pnl || e.check1H?.pnl || 0), 0) / losses.length).toFixed(2) : null;

  // Best signal
  const bestSig = wins.length > 0 ? wins.reduce((best, e) => {
    const pnl = e.check24H?.pnl || e.check4H?.pnl || e.check1H?.pnl || 0;
    const bpnl = best.check24H?.pnl || best.check4H?.pnl || best.check1H?.pnl || 0;
    return pnl > bpnl ? e : best;
  }, wins[0]) : null;

  // Streak
  let streak = 0, streakType = null;
  for (let i = resolved.length - 1; i >= 0; i--) {
    const r = resolved[i].finalResult;
    if (r === 'expired') continue;
    if (streakType === null) { streakType = r; streak = 1; }
    else if (r === streakType) streak++;
    else break;
  }

  return {
    total, wins: wins.length, losses: losses.length, expired: expired.length,
    winRate, wr1H, wr4H, wr24H,
    byPair, buyWR, sellWR,
    avgWinPnL, avgLossPnL,
    bestSig, streak, streakType,
    pending: signalLog.filter(e => e.finalResult === 'pending').length
  };
}

// Daily summary at midnight UTC
function scheduleDailySummary() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  const msUntilMidnight = midnight - now;

  setTimeout(async () => {
    const stats = calcStats();
    const today = signalLog.filter(e => {
      const d = new Date(e.firedAt);
      const n = new Date();
      return d.getUTCDate() === n.getUTCDate() - 1;
    });
    const todayWins = today.filter(e => e.finalResult === 'win').length;
    await sendTelegram(
      `📊 <b>Daily Signal Summary</b>\n\n` +
      `Signals today: <b>${today.length}</b>\n` +
      `Wins: <b>${todayWins}</b> · Losses: <b>${today.length - todayWins}</b>\n\n` +
      `Overall win rate: <b>${stats.winRate ?? '--'}%</b> (${stats.total} signals)\n` +
      `Best timeframe: ${stats.wr4H !== null ? '4H ' + stats.wr4H + '%' : '--'}\n\n` +
      `🤖 Defi Insider Signal Bot`
    );
    scheduleDailySummary(); // schedule next day
  }, msUntilMidnight);
}
scheduleDailySummary();

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

function derive4H(c1h) {
  const out = [];
  for (let i = 0; i + 3 < c1h.length; i += 4) {
    const g = c1h.slice(i, i + 4);
    out.push({
      time:   g[0].time,
      open:   g[0].open,
      high:   Math.max(...g.map(c => c.high)),
      low:    Math.min(...g.map(c => c.low)),
      close:  g[g.length-1].close,
      volume: g.reduce((s,c) => s+c.volume, 0)
    });
  }
  return out;
}

async function getCandles(sym) {
  for (const [name, fn] of [['CC', () => fetchCC(sym)], ['CG', () => fetchCG(sym)]]) {
    try {
      const candles1h = await fn();
      const candles4h = derive4H(candles1h);
      pairCache[sym] = { candles1h, candles4h, ts: Date.now() };
      console.log(`✓ ${sym} (${name})`);
      return { candles1h, candles4h };
    } catch(e) { console.log(`✗ ${sym} ${name}: ${e.message}`); }
  }
  if (pairCache[sym]) {
    const age = Math.round((Date.now() - pairCache[sym].ts) / 60000);
    console.log(`⚠ ${sym}: cache (${age}m)`);
    return pairCache[sym];
  }
  throw new Error(`${sym}: all sources failed`);
}

// ── INDICATORS ────────────────────────────────────────────
function calcRSI(closes, p = 14) {
  if (closes.length < p+1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length-p; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) g += d; else l += Math.abs(d);
  }
  const ag = g/p, al = l/p;
  return al === 0 ? 100 : Math.round(100 - 100/(1+ag/al));
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
  const mid = sl.reduce((a,b) => a+b,0)/p;
  const std = Math.sqrt(sl.reduce((s,v) => s+Math.pow(v-mid,2),0)/p);
  const upper = mid+2*std, lower = mid-2*std;
  const last = closes[closes.length-1];
  const range = upper-lower;
  const pctB = range===0 ? 0.5 : (last-lower)/range;
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
  return trs.slice(-p).reduce((a,b)=>a+b,0)/p;
}

function calcEMA(closes, p) {
  const k = 2/(p+1); let e = closes[0];
  for (let i = 1; i < closes.length; i++) e = closes[i]*k + e*(1-k);
  return e;
}

function getTrend(closes, fast, slow) {
  if (closes.length < slow) return null;
  return { trend: calcEMA(closes,fast) > calcEMA(closes,slow) ? 'bull' : 'bear' };
}

// ── SIGNAL LOGIC ──────────────────────────────────────────
// Backtest version — uses ORIGINAL TP/SL values to reflect actual traded methodology
// TP1 = 2x ATR, TP2 = 3.5x ATR, SL = 1.5x ATR
// Do NOT change these — they must match how we were trading
function getSignalsBacktest(rsi, macd, bb, volRatio, trend1h, trend4h, atr, price) {
  if (trend1h && trend4h && trend1h.trend !== trend4h.trend) return [];
  const trendDir = trend4h?.trend || trend1h?.trend || null;
  if (!trendDir) return [];
  if (trendDir === 'bull' && !macd.bull) return [];
  if (trendDir === 'bear' &&  macd.bull) return [];
  const bbB = (bb.pctB > 0.05 && bb.pctB < 0.95) ? bb.pctB : 0.5;
  let score = 6.0;
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
  if      (volRatio > 0.05)  score += 0.5;
  else if (volRatio < 0.005) score -= 1.0;
  score = Math.max(0, Math.min(10, +score.toFixed(1)));
  const conf = score >= 8.5 ? 3 : score >= 6.5 ? 2 : 1;
  const trendNote = `1H: ${trend1h?.trend?.toUpperCase()||'?'} · 4H: ${trend4h?.trend?.toUpperCase()||'?'}`;
  if (trendDir === 'bull') {
    return [{ dir:'BUY', score, conf, aligned:true, trendNote,
      sl:  +(price - atr*1.5).toFixed(4),
      tp1: +(price + atr*2.0).toFixed(4),  // ORIGINAL — do not change
      tp2: +(price + atr*3.5).toFixed(4)   // ORIGINAL — do not change
    }];
  } else {
    return [{ dir:'SELL', score, conf, aligned:true, trendNote,
      sl:  +(price + atr*1.5).toFixed(4),
      tp1: +(price - atr*2.0).toFixed(4),  // ORIGINAL — do not change
      tp2: +(price - atr*3.5).toFixed(4)   // ORIGINAL — do not change
    }];
  }
}

function getSignals(rsi, macd, bb, volRatio, trend1h, trend4h, atr, price) {
  // Step 1: Trend gate — 1H and 4H must agree
  if (trend1h && trend4h && trend1h.trend !== trend4h.trend) return [];
  const trendDir = trend4h?.trend || trend1h?.trend || null;
  if (!trendDir) return [];

  // Step 2: MACD must align with trend
  if (trendDir === 'bull' && !macd.bull) return [];
  if (trendDir === 'bear' &&  macd.bull) return [];

  // Step 3: BB sanity — reject corrupted readings
  const bbB = (bb.pctB > 0.05 && bb.pctB < 0.95) ? bb.pctB : 0.5;

  // Step 4: Score within confirmed trend
  let score = 6.0;

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
  if      (volRatio > 0.05)  score += 0.5;
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
      tp1: +(price + atr*3.0).toFixed(4),
      tp2: +(price + atr*5.0).toFixed(4)
    }];
  } else {
    return [{
      dir:'SELL', score, conf, aligned:true, trendNote,
      swing: score >= 7.0 ? 'SELL' : 'WATCH',
      scalp: score >= 6.5 ? 'SELL' : 'WATCH',
      sl:  +(price + atr*1.5).toFixed(4),
      tp1: +(price - atr*3.0).toFixed(4),
      tp2: +(price - atr*5.0).toFixed(4)
    }];
  }
}

// ── PROCESS PAIR ──────────────────────────────────────────
async function processPair(pair) {
  const { candles1h, candles4h } = await getCandles(pair.sym);
  if (candles1h.length < 26) throw new Error('Insufficient candles');

  const closes1h = candles1h.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);
  const price    = closes1h[closes1h.length-1];

  const rsi    = calcRSI(closes1h, 14);
  const macd   = calcMACD(closes1h);
  const bb     = calcBB(closes1h, 20);
  const atr    = calcATR(candles1h, 14);
  const trend1h = getTrend(closes1h, 9, 21);
  const trend4h = getTrend(closes4h, 20, 50);

  const price24hAgo = closes1h.length >= 24 ? closes1h[closes1h.length-24] : closes1h[0];
  const pct24h = ((price - price24hAgo) / price24hAgo) * 100;
  const lastC  = candles1h[candles1h.length-1];
  const vol    = (lastC.volume || 0) * price;
  const mcap   = pair.mcap || 0;
  const volRatio = mcap > 0 ? vol / mcap : 0;

  const signals = getSignals(rsi, macd, bb, volRatio, trend1h, trend4h, atr, price);
  const topSig  = signals[0];

  console.log(`${pair.sym}: RSI=${rsi} 1H=${trend1h?.trend||'?'} 4H=${trend4h?.trend||'?'} MACD=${macd.bull?'B':'b'} → ${topSig ? topSig.dir+' '+topSig.score : 'HOLD'}`);

  return {
    sym:pair.sym, price, pct24h, vol, mcap, volRatio,
    rsi, macd, bb, atr, trend1h, trend4h,
    score:    topSig?.score    || 5,
    swing:    topSig?.swing    || 'HOLD',
    scalp:    topSig?.scalp    || 'HOLD',
    conf:     topSig?.conf     || 1,
    aligned:  topSig?.aligned  || null,
    trendNote:topSig?.trendNote || '',
    signals
  };
}

// ── SIGNAL HISTORY (in-memory, 4H window) ────────────────
let signalHistory = [];
const HISTORY_TTL = 4*60*60*1000;

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
        // Log ★★★ to performance tracker + send Telegram
        if (sig.conf === 3) {
          addSignalToLog(s, sig);
          sendTelegram(formatTGSignal(s, sig));
        }
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
      data.push(await processPair(pair));
    } catch(e) {
      console.error(`${pair.sym}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  console.log(`Scan done: ${data.length}/${PAIRS.length}`);
  if (data.length === 0) throw new Error('All requests failed');
  addToHistory(data);
  await updateSignalLog(data); // check performance checkpoints
  return data;
}

// ── ROUTES ────────────────────────────────────────────────
app.get('/api/scan', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.data && (now - cache.ts) < CACHE_TTL) {
      return res.json({
        ok:true, data:cache.data,
        history:signalHistory.slice().reverse(),
        signalLog: signalLog.slice(-100).reverse(),
        stats: calcStats(),
        cached:true, timestamp:new Date().toISOString()
      });
    }
    const data = await buildSignals();
    cache = { data, ts:Date.now() };
    res.json({
      ok:true, data,
      history:signalHistory.slice().reverse(),
      signalLog: signalLog.slice(-100).reverse(),
      stats: calcStats(),
      cached:false, timestamp:new Date().toISOString()
    });
  } catch(e) {
    console.error('Scan error:', e.message);
    if (cache.data) {
      return res.json({
        ok:true, data:cache.data,
        history:signalHistory.slice().reverse(),
        signalLog: signalLog.slice(-100).reverse(),
        stats: calcStats(),
        cached:true, stale:true, timestamp:new Date().toISOString()
      });
    }
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post('/api/trade-alert', async (req, res) => {
  const { sym, dir, entry, sl, tp1, tp2, score, conf, type } = req.body;
  const msgs = {
    entered: `📥 <b>TRADE ENTERED</b>\n\n${dir==='BUY'?'🟢':'🔴'} <b>${sym}/USDT ${dir}</b>\nScore: ${score}/10 ${'⭐'.repeat(conf)}\n\n📍 Entry: ${entry}\n🛑 Stop:  ${sl}\n🎯 TP1:   ${tp1}\n🎯 TP2:   ${tp2}\n\n🤖 Defi Insider Signal Bot`,
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
    res.json({
      ok:true, source:'CryptoCompare',
      btcPrice:'$'+price?.toLocaleString(),
      pairs:PAIRS.map(p=>p.sym),
      cached:Object.keys(pairCache),
      signalsTracked: signalLog.length,
      stats: calcStats()
    });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Defi Insider Signal Bot on port ${PORT}`));

// ══════════════════════════════════════════════════════════
// BACKTESTER — ORIGINAL METHODOLOGY
// SL=1.5x ATR, TP1=2x ATR, TP2=3.5x ATR
// Skip gap: 10 candles between signals
// This matches the exact criteria used in live signals
// DO NOT CHANGE — results must reflect actual traded methodology
// ══════════════════════════════════════════════════════════

let backtestResults = null;
let backtestRunning = false;

async function fetchHistoricalCandles(sym) {
  const { default: fetch } = await import('node-fetch');
  // Fetch maximum available: 2000 x 1H candles (~83 days)
  const url = `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${sym}&tsym=USD&limit=2000`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.Response !== 'Success') throw new Error(json.Message || 'CC error');
  return json.Data.Data
    .map(c => ({ time:c.time, open:c.open, high:c.high, low:c.low, close:c.close, volume:c.volumeto||0 }))
    .filter(c => c.close > 0);
}

function runSignalLogicAt(candles, idx) {
  // Need at least 50 candles of history before this point
  if (idx < 50) return null;

  const window1h = candles.slice(0, idx + 1);
  const closes1h = window1h.map(c => c.close);

  // Derive 4H candles from the 1H window
  const window4h = derive4H(window1h);
  const closes4h = window4h.map(c => c.close);

  if (closes4h.length < 20) return null;

  const rsi    = calcRSI(closes1h, 14);
  const macd   = calcMACD(closes1h);
  const bb     = calcBB(closes1h, 20);
  const atr    = calcATR(window1h, 14);
  const trend1h = getTrend(closes1h, 9, 21);
  const trend4h = getTrend(closes4h, 20, 50);

  // Use same vol ratio proxy (no mcap data in historical, use vol/price ratio)
  const lastC   = window1h[window1h.length - 1];
  const price   = lastC.close;
  // Estimate volume ratio from last candle volume vs rolling average
  // Higher than average volume = above 0.02, lower = below
  const recentVols = window1h.slice(-20).map(c => c.volume);
  const avgVol = recentVols.reduce((a,b)=>a+b,0) / recentVols.length;
  const lastVol = window1h[window1h.length-1].volume;
  const volRatio = avgVol > 0 ? (lastVol / avgVol) * 0.02 : 0.02;

  const signals = getSignals(rsi, macd, bb, volRatio, trend1h, trend4h, atr, price);
  return signals.length > 0 ? { signal: signals[0], rsi, macd, bb, atr, price } : null;
}

function checkOutcome(candles, fromIdx, signal) {
  const { sl, tp1, dir } = signal;
  const maxLookAhead = 24; // 24 hours forward

  for (let i = fromIdx + 1; i < Math.min(fromIdx + maxLookAhead + 1, candles.length); i++) {
    const c = candles[i];
    const hoursElapsed = i - fromIdx;

    if (dir === 'BUY') {
      // Check high for TP1, low for SL
      if (c.high >= tp1 && c.low <= sl) {
        // Both hit same candle — use open to determine which first
        return { result: c.open >= sl ? 'win' : 'loss', hours: hoursElapsed };
      }
      if (c.high >= tp1) return { result: 'win',   hours: hoursElapsed };
      if (c.low  <= sl)  return { result: 'loss',  hours: hoursElapsed };
    } else {
      // SELL
      if (c.low <= tp1 && c.high >= sl) {
        return { result: c.open <= sl ? 'win' : 'loss', hours: hoursElapsed };
      }
      if (c.low  <= tp1) return { result: 'win',   hours: hoursElapsed };
      if (c.high >= sl)  return { result: 'loss',  hours: hoursElapsed };
    }
  }
  return { result: 'expired', hours: maxLookAhead };
}

async function runBacktest() {
  if (backtestRunning) return;
  backtestRunning = true;
  console.log('🔬 Starting backtest across all 12 pairs...');

  const allResults = [];
  const pairResults = {};

  for (const pair of PAIRS) {
    try {
      console.log(`Backtesting ${pair.sym}...`);
      const candles = await fetchHistoricalCandles(pair.sym);
      if (candles.length < 100) { console.log(`${pair.sym}: insufficient history`); continue; }

      const pairSignals = [];
      let lastSignalIdx = -10;

      for (let idx = 50; idx < candles.length - 24; idx++) {
        if (idx - lastSignalIdx < 10) continue;

        const result = runSignalLogicAt(candles, idx);
        if (!result) continue;

        const { signal } = result;
        const outcome = checkOutcome(candles, idx, signal);

        pairSignals.push({
          sym:   pair.sym,
          dir:   signal.dir,
          conf:  signal.conf,
          score: signal.score,
          price: result.price,
          sl:    signal.sl,
          tp1:   signal.tp1,
          rsi:   result.rsi,
          time:  candles[idx].time,
          ...outcome
        });

        lastSignalIdx = idx;
        allResults.push(pairSignals[pairSignals.length - 1]);
      }

      pairResults[pair.sym] = pairSignals;
      console.log(`${pair.sym}: ${pairSignals.length} signals`);

      await new Promise(r => setTimeout(r, 1500));
    } catch(e) {
      console.error(`Backtest ${pair.sym}: ${e.message}`);
    }
  }

  // ── COMPILE STATS ──────────────────────────────────────
  function compileStats(signals) {
    const total   = signals.length;
    const wins    = signals.filter(s => s.result === 'win');
    const losses  = signals.filter(s => s.result === 'loss');
    const expired = signals.filter(s => s.result === 'expired');
    const resolved= wins.length + losses.length;
    const winRate = resolved > 0 ? Math.round(wins.length / resolved * 100) : null;
    const avgWinH  = wins.length   > 0 ? +(wins.reduce((s,x)=>s+x.hours,0)/wins.length).toFixed(1) : null;
    const avgLossH = losses.length > 0 ? +(losses.reduce((s,x)=>s+x.hours,0)/losses.length).toFixed(1) : null;
    return { total, wins:wins.length, losses:losses.length, expired:expired.length, resolved, winRate, avgWinH, avgLossH };
  }

  // By star rating
  const byStars = {
    3: compileStats(allResults.filter(s => s.conf === 3)),
    2: compileStats(allResults.filter(s => s.conf === 2)),
    1: compileStats(allResults.filter(s => s.conf === 1))
  };

  // By pair
  const byPair = {};
  PAIRS.forEach(p => {
    byPair[p.sym] = compileStats(allResults.filter(s => s.sym === p.sym));
  });

  // By direction
  const byDir = {
    BUY:  compileStats(allResults.filter(s => s.dir === 'BUY')),
    SELL: compileStats(allResults.filter(s => s.dir === 'SELL'))
  };

  // Overall
  const overall = compileStats(allResults);

  backtestResults = {
    overall,
    byStars,
    byPair,
    byDir,
    totalSignals: allResults.length,
    candlesPer: 2000,
    daysBack: 83,
    methodology: 'SL=1.5x ATR, TP1=2x ATR, TP2=3.5x ATR — original traded methodology',
    ranAt: new Date().toISOString(),
    // Sample signals for display (last 50)
    recentSignals: allResults.slice(-50).reverse()
  };

  console.log(`✅ Backtest complete: ${allResults.length} total signals`);
  console.log(`★★★ win rate: ${byStars[3].winRate}% (${byStars[3].resolved} resolved)`);
  console.log(`★★  win rate: ${byStars[2].winRate}% (${byStars[2].resolved} resolved)`);
  console.log(`★   win rate: ${byStars[1].winRate}% (${byStars[1].resolved} resolved)`);

  backtestRunning = false;
}

// Backtest route
app.get('/api/backtest', (req, res) => {
  if (!backtestResults && !backtestRunning) {
    runBacktest();
    return res.json({ ok: true, status: 'running', message: 'Backtest started, check back in 60s' });
  }
  if (backtestRunning) {
    return res.json({ ok: true, status: 'running', message: 'Backtest in progress...' });
  }
  res.json({ ok: true, status: 'complete', results: backtestResults });
});

// Run backtest on startup (after 10 second delay to let server settle)
setTimeout(() => {
  console.log('Scheduling backtest in 10s...');
  runBacktest();
}, 10000);
