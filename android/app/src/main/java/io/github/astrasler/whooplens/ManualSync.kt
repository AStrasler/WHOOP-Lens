package io.github.astrasler.whooplens

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.LocalDate

/** In-memory preview of one day of aggregate steps; no credentials or persistent storage. */
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

/**
 * Deployment gate is intentionally OFF. Enable in a reviewed, separately approved
 * release after the health_connect_records migration + v2 Edge Function are live.
 * No caller may override this gate or pass an arbitrary destination URL.
 */
internal object ManualSync {
  const val ENABLE_UPLOADS = false
  private const val destination =
    "https://evoiwauqplbcecumiwqn.supabase.co/functions/v1/samsung-health"
  private const val publishable = "sb_publishable_iSQO1ZdTmCnRHC_YxKb30A_x7rVRYr_"

  /** A separate explicit confirmation is required by the calling UI. */
  fun deleteApprovedSteps(draft: ReviewedSteps, token: String): Int {
    check(ENABLE_UPLOADS) { "Private deletion is not released yet." }
    check(draft.valid()) { "Preview expired. Review again." }
    check(token.isNotBlank()) { "Sign in again." }
    val body = JSONObject()
      .put("schema_version", 2)
      .put("source", "health_connect")
      .put("approved", true)
      .put("metric", "steps_daily")
      .put("record_key", "daily:" + draft.day + ":local").toString()
    val conn = URL(destination).openConnection() as HttpURLConnection
    try {
      conn.requestMethod = "DELETE"
      conn.connectTimeout = 15_000
      conn.readTimeout = 20_000
      conn.instanceFollowRedirects = false
      conn.doOutput = true
      conn.setRequestProperty("Authorization", "Bearer $token")
      conn.setRequestProperty("apikey", publishable)
      conn.setRequestProperty("Content-Type", "application/json")
      conn.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
      if (conn.responseCode != 200) return -1
      val response = conn.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
      if (response.length > 4000) return -1
      val result = JSONObject(response)
      return if (result.optInt("schema_version") == 2) result.optInt("deleted", -1) else -1
    } finally {
      conn.disconnect()
    }
  }

  fun uploadApprovedSteps(draft: ReviewedSteps, token: String): Boolean {
    check(ENABLE_UPLOADS) { "Private sync is not released yet." }
    check(draft.valid()) { "Preview expired. Review again." }
    check(token.isNotBlank()) { "Sign in again." }
    // Must be invoked off the UI thread, after the user presses Upload.
    val body = draft.exportJson()
    val conn = URL(destination).openConnection() as HttpURLConnection
    try {
      conn.requestMethod = "POST"
      conn.connectTimeout = 15_000
      conn.readTimeout = 20_000
      conn.instanceFollowRedirects = false
      conn.doOutput = true
      conn.setRequestProperty("Authorization", "Bearer $token")
      conn.setRequestProperty("apikey", publishable)
      conn.setRequestProperty("Content-Type", "application/json")
      conn.setRequestProperty("Accept", "application/json")
      conn.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
      if (conn.responseCode != 200) return false
      val response = conn.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
      if (response.length > 4000) return false
      val result = JSONObject(response)
      return result.optInt("schema_version") == 2 && result.optInt("accepted") == 1
    } finally {
      conn.disconnect()
    }
  }
}
