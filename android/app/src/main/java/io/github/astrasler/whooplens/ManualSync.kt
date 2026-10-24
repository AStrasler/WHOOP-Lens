package io.github.astrasler.whooplens

import org.json.JSONArray
import org.json.JSONObject
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
  // Uploads require a reviewed Cloudflare endpoint and mobile OAuth session.
  // No legacy endpoint fallback is permitted.

  /** No network fallback to Supabase. Cloudflare mobile OAuth is not yet released. */
  fun deleteApprovedSteps(day: LocalDate, token: String): Int {
    throw UnsupportedOperationException("Cloudflare mobile sync is not released")
  }

  fun uploadApprovedSteps(draft: ReviewedSteps, token: String): Boolean {
    throw UnsupportedOperationException("Cloudflare mobile sync is not released")
  }
}