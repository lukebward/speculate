# Day-to-day utility validation findings

**Date:** 2026-08-30 · **Status:** implementation checkpoint

## Decisions

- Keep paired off/candidate workflow records. NIST's paired-observation model
  matches the benchmark because the same generated session is naturally paired
  across arms.
- Measure waits with `performance.now()`, whose Node contract is a
  process-relative high-resolution millisecond timestamp.
- Persist latency as decayed weighted mean/`M2`, not raw square sums. The
  centered pairwise variance family has better numerical behavior and supports
  concurrent group combination.
- Evaluate Beta-Bernoulli candidate calibration in observation-only mode first,
  then activate it only after local and hosted Brier comparisons agree.
- Keep HTTP cold exploration unimplemented until the daily runner can compare
  it against a negative control.

## Implemented checkpoint

- Pure daily workflow generator and paired comparison/accounting core.
- Persisted tool/server latency model with decay, uncertainty, defensive
  import, bounded state, baseline-delta concurrent merge, and legacy hints.
- Proxy/predictor integration with no change to the admission formula.
- Shadow candidate evaluation before admission, including suppressed
  candidates, stable alternative IDs, persisted decayed feedback, Brier score,
  reliability buckets, correct-but-suppressed, and admitted-but-wrong counts.
- Calibrated next-call probability now ranks candidates and feeds the existing
  marginal latency admission calculation. Operational hit/waste history remains
  a separate sufficiently-sampled suppression gate.

## Validation results

Focused validation:

```text
113 tests passed across calibration, latency, predictor, persistence, metrics,
and benchmark core
TypeScript no-emit check passed
```

Full validation after integration:

```text
796 tests passed, 7 skipped
production build passed
offline eval recall@3: 0.8463 (unchanged)
offline eval waste/hit: 2.00 (unchanged)
```

Real Git, five persisted sessions:

```text
default speculative calls: 0
default waste: 0
raw recall@3: 0.7778
unconstrained useful hit/join rate: 0.8000
```

Real filesystem at 120 ms, four persisted sessions:

```text
off mean wait: 122.25 ms
default mean wait: 47.69 ms
default useful hit/join rate: 0.6818
default terminal waste/useful: 0.1667
default estimated net saved: 3278 ms
```

These pass the latency-model gates: cheap local Git remains quiet while the
slow filesystem workflow stays useful and materially faster. The measurements
also held after calibrated ranking was activated.

Calibration Brier comparisons (lower is better):

```text
workflow                  static   calibrated
real Git                  0.2302       0.1943
real filesystem           0.2399       0.2168
Hugging Face, warm        0.3323       0.2930
Context7, session 3       0.2840       0.2812
```

Post-activation behavior stayed stable: Git issued zero default speculative
calls, filesystem retained 30 useful hits/joins and 68.2% useful rate, and
Context7 reached 83% useful rate with zero terminal waste. Context7 suppressed
one correct-but-low-value candidate and reduced outstanding work from six to
five, showing the new separation between correctness and admission value.

These measurements validate calibrated ranking and the existing independent
per-candidate latency threshold. They do not validate active cold discovery.

## Sources

- [NIST: analysis of paired observations](https://www.itl.nist.gov/div898/handbook/prc/section3/prc311.htm)
- [Node.js: `performance.now()`](https://nodejs.org/api/perf_hooks.html#performancenow)
- [Chan, Golub, and LeVeque: variance algorithms](https://doi.org/10.1080/00031305.1983.10483115)
- [Beta-binomial probability calibration](https://journals.ametsoc.org/view/journals/mwre/137/3/2008mwr2579.1.xml)
- [ECMWF probabilistic forecast verification and Brier score](https://www.ecmwf.int/sites/default/files/elibrary/1999/7848-probabilistic-forecasting-meteo-france.pdf)

## Next evidence gate

Finish the executable local daily runner and its seeded negative control before
changing unknown-latency behavior. Compare no discovery against the proposed
single HTTP rank-1 exception. Bounded cold discovery remains unimplemented
unless it improves a cold varied workflow without making the negative control
meaningfully noisier.
