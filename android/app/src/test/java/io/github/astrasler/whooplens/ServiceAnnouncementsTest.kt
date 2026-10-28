package io.github.astrasler.whooplens

import java.time.Instant
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ServiceAnnouncementsTest {
    private val account = "a".repeat(43)
    private val other = "b".repeat(43)
    private val now = Instant.parse("2026-10-27T15:00:00Z").toEpochMilli()

    private fun payload(vararg notices: String, enabled: Boolean = true, extra: String? = null): String {
        val items = notices.joinToString(",")
        val tail = if (extra == null) "" else ""","$extra":"hidden""""
        return """{"enabled":$enabled,"announcements":[$items]$tail}"""
    }

    private fun notice(
        id: String = "a".repeat(32),
        kind: String = "maintenance",
        title: String = "Maintenance tonight",
        body: String = "WhoopLens will be briefly unavailable.",
        starts: String = "2026-10-27T14:00:00Z",
        expires: String? = "2026-10-28T06:00:00Z",
    ): String {
        val expiry = if (expires == null) "null" else "\"$expires\""
        return """{"id":"$id","kind":"$kind","title":"$title","body":"$body","starts_at":"$starts","expires_at":$expiry}"""
    }

    @Test
    fun disabledAndEmptyPayloadsShowNothing() {
        val off = ServiceAnnouncements.parse(account, payload(notice(), enabled = false), now)
        assertFalse(off.enabled)
        assertTrue(off.notices.isEmpty())
        val missing = ServiceAnnouncements.parse(account, "{", now)
        assertTrue(missing.notices.isEmpty())
    }

    @Test
    fun memberInboxKeepsAddressedNoticesAndDropsPrivateOrUntimelyOnes() {
        val good = notice()
        val update = notice(id = "b".repeat(32), kind = "update", title = "Reader update", body = "A small fix is live.")
        val future = notice(id = "c".repeat(32), kind = "outage", starts = "2026-10-28T02:00:00Z")
        val ended = notice(id = "d".repeat(32), expires = "2026-10-27T14:30:00Z")
        val health = notice(title = "Recovery score is ready")
        val mail = notice(body = "Write to member@example.com")
        val identity = notice(body = "Seat 0b0b0b0b-0000-4000-8000-00000000000b")
        val inbox =
            ServiceAnnouncements.parse(
                account,
                payload(good, update, future, ended, health, mail, identity),
                now,
            )
        assertEquals(listOf("maintenance", "update"), inbox.notices.map { it.kind })
        assertEquals("Maintenance tonight", inbox.notices[0].title)
        assertNull(ServiceAnnouncements.parse(account, payload(good, extra = "user_id"), now).notices.firstOrNull())
        assertTrue(ServiceAnnouncements.parse(account, payload(good, extra = "heart_rate"), now).notices.isEmpty())
    }

    @Test
    fun bannerPrefersMaintenanceThenOutageAndStaysOnItsAccount() {
        val outage = notice(id = "b".repeat(32), kind = "outage", title = "Partial outage", body = "Reads are delayed.")
        val maintenance = notice()
        val inbox = ServiceAnnouncements.parse(account, payload(outage, maintenance), now)
        assertEquals("maintenance", ServiceAnnouncements.banner(inbox.notices)?.kind)
        assertEquals("outage", ServiceAnnouncements.banner(listOf(inbox.notices.first { it.kind == "outage" }))?.kind)
        assertTrue(ServiceAnnouncements.forAccount(inbox, other).notices.isEmpty())
        assertEquals(inbox.notices, ServiceAnnouncements.forAccount(inbox, account).notices)
        assertTrue(ServiceAnnouncements.forAccount(inbox, null).notices.isEmpty())
    }

    @Test
    fun cachedNoticeDropsWhenItsExpiryPassesWithoutAnotherFetch() {
        val expires = "2026-10-27T16:00:00Z"
        val inbox = ServiceAnnouncements.parse(account, payload(notice(expires = expires)), now)
        val expiry = Instant.parse(expires).toEpochMilli()
        assertEquals(listOf("maintenance"), ServiceAnnouncements.current(inbox, account, now).notices.map { it.kind })
        assertEquals(expiry, ServiceAnnouncements.nextExpiryEpochMs(inbox.notices, now))
        assertEquals(1, ServiceAnnouncements.current(inbox, account, expiry - 1).notices.size)
        assertTrue(ServiceAnnouncements.current(inbox, account, expiry).notices.isEmpty())
        assertNull(ServiceAnnouncements.nextExpiryEpochMs(inbox.notices, expiry))
        val open = ServiceAnnouncements.parse(account, payload(notice(expires = null)), now)
        assertEquals(1, ServiceAnnouncements.current(open, account, expiry).notices.size)
        assertNull(ServiceAnnouncements.nextExpiryEpochMs(open.notices, now))
        assertTrue(ServiceAnnouncements.current(inbox, other, now).notices.isEmpty())
    }

    @Test
    fun clientUsesTheSignedInAccountAndDiscardsErrorBodies() {
        val session = session(account)
        var seenUrl = ""
        var seenAuth = ""
        val client =
            AnnouncementClient(session, account) { url, authorization ->
                seenUrl = url
                seenAuth = authorization
                500 to """{"recovery_score":87.5,"heart_rate":54}"""
            }
        val raw = client.fetch()
        assertEquals(AnnouncementClient.ENDPOINT, seenUrl)
        assertEquals("Bearer synthetic-access-token", seenAuth)
        assertFalse(seenAuth.contains("synthetic-refresh-token"))
        assertFalse(raw.contains("87.5"))
        assertFalse(raw.contains("heart_rate"))
        assertTrue(raw.contains("\"enabled\":false"))
        var called = false
        assertThrows(IllegalStateException::class.java) {
            AnnouncementClient(session, other) { _, _ ->
                    called = true
                    200 to payload(notice())
                }
                .fetch()
        }
        assertFalse(called)
    }

    private fun session(account: String): PrivateSession {
        val storage = MemorySessionStorage()
        storage.write(
            JSONObject()
                .put("version", 1)
                .put("issuer", PrivateSession.ISSUER)
                .put("resource", PrivateSession.RESOURCE)
                .put("account", account)
                .put("client", "synthetic-client")
                .put("endpoint", "https://auth.whooplens.tech/token")
                .put("revoke", "https://auth.whooplens.tech/revoke")
                .put("access", "synthetic-access-token")
                .put("refresh", "synthetic-refresh-token")
                .put("expires", 9_000_000_000_000L)
                .put("refreshAt", 9_000_000_000_000L)
                .put("pendingUntil", 0)
                .toString(),
        )
        return PrivateSession(null, { 1_000L }, storage)
    }
}
