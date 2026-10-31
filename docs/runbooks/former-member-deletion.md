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
2. Verify identity before deleting anything. A matching From address is never
   enough on its own: sender addresses can be spoofed, and the seat-request email
   was unverified form input. Use one of:
   - **Authenticated sign-in (preferred):** the requester completes a fresh
     sign-in at `auth.whooplens.tech` with the same identity-provider account,
     and the owner confirms that the resulting identity maps to the same
     `user_id` in `identity_links` / `access_identity_links`.
   - **Challenge to an independently established address:** the owner sends a
     random one-time code (at least 8 characters, valid 24 hours) to the
     address the identity provider verified for that account (not to the
     address the request came from, unless they are the same verified address).
     The requester must send the code back on the private channel.
   Do not accept a user id, screenshot, name or forwarded email as proof. If
   verification fails, reply without confirming whether the person was ever a
   member.
3. Resolve the WhoopLens `user_id` privately (owner console / D1 lookup by the
   verified identity in `identity_links` / `access_identity_links`). Record it
   only in a private note. Record which mode the verified requester asked for
   (section 4): **health-data-only** (the account stays usable) or **full
   account deletion**. If unclear, ask; never default to full deletion. For an
   active member, point them to the in-app tools first.

## 2. Revoke external access first

1. **WHOOP:** WhoopLens disconnect only deletes the stored tokens locally; it
   does not call WHOOP. Ask the person to remove WhoopLens under connected apps
   in their WHOOP account. Then delete the stored connection (step 4), which
   ends WhoopLens's ability to refresh.
2. **Notion:** ask the person to remove the WhoopLens integration in Notion
   settings. WhoopLens never deletes Notion pages.
3. **Health Connect phone ingest:** deleting `health_connect_ingest_tokens`
   (step 4) stops the webhook accepting their phone's uploads.
4. **MCP OAuth grants, full account deletion only:** determine which state store
   the deployed auth worker uses. In legacy KV mode, list the user's grants with
   the provider's `listUserGrants(userId)` and revoke each with
   `revokeGrant(grantId, userId)` from an owner-run script. In D1 mode
   (`OAUTH_STATE_STORE=d1`), grants and tokens are in `oauth_security_state`;
   the full-deletion block below invalidates them by clearing their payloads and
   advancing revisions. **Never DELETE D1 OAuth rows or existing tombstones.**
   The retained keys/revisions contain no usable credentials or health payloads
   and prevent delayed writers from restoring revoked grants/tokens. Account
   deletion therefore retains only these minimal security revocation markers.
   Do not fall back to old KV credentials after a D1 cutover. If multiple stores
   or versions still serve traffic, stop and resolve that cutover before deletion.
   In health-data-only mode keep the grants and tokens in either store: they
   hold no health data and the member's assistant connection must keep working.
5. **Full-deletion ordering:** disable the target's membership and Access mapping
   before deletion. Drain the target's in-flight authorization/credential writers
   across all serving versions before the final counts and transaction. An
   already identity-verified callback must not be allowed to publish a new grant
   after the deletion snapshot. These are owner-controlled prerequisites, not
   changes performed by this runbook automatically. Do not reactivate the
   member during deletion. Migration 0023 invalidates Health Connect admission
   generations and revokes phone tokens on membership deactivation/removal,
   including direct operator SQL.

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
UNION ALL SELECT 'diagnostic_events', COUNT(*) FROM diagnostic_events WHERE user_key=':U'
UNION ALL SELECT 'service_announcement_targets', COUNT(*) FROM service_announcement_targets WHERE user_id=':U';
```

Keep only the counts in the private note.

### 3b. OAuth D1 counts (separate from health-data counts)

When migrations 0021-0023 are present, count the exact target prefixes without
printing keys or payloads:

```sql
SELECT 'oauth_d1_payloads', COUNT(*) FROM oauth_security_state
WHERE value IS NOT NULL AND
  (substr(key,1,length('grant::U:'))='grant::U:' OR
   substr(key,1,length('token::U:'))='token::U:');
