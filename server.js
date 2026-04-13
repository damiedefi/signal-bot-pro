const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.static('public'));

// ── TELEGRAM NOTIFICATIONS ────────────────────────────────
const TG_TOKEN   = process.env.TG_TOKEN   || '8657562447:AAGGn9GzBf8mHyP44ZAukdM702ls_NlboDI';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '5337031418';

async function sendTelegram(message) {
  try {
    const { default: fetch } = await import('node-fetch');
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });
    console.log('Telegram notification sent');
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

function formatTelegramSignal(s, sig) {
  const dir     = sig.dir === 'BUY' ? '🟢 BUY' : '🔴 SELL';
  const stars   = '⭐'.repeat(sig.conf);
  const aligned = sig.aligned ? '✅ Trend Aligned' : '⚠️ Counter-Trend';
  const lev     = leverageFromScore(sig.score, sig.conf);

  return `${dir} <b>${s.sym}/USDT</b>
${stars} ${sig.conf === 3 ? 'High Conviction' : 'Moderate'} — Score <b>${sig.score}/10</b>

📍 Entry:    <b>${fmtPrice(s.price)}</b>
🛑 Stop:     <b>${fmtPrice(sig.sl)}</b>
🎯 TP1:      <b>${fmtPrice(sig.tp1)}</b>
🎯 TP2:      <b>${fmtPrice(sig.tp2)}</b>
⚡ Leverage: <b>${lev}</b>
📊 ATR(14):  <b>${fmtPrice(s.atr)}</b>

${aligned}
<i>${sig.trendNote || ''}</i>

🤖 Defi Insider Signal Bot`;
}

function fmtPrice(p) {
  if (!p && p !== 0) return '--';
  if (p >= 10000) return '$' + p.toLocaleString('en', { maximumFractionDigits: 0 });
  if (p >= 1000)  return '$' + p.toLocaleString('en', { maximumFractionDigits: 1 });
  if (p >= 1)     return '$' + p.toFixed(2);
  if (p >= 0.01)  return '$' + p.toFixed(4);
  return '$' + p.toFixed(6);
}

function leverageFromScore(score, conf) {
  if (conf === 3 && score >= 9)   return '3x–5x';
  if (conf === 3 && score >= 8.5) return '2x–3x';
  if (conf === 2 && score >= 7)   return '1x–2x';
  return '1x spot';
}

