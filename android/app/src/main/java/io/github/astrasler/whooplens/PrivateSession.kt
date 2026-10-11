package io.github.astrasler.whooplens

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * A private, in-memory Supabase session. Network calls must run off the UI thread.
 * Session revisions prevent a delayed sign-in from undoing Sign out.
 * The publishable project key is public; service-role keys must never enter this app.
 */
internal class PrivateSession {
  private val project = "https://evoiwauqplbcecumiwqn.supabase.co"
  private val publishable = "sb_publishable_iSQO1ZdTmCnRHC_YxKb30A_x7rVRYr_"
  private val lock = Any()
  private var revision = 0L
  private var token: String? = null
  private var expiresAtMs = 0L

  // Call this on the sign-in button tap. A later Sign out invalidates
  // the attempt even if its network thread has not started yet.
  fun beginSignIn(): Long = synchronized(lock) {
    revision++
    token = null
    expiresAtMs = 0L
    revision
  }

  fun signIn(email: String, password: String, attempt: Long): Boolean {
    if (synchronized(lock) { attempt != revision }) return false
    require(email.length in 3..254 && password.isNotEmpty())
    val login = request(
      "/auth/v1/token?grant_type=password", "POST",
      JSONObject().put("email", email).put("password", password).toString(), null
    )
    val newToken = login.optString("access_token").takeIf { it.isNotBlank() }
      ?: throw IllegalStateException("Sign-in failed")
    val expirySeconds = login.optLong("expires_in", 0L)
    if (expirySeconds < 60L || expirySeconds > 86400L)
      throw IllegalStateException("Unexpected session expiry")

    // WHOOP Lens's deployed status route enforces the account-active gate.
    // Do not publish a token until the WHOOP connection is confirmed.
    val status = request("/functions/v1/whoop-mcp/status", "GET", null, newToken)
    if (!status.optBoolean("connected", false)) return false

    return synchronized(lock) {
      if (attempt != revision) {
        false
      } else {
        token = newToken
        expiresAtMs = System.currentTimeMillis() + expirySeconds * 1000L
        true
      }
    }
  }

  fun currentToken(): String? = synchronized(lock) {
    val active = token
    if (active == null || System.currentTimeMillis() >= expiresAtMs - 30_000L) null else active
  }

  fun signOut() = synchronized(lock) {
    revision++
    token = null
    expiresAtMs = 0L
  }

  private fun request(path: String, method: String, jsonBody: String?, bearer: String?): JSONObject {
    check(path.startsWith("/auth/v1/") || path.startsWith("/functions/v1/whoop-mcp/"))
    val conn = URL(project + path).openConnection() as HttpURLConnection
    try {
      conn.requestMethod = method
      conn.connectTimeout = 15_000
      conn.readTimeout = 20_000
      conn.instanceFollowRedirects = false
      conn.setRequestProperty("apikey", publishable)
      conn.setRequestProperty("Accept", "application/json")
      if (bearer != null) conn.setRequestProperty("Authorization", "Bearer $bearer")
      if (jsonBody != null) {
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(jsonBody.toByteArray(StandardCharsets.UTF_8)) }
      }
      val status = conn.responseCode
      if (status !in 200..299) throw IllegalStateException(
        if (status == 401 || status == 403) "Sign-in or WHOOP Lens access denied"
        else "Service unavailable (HTTP $status)"
      )
      val response = conn.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
      if (response.length > 100_000) throw IllegalStateException("Unexpected response")
      return JSONObject(response)
    } finally {
      conn.disconnect()
    }
  }
}
