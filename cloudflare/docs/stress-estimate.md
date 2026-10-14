# WHOOP Lens experimental physiological stress estimate (wl-stress-v1)

**Status:** experimental and off by default. It is on only when `STRESS_ESTIMATE_ENABLED` and `AI_SUMMARY_ENABLED` are both exactly `"true"`,
because the estimate is only returned inside an AI summary (`get_recovery` with `summary=true`, and the weekly digest). Not WHOOP's Stress Monitor. Not clinically validated. Not a diagnosis.
It answers one question only: how far today's autonomic, sleep and respiratory measurements sit from the same person's own recent norm,
in the direction usually linked with physiological load. Spec: issue #23, section 6.

## Why it was a placeholder
Issue #23 section 6 marked the estimate as a separate, unverified sub-experiment ("Nothing here is approved for implementation"),
so the phased plan shipped AI summaries first and left `stressEstimatePlaceholder()` returning `available:false` behind its own flag.
This change replaces the placeholder. It stays off until Aaron enables it.

## Data (one user, already authorized)
- **Target dates come only from recovery records** (`isRecoveryRecord`: has `cycle_id`, no `start`/`nap`), using the recovery's own
  `created_at` day. Sleep records mixed into the same list (the weekly digest does this) never become target dates; they are only used as sleep data.
