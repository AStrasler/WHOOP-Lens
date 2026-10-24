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

/** Result of a remote server deletion request. */
internal sealed class DeletionResult {
  /** Confirmed deletion response received from verified backend. */
  data class Confirmed(val recordsDeleted: Int) : DeletionResult()

  /**
   * Upload and sync gates are inactive in this companion build (ENABLE_UPLOADS = false).
   * No remote call was made, and no remote data was modified.
   */
  object Disabled : DeletionResult()

  /** The backend returned an error or the request failed. */
  data class Failed(val reason: String, val statusCode: Int? = null) : DeletionResult()
}

/** The server verifies the existing OAuth token and derives user identity itself. */
internal object ManualSync {
  // Keep OFF until the replacement Cloudflare endpoint is deployed and verified.
  const val ENABLE_UPLOADS = false
  const val ENDPOINT_IMPORT = "https://whooplens.tech/v1/health-connect/import"
  const val ENDPOINT_HEALTH_CONNECT = "https://whooplens.tech/v1/health-connect"

  fun uploadApprovedSteps(draft: ReviewedSteps, token: String): Boolean {
    check(ENABLE_UPLOADS && draft.valid()) { "Manual sync is not released" }
    val body = JSONObject().put("consent", "store-health-connect-file")
      .put("file", JSONObject(draft.exportJson()))
    val connection = URL(ENDPOINT_IMPORT).openConnection() as HttpURLConnection
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

  /**
   * Request deletion of all server-held Health Connect records for the authenticated user.
   *
   * Honors ENABLE_UPLOADS: If false, never calls the network or fakes success.
   * When enabled, invokes DELETE https://whooplens.tech/v1/health-connect with consent.
   */
  fun deleteAccountData(token: String, connectionProvider: ((String) -> HttpURLConnection)? = null): DeletionResult {
    if (!ENABLE_UPLOADS) {
      return DeletionResult.Disabled
    }
    return executeDeletionRequest(token, connectionProvider)
  }

  /**
   * Internal helper for executing or testing the verified DELETE protocol.
   */
  internal fun executeDeletionRequest(
    token: String,
    connectionProvider: ((String) -> HttpURLConnection)? = null
  ): DeletionResult {
    if (!ENABLE_UPLOADS) return DeletionResult.Disabled
    val connection = connectionProvider?.invoke(ENDPOINT_HEALTH_CONNECT)
      ?: (URL(ENDPOINT_HEALTH_CONNECT).openConnection() as HttpURLConnection)
    try {
      connection.requestMethod = "DELETE"
      connection.connectTimeout = 15000
      connection.readTimeout = 20000
      connection.instanceFollowRedirects = false
      connection.doOutput = true
      connection.setRequestProperty("Authorization", "Bearer $token")
      connection.setRequestProperty("Content-Type", "application/json")
      connection.setRequestProperty("Accept", "application/json")

      val body = JSONObject().put("consent", "delete-my-health-connect-records")
      connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }

      val code = connection.responseCode
      if (code !in 200..299) {
        return DeletionResult.Failed("Server error (HTTP $code)", code)
      }
      val responseText = connection.inputStream.bufferedReader().use { it.readText() }
      return parseDeletionResponse(code, responseText)
    } catch (e: Exception) {
      return DeletionResult.Failed("Deletion was not confirmed")
    } finally {
      connection.disconnect()
    }
  }

  /**
   * Parse a JSON response body into a DeletionResult.
   */
  internal fun parseDeletionResponse(httpCode: Int, responseBody: String): DeletionResult {
    if (httpCode !in 200..299) {
      return DeletionResult.Failed("Server returned HTTP $httpCode", httpCode)
    }
    return try {
      val json = JSONObject(responseBody)
      if (!json.has("deleted") || json.isNull("deleted") || json.opt("deleted") !is Int || json.getInt("deleted") < 0) {
        DeletionResult.Failed("Missing or invalid deleted count", httpCode)
      } else {
        DeletionResult.Confirmed(json.getInt("deleted"))
      }
    } catch (e: Exception) {
      DeletionResult.Failed("Malformed server response", httpCode)
    }
  }
}