// ── 12 PAIRS — hardcoded, real klines, no rate limit risk ──
const PAIRS = [
  { sym: 'BTC',  cc: 'BTC',  mcap: 1.32e12 },
  { sym: 'ETH',  cc: 'ETH',  mcap: 382e9   },
  { sym: 'BNB',  cc: 'BNB',  mcap: 61e9    },
  { sym: 'SOL',  cc: 'SOL',  mcap: 77e9    },
  { sym: 'DOGE', cc: 'DOGE', mcap: 23e9    },
  { sym: 'AVAX', cc: 'AVAX', mcap: 14e9    },
  { sym: 'LINK', cc: 'LINK', mcap: 8.5e9   },
  { sym: 'NEAR', cc: 'NEAR', mcap: 6.8e9   },
  { sym: 'UNI',  cc: 'UNI',  mcap: 5.9e9   },
  { sym: 'INJ',  cc: 'INJ',  mcap: 2.4e9   },
  { sym: 'SUI',  cc: 'SUI',  mcap: 2.1e9   },
  { sym: 'TAO',  cc: 'TAO',  mcap: 1.8e9   }
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

// ── 1H TREND (informational only — not used for filtering) ─
function get1HTrend(closes1h) {
  if (!closes1h || closes1h.length < 21) return null;
  const ema9  = calcEMA(closes1h, 9);
  const ema21 = calcEMA(closes1h, 21);
  const price = closes1h[closes1h.length - 1];
  return {
    trend:        ema9 > ema21 ? 'bull' : 'bear',
    priceVsEMA9:  price > ema9 ? 'above' : 'below',
    ema9:         +ema9.toFixed(4),
    ema21:        +ema21.toFixed(4)
  };
}


// ── SIGNAL DECISION ───────────────────────────────────────
// Active thresholds: score >= 6 = signal fires
// ★★★ = score >= 7.5 + 4H aligned
// ★★  = score >= 6 (including counter-trend)

// ── STAR RATING — single source of truth ─────────────────
// Stars come directly from score + alignment. Nothing else.
// 8.5+ AND aligned = ★★★ (high conviction, trend confirmed)
// 8.5+ but counter = ★★ (strong setup, against 4H — use caution)
// 6.0–8.4           = ★★ (valid signal, moderate conviction)
// Below 6           = no signal

function getStars(score, aligned) {
  if (score >= 8.5 && aligned) return 3;
  if (score >= 6.0) return 2;
  return 1;
}

function getSignals(rsi, macd, bb, pct24h, volRatio, trend4h, atr, price) {
  const bullScore = scoreDirection(rsi, macd, bb, pct24h, volRatio, trend4h, 'bull');
  const bearScore = scoreDirection(rsi, macd, bb, pct24h, volRatio, trend4h, 'bear');

  const results = [];

  // BUY signal
  if (bullScore >= 6) {
    const aligned = !trend4h || trend4h.trend === 'bull';
    const conf = getStars(bullScore, aligned);
    const trendNote = aligned
      ? (trend4h ? `Trend-confirmed — 4H is BULL.` : '')
      : `Counter-trend — 4H is BEAR. Score ${bullScore}/10 but capped at ★★.`;
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
    const conf = getStars(bearScore, aligned);
    const trendNote = aligned
      ? (trend4h ? `Trend-confirmed — 4H is BEAR.` : '')
      : `Counter-trend — 4H is BULL. Score ${bearScore}/10 but capped at ★★.`;
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
// ── KRAKEN API FETCH — no rate limits, no key needed ─────
// Kraken pair format: XBTUSD for BTC, ETHUSD for ETH, etc.
const KRAKEN_MAP = {
  BTC:  'XBTUSD',
  ETH:  'ETHUSD',
  BNB:  'BNBUSD',
  SOL:  'SOLUSD',
  DOGE: 'XDGUSD',
  AVAX: 'AVAXUSD',
  LINK: 'LINKUSD',
  NEAR: 'NEARUSD',
  UNI:  'UNIUSD',
  INJ:  'INJUSD',
  SUI:  'SUIUSD',
  TAO:  'TAOUSD'
};

async function krakenFetch(pair, interval, count = 200) {
  const { default: fetch } = await import('node-fetch');
  // Kraken intervals: 60 = 1H, 240 = 4H
  const since = Math.floor(Date.now() / 1000) - (interval * 60 * count);
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}&since=${since}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Kraken ${res.status}`);
  const json = await res.json();
  if (json.error && json.error.length > 0) throw new Error(`Kraken error: ${json.error[0]}`);
  // Kraken returns { result: { PAIRNAME: [[time,open,high,low,close,vwap,volume,count]], last: N } }
  const resultKey = Object.keys(json.result).find(k => k !== 'last');
  const candles = json.result[resultKey];
  // Each candle: [time, open, high, low, close, vwap, volume, count]
  // Kraken returns oldest first, last candle is current open — drop it
  return candles.slice(0, -1).map(c => ({
    time:   c[0],
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[6])
  }));
}

async function processPairData(pair, candles1h, candles4h) {
  if (candles1h.length < 26) throw new Error('Insufficient candles');

  // Kraken already drops the open candle in krakenFetch — candles are clean
  const closes1h = candles1h.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);
  const price    = closes1h[closes1h.length - 1]; // last confirmed close

  const rsi     = calcRSI(closes1h, 14);
  const macd    = calcMACD(closes1h);
  const bb      = calcBB(closes1h, 20);
  const atr     = calcATR(candles1h, 14);
  const trend4h = get4HTrend(closes4h);
  const trend1h = get1HTrend(closes1h);

  const price24hAgo = closes1h.length >= 24 ? closes1h[closes1h.length - 24] : closes1h[0];
  const pct24h = ((price - price24hAgo) / price24hAgo) * 100;

  const lastCandle = candles1h[candles1h.length - 1];
  const vol      = (lastCandle.volume || 0) * price; // convert to USD volume
  const mcap     = pair.mcap || 0;
  const volRatio = mcap > 0 ? vol / mcap : 0;

  const signals = getSignals(rsi, macd, bb, pct24h, volRatio, trend4h, trend1h, atr, price);
  const topSignal = [...signals].sort((a, b) => b.score - a.score)[0];

  console.log(
    `${pair.sym}: RSI=${rsi} MACD=${macd.bull?'BULL':'BEAR'} BB=${bb.pct}% ` +
    `1H=${trend1h?trend1h.trend:'?'} 4H=${trend4h?trend4h.trend:'?'} ` +
    `→ ${topSignal?topSignal.dir+' '+topSignal.score:'NO SIGNAL'}`
  );

  return {
    sym:      pair.sym,
    price,    pct24h, vol, mcap, volRatio,
    rsi,      macd,   bb,  atr,  trend4h, trend1h,
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
          // Send Telegram notification for ★★★ signals only
          if (sig.conf === 3) {
            sendTelegram(formatTelegramSignal(s, sig));
          }
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
  console.log(`Scanning ${PAIRS.length} pairs via Kraken...`);
  const data = [];

  // Kraken allows parallel requests — no rate limiting on public endpoints
  const results = await Promise.allSettled(PAIRS.map(async pair => {
    const krakenPair = KRAKEN_MAP[pair.sym];
    if (!krakenPair) throw new Error(`No Kraken mapping for ${pair.sym}`);

    // Fetch 1H and 4H in parallel — Kraken handles it fine
    const [candles1h, candles4h] = await Promise.all([
      krakenFetch(krakenPair, 60,  100), // 1H candles
      krakenFetch(krakenPair, 240, 100)  // 4H candles
    ]);

    if (candles1h.length < 26) throw new Error(`Only ${candles1h.length} 1H candles`);

    return processPairData(pair, candles1h, candles4h);
  }));

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      data.push(r.value);
    } else {
      console.error(`${PAIRS[i].sym}: ${r.reason.message}`);
    }
  });

  console.log(`Scan complete: ${data.length}/${PAIRS.length} pairs loaded`);
  if (data.length === 0) throw new Error('All Kraken requests failed');
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

// ── TRADE ALERT ENDPOINT ─────────────────────────────────
app.post('/api/trade-alert', express.json(), async (req, res) => {
  const { sym, dir, entry, sl, tp1, tp2, score, conf, type } = req.body;
  let message = '';
  if (type === 'sl_hit') {
    message = `🚨 <b>STOP LOSS HIT</b>\n\n<b>${sym}/USDT ${dir}</b>\nEntry: ${entry}\nStop: ${sl}\n\nTrade closed at stop loss.\n\n🤖 Defi Insider Signal Bot`;
  } else if (type === 'tp1_hit') {
    message = `🎯 <b>TP1 REACHED</b>\n\n<b>${sym}/USDT ${dir}</b>\nEntry: ${entry}\nTP1: ${tp1}\n\nConsider moving stop to breakeven.\n\n🤖 Defi Insider Signal Bot`;
  } else if (type === 'tp2_hit') {
    message = `🏆 <b>TP2 REACHED</b>\n\n<b>${sym}/USDT ${dir}</b>\nEntry: ${entry}\nTP2: ${tp2}\n\nFull target hit!\n\n🤖 Defi Insider Signal Bot`;
  } else if (type === 'entered') {
    message = `📥 <b>TRADE ENTERED</b>\n\n${dir === 'BUY' ? '🟢' : '🔴'} <b>${sym}/USDT ${dir}</b>\nScore: ${score}/10 ${'⭐'.repeat(conf)}\n\n📍 Entry: ${entry}\n🛑 Stop:  ${sl}\n🎯 TP1:   ${tp1}\n🎯 TP2:   ${tp2}\n\n🤖 Defi Insider Signal Bot`;
  }
  if (message) await sendTelegram(message);
  res.json({ ok: true });
});

app.get('/api/health', async (req, res) => {
  try {
    const { default: fetch } = await import('node-fetch');
    const candles = await krakenFetch('XBTUSD', 60, 2);
    const btcPrice = candles[candles.length - 1]?.close;
    res.json({
      ok: true,
      kraken: btcPrice ? 'connected' : 'error',
      btcPrice: btcPrice ? '$' + btcPrice.toLocaleString() : null,
      pairs: PAIRS.map(p => p.sym),
      scoring: 'sequential hierarchy — trend + MACD gate',
      atr: 'real 14-period from OHLC'
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Defi Insider Signal Bot running on port ${PORT}`));
