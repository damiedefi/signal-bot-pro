# Primary-source research and implementation decisions

Research for this rebuild used exchange documentation, vendor documentation and the original overfitting paper. Internet research explains API and modeling behavior; it does not establish an alpha signal or replace the original backtest.

| Primary source | Finding used | Implementation / implication |
|---|---|---|
| [Bybit V5 kline](https://bybit-exchange.github.io/docs/v5/market/kline) | Rows are returned newest first; the unfinished close is the last traded price; linear-contract turnover is quote-denominated. | Sort by UTC open time; completed candles only for features; use forming-bar open only; preserve turnover without multiplying by price again. |
| [Bybit tickers](https://bybit-exchange.github.io/docs/v5/market/tickers) | Ticker data exposes current funding and instrument fields. | Record the raw funding fraction and display percent separately; never add current funding to historical scores. |
| [Bybit funding history](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate) | Funding settlement history exists; settlement intervals vary by instrument. | The claim that every non-price input has no history is too broad. Still, the original window's complete point-in-time feature set was not supplied. Optional explicit settlement events are supported; no invented 8-hour historical settlement schedule. |
| [Bybit open interest](https://bybit-exchange.github.io/docs/v5/market/open-interest) | OI observations have timestamps, intervals and instrument-dependent units. | Archive raw timestamped observations for later research; no unvalidated weight. Some historical access does not recreate the complete original non-price dataset. |
| [Bybit recent trades](https://bybit-exchange.github.io/docs/v5/market/recent-trade) | The public trades endpoint supplies actual trade sides, sizes, prices and timestamps. | Replace candle-direction “taker” inference with actual observed trade-side context; disclose the variable lookback represented by the last 1,000 trades. |
| [CoinGecko OHLC](https://docs.coingecko.com/reference/coins-id-ohlc) | Automatic granularity changes with requested span; a seven-day request normally returns 4H bars, timestamped at close. | Remove the fallback that treated that response as equivalent hourly open-timestamped data. Never silently change the source or timeframe. |
| [TradingView strategy execution](https://www.tradingview.com/pine-script-docs/concepts/strategies/) | Bar-based backtests rely on modeled event order; lower-timeframe data can improve intrabar simulation. | Next-bar entry contract; conservative ambiguous-bar outcomes; gap handling; explicit minute-data option and full-policy ambiguity sensitivity. This is a modeling choice, not a claim to reproduce TradingView's exact emulator. |
| [The Probability of Backtest Overfitting, Bailey et al.](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf) | Searching configurations on the same historical observations can create impressive in-sample results that do not generalize. | Keep a frozen control, one-change experiments, hashes and untouched chronological confirmation. Weekly block intervals are not a PBO implementation or a multiple-testing correction. |
| [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security) | Privileged server access must not be exposed in a browser; table access needs explicit controls. | Private v6 tables, no anon/client access, server-only reads and fenced RPC writes. Tested on a local PostgreSQL-compatible runtime; not a live Supabase certification. |
| [Node AbortSignal timeout](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay) | Requests can receive bounded abort signals. | Bounded feed requests and retry logic; HTTP 401 fails immediately, transient failures retry finitely; secrets are omitted from errors. |
| [Railway volumes](https://docs.railway.com/volumes/reference) | Persistent volumes survive deployment replacement. | Mount the SQLite data directory on a volume so an unacknowledged outbox survives while the remote mirror is unavailable. |
| [Node SQLite](https://nodejs.org/api/sqlite.html) | Node provides an embedded SQLite API. | Node 24 target, durable WAL journal, transactional outbox, no third-party runtime dependency. |

## What the original claims do not establish

- “Slope is king” and the RSI strength window are observations on one selected bull window, not universal laws. Keep them as hypotheses and require independent regimes.
- The reported +1.85R cannot be accepted as verified net expectancy when the original engine can truncate pairs, reward ambiguous candles, use incorrect averages and ignore realistic costs. Fix the measuring instrument first.
- High RR does not necessarily mean a distant target: it can mean a very tight stop. Target distance in ATR and stop distance in ATR expose those different mechanisms. Neither a new target cap nor a stop-width filter is promoted on intuition.
- Per-coin preferences learned from the same 83 days are especially fragile. A coincidentally strong NEAR period does not prove a durable NEAR score premium.
- Mirroring a BUY score for SELL does not establish a short-side edge. Regime permission and empirical validation are separate questions.
- Price-derived RSI, EMA, Bollinger position, slope and structure are correlated evidence, not independent confirmations. No new indicator pile was added.

## Network and evidence limits

Read-only probes during this work found the CryptoCompare hourly endpoint required an API key (HTTP 401); the Bybit time probe timed out in this execution environment. The supplied files did not contain the original frozen candles or exact historical dates. The old rolling request cannot recover an identical window just by rerunning it now. Therefore there is no claimed original-window P&L result, no current optimal parameter claim, and no assertion that the candidate increases profits.