```

For health-data-only mode this count is unchanged. For full deletion it must
be zero afterward. Tombstones remain and are not counted as credential payloads.
Do not delete shared client registrations or opaque uncompleted transactions by
guessing ownership from their contents.

## 4. Delete (owner approval per request)

Requires the reviewed schema through migrations 0021-0023; do not run against
an earlier schema or apply migrations as an incidental deletion step.
Two modes. Each is one D1 transaction, children before parents (most tables
reference `identity_links` without `ON DELETE CASCADE`).

Migration 0024 adds `member_life_schedule`. Health-data-only deletion preserves
that explicit account preference. Full identity deletion removes it through its
`ON DELETE CASCADE` foreign key; do not reset it from analysis or retention jobs.

### 4a. Health-data-only (account stays usable)

Removes WHOOP, Health Connect, Samsung, medical context, journal, Notion,
issue-report, diagnostic, AI data, and this member's service-announcement
targets. The announcement text is service-wide and stays; only the target row
for this member is removed. It **keeps** the rows sign-in needs:
`access_identity_links` (the auth worker maps the Access subject to the user
here, `enabled=1`), `identity_links` and `whoop_members` (active-membership
check), plus `whoop_waitlist`, `whoop_member_request_budget` and the
OAuth grants/tokens in either `OAUTH_KV` or `oauth_security_state`. The member
can sign in again and reconnect WHOOP.

```sql
DELETE FROM notion_update_previews WHERE user_id=':U';
DELETE FROM notion_oauth_states WHERE user_id=':U';
DELETE FROM notion_accounts WHERE user_id=':U';
DELETE FROM whoop_oauth_states WHERE user_id=':U';
DELETE FROM whoop_connections WHERE user_id=':U';
DELETE FROM whoop_credential_revocations WHERE user_id=':U';
DELETE FROM whoop_connection_generations WHERE user_id=':U';
DELETE FROM whoop_recovery WHERE user_id=':U';
DELETE FROM whoop_sleep WHERE user_id=':U';
DELETE FROM health_connect_ingest_tokens WHERE user_id=':U';
DELETE FROM health_connect_records WHERE user_id=':U';
-- If migration 0025 is present; otherwise verify the table is absent.
DELETE FROM companion_sync_status WHERE user_id=':U';
DELETE FROM health_import_consent WHERE user_id=':U';
DELETE FROM health_import_fences WHERE user_id=':U';
DELETE FROM samsung_health_records WHERE user_id=':U';
DELETE FROM medical_context WHERE user_id=':U';
DELETE FROM flare_journal WHERE user_id=':U';
DELETE FROM flare_consent WHERE user_id=':U';
DELETE FROM issue_report_approvals WHERE user_id=':U';
DELETE FROM issue_reports WHERE user_id=':U';
DELETE FROM service_announcement_targets WHERE user_id=':U';
DELETE FROM diagnostic_events WHERE user_key=':U';
DELETE FROM ai_weekly_digest WHERE scope='user::U' OR scope LIKE 'user::U:%';
DELETE FROM ai_usage WHERE scope='user::U';
```

### 4b. Full account deletion

Run the 4a block, then this block in the same transaction, and complete legacy
KV revocation if that is the active store (step 2.4).
Deleting `identity_links` and `whoop_members` frees the seat; the person must
request a new seat to return.

```sql
UPDATE oauth_security_state
SET value=NULL, revision=revision+1, expires_at=NULL, metadata_json=NULL
WHERE substr(key,1,length('grant::U:'))='grant::U:'
   OR substr(key,1,length('token::U:'))='token::U:';
-- If migration 0024 is present; skip only after verifying the table is absent.
DELETE FROM member_life_schedule WHERE user_id=':U';
DELETE FROM whoop_member_request_budget WHERE user_id=':U';
DELETE FROM whoop_waitlist WHERE user_id=':U';
DELETE FROM access_identity_links WHERE user_id=':U';
DELETE FROM whoop_members WHERE user_id=':U';
DELETE FROM health_import_fences WHERE user_id=':U';
DELETE FROM identity_links WHERE user_id=':U';
```

The membership-delete trigger refreshes the Health Connect fence, so 4b removes
that fence again after deleting the membership and before the identity parent.
The OAuth tombstones have no identity foreign key and must remain. A fresh
Health Connect admission for a subsequently approved account gets a new random
generation; an old request must never reuse its deleted generation.

Re-run the step 3 health-data counts; every count must be 0 in either mode.
Re-run 3b separately: D1 OAuth payloads must be zero only for full deletion. For 4b also
confirm zero rows in `access_identity_links`, `whoop_members` and
`identity_links` for the id. For 4a confirm those three still have their rows.
`seat_request_delivery` holds only an email hash with a short expiry and is
cleaned automatically.

## 5. Confirm privately

Reply on the same private channel: what was deleted (categories, not counts of
health records), what they must revoke themselves (WHOOP, Notion), and that
ChatGPT/Codex conversation history is controlled by their OpenAI settings.
Delete the private working note once confirmed. Do not record the request
anywhere public.
