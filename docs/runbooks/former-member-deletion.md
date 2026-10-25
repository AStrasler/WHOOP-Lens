# Runbook: deleting a former member's data

Owner-only, manual. There is no in-product path once a membership has ended:
every member-side delete (WHOOP disconnect, Health Connect withdrawal, Notion
disconnect, journal withdrawal) requires an active membership. Nothing deletes a
former member's data automatically. Retention cleanup covers only diagnostic
codes (30 days) and resolved reports (180 days).

Never discuss the request, the member, or the outcome in a public GitHub issue,
pull request, commit message, or log. Never paste the member's user id,
email, or any health data into a public place.

## 1. Receive and verify the request (private channel only)

1. The request must arrive by the private channel published on the support
   page (currently pending owner confirmation of the mailbox). If it arrives
   publicly, do not act on it there: reply privately or ask the person to use
   the private channel, without confirming whether they were a member.
2. Verify identity before deleting anything. Acceptable proof: the request comes
   from the email address used for the seat request, or the requester completes
   a fresh sign-in at `auth.whooplens.tech` with the same identity provider
   account. Do not accept a user id, screenshot or name alone.
3. Resolve the WhoopLens `user_id` privately (owner console / D1 lookup by the
   verified identity in `identity_links` / `access_identity_links`). Record it
   only in a private note. Confirm `whoop_members.active = 0`; if the member is
   still active, point them to the in-app tools instead.

## 2. Revoke external access first

1. **WHOOP:** WhoopLens disconnect only deletes the stored tokens locally; it
   does not call WHOOP. Ask the person to remove WhoopLens under connected apps
   in their WHOOP account. Then delete the stored connection (step 4), which
   ends WhoopLens's ability to refresh.
2. **Notion:** ask the person to remove the WhoopLens integration in Notion
   settings. WhoopLens never deletes Notion pages.
3. **Health Connect phone ingest:** deleting `health_connect_ingest_tokens`
   (step 4) stops the webhook accepting their phone's uploads.
4. **MCP OAuth grants (auth worker, `OAUTH_KV`):** list the user's grants with
   the provider's `listUserGrants(userId)` and revoke each with
   `revokeGrant(grantId, userId)` from an owner-run script, or delete the KV keys
   prefixed `grant:<user_id>:` and `token:<user_id>:`. Count first, then delete.

## 3. Dry run (counts only)

Run against the production D1 database (`whoop-lens-migration`) with the
validated id substituted for `:U` (must match
`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`):

```sql
SELECT 'whoop_connections', COUNT(*) FROM whoop_connections WHERE user_id=':U'
UNION ALL SELECT 'whoop_oauth_states', COUNT(*) FROM whoop_oauth_states WHERE user_id=':U'
UNION ALL SELECT 'whoop_recovery', COUNT(*) FROM whoop_recovery WHERE user_id=':U'
UNION ALL SELECT 'whoop_sleep', COUNT(*) FROM whoop_sleep WHERE user_id=':U'
UNION ALL SELECT 'health_connect_records', COUNT(*) FROM health_connect_records WHERE user_id=':U'
UNION ALL SELECT 'samsung_health_records', COUNT(*) FROM samsung_health_records WHERE user_id=':U'
UNION ALL SELECT 'medical_context', COUNT(*) FROM medical_context WHERE user_id=':U'
UNION ALL SELECT 'flare_journal', COUNT(*) FROM flare_journal WHERE user_id=':U'
UNION ALL SELECT 'ai_weekly_digest', COUNT(*) FROM ai_weekly_digest WHERE scope='user::U' OR scope LIKE 'user::U:%'
UNION ALL SELECT 'diagnostic_events', COUNT(*) FROM diagnostic_events WHERE user_key=':U';
```

Keep only the counts in the private note.

## 4. Delete (owner approval per request)

One D1 transaction, children before parents (most tables reference
`identity_links` without `ON DELETE CASCADE`):

```sql
DELETE FROM notion_update_previews WHERE user_id=':U';
DELETE FROM notion_oauth_states WHERE user_id=':U';
DELETE FROM notion_accounts WHERE user_id=':U';
DELETE FROM whoop_oauth_states WHERE user_id=':U';
DELETE FROM whoop_connections WHERE user_id=':U';
DELETE FROM whoop_credential_revocations WHERE user_id=':U';
DELETE FROM whoop_connection_generations WHERE user_id=':U';
DELETE FROM whoop_member_request_budget WHERE user_id=':U';
DELETE FROM whoop_recovery WHERE user_id=':U';
DELETE FROM whoop_sleep WHERE user_id=':U';
DELETE FROM health_connect_ingest_tokens WHERE user_id=':U';
DELETE FROM health_connect_records WHERE user_id=':U';
DELETE FROM health_import_consent WHERE user_id=':U';
DELETE FROM samsung_health_records WHERE user_id=':U';
DELETE FROM medical_context WHERE user_id=':U';
DELETE FROM flare_journal WHERE user_id=':U';
DELETE FROM flare_consent WHERE user_id=':U';
DELETE FROM issue_report_approvals WHERE user_id=':U';
DELETE FROM issue_reports WHERE user_id=':U';
DELETE FROM diagnostic_events WHERE user_key=':U';
DELETE FROM ai_weekly_digest WHERE scope='user::U' OR scope LIKE 'user::U:%';
DELETE FROM ai_usage WHERE scope='user::U';
DELETE FROM whoop_waitlist WHERE user_id=':U';
DELETE FROM access_identity_links WHERE user_id=':U';
DELETE FROM whoop_members WHERE user_id=':U';
DELETE FROM identity_links WHERE user_id=':U';
```

Deleting `identity_links` and `whoop_members` frees the seat and means the
person must request a new seat to return. If they only want health data removed
but may come back, stop before the last two statements.

Re-run the step 3 counts; every count must be 0. `seat_request_delivery` holds
only an email hash with a short expiry and is cleaned automatically.

## 5. Confirm privately

Reply on the same private channel: what was deleted (categories, not counts of
health records), what they must revoke themselves (WHOOP, Notion), and that
ChatGPT/Codex conversation history is controlled by their OpenAI settings.
Delete the private working note once confirmed. Do not record the request
anywhere public.
