package io.github.astrasler.whooplens

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * A private, in-memory Supabase session. This class must be called off the UI thread.
 * The publishable key is public; service-role keys must NEVER enter the Android app.
 */
internal class PrivateSession {
  private val project = "https://evoiwauqplbcecumiwqn.supabase.co"
  private val publishable = "sb_publishable_iSQO1ZdTmCnRHC_YxKb30A_x7rVRYr_"
  @Volatile private var token: String? = null
  @Volatile private var expiresAtMs = 0L

  fun signIn(email: String, password: String): Boolean {
    signOut()
    require(email.length in 3..254 && password.isNotEmpty())
    val body = JSONObject().put("email", email).put("password", password)
    val login = request("/auth/v1/token?grant_type=password", "POST", body.toString(), null)
    val newToken = login.optString("access_token").takeIf { it.isNotBlank() }
      ?: throw IllegalStateException("Sign-in failed")
    val expiry = login.optLong("expires_in", 0L)
    if (expiry < 60L) throw IllegalStateException("Sign-in expired")
    token = newToken
    expiresAtMs = System.currentTimeMillis() + expiry * 1000L
    try {
      val status = request("/functions/v1/whoop-mcp/status", "GET", null, newToken)
      if (!status.optBoolean("connected", false)) {
        signOut()
        return false
      }
      return true
    } catch (error: Exception) {
      signOut()
      throw error
    }
  }

  fun currentToken(): String? =
    token?.takeIf { System.currentTimeMillis() < expiresAtMs - 30_000L }

  fun signOut() {
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
