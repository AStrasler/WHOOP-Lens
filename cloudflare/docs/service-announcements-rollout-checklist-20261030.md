# Service announcements — development and activation

## Implemented and verified without production access

The existing authenticated HTTP and MCP workflow supports owner-only creation, scheduling, publication, cancellation, expiry and targeting. Members receive only active notices addressed to them or everyone; payloads exclude target ids and account/health data. Delivery is a member-initiated pull (Android inbox/banner or MCP list), not push messaging.

The service now independently verifies active membership on owner actions and member reads, in addition to router/OAuth checks. Synthetic in-memory SQLite tests cover the exact `ABC 123` body through authenticated HTTP creation, hidden draft, owner publication, member read and MCP retrieval; unauthorized/inactive callers, target isolation, cancellation, flag rollback and failed-batch rollback are verified. No test creates a live notice.

Run `node --test cloudflare/test/service-announcements.test.mjs`. The staging-isolation workflow runs this suite with all offline server tests; the OAuth workflow validates the production wrapper and dry-run bundles.

## Separate production gates — not performed

1. Owner approves a reviewed release/rollback plan and live-schema/configuration reconciliation. Migration `0020_service_announcements.sql` and `ANNOUNCEMENTS_ENABLED=true` remain separate production operations, not consequences of merging this code. Do not apply unrelated migrations 0021–0023 here.
2. Only after explicit activation approval: apply the required schema, release the reviewed Worker and enable the existing feature flag. Verify authentication and owner-only management. Roll back visibility by setting the flag false; disabling hides notices without deleting them. Schema rollback must happen only after disabling and releasing code that no longer queries these tables.
3. Only after separate explicit publication approval: create the short-lived `kind=update`, `audience=all`, `title=Test notice`, `body=ABC 123` notice with the actual publication time. Read it back through the authorized member HTTP/MCP paths. Discuss expiry/cancellation with the owner.

No live notice, production migration, feature activation, Worker deployment or member notification was performed during development. Production flag defaults remain false. See `service-announcements.md` for the endpoint and permission contracts.
