# Defi Insider Signal Bot · v6

A rebuilt recorder and research lab for the original 12 pairs. **Paper signals only. Profitability has not been established.**

The highest-impact change is honest measurement: one causal signal engine, one execution contract, actual net R for every resolved trade, frozen datasets and isolated experiments. The recorder starts with a corrected price-only control. Proposed changes remain independently testable candidates.

## Start here

- `server.js` is the complete backend; Node 24 is required. No production npm dependencies.
- `public/` contains the new read-only dashboard. The old HTML was not supplied.
- `schema.sql` adds separate v6 Supabase tables and lease-protected write functions. It leaves the legacy `signals` table intact.
- `SIGNAL-BOT-FULL-CONTEXT.md` explains the ranked improvements, changed behavior, overfit risks and original design history.
- `RESEARCH.md` links primary sources and maps findings to code.
- `VALIDATION.md` records what was actually tested and what remains unverified.
- `strategy-corrected-control.json` is the recorder's default policy.
- `strategy-candidate.json` combines the proposed price-rule changes for research. It has **not** beaten the original historical window.

Use the complete folder when replacing the project. Copying only `server.js` will not install the new dashboard, policy files or database migration. No deployment, exchange order or real Telegram message was performed during this rebuild.

## Run locally

Use Node 24.x, which provides `node:sqlite`.

```sh
cp .env.example .env
npm run check
npm test
node --env-file=.env server.js
```

Set real environment variables in `.env`. Node does not load this file automatically with `npm start`; that command is for an environment, such as Railway, that injects variables. For a local dashboard with no network scanning, set `SCAN_ENABLED=false` and `REQUIRE_REMOTE_STORAGE=false`. Do not put keys in the frontend.

The server listens on `PORT` (default 3000) and serves its dashboard at `/`. An unknown expectancy is displayed as `—`, never zero or a fabricated win rate.

## Railway / Supabase migration

1. Use the Railway service and environment that actually runs the backend. Keep one recorder replica. Use Node 24 and `npm start`.
2. Run the complete `schema.sql` in the Supabase SQL editor as the database owner. This is additive, transactional and rerunnable. Existing v5 history is preserved but excluded from v6 performance statistics.
3. Set `SUPABASE_URL` and a **server-side** `SUPABASE_SERVICE_ROLE_KEY`. The previous `SUPABASE_KEY` name is accepted as an alias. Never use a browser anon key for these operations.
4. Mount a persistent Railway volume, for example at `/data`, and set `DATA_DIR=/data`. SQLite is the durable local journal; Supabase is the cross-deployment mirror. Without a persistent volume, unacknowledged writes can still be lost during a container replacement while remote storage is down.
5. Keep `MARKET_SOURCE=cryptocompare-cccagg` with `CC_API_KEY` to compare with the original price source. `bybit-linear` is an explicit alternative for USDT perpetuals; its prices are not the same market and must be analyzed separately. There is no silent provider/timeframe fallback.
6. Set `STRATEGY_FILE=./strategy-corrected-control.json`, `REQUIRE_REMOTE_STORAGE=true` and `SCAN_ENABLED=true`. The in-code recorder default is also this corrected control. A scan outside the first 120 seconds of an hourly boundary intentionally records a missed entry instead of pretending a delayed trade filled earlier.
7. Keep `TG_ENABLED=false` initially. Rotate the previously embedded Telegram token through BotFather, then set new `TG_TOKEN` and `TG_CHAT_ID` values server-side. To receive uncalibrated **paper** alerts, explicitly set `TG_PAPER_UNRATED=true`; SELL alerts separately require `TG_PAPER_SELL=true`.
8. Check `/api/health`: remote `connected` and `recovered`, a recorder lease, recent scan time, all 12 pairs available, and a draining write queue. The endpoint never returns key values. A fresh deployment may wait up to the lease's 180-second expiry before taking over from an old process.

The wrong Railway env-var placement cannot be repaired by changing backend code. No Railway or Supabase credentials were supplied here, so those live operations remain yours to apply. A rollback means restoring the previous project deployment; the new tables do not replace or mutate the old tables.

## Execution and accounting contract

