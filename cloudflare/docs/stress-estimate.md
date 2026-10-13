# WHOOP Lens experimental physiological stress estimate (wl-stress-v1)

**Status:** experimental and off by default (`STRESS_ESTIMATE_ENABLED`). Not WHOOP's Stress Monitor. Not clinically validated. Not a diagnosis.
It answers one question only: how far today's autonomic, sleep and respiratory measurements sit from the same person's own recent norm,
in the direction usually linked with physiological load. Spec: issue #23, section 6.

## Why it was a placeholder
Issue #23 section 6 marked the estimate as a separate, unverified sub-experiment ("Nothing here is approved for implementation"),
so the phased plan shipped AI summaries first and left `stressEstimatePlaceholder()` returning `available:false` behind its own flag.
This change replaces the placeholder. It stays off until Aaron enables it.

## Data (one user, already authorized)
- WHOOP recovery records for the returned dates, plus that user's own recovery history from 30 days before the earliest returned date.
- That user's WHOOP sleep records for the same span. Only fetched when the flag is on; if sleep cannot be read, the estimate runs without it.
- Everything goes through the caller's own `whoopRequest(db, userId, ...)`: no other user's data, no storage, no new scopes.
- Excluded days: `score_state` not `SCORED`, `user_calibrating: true`, and naps. They count as missing.

## Alignment
- One row per recovery (cycle). Duplicates on a day keep the highest `cycle_id`, independent of page order.
- Sleep joins **only** via `recovery.sleep_id = sleep.id`, never by calendar day, so time zones and late or split sleeps cannot attach the wrong night.
  A recovery without a matching sleep has its sleep inputs marked missing.

## Inputs, direction and weights
| Input | Field | Direction (more load) | Cluster | Cluster weight | Weight in cluster | Effective |
|---|---|---|---|---|---|---|
| HRV (RMSSD) | recovery `hrv_rmssd_milli` | lower | autonomic | 0.6 | 0.6 | 0.36 |
| Resting heart rate | recovery `resting_heart_rate` | higher | autonomic | 0.6 | 0.4 | 0.24 |
| Sleep performance | sleep `sleep_performance_percentage` | lower | sleep | 0.3 | 0.4 | 0.12 |
| Sleep duration (h asleep) | light + slow wave + REM | lower | sleep | 0.3 | 0.35 | 0.105 |
| Sleep efficiency | sleep `sleep_efficiency_percentage` | lower | sleep | 0.3 | 0.25 | 0.075 |
| Respiratory rate | sleep `respiratory_rate` | higher | respiratory | 0.1 | 1 | 0.1 |

### Overlap and double counting
- **Recovery score is excluded** from the score. WHOOP recovery is derived largely from HRV, resting heart rate and sleep,
  so scoring it beside them would count the same signal two or three times. It is listed under `method.excluded` with the reason.
- **HRV and resting HR share one autonomic cluster** (0.6 total) instead of two independent weights, because they are correlated
  expressions of autonomic state. HRV gets the larger share because RMSSD is the more direct parasympathetic marker.
- **The sleep metrics share one cluster** (0.3). Performance, duration and efficiency overlap, so together they cannot outweigh the autonomic cluster.
- **Respiratory rate** is a separate 0.1 cluster: it is measured during sleep, but it is not computed from the other sleep metrics.
- **Skin temperature is not scored.** WHOOP's value has no single stress direction, so it is excluded with a reason.
- The weights are a documented prior, not fitted. Issue #23 asks for correlation and VIF analysis on consented data before tuning; v1 does not claim it.

## Baseline (per user, per input)
- Window: the 30 days **before** the target day. The target day is never in its own baseline.
- Center: median. Spread: MAD x 1.4826 (a robust SD).
- Scale floor when the spread is 0 or tiny: HRV max(1 ms, 5% of median), RHR 1 bpm, sleep performance 3, efficiency 2, duration 0.25 h, respiratory rate 0.3.
- Minimum data: at least **14** baseline days with both HRV and RHR. Otherwise the day is `insufficient_baseline` with no value.
  An optional input is only scored if it has at least 14 baseline values of its own.

## Score
- z = direction x (value - median) / scale, clipped to [-3, 3].
- Contribution (points) = (50 / 3) x z x weight / (sum of available weights).
- Value = round(clip(50 + sum of contributions, 0, 100)). 50 = typical for this person.
- Bands: low < 35, typical 35-64, elevated 65-79, high 80-100.
- Missing inputs renormalize over what is present, but that lowers `coverage` and `confidence` (below), so a value from fewer inputs is never presented as equally certain.

## Confidence
`confidence.score = coverage x min(1, baseline_days / 30) x max(0, 1 - 0.15 x capped inputs)`, with levels high >= 0.75, moderate >= 0.5, low otherwise.
- `coverage` = sum of the available effective weights (1.0 when all six inputs are present).
- A partial history, missing inputs, or capped (anomalous) inputs each lower confidence. Days with no value have confidence `none`.

## Output (`summary.chart_data.stress_estimate`)
Top level: `name`, `label`, `experimental: true`, `version`, `scale`, `available`, `reason`, `date_range`, `method` (all of the above),
`excluded_days`, `points`, `latest`, `limitations`.
Each point: `date`, `label`, `value`, `band`, `status` (`ok`, `insufficient_baseline`, `missing_required_inputs`), `baseline_days`,
`coverage`, `confidence`, `anomalies`, `inputs_used`, `inputs_missing`, `contributions`, `measurements` (the measured values used, unchanged), `limitations`.
No value is imputed or invented: missing inputs stay missing.

## AI summary
Only when the flag is on and the latest point has a value, the model gets `stats.stress_estimate` with
{name, experimental, date, value, band, confidence, baseline_days}. The output filter is unchanged except for neutral words
(experimental, physiological, stress, estimate, lens, band, typical, elevated, low, high, confidence, moderate, index).
Every number still has to match, and advice or diagnostic wording is still rejected.

## Logging
The module logs nothing. No health values are logged anywhere in this path (tested).

## Limitations
See `LIMITATIONS` in `src/stress-estimate.mjs`: daily resolution only (no intraday WHOOP heart rate); training, illness, alcohol,
travel and noise move the same inputs; no cause is identified; there's no validation against self-reported stress yet.

## Review aids
- `test/stress-estimate.test.mjs`: hand-computed values, the 14-day boundary, zero variance, clipping, missing data, sleep_id join, duplicates,
  per-user isolation, flag off, and no values in logs.
- `test/fixtures/stress-estimate-sample.json`: the full output for 45 synthetic days (the last 5 shifted toward load). Regenerate with
  `node test/make-stress-fixture.mjs`; the test fails if the calculation drifts.
