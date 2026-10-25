# Private seat requests

Deployed and enabled on October 16, 2026. The request form is a public contact route at `https://auth.whooplens.tech/request-seat`; the MCP, WHOOP records and OAuth callback remain private. WhoopLens has three seats in total, the owner's included (`WHOOP_LENS_SEAT_LIMIT`, default 3, on the resource Worker). Submitting never enrolls a user, links an identity or reserves a seat.

The form asks for name, desired email and an optional short message, with explicit permission to contact the applicant. The auth Worker sends a plain-text email only to `whoop-lens@outlook.com` from `seat-requests@whooplens.tech`. Applicant content is untrusted and cannot choose the recipient or subject. Reply-To is the validated applicant address. The sender domain must be configured for Cloudflare email service and the destination verified.

The public seat illustration shows counts only, never names, emails or relationships: one owner/developer seat, two approved members and zero open seats, out of a maximum of three (all seats allocated). The counts come from `SEAT_ALLOCATION` in `oauth/auth-server/src/seat-request-page.mjs`; open seats are computed as the maximum minus the others, and an allocation larger than the maximum is rejected. These are owner-declared allocations, not a live membership count. The display creates no membership, identity or access permission. Access is enforced by the Cloudflare Access allow rule, manual member approval and the resource Worker's seat cap. Update `SEAT_ALLOCATION` when the owner changes allocations, for example raising `max` only after the owner raises `WHOOP_LENS_SEAT_LIMIT` and approves a new member.

## Branding

The request form and result pages share the teal card presentation in `cloudflare/oauth/auth-server/src/seat-request-page.mjs`. It includes reduced-motion support, visible keyboard focus, narrow-screen wrapping and a compact dark Turnstile widget. Google Fonts provides Inter and JetBrains Mono; system fallbacks remain available. The request-page CSP permits styles only from `fonts.googleapis.com` and font files from `fonts.gstatic.com`, alongside the existing inline CSS and Turnstile permissions. Browser requests to Google carry ordinary network metadata; the page uses `Referrer-Policy: no-referrer`. Form fields and consent semantics are unchanged.

## Protections and delivery behavior

- Exact same-origin POSTs, streamed 8 KB body limit, bounded fields, duplicate/unknown-field rejection and a honeypot.
- Server-verified Turnstile with exact hostname `auth.whooplens.tech` and action `seat-request`.
- Five valid-form verification attempts per IP/hour, stored as salted hashes. Email duplication suppression for 24 hours, with an atomic five-minute pending delivery claim.
- Database stores only salted hashes, counters, status and claim metadata; name, address and message are sent to the owner mailbox, not stored in these tables or logged by this handler.
- Expired metadata is removed lazily on the next valid form submission. This is not a scheduled hard-deletion guarantee. Email retention follows mailbox policy.
- Confirmed send API success displays “Request received. Access requires the owner’s approval.” This confirms API acceptance, not inbox delivery or approval. Failures return 503 and permit retry. Concurrent duplicates get a processing message. A crash after email acceptance but before recording success can cause a duplicate on a later retry; email delivery is not exactly-once.
- No health data is requested. No membership, identity, token, OAuth state, redirect target or seat table is read or written by this feature.

## Deployment verification

PR #59 merged as `ab448d8362b2144aa3daa91487b9300ea9cc44f5`. Initial activation used auth Worker version `58916b72-0d25-4a1e-b464-2c229e0a5533` at 100% of production traffic. Subsequent presentation release versions are recorded on their pull requests. The destination email is verified, Email Routing is ready, migration 0014 is applied, Turnstile and the destination-restricted mail binding are configured, and `SEAT_REQUEST_ENABLED=true`. The public form and human-verification widget render in a browser. The Access application identity-denial URL is configured and read back; its policies, audience and existing editable settings match their pre-change values. The resource Worker was not redeployed.

Validation: 346 synthetic tests passed; all three PR CI workflows passed; auth Worker normal and minified dry-run builds passed. Remaining live acceptance checks: complete a human-verified synthetic request and confirm actual receipt in Outlook; exercise denied and approved sign-ins interactively. Configuration readback is not an end-to-end sign-in or inbox-delivery test.

## Activation / recovery runbook

1. Verify `whoop-lens@outlook.com` using the Cloudflare verification email requested on October 16, 2026. Do not read or consume its verification link on the owner's behalf.
2. Onboard `whooplens.tech` to Cloudflare Email Service. Inspect existing mail DNS before any changes; do not replace another mail provider's MX/SPF/DKIM records blindly. Inspection before activation on October 16 found no existing MX or SPF records; Email Routing was then enabled.
3. Create a managed Turnstile widget restricted to `auth.whooplens.tech`. Add the public `SEAT_REQUEST_TURNSTILE_SITE_KEY` binding and secret `SEAT_REQUEST_TURNSTILE_SECRET` to the auth Worker. Never commit the secret or expose it to HTML.
4. Apply additive migration `0014_seat_requests.sql` to the existing D1 database. It creates only request-abuse and delivery-metadata tables.
5. Add an auth-Worker `send_email` binding named `SEAT_REQUEST_MAILER`, restricted with `destination_address: whoop-lens@outlook.com`. Preserve every existing binding, OAuth KV namespace, D1 binding, Access audience and issuer setting.
6. Deploy the tested auth Worker and set `SEAT_REQUEST_ENABLED=true` only after mail/Turnstile configuration is ready. Keep workers.dev and previews disabled. The resource Worker requires no change.
7. Test a consented synthetic applicant submission and verify receipt in the owner mailbox. Confirm no membership/seat mutation, and verify allowed-user sign-in still works.
8. On the existing **WhoopLens browser identity** Access application for `auth.whooplens.tech/oauth/upstream/callback`, set `custom_deny_url` to `https://auth.whooplens.tech/request-seat`. This is the identity-rule denial redirect. Preserve the application domain, audience and policies exactly. Do not create an Access bypass policy or redirect API authentication failures. Leave non-identity denial behavior unchanged.
9. Verify a denied browser sign-in reaches the form without forwarding OAuth state or credentials. A locally disabled/missing D1 member who passes Cloudflare Access still receives the existing OAuth failure; it is not silently enrolled.

For a new environment, keep activation off until its prerequisites are configured. Production is enabled with the remaining live acceptance checks recorded above. Rollback removes the custom denial redirect first and disables the feature flag; it does not alter access policies or delete health data.

## Regression checks

`node --test cloudflare/test/seat-request.test.mjs` uses synthetic applicants, in-memory SQLite, a fake challenge verifier and a fake mail sender. It tests gating, output escaping, no OAuth-state reflection, valid and duplicate submissions, independent applicants, pending claims, rate limits, oversized/malformed requests, header injection, missing consent, wrong challenge host/action and retryable mail failures. Run the existing auth/provider and repository suites and both Worker dry-run builds before activation.