- Recovery history: one bounded walk of WHOOP `/recovery` with `start` = earliest target - 31 days and `end` = latest target + 1 day
  (WHOOP's own `start`/`end` query parameters), paginated until `next_token` is null. Page budget: ceil(span/25)+2, at most 20.
  Old targets (for example 150+ records behind the newest) are reachable because the walk starts at the window, not at today.
- Sleep: the same bounded walk of `/activity/sleep` (one extra day earlier, since a sleep can begin on the previous UTC date).
  Sleep is optional but its retrieval state is never swallowed. `history.sleep` / `method.sleep_data` / each point's `sleep_data` is:
  - `complete`: retrieved, records present;
  - `none_recorded`: retrieval complete, no sleep exists. A limitation says so; no retrieval penalty (only lower coverage);
  - `partial`: page budget exhausted, invalid cursor, or a failed sleep fetch. A limitation says so and confidence counts it as one conflict (x0.85).
  `history.complete` = recovery complete AND sleep not `partial`; `history.recovery_complete` is reported separately.
- The summary's own baseline fetch is unchanged from main; the estimate does its own bounded fetch only when the flag is on.
- **Incomplete history** (page budget exhausted, invalid cursor, or a non-rate-limit error) sets `history.complete=false`, adds a limitation,
  and days short of baseline get status `incomplete_history` (reason `incomplete_history`), distinct from a genuine `insufficient_baseline`.
- **Rate limit:** a WHOOP 429 on either fetch returns no estimate (`available:false`, `reason:"rate_limited"`, no points) and a limitation note.
  The tool call and summary still succeed. `callWhoop` keeps its error message and now attaches `error.status`.
- Everything goes through the caller's own `whoopRequest(db, userId, ...)` (the same OAuth refresh path): no other user's data, no storage, no new scopes.
- Excluded days: `score_state` not `SCORED`, `user_calibrating: true`, and naps.
- **Plausibility guard:** values outside these ranges are artifacts, never scored or used in any baseline, and reported as
  `implausible_value`: HRV 5-300 ms, RHR 25-130 bpm, sleep performance/efficiency 0-100 %, sleep 0.5-16 h, respiratory rate 5-40 /min.

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

## Magnitude vs evidence
- **Magnitude** is the value plus `deviation` = {points_from_typical, direction, largest_input}. It never affects confidence.
- **Confidence** is evidence quality only:
  `evidence = sum over scored inputs of effective weight x min(1, that input's own baseline values / 30)`;
  `confidence.score = evidence x max(0, 1 - 0.15 x conflicts)`. Levels: high >= 0.75, moderate >= 0.5, low otherwise.
  Six inputs with full 30-value baselines and no conflicts give 1.0. Each input's own baseline completeness counts, not just the
  HRV/RHR day count. `confidence.components` shows input_coverage, baseline_completeness, conflicts and per-input counts.
- An optional input with fewer than 14 baseline values is not scored at all (it lowers coverage).
- **Capped inputs** (|raw z| >= 3) are classified against the weighted mean z of the other scored inputs (`m`):
  - `agrees`: |m| >= 1, same sign. Not a conflict. Agreement adds nothing (confidence still equals evidence), so agreement is never proof.
  - `disagrees`: opposite sign with |m| >= 1, or 0.5 <= |m| < 1. Conflict.
  - `lone_outlier`: the others did not move with it and |raw z| < 8. Scored (clipped), conflict.
  - `suspected_artifact`: unsupported and |raw z| >= 8. **Not scored**, conflict. If it is HRV or RHR, the day gets status `suspected_artifact` and no value.
  - `implausible_value` (see Data): not scored, conflict.
- Every case is reported in the point's `anomalies` with a note, repeated in `limitations`.
- Example: the sample fixture's last five days shift all six inputs toward load and all are capped. The first version gave confidence 0.1;
  they now all `agree`, so confidence is 1.0.

## Output (`summary.chart_data.stress_estimate`)
Top level: `name`, `label`, `experimental: true`, `version`, `scale`, `available`, `reason` (`insufficient_baseline`, `incomplete_history`,
`insufficient_data`, `rate_limited`, `requires_recovery_data`), `date_range`, `history.complete`, `method`, `excluded_days`, `points`,
`requested_latest_date`, `latest_requested` (that day's status, value or null), `latest_valid` (most recent day with a value),
`latest_valid_is_requested_latest`, `limitations`. There is no ambiguous `latest` field, so a past value is never presented as the newest
day's; when they differ, the first limitation names both dates.
Each point: `date`, `label`, `value`, `band`, `status` (`ok`, `insufficient_baseline`, `incomplete_history`, `missing_required_inputs`,
`suspected_artifact`), `baseline_days`, `coverage`, `confidence` (+ `components`), `deviation`, `anomalies`, `inputs_used`, `inputs_missing`,
`contributions`, `measurements`, `limitations`.

## AI summary
Only when the flag is on **and** a valid calculated estimate exists does the model get `stats.stress_estimate`:
{name, experimental, estimate_date, requested_latest_date, is_latest_requested_date, unavailable_dates (requested dates with no valid
estimate, newest first, at most 7), value, band, confidence, baseline_days}. Only then:
- the system prompt gains one line (name it as the experimental estimate, state the estimate_date, say when the requested latest date has
  no estimate, never call it WHOOP's Stress Monitor, stress-zone time or a diagnosis);
- every sentence that makes a stress claim (mentions stress, estimate or index) is bound to the estimate (`stress_claim` rule):
  it must state exactly `value`, and every number in it (digits or spelled) must be that value, so recovery, HRV or other summary numbers
  cannot satisfy it; level words (low, typical, elevated, high, moderate) must be its band or confidence; every date in it must be
  `estimate_date`; and when the estimate is not for the newest requested date the sentence must contain `estimate_date`;
- the output filter accepts extra neutral words (experimental, physiological, stress, estimate, lens, band, elevated, low, high, confidence, moderate, index);
- a stress sentence may instead say an estimate is **unavailable**, using only: no estimate, not available, unavailable, insufficient.
  Such a statement must name at least one date, only dates in `unavailable_dates`, and contains no number or level word.
  A sentence without a stress word that uses missing-data wording is also validated as an unavailable-estimate claim when it is
  pronoun-led ("It is unavailable for 2026-10-15.") or uses the tight wording without naming another metric; a pronoun-led "missing"
  sentence is rejected (wording outside the tight list). Sentences naming another metric ("HRV data was unavailable on ...") follow the normal rules. A sentence naming both the estimate
  date and an unavailable date is split into clauses (`,` `;` and / but / while / whereas): the clause with `estimate_date` carries
  exactly the value, the clause with the unavailable date carries the unavailable wording, and no other clause carries a number or date.
  Any value attached to an unavailable date is rejected. Example accepted: "The stress estimate was 72 on 2026-10-13. 2026-10-15 has no estimate."
  ("unavailable" and "insufficient" are added to the gated stress vocabulary.)
- the estimate's value grounds **only** stress claims: every other sentence must be grounded by the summary stats without
  `stress_estimate` (so "Recovery score was 72" cannot borrow the estimate's 72), and a stress claim may not also name another metric
  ("The stress estimate and recovery score were 72" is rejected);
- the same rule rejects unsupported claims (Stress Monitor, stress zones, non-activity, clinical, burnout, anxiety, cortisol, "stressed").
  It runs in addition to every existing check and can only reject more.
Flag off, or on with no valid estimate: the prompt is byte-identical to main (`test/fixtures/system-prompt-main.txt`, from main d98346f) and
the stress words fail the vocabulary check exactly as on main. Number/date grounding, advice and medical checks are unchanged in every case.

## Host instructions and get_capabilities
- Stress Monitor zone data stays unsupported in both, always.
- Off (either flag not "true"): MCP initialize instructions are identical to main (`test/fixtures/host-instructions-main.txt`) and `get_capabilities` does not mention the estimate.
- "On" means both `STRESS_ESTIMATE_ENABLED` and `AI_SUMMARY_ENABLED` are `"true"`, the same rule as the tool path, so discovery never
  advertises an estimate the tools cannot return. All four combinations are tested for agreement (instructions, capabilities, tool output).
- On: `hostInstructionsFor(env)` appends one paragraph describing the experimental index and its labels; `get_capabilities` adds an
  `experimental-stress-estimate` entry ("Not WHOOP's Stress Monitor. Not clinically validated.") and a global limitation. Without a WHOOP
  connection the entry reports `requires_connection_or_data`, never `available`.

## Logging
The module logs nothing. No health values are logged anywhere in this path (tested).

## Limitations
See `LIMITATIONS` in `src/stress-estimate.mjs`: daily resolution only (no intraday WHOOP heart rate); training, illness, alcohol,
travel and noise move the same inputs; no cause is identified; there's no validation against self-reported stress yet.

## Review aids
- `test/stress-estimate.test.mjs`, grouped by finding (F1-F6) plus cross-cutting regressions: hand-computed values, recovery exclusion,
  rolling 30-day baseline and the 14-day boundary, determinism, agreement / contradiction / isolated extreme / artifact, per-input baseline
  completeness, requested vs latest valid dates, bounded window fetch (recent, 150+ records back, page boundaries 25/26/50, incomplete,
  genuinely insufficient), 429, mixed digest and the real weekly digest with cache, sleep_id join, per-user isolation, no values or tokens in logs, flag off unchanged.
- `test/extra-tools.test.mjs` and `test/mcp.test.mjs` (F7): discovery off / on / on without account data; initialize instructions off / on.
- `test/whoop-api.test.mjs`: start/end sent only when given, validated; 429 keeps its status.
- Round 2 tests are named `R2-1 ...` (claim binding), `R2-2 ...` (sleep completeness) and `R2-3 ...` (four flag combinations); round 3 tests `R3 ...` (unavailable-estimate statements).
- `test/fixtures/stress-estimate-sample.json`: full output for 45 synthetic days. Regenerate with `node test/make-stress-fixture.mjs`.
