package io.github.astrasler.whooplens

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.time.LocalDate

/** A five-minute, in-memory, explicitly reviewed Health Connect aggregate. */
internal data class ReviewedSteps(
  val day: LocalDate,
  val start: Instant,
  val end: Instant,
  val count: Long,
  val preparedAtMs: Long = System.currentTimeMillis()
) {
  fun valid(nowMs: Long = System.currentTimeMillis()): Boolean =
    count in 0..10_000_000L && end.isAfter(start) &&
      preparedAtMs <= nowMs && nowMs - preparedAtMs < 5L * 60_000L

  fun describe(): String =
    "$day: $count steps. Source: Health Connect daily aggregate; origin: mixed/unknown. " +
      "Destination: your private WHOOP Lens account. Only this one record would be sent."

  fun exportJson(): String {
    check(valid()) { "Preview expired. Review your steps again." }
    val row = JSONObject()
      .put("metric", "steps_daily")
      .put("record_key", "daily:$day:local")
      .put("observed_at", start.toString())
      .put("ended_at", end.toString())
      .put("local_date", day.toString())
      .put("unit", "steps")
      .put("payload", JSONObject().put("count", count))
    return JSONObject()
      .put("schema_version", 2)
      .put("source", "health_connect")
      .put("exported_at", Instant.now().toString())
      .put("records", JSONArray().put(row)).toString()
  }
}

/** The server verifies the existing OAuth token and derives user identity itself. */
internal object ManualSync {
  // Keep OFF until the replacement Cloudflare endpoint is deployed and verified.
  const val ENABLE_UPLOADS = false
  private const val ENDPOINT = "https://whooplens.tech/v1/health-connect/import"

  fun uploadApprovedSteps(draft: ReviewedSteps, token: String): Boolean {
    check(ENABLE_UPLOADS && draft.valid()) { "Manual sync is not released" }
    val body = JSONObject().put("consent", "store-health-connect-file")
      .put("file", JSONObject(draft.exportJson()))
    val connection = URL(ENDPOINT).openConnection() as HttpURLConnection
    try {
      connection.requestMethod = "POST"
      connection.connectTimeout = 15000
      connection.readTimeout = 20000
      connection.instanceFollowRedirects = false
      connection.doOutput = true
      connection.setRequestProperty("Authorization", "Bearer $token")
      connection.setRequestProperty("Content-Type", "application/json")
      connection.setRequestProperty("Accept", "application/json")
      connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
      if (connection.responseCode != 200) return false
      val result = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
      return result.optInt("stored", 0) == 1 && result.optString("source") == "health_connect"
    } finally { connection.disconnect() }
  }

  fun deleteApprovedSteps(day: LocalDate, token: String): Int {
    // Existing API deletes every imported record, not one day. Never misrepresent it.
    throw UnsupportedOperationException("Per-day deletion is not supported")
  }
}
