"use strict";
// Synthetic 83-day software workload. This is NOT the original market backtest.
const assert = require("node:assert/strict");
const e = require("../server");
const { dataset } = require("../test/fixtures");
const data = dataset({ count: 320 + 83 * 24, symbols: e.PAIRS });
const report = e.experimentSuite(data);
assert.equal(report.experiments.length, 8);
assert.equal(report.control.symbols.length, 12);
assert.equal(report.control.dataHash, report.candidate.dataHash);
assert.ok(report.control.complete && report.candidate.complete);
for (const test of report.experiments) {
  assert.equal(
    Object.keys(test.patch).length,
    1,
    "Isolate exactly one strategy change",
  );
  assert.ok(test.overall.resolved > 0);
  assert.ok(Number.isFinite(test.overall.expectancy));
  if (test.comparison.delta < 0)
    assert.equal(test.comparison.decision, "ROLL BACK STRATEGY CHANGE");
}
assert.match(report.promotion, /NONE/);
const result = {
  kind: "synthetic-experiment-suite-verification",
  engineHash: e.ENGINE_HASH,
  pairs: 12,
  syntheticDays: 83,
  singleChangeExperiments: report.experiments.map((x) => x.name),
  complete: true,
  sameDataHash: true,
  lowerExpectancyRollbackLabelsVerified: true,
  autoPromotion: false,
  profitabilityConclusion:
    "none: synthetic workload, not original historical candles",
};
if (process.argv[2]) e.writeJSON(process.argv[2], result);
console.log(JSON.stringify(result, null, 2));
