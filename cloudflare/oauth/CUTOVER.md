# Independent Cloudflare release and rollback plan

Status: implementation/configuration prepared; live operability NOT verified.
Owner approval is required for verification activation, cutover and retirement.
Successful tests alone do not authorize any of those actions. Supabase stays live.

## Independent authentication

The deployed issuer uses Cloudflare Access email one-time PIN, not Supabase Auth.
Access protects only `auth.whooplens.tech/oauth/upstream/callback`. OAuth metadata,
registration, authorization, token endpoints and MCP retain their OAuth protocol
handling; an Access HTML challenge must not intercept machine-to-machine requests.
The callback requires both the provider's browser-bound state cookie and a
cryptographically verified Access application JWT (RS256, pinned issuer/audience,
expiry, issued-at, subject and app type). The literal `code=access` is a marker,
never a credential. Client PKCE and explicit MCP scope consent remain mandatory.

Access issuer: `https://whoop-lens.cloudflareaccess.com`
Access app: `0718034c-f504-43e8-b7ba-42d7405b8341`
Email provider: `2aa857d1-bd35-44d4-bd7c-3751dea78a7d`
Application audience is configured in the auth Worker wrangler file.
Access app policy denies everyone until a verification cohort is explicitly enabled.
No paid subscription or paid feature was requested. The published Access free tier
covers 50 users; retain the WHOOP beta limit of ten seats (one developer, nine public).

## Identity preparation

Migration 0005 adds `access_identity_links`. It changes no existing identities.
Each record binds an exact Access issuer and stable subject to an existing internal
UUID and requires explicit approval metadata. Email is not an account-merge key.
New independent accounts use `identity_provider=cloudflare_access`; existing UUIDs
can be preserved during an approved migration. A missing link or inactive member
is denied. Never promote the existing connected account with missing membership.
No real identities or health records have been copied. Synthetic identities remain
local test fixtures. Obtain the Access subject through the approved verification
session before preparing the real mapping. Disable `whoop_members.active` to revoke
both existing MCP-token access and future sign-in; disabling only an Access link
blocks new sign-ins but does not revoke already-issued MCP tokens.

## Remaining owner/external setup

- WHOOP app: add `https://whooplens.tech/api/whoop/callback` while retaining the
  existing Supabase callback. Store client ID/secret through Worker secrets, never
  GitHub or chat. Credentials are not readable from the existing Supabase service.
- A separate Cloudflare AES-256 token-encryption secret is provisioned for the v1
  envelope format. Never reuse or
  copy rotating WHOOP refresh tokens between both live services. Confirm WHOOP's
  grant behavior before a real reconnect; it could affect an existing grant.
- Approve the exact identity cohort and any live record migration manifest.
  Keep imported medical context unreviewed until explicitly reviewed.
- ChatGPT reconnection is performed by the owner later.

## Deferred verification acceptance record

Before cutover, record evidence for independent browser sign-in with Supabase
unavailable to the Cloudflare path, consent denial, PKCE rejection, expired/replayed
state, logout/session expiry, member revocation, cross-account isolation, all eleven
MCP tool contracts, WHOOP refresh, and both registered MCP protocol versions.
Use synthetic identities first; live records require separate owner authorization.
Local tests and CI are implementation checks, not proof of live operability.
Browser verification previously encountered ERR_BLOCKED_BY_CLIENT; no successful
live browser sign-in has been established.

## Proposed cutover sequence (NOT authorized)

1. Keep the Supabase Edge Function, auth clients, WHOOP callback and data intact.
2. Complete the deferred Cloudflare-only operability record and resolve every
   identity/membership discrepancy. Produce source/destination count comparisons
   for the specifically approved migration scope, without logging health records.
3. Present the owner with exact deployed commit/version IDs, verification evidence,
   remaining limitations, affected accounts and this rollback procedure.
4. Only after explicit approval, enable the agreed Cloudflare cohort and reconnect
   the owner's ChatGPT connector. Expand only within the approved cohort.
5. Agree an observation period with the owner. Supabase continues operating for
   existing connections throughout; retirement needs a later explicit instruction.

## Rollback sequence (owner-approved execution only)

Triggers: sign-in failure, token-refresh failure, wrong-account results, missing
records, elevated errors, unexpected charges or owner request.
Stop Cloudflare adoption; set all issuer/resource launch flags false and restore
Access deny-all. Restore the last known-good Worker versions if a code rollback is
needed, without dropping D1 tables, deleting keys or erasing logs required to assess
impact. Existing Supabase users keep their original connector. Reconnect migrated
ChatGPT users to the preserved Supabase endpoint only after checking their WHOOP
grant remains valid; reconnect WHOOP there if its grant was invalidated. A token
rotation conflict is not fixed merely by switching DNS. No DNS change is required
for rollback because the Supabase endpoint remains separate and live.
Reconcile any Cloudflare-only writes before future migration; never overwrite
Supabase automatically. Do not delete either service's records during rollback.

## Sources

- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
- https://www.cloudflare.com/sase/products/access/
