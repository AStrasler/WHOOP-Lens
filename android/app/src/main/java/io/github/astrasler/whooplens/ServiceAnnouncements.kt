package io.github.astrasler.whooplens

import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import org.json.JSONObject

/** A service notice the signed-in member is allowed to see. No account or health fields. */
internal data class ServiceNotice(
    val id: String,
    val kind: String,
    val title: String,
    val body: String,
    val startsAt: String,
    val expiresAt: String?,
)

/** Notices for one local account. A mismatch with the signed-in account yields nothing. */
internal data class NoticeInbox(
    val account: String,
    val notices: List<ServiceNotice>,
    val enabled: Boolean,
)

/**
 * Member-facing service notices. The server flag defaults off, so an ordinary
 * response is an empty inbox and the app shows nothing. This does not register
 * for push notifications or contact a member.
 */
internal object ServiceAnnouncements {
    private val kinds = setOf("maintenance", "outage", "restoration", "update")
    private val idOk = Regex("^[0-9a-f]{32}$")
    private val rootKeys = setOf("enabled", "announcements", "note")
    private val noticeKeys = setOf("id", "kind", "title", "body", "starts_at", "expires_at")
    private val privateText =
        Regex(
            "(?i)([^\\s@]+@[^\\s@]+\\.[^\\s@]+)|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|(recovery_score|heart_rate|resting_heart_rate|\\bhrv\\b|spo2|strain_score|heart\\s+rate|recovery\\s+score)|(\\d{8,})"
        )

    fun empty(account: String) = NoticeInbox(account, emptyList(), false)

    fun forAccount(inbox: NoticeInbox?, account: String?): NoticeInbox {
        if (inbox == null || account.isNullOrEmpty() || inbox.account != account) return empty(account ?: "")
        return inbox
    }

    fun parse(account: String, payload: String, nowEpochMs: Long): NoticeInbox {
        if (account.isEmpty()) return empty(account)
        val root =
            try {
                JSONObject(payload)
            } catch (_: Exception) {
                return empty(account)
            }
        val keys = root.keys().asSequence().toList()
        if (keys.any { it !in rootKeys }) return empty(account)
        if (root.optBoolean("enabled") != true) return empty(account)
        val raw = root.optJSONArray("announcements") ?: return NoticeInbox(account, emptyList(), true)
        val now = Instant.ofEpochMilli(nowEpochMs)
        val notices = ArrayList<ServiceNotice>()
        for (i in 0 until raw.length()) {
            if (notices.size >= 20) break
            val item = raw.optJSONObject(i) ?: continue
            val notice = notice(item, now) ?: continue
            if (notices.none { it.id == notice.id }) notices.add(notice)
        }
        return NoticeInbox(account, notices, true)
    }

    /** Maintenance first, then an outage. Other kinds stay in the inbox. */
    fun banner(notices: List<ServiceNotice>): ServiceNotice? =
        notices.firstOrNull { it.kind == "maintenance" } ?: notices.firstOrNull { it.kind == "outage" }

    private fun notice(item: JSONObject, now: Instant): ServiceNotice? {
        val keys = item.keys().asSequence().toList()
        if (keys.any { it !in noticeKeys } || keys.toSet() != noticeKeys) return null
        val id = item.optString("id")
        val kind = item.optString("kind")
        val title = item.optString("title").trim()
        val body = item.optString("body").trim()
        val startsAt = item.optString("starts_at")
        if (!idOk.matches(id) || kind !in kinds || title.isEmpty() || title.length > 120 || body.isEmpty() || body.length > 1000)
            return null
        if (privateText.containsMatchIn(title) || privateText.containsMatchIn(body)) return null
        val starts = parseTime(startsAt) ?: return null
        if (starts.isAfter(now)) return null
        val expiresRaw = if (item.isNull("expires_at")) null else item.optString("expires_at")
        val expires = if (expiresRaw.isNullOrEmpty()) null else parseTime(expiresRaw) ?: return null
        if (expires != null && !expires.isAfter(now)) return null
        return ServiceNotice(id, kind, title, body, startsAt, expiresRaw)
    }

    private fun parseTime(value: String): Instant? =
        try {
            Instant.parse(value)
        } catch (_: Exception) {
            null
        }
}

internal fun interface AnnouncementTransport {
    fun get(url: String, authorization: String): Pair<Int, String>
}

/** Pulls the member inbox. A non-200 body is discarded so an error page cannot be shown. */
internal class AnnouncementClient(
    private val auth: PrivateSession,
    private val account: String,
    private val transport: AnnouncementTransport = httpAnnouncementTransport(),
) {
    fun fetch(): String {
        check(auth.accountKey() == account)
        val token = auth.accessToken() ?: return DISABLED
        check(auth.accountKey() == account)
        val (status, body) =
            try {
                transport.get(ENDPOINT, "Bearer $token")
            } catch (_: Exception) {
                return DISABLED
            }
        if (auth.accountKey() != account || status != 200 || body.length > 100_000) return DISABLED
        return body
    }

    companion object {
        const val ENDPOINT = "https://whooplens.tech/v1/announcements"
        private const val DISABLED = """{"enabled":false,"announcements":[]}"""
    }
}

internal fun httpAnnouncementTransport(): AnnouncementTransport =
    AnnouncementTransport { url, authorization ->
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "GET"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 8000
            connection.readTimeout = 8000
            connection.setRequestProperty("Authorization", authorization)
            connection.setRequestProperty("Accept", "application/json")
            val status = connection.responseCode
            val stream = if (status == 200) connection.inputStream else connection.errorStream
            val text = stream?.use { it.readNBytes(100_001).toString(Charsets.UTF_8) }.orEmpty()
            status to text
        } finally {
            connection.disconnect()
        }
    }
