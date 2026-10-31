package io.github.astrasler.whooplens

import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

internal enum class LifeSchedule(val value: String, val label: String, val description: String) {
    FIXED("fixed", "Fixed", "My daily routine generally follows predictable times."),
    FLEXIBLE("flexible", "Flexible", "I have a general routine, but it changes when needed."),
    UNPREDICTABLE("unpredictable", "Unpredictable", "My schedule varies significantly depending on what life requires.");
    companion object {
        fun effective(value: String?) = entries.firstOrNull { it.value == value } ?: UNPREDICTABLE
    }
}
internal data class LifeSchedulePreference(val account: String, val selection: LifeSchedule, val explicit: Boolean)
internal fun interface LifeScheduleTransport {
    fun request(method: String, authorization: String, body: String?): Pair<Int, String>
}
/** Server persistence only; no local fallback writes, observed-pattern or AI setters. */
internal class LifeScheduleClient(
    private val auth: PrivateSession,
    private val account: String,
    private val transport: LifeScheduleTransport = httpLifeScheduleTransport(),
) {
    fun read(): LifeSchedulePreference? = exchange("GET", null)
    fun select(selection: LifeSchedule, confirmedByUser: Boolean): LifeSchedulePreference? {
        require(confirmedByUser) { "Explicit user confirmation required" }
        return exchange("PUT", JSONObject().put("life_schedule", selection.value)
            .put("confirmation", "user_selected_life_schedule").toString())
    }
    private fun exchange(method: String, body: String?): LifeSchedulePreference? {
        check(auth.accountKey() == account)
        val token = auth.accessToken() ?: return null
        check(auth.accountKey() == account)
        val (status, raw) = try { transport.request(method, "Bearer $token", body) } catch (_: Exception) { return null }
        if (auth.accountKey() != account || status != 200 || raw.length > 2048) return null
        return try {
            val json = JSONObject(raw)
            if (json.has("error")) return null
            val value = json.optString("life_schedule")
            LifeSchedulePreference(account, LifeSchedule.effective(value),
                LifeSchedule.entries.any { it.value == value } && json.optBoolean("explicit", false))
        } catch (_: Exception) { null }
    }
    companion object { const val ENDPOINT = "https://whooplens.tech/v1/preferences/life-schedule" }
}
internal fun httpLifeScheduleTransport() = LifeScheduleTransport { method, authorization, body ->
    val connection = URL(LifeScheduleClient.ENDPOINT).openConnection() as HttpURLConnection
    try {
        connection.requestMethod = method
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 8000; connection.readTimeout = 8000
        connection.setRequestProperty("Authorization", authorization)
        connection.setRequestProperty("Accept", "application/json")
        if (body != null) {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        }
        val status = connection.responseCode
        val raw = if (status == 200) connection.inputStream.use { it.readNBytes(2049).toString(Charsets.UTF_8) } else ""
        status to raw
    } finally { connection.disconnect() }
}
