# HC Webhook setup

Phone delivery into WHOOP Lens uses the open-source Android app [HC Webhook](https://github.com/mcnaveen/health-connect-webhook) (`com.hcwebhook.app`). The ingest below was checked against v1.9.22 and its JSON webhook (`docs/webhook.md` in that repository).

This path is in the repository and is not deployed. `HEALTH_CONNECT_WEBHOOK_ENABLED` is `false` in both Wrangler configs. Migration `cloudflare/migrations/0007_health_connect_ingest.sql` is not applied to production D1 `whoop-lens-migration`. Posts succeed only after that migration is applied and the flag is true on the `whoop-lens` Worker.

## Phone

1. Install the free FOSS build with Obtainium from the GitHub repository. The release asset is `app-foss-release.apk`.
2. Grant every Health Connect permission the app requests, including the background permission. No battery-optimization change is required.
3. Set the sync interval to 15 minutes. The first sync can include the last 48 hours. Later syncs send records that are new or changed since the last success.
4. Leave sample resolution at the app default (1 minute for heart rate and the other series). A full-resolution 48-hour dump can exceed the 12 MB body cap or the 20,000 stored-row cap. The Worker then answers 413 and the app retries the same window.
5. Add exactly one webhook. URL: `https://whooplens.tech/api/health-connect/webhook`. Method is POST JSON. Delivery format stays JSON.
6. Add one custom header. Name: `Authorization`. Value: `Bearer hct_…` using the token from the tool below, including the word `Bearer` and a single space. The app has no built-in signature. The header is the credential.

## Token

In ChatGPT, after Access sign-in, call `issue_health_connect_ingest_token` with consent `enable-health-connect-webhook`. The tool returns `header_name` and `header_value` once and grants Health Connect storage consent for that member. The database stores only the SHA-256 of the token. Calling the tool again revokes the previous token. `revoke_health_connect_ingest_token` with confirm `revoke-health-connect-ingest-token` stops delivery and leaves stored rows in place. `withdraw_health_connect_import` with confirm `delete-my-health-connect-records` deletes stored Health Connect rows, records withdrawal, and revokes ingest tokens.

The Worker attributes every accepted row to the token's member. A user id inside the JSON is ignored.

## What is stored

| HC Webhook array | Stored metric | Notes |
| --- | --- | --- |
| `steps` | `steps_daily` | Interval count, including shorter than a day |
| `sleep` | `sleep_session` | Duration in seconds, plus up to 64 stages |
| `heart_rate` | `heart_rate` | Sample `bpm`, or the aggregate `bpm` (the bucket average) |
| `exercise` | `exercise_session` | Duration and exercise type |

Rows upsert on the Health Connect record id when the JSON includes `metadata.id` (or a top-level `id`). v1.9.22's JSON metadata sends `data_origin` and `recording_method` and omits that id; the id is present on the app's protobuf metadata. Without an id, the upsert key is a hash of the type, time bounds, and data origin, so a 48-hour resend updates the same row. `metadata.lastModifiedTime` or `metadata.last_modified_time`, when present, keeps an older retry from replacing a newer row.

Every other array the app can send is skipped and counted. The response is still HTTP 200 after the supported rows are written, including when every record is unsupported, so the app can advance its sync marker. A body that is not the webhook envelope, or a write that fails, is not 2xx.
