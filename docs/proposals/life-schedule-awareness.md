# Proposal: Life Schedule Awareness

> **Status:** Draft proposal only. No implementation, migration, API, configuration, or deployment is authorized by this document.

## Goal

Enable WhoopLens insights to accommodate actual everyday life without presuming that a consistent daily schedule is practical or desirable. Sleep consistency remains an observed metric, not automatically an improvement target.

## User-facing preference

Location: **Preferences → Life Schedule**

Prompt: **How predictable is your everyday schedule?**

| Value | Label | Description |
| --- | --- | --- |
| `fixed` | Fixed | My daily routine generally follows predictable times. |
| `flexible` | Flexible | I have a general routine, but it changes when needed. |
| `unpredictable` | Unpredictable (default) | My schedule varies significantly depending on what life requires. |

- **Default effective value:** `unpredictable`, for every user when no explicit preference exists.
- **Change authority:** Only an explicit action by the authenticated user may change their Life Schedule preference.
- **Persistence:** A user-selected preference must survive subsequent sessions and must be scoped to that user's account.
- **Observation is not preference:** Inferred routine regularity may inform descriptive analysis, but it must never create or modify the setting, including when measured behavior contradicts the user's selection.
- **Unset/invalid value:** Resolve to `unpredictable` without recording a new explicit user selection.

## Insight interpretation

The preference applies to relevant sleep, recovery, and activity insights. The engine should:

1. Separate *sleep timing variability* from *sleep sufficiency, sleep debt, and physiological recovery*.
2. Use available sleep duration, sleep debt, HRV, resting heart rate, strain and recovery data, including rolling 7-, 14-, and 30-day context where coverage permits.
3. Refrain from recommending rigid bedtimes solely because a consistency metric is low, especially under `unpredictable`.
4. Continue surfacing meaningful deficits, trends, and potential tradeoffs even for an unpredictable schedule.
5. Distinguish measured associations from demonstrated causes. Do not assert that irregular timing alone caused a recovery dip without supporting evidence.
6. Generate advice that accommodates the selected context rather than assuming the user should reorganize life around a metric.
7. Make missing or limited historical coverage apparent rather than claiming an unsupported correlation.

**Illustrative outcome:** "Your sleep timing varied substantially this week. Recent recovery and HRV improved despite that variability. Short sleep periods and cumulative sleep debt remain useful to monitor. The available data does not establish that schedule regularity is the main issue."

## Proposed implementation path — not started

- Review the current account preference storage and insight-generation paths.
- Add a per-user `life_schedule` preference with the effective default `unpredictable` and explicit-user-only writes.
- Apply the setting in the server-side contextual recommendation layer.
- Expose the three options in user preferences when the relevant client work is planned.
- Add regression coverage before enabling behavior in production.

## Acceptance criteria for a future implementation

- New/unset accounts receive the effective `unpredictable` context.
- Only authenticated, explicit user actions change or persist a selection.
- Scheduled jobs, analytics and generated insights cannot silently reclassify users.
- Selection persists between sessions and is isolated by member.
- `fixed`, `flexible`, and `unpredictable` each influence interpretation as specified.
- Low sleep-consistency data alone does not produce an automatic rigid-bedtime recommendation.
- Material short sleep, sleep debt, or unfavorable recovery signals remain visible regardless of selected schedule.
- Missing history does not produce overconfident causal conclusions.

## Out of scope for this proposal PR

No runtime code, schema migration, tests, settings UI, feature flags, production configuration, or deployment changes. Work begins only after separate owner approval.