- Indicators see **320 completed hourly candles**, with complete UTC-anchored 4H groups. All missing, duplicate, stale or inverted candles fail explicitly.
- A decision at hour `T` can use only data closed by `T`. A hypothetical fill uses the next hourly **open**, then the configured adverse market fill adjustment. `observedAt` records when the running process actually saw the decision. This models paper execution; it cannot prove that a later Telegram reader could obtain the same price.
- One open position per pair. Full exit at TP1, initial stop or the 24-hour deadline. TP2 is context only. There are no partial exits, trailing stops, breakeven moves or leverage recommendations.
- If an hourly candle touches both stop and target, default to the stop. The suite also reruns the entire policy with target-first ambiguity to expose sensitivity. Opening gaps through stops fill at the gap open and may lose more than 1R. Target gaps conservatively fill at the target.
- Costs default to **5.5 bps fee per leg, 2 bps market slippage, 2 bps full spread and a 1 bp per 8h financing allowance**. These are configurable research assumptions, not a claim about your account's fee tier. Entry, stop and time exits get adverse market adjustments; a target is modeled as a limit exit. Financing is a stress allowance unless explicit historical settlements and coverage are supplied.
- `grossR` includes modeled fill slippage but excludes fee/funding deductions. `netR = grossR − feeR − fundingR`. Denominator is the initial modeled entry-to-stop risk. **Expectancy is the mean net R of all resolved positions**, including time exits. Pending outcomes are disclosed separately.
- A time exit is marked to market, not silently excluded. Missing outcome history leaves a position unresolved with an error. Intrabar exits use the bar-end upper bound for timing and estimated financing; funding around a boundary can therefore differ from real fills.
- Historical entries in the last `horizonHours` of a frozen dataset are excluded so every accepted trade has a complete possible outcome window. Both policies use this same restriction.
- The runtime and historical hourly modes share their implementation. An optional complete minute dataset refines ordering inside the historical lab; this does not turn the forward recorder into a minute-resolution execution system.
- Sum R and closed-trade drawdown assume equal R contributions. They are not account returns, an equity curve with position sizing, or portfolio drawdown including open correlated positions.

## Freeze the historical window, then test one change

The original fixed 83-day candles, exact dates and trade ledger were not attached. A fresh rolling `limit=2000` download is **not** the same test. Recover the original snapshot if it exists. Otherwise pin and label a new dataset, and rerun the control and every candidate together; do not compare its output to the old headline +1.85R.

The old “83-day” label describes roughly 2,000 fetched hourly candles, not necessarily 83 days of eligible decisions. Establish the actual decision window after warm-up and reserve full exit coverage. Do not invent extra history and call its results directly comparable to the archived headline.

The following dates are placeholders. Substitute the actual fixed UTC boundaries, with the end exclusive. The downloader adds the 320-hour warm-up before the start and refuses partial coverage.

```sh
node --env-file=.env server.js download datasets/original-window.json --start ACTUAL_START_ISO --end ACTUAL_END_ISO --source cryptocompare-cccagg
node server.js backtest datasets/original-window.json reports/control.json --config strategy-corrected-control.json
node server.js backtest datasets/original-window.json reports/experiments.json --suite --config strategy-candidate.json
```

The suite evaluates the corrected control, eight **one-change** variants and the combined candidate. For each it reports net expectancy, sample count, direction, regime, pair and setup tiers. A lower mean net R gets `ROLL BACK STRATEGY CHANGE`. An inconclusive comparison gets `do not promote`. Even a positive block-bootstrap interval requires untouched confirmation. The lab never edits `STRATEGY_FILE` or a running recorder.

The eight variants are: remove coin bias; require real quality for tier 3; require a previous squeeze before a release; abstain in neutral regime; cap targets at 3 ATR; cap targets at 4 ATR; reject intervening opposing zones; use ATR exits. The two ATR caps are sensitivity probes, not optimized recommendations. The candidate combines the first four; it does not enable a target cap or obstruction veto.

To test a single additional change, copy the control JSON, edit exactly one key, and run `backtest` against the **same immutable dataset**. Hashes identify the exact dataset, source code and policy. A source edit—including formatting—changes the engine hash and intentionally invalidates old calibration.

The control is explicitly **not an exact recreation of buggy v5**. Both sides share corrected prices, costs, timing, outcome accounting, structure fixes and exclusion of unavailable non-price state. Software defects should not be reintroduced to recover an inflated headline statistic.

### Honest validation order

1. Predeclare the single change and rejection criterion before viewing results.
2. Use the original window for the required regression comparison; roll back worse candidates.
3. Use untouched subsequent periods and separately labeled bull, bear and range windows for confirmation. Keep a full outcome-horizon gap between training and validation. Repeatedly tuning the same holdout makes it training data.
4. Inspect calendar-block uncertainty, minimum samples, direction/regime/pair breakdowns, trade count, total R, drawdown, ambiguous-bar sensitivity and higher cost assumptions. Improvement on one coin or one month is fragile.
5. Freeze the selected policy before forward paper recording. Compare modeled and obtainable entries separately. No automatic parameter learner changes it while data accumulates.

Weekly block resampling groups all pairs together to reduce false independence from correlated crypto trades. It remains an approximate uncertainty estimate with few blocks; it is not a formal multiple-testing correction or proof of robustness.

## Quality stars

`setupTier` is an internal heuristic bucket. It is **not** the star rating. Without a compatible calibration artifact, `conf=0` and the UI says **Unrated**.

```sh
node server.js calibrate reports/training.json reports/untouched-validation.json calibration.json
```

