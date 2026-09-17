# Verification record · v6

The delivered software was checked on Node **v24.19.0**. These are engineering checks, not evidence of profitable trading.

| Check | Observed result | Evidence |
|---|---|---|
| Syntax / runtime parsing | Pass for backend and browser JavaScript | `npm run check` |
| Real local process and HTTP smoke | CLI startup, dashboard/assets, CSP and corrected-control defaults pass; no external requests | `reports/package-smoke.json` |
| Automated engine and infrastructure regression tests | **66 passed, 0 failed, 0 skipped** | `reports/tests.tap` |
| Forward recorder versus historical replay | **141 exactly matching control trades and 113 candidate trades**, 12 pairs, 281 hourly boundaries per policy, one restart per policy, zero duplicates | `reports/replay-verification.json`, `reports/candidate-replay-verification.json` |
| Experiment suite workload | All eight isolated changes and combined candidate completed on 12 pairs / 83 synthetic days; same dataset; lower-expectancy rollback labels checked; no promotion | `reports/suite-verification.json` |
| Database migration and permissions | **16 passed** in PGlite PostgreSQL WASM | `reports/schema-verification.json` |
| Dashboard DOM integration | **7 passed** | `reports/dashboard-verification.json` |

## What these checks cover

The engine tests exercise bullish and bearish trades, stop/target ambiguity, stop gaps, target gaps, 24-hour mark-to-market exits, ignored unfinished bars, missing history, minute ordering, adverse fills, fees, signed supplied funding, duplicate funding rejection, the historical incorrect-average regression, disjoint rating cohorts, one open position per pair, no current-state non-price leakage, repeatable replay and strict frozen-dataset coverage.

Calibration tests verify synthetic-data rejection, separation from future decisions, engine/source restrictions, a supported positive and ordered cohort, inverted tiers remaining unrated, unsupported SELL groups staying unrated and the full outcome-horizon gap.

Infrastructure tests cover SQLite restart recovery, transactional outbox acknowledgements, stale remote/local reconciliation, pagination, failed-write retry state, old archive retrieval, funding units, bounded requests, redacted errors, scanning without dashboard requests, concurrent scan deduplication, notification uncertainty, authentication, path traversal, read protection, context after price decisions and an isolated backtest worker. The recorder default is tested against the corrected control, so new filters are not silently enabled.

The replay test sends the same synthetic hourly inputs through the real forward recorder and historical engine, restarts the local database halfway and repeats some scans. It compares IDs, sides, entry times/prices, stops, targets, scores, tiers, regimes, exit times/reasons and each R component exactly. Synthetic gaps deliberately exercise event ordering. This verifies the code paths under the fixture; it is not a universal proof or an exchange-fill test.

The SQL check executes `schema.sql`, lease ownership and expiry/takeover, stale writer rejection, atomic failed batches, completed-result protection, anonymous permission denial and prevention of direct service-role writes bypassing the fenced RPC. It also reruns the migration and confirms retained history.

The dashboard check runs the actual HTML/JavaScript in jsdom. It checks all 12 pairs, unknown expectancy, empty states, filters, uncalibrated labels, safe rendering of API strings, authentication without token storage, stale-data errors and read-only requests. Browser visual layout and mobile rendering have **not** been verified in a real browser.

## Reproduce

Production has no third-party npm dependencies. Core tests and the replay/suite verification use Node only:

```sh
npm run check
npm test
node scripts/verify-replay.js reports/replay-verification.json
node scripts/verify-suite.js reports/suite-verification.json
```

Optional development checks used `@electric-sql/pglite@0.3.14` and `jsdom@26.1.0`, installed outside the application. To reproduce without adding application dependencies:

```sh
npm install --prefix /tmp/signal-bot-qa --no-package-lock @electric-sql/pglite@0.3.14 jsdom@26.1.0
node scripts/verify-schema.js /tmp/signal-bot-qa/node_modules/@electric-sql/pglite reports/schema-verification.json
node scripts/verify-dashboard.js /tmp/signal-bot-qa/node_modules/jsdom reports/dashboard-verification.json
```

Hashes in the final manifest identify the supplied files. Engine changes intentionally invalidate prior calibration.

## Still unverified

- The actual original 83-day historical results: candle snapshot, exact bounds and original trade ledger were not supplied. No financial result from this rebuild is claimed.
- Live exchange availability and full historical coverage from this deployment region. CryptoCompare required a key during a probe; the Bybit time probe timed out. Parser/network tests used controlled responses.
- Live Supabase gateway behavior, credentials, project schema permissions and Railway volume/env configuration. SQL checks were local; they do not replace the first real deployment check.
- Real Telegram delivery and actual trade fills. No real message or order was sent.
- Generalization into unseen bull, bear and sideways markets; fee/slippage/funding realism for the user's venue/account; star ordering in future samples.
- Arbitrarily large archives, exchange-scale throughput, multi-region failover or extensive concurrent writers. The intended deployment is one recorder process and one research worker.

The proper next evidence is the same fixed market dataset for control versus one change, followed by untouched chronological validation and forward paper observations. Synthetic fixtures are never a substitute for that evidence.
