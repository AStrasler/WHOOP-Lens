# Life Schedule Awareness

Development implementation for PR #118. Production activation is separate; no production migration or deployment was performed.

## Preferences → Life Schedule

- **Fixed:** My daily routine generally follows predictable times.
- **Flexible:** I have a general routine, but it changes when needed.
- **Unpredictable (Default):** My schedule varies significantly depending on what life requires.

The native Android Account & Settings screen includes Preferences → Life Schedule. Loading reads the signed-in account's server preference. Choosing an option opens an explicit confirmation dialog, then sends an authenticated PUT. Selection persists on the server between sessions. Account changes and late signed-out responses cannot expose a previous account's selection.

## Storage and authorization

`GET /v1/preferences/life-schedule` returns an effective value, explicit-selection indicator and opaque revision. Missing/invalid values resolve to `unpredictable` without creating or repairing a row. Storage or authentication failures are errors, not invented successful defaults.

`PUT /v1/preferences/life-schedule` accepts exactly `life_schedule` (one of the three values) and `confirmation="user_selected_life_schedule"`. The normal resource-scoped OAuth wrapper and active-membership checks apply. Identity comes from verified authentication, never request parameters. The parameterized write rechecks membership in SQL. Browser origins must match the resource origin. There is no MCP write tool, inferred preference writer, scheduled reclassification or AI setter.

Migration `0024_life_schedule.sql` adds a per-user D1 table with a constrained value, revision and update time. Reads never write. Full identity deletion cascades to this preference; health-data-only deletion preserves the explicit account selection.

## Analysis

`get_life_schedule_insights` is a read-only MCP tool using the existing bounded WHOOP paginator and per-member request budget. It reads sleep, recovery, cycles and workouts for rolling 7/14/30 UTC calendar-day windows (including today's partial day), reporting observed/missing days. Available fields cover duration and variability, local timing variability with an explicit timezone offset, efficiency, consistency, measured sleep debt, estimated sleep deficit, HRV, resting heart rate, recovery, daily strain and workout energy. Missing required sleep-need components or unrecorded stage time suppress a computed deficit. WHOOP's signed negative nap contribution reduces estimated need (see [WHOOP Sleep API](https://developer.whoop.com/docs/developing/user-data/sleep/)). Sleep debt is a balance, not summed repeated daily debt. Naps are excluded from main-sleep comparison. Workout energy is summed per observed day; independent resource ids are deduplicated. Missing/truncated/rate-limited history remains explicitly incomplete.

Existing optional server summaries and weekly digests include deterministic Life Schedule context and recommendations over their available input records. A short input sample does not become a complete 30-day history; longer windows retain missing-day counts. The dedicated tool retrieves broader context. Digest cache keys include the explicit preference revision, so changing the setting cannot replay advice from the previous selection.

Fixed context supports the chosen routine without demanding tighter timing; Flexible accommodates adjustments; Unpredictable focuses on feasible sleep opportunity without requiring fixed bedtimes. Low consistency or irregular timing alone never generates fixed-schedule advice. Meaningful measured deficits, debt and physiological changes remain visible. Recommendations distinguish association from causation and state coverage limits. The model still only selects grounded measurement statements; it does not generate or persist preferences or free-form recommendations.

## Verification and production gates

Server regression tests cover all options, defaults without writes, invalid legacy data, account isolation, membership revocation during writes, authentication failures, prohibited AI writes, 7/14/30 observations, variability-only cases, sparse/future/nap data, summary read-only behavior, revision-separated digest caching and rollback. Android unit tests cover explicit confirmation, authenticated payloads, no default writes, other-account requests, error responses and late responses after sign-out.

`LIFE_SCHEDULE_ENABLED` defaults false in both committed Worker configurations. Before a separately approved production release: review/apply 0024 to the intended database, deploy reviewed code, then enable the flag. Disabling the flag closes preference endpoints/tool discovery; it does not overwrite saved choices. For schema rollback disable the flag and release compatible code before dropping the preference table using the reviewed down migration. No migration, flag change or release is authorized merely by merging this PR. Migration 0023 and service-announcement activation remain separate operations.
