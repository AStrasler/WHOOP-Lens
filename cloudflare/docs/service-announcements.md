# Service announcements

Owner-only notices for maintenance, outages, restoration, and updates. The
feature is off until the owner applies migration `0020_service_announcements.sql`
and sets `ANNOUNCEMENTS_ENABLED` to exactly `true`. Neither is done by this
change. No member is contacted, and nothing is deployed.

Supabase is retired. Notices live in the existing Cloudflare D1 database on the
WhoopLens Worker. Authorization uses the existing
`WHOOP_LENS_DEVELOPER_USER_ID` check. A normal member cannot create, edit,
schedule, expire, target, or list management records, including by calling the
HTTP routes or the MCP tools directly.

## What a member can see

`GET /v1/announcements` and the MCP tool `list_service_announcements` return
notices that are `scheduled` or `active`, whose `starts_at` has passed, that
have not expired, and that are addressed to every member or to that member's
existing pseudonymous id. The response is the id, kind, title, body, start, and
expiry. It does not include the audience list, other member ids, names, emails,
or health data.

The Android companion fetches that route on launch with the existing sign-in
and shows a maintenance or outage banner plus an inbox on Home. A notice whose
expiry passes while the app is open is removed on the next draw, without
waiting for another launch. Switching accounts drops the previous inbox. There
is no push notification and no FCM setup. Push delivery, if it is ever wanted, is a separate decision and would
add a service this project does not use today.

The public website has no signed-in member session. The member surfaces are the
companion app and the authenticated HTTP/MCP routes. The server cannot push an
unsolicited chat message.

## What the owner can do

Only while the flag is on, and only for the owner id:

- `POST /v1/announcements` or `create_service_announcement`
- `POST /v1/announcements/update` or `update_service_announcement`
  (`save`, `schedule`, `publish`, `expire`, `cancel`, and retarget)
- `GET /v1/announcements/manage` or `manage_service_announcements`

`audience` is `all` or `members`. `members` takes up to 20 existing active
member ids, not names or emails. That active-member check runs when recipients
are added or changed. Expiring or cancelling still works after a targeted
member becomes inactive. At most 50 draft, scheduled, or active notices can
exist at once. Expired and cancelled notices stay in the record and do not
count toward that cap. Notice text is refused if it contains an
email, a member id, a link, a credential, an 8-digit run, or a health field
such as heart rate or HRV.

## Owner approval still required

1. Review and merge.
2. Apply `cloudflare/migrations/0020_service_announcements.sql` to the
   production D1 database. Rollback is
   `cloudflare/migration/rollback/0020_service_announcements.down.sql`.
   Turn the flag off before rolling back.
3. Release the Worker with the existing code-only path. Do not use a plain
   Wrangler deploy. The committed configs keep `ANNOUNCEMENTS_ENABLED` at
   `"false"` and are not live settings.
4. Set `ANNOUNCEMENTS_ENABLED` to `true` only after that release. Until then
   the routes answer members with an empty inbox and refuse management.

Push notifications (FCM or otherwise) are not included and are not authorized
by enabling this flag.