Both reports must be historical, complete, on the same engine/policy/source/universe, and separated chronologically by a full outcome horizon. By default each tier needs at least 50 validation trades across at least 12 nonempty weekly blocks. Tier 2 must have a positive lower expectancy bound; tier 3's lower bound must exceed tier 2's upper bound, with a consistent ordering in training. Unsupported BUY/SELL + regime cohorts stay unrated. An artifact can only rate decisions strictly after its `knownThrough` date. Synthetic reports are rejected.

Set `CALIBRATION_FILE=./calibration.json` for a matching frozen recorder only after this process. Nonoverlapping intervals are a deliberately conservative evidence rule, not a guarantee that future ★★★ expectancy will always exceed ★★. The software cannot verify that a human really left a validation period untouched.

The historical non-price layer and the 4–5 sample win-rate learner are removed from scoring. Funding, open interest, long/short ratio, order book and actual recent taker trades are timestamped as context with zero score contribution. Fear & Greed is no longer fetched. Future research on those inputs needs point-in-time snapshots; current values must never be injected into older bars. Funding/OI endpoints do offer some historical data, but that does not recover every original missing input or make coverage equivalent to the original backtest.

## Archive and dataset format

Closed candles are stored with provider, symbol, interval and UTC open time. On startup, signal/decision/notification history is recovered with keyset pagination. Older candles are restored from Supabase on demand, then the original provider if needed for pending outcomes. Export uses local and remote archives and rejects incomplete data:

```sh
node --env-file=.env server.js export datasets/forward-window.json --start ACTUAL_START_ISO --end ACTUAL_END_ISO
```

The export command never manufactures missing history. Use `--pairs BTC,ETH` only when intentionally testing a smaller declared universe. A subset is not a 12-pair comparison. Example shape (not a runnable dataset):

```json
{
  "schemaVersion": 1,
  "kind": "historical",
  "source": "cryptocompare-cccagg",
  "intervalSeconds": 3600,
  "testStart": 0,
  "testEnd": 0,
  "symbols": ["BTC"],
  "candles": {"BTC": []},
  "capturedAt": "ISO timestamp"
}
```

Each candle is `{time, open, high, low, close, volume}`. Time is the UTC **opening** timestamp in seconds; volume is quote turnover. Actual bounds must be hourly and increasing; arrays need contiguous warm-up and test coverage. For optional `intrabars`, provide complete 60-second candles for every symbol over the full test period. For optional `funding`, provide per-symbol chronological `{time, rate, markPrice}` events plus `fundingCoverage: {start, end}`. Rate is a signed fraction, not a percent. Coverage is an input attestation, not independent verification of completeness.

## API and compatibility

| Route | Behavior |
|---|---|
| `GET /api/health` | Public readiness and configuration booleans; no secrets |
| `GET /api/scan` | Read-only latest scan, last 100 current-policy paper trades and stats |
| `POST /api/scan` | Request a scan; admin bearer token required |
| `GET /api/live-stats` | Current engine/policy/source only; net R breakdowns |
| `GET /api/full-log?limit=100&offset=0` | All retained v6 trades across policy versions, paginated |
| `GET /api/patterns` | Descriptive net-R cohorts only; score contribution zero |
| `GET /api/config` | Public strategy assumptions, source and hashes |
| `GET /api/backtest` | Background lab job status and completed results |
| `POST /api/backtest` | Run configured frozen dataset; admin token required |
| `/api/trade-alert` | Arbitrary message relay removed; no external content forwarding |

`ADMIN_TOKEN` enables authenticated mutations. If unset, mutations are disabled. Optional `READ_TOKEN` protects data-reading APIs except health; the dashboard accepts it in memory for the current tab. The dashboard is read-only. For a separately hosted frontend set one exact `ALLOWED_ORIGIN`; no wildcard CORS. The former frontend's rendering contract is not guaranteed—the new UI is bundled.

To run a lab job over HTTP, configure `BACKTEST_DATASET` server-side and send JSON such as `{"mode":"suite"}` or `{"mode":"single","config":{"coinBias":false}}` to `POST /api/backtest` with `Authorization: Bearer YOUR_ADMIN_TOKEN`. No client-supplied filesystem path is accepted. The worker does not block scanning or modify its policy.

## Tests

```sh
npm run check
npm test
node scripts/verify-replay.js reports/replay-verification.json
node scripts/verify-suite.js reports/suite-verification.json
```

Optional SQL and dashboard DOM checks accept externally installed `@electric-sql/pglite` and `jsdom` module paths; these are QA tools, not production dependencies. See `VALIDATION.md` for exact versions and limitations.

No test here claims a trading edge. The included 83-day workload is visibly synthetic and exists to exercise software paths. Real validation is blocked by the missing original market snapshot and credentials, not replaced by synthetic returns.
