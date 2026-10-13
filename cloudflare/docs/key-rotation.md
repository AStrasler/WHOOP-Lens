# WHOOP token key rotation and Secrets Store backup

## Dual-key AES
- `WHOOP_TOKEN_AES256_KEY` (k1): the current key. `WHOOP_TOKEN_AES256_KEY_NEXT` (k2): the new key, optional.
- While NEXT is unset, nothing changes: envelopes stay `v1.<iv>.<ct>` with k1.
- With NEXT set: new envelopes are `v2.k2.<iv>.<ct>`. Legacy `v1` envelopes try k2, then k1. `v2.k2` envelopes never fall back.
- Lazy migration: a token read that opened a row with k1 reseals both tokens with k2 (optimistic UPDATE).
- Batch pass: once per isolate every 10 minutes, during a WHOOP token read or refresh, up to 25 non-k2 rows are resealed.
  It logs `{"event":"token_key_migration","key":"k2","migrated","raced","failed","total","on_k2","remaining"}`.
- Nothing deletes k1. Promote only after `remaining` is 0, checked in D1:
  `SELECT COUNT(*) FROM whoop_connections WHERE encrypted_access_token NOT LIKE 'v2.k2.%' OR encrypted_refresh_token NOT LIKE 'v2.k2.%'`
- Promotion: set `WHOOP_TOKEN_AES256_KEY` to the k2 value and keep NEXT the same value (k2 envelopes keep opening via NEXT).
  Then remove the k1 value later. A future change can drop the NEXT name.

## Rollback limit (read before setting NEXT)
- Once any row holds a `v2.k2.` envelope, roll back only to Worker versions that include dual-key support (this PR or later).
  An older version cannot read `v2.k2.` envelopes, and those users would have to reconnect WHOOP.
- Before setting NEXT, the value must exist in two places, both verified: the Worker secret, and the `BK_WHOOP_TOKEN_AES256_KEY_NEXT`
  Secrets Store backup (bound and resolvable). Keep a protected box copy as well. Losing k2 after migration means every user reconnects.
- Rows within 5 minutes of token expiry are never re-encrypted, so the re-encryption cannot race a refresh. If a refresh write still
  misses because only the ciphertext changed (same refresh token), the refresh retries against the current ciphertext.

## Secrets Store backup
Optional `secrets_store_secrets` bindings named `BK_<SECRET>`: `BK_WHOOP_CLIENT_ID`, `BK_WHOOP_CLIENT_SECRET`,
`BK_WHOOP_TOKEN_AES256_KEY`, `BK_WHOOP_TOKEN_AES256_KEY_NEXT` and `BK_AI_ACCOUNT_ANALYTICS_TOKEN`.
They are not in wrangler.jsonc yet because the store id is created at deploy time. Example:
```jsonc
"secrets_store_secrets": [
  { "binding": "BK_WHOOP_TOKEN_AES256_KEY", "store_id": "<store id>", "secret_name": "WHOOP_TOKEN_AES256_KEY" }
]
```
The store is read once per request, and only when the Worker secret is missing or fails its format check
(AES keys must be 43-character base64url that decodes to 32 bytes; others must be non-empty with no whitespace and within a length range).
A decrypt failure never switches to the store. Logs show only `{"event":"secret_source","secret","source","reason"}`.
