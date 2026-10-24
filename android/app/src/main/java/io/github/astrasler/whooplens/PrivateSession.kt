package io.github.astrasler.whooplens

import android.net.Uri
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom

/** Public native OAuth client. Tokens and PKCE state live in memory only. */
internal class PrivateSession {
  companion object {
    const val ISSUER = "https://auth.whooplens.tech"
    const val RESOURCE = "https://whooplens.tech/mcp"
    const val REDIRECT = "io.github.astrasler.whooplens:/oauth/callback"
  }
  private val lock = Any()
  private var revision = 0L
  private var token: String? = null
  private var expiresAtMs = 0L
  private var verifier: String? = null
  private var state: String? = null
  private var clientId: String? = null
  private var tokenEndpoint: String? = null

  fun beginSignIn(): Long = synchronized(lock) {
    revision++
    token = null
    expiresAtMs = 0L
    verifier = null
    state = null
    revision
  }

  fun authorizationUrl(attempt: Long): String {
    val metadata = requestJson("$ISSUER/.well-known/oauth-authorization-server")
    val registration = trustedEndpoint(metadata.getString("registration_endpoint"))
    val authorize = trustedEndpoint(metadata.getString("authorization_endpoint"))
    val tokenUrl = trustedEndpoint(metadata.getString("token_endpoint"))
    val client = postFormlessJson(registration, JSONObject()
      .put("client_name", "WHOOP Lens Android Companion")
      .put("redirect_uris", JSONArray().put(REDIRECT))
      .put("grant_types", JSONArray().put("authorization_code"))
      .put("response_types", JSONArray().put("code"))
      .put("token_endpoint_auth_method", "none"))
    val id = client.getString("client_id").takeIf { it.length in 1..512 }
      ?: error("Invalid OAuth client registration")
    val secret = randomUrlSafe()
    val nonce = randomUrlSafe()
    val challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256")
      .digest(secret.toByteArray(StandardCharsets.US_ASCII)), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    synchronized(lock) {
      check(attempt == revision) { "Sign-in cancelled" }
      clientId = id
      tokenEndpoint = tokenUrl
      verifier = secret
      state = nonce
    }
    return Uri.parse(authorize).buildUpon()
      .appendQueryParameter("response_type", "code")
      .appendQueryParameter("client_id", id)
      .appendQueryParameter("redirect_uri", REDIRECT)
      .appendQueryParameter("scope", "mcp:read")
      .appendQueryParameter("resource", RESOURCE)
      .appendQueryParameter("state", nonce)
      .appendQueryParameter("code_challenge", challenge)
      .appendQueryParameter("code_challenge_method", "S256")
      .build().toString()
  }

  fun completeSignIn(callback: Uri, attempt: Long): Boolean {
    if (callback.scheme != "io.github.astrasler.whooplens" ||
      callback.path != "/oauth/callback" || callback.host != null ||
      callback.getQueryParameters("state").size != 1 ||
      callback.getQueryParameters("code").size != 1 || callback.getQueryParameter("error") != null) return false
    val values = synchronized(lock) {
      if (attempt != revision || state == null || state != callback.getQueryParameter("state")) return false
      val result = Triple(clientId ?: return false, verifier ?: return false, tokenEndpoint ?: return false)
      state = null // one-time callback, including failed exchanges
      verifier = null
      result
    }
    val response = postForm(values.third, listOf(
      "grant_type" to "authorization_code", "code" to (callback.getQueryParameter("code") ?: return false),
      "redirect_uri" to REDIRECT, "client_id" to values.first,
      "code_verifier" to values.second, "resource" to RESOURCE))
    val access = response.optString("access_token").takeIf { it.isNotBlank() } ?: return false
    val seconds = response.optLong("expires_in")
    if (seconds !in 60..86400) return false
    return synchronized(lock) {
      if (attempt != revision) false else {
        token = access
        expiresAtMs = System.currentTimeMillis() + seconds * 1000L
        true
      }
    }
  }

  fun currentToken(): String? = synchronized(lock) {
    token?.takeIf { System.currentTimeMillis() < expiresAtMs - 30_000L }
  }
  fun signOut() = synchronized(lock) {
    revision++
    token = null
    expiresAtMs = 0L
    state = null
    verifier = null
    clientId = null
    tokenEndpoint = null
  }
  private fun randomUrlSafe(): String = ByteArray(32).also { SecureRandom().nextBytes(it) }
    .let { Base64.encodeToString(it, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) }
  private fun trustedEndpoint(value: String): String {
    val uri = Uri.parse(value)
    require(uri.scheme == "https" && uri.host == "auth.whooplens.tech" && uri.port == -1 &&
      uri.userInfo == null && uri.fragment == null) { "Untrusted OAuth endpoint" }
    return value
  }
  private fun requestJson(url: String): JSONObject = exchange(url, "GET", null, null)
  private fun postFormlessJson(url: String, body: JSONObject): JSONObject =
    exchange(url, "POST", "application/json", body.toString())
  private fun postForm(url: String, values: List<Pair<String, String>>): JSONObject =
    exchange(url, "POST", "application/x-www-form-urlencoded",
      values.joinToString("&") { Uri.encode(it.first) + "=" + Uri.encode(it.second) })
  private fun exchange(url: String, method: String, contentType: String?, body: String?): JSONObject {
    val connection = URL(trustedEndpoint(url)).openConnection() as HttpURLConnection
    try {
      connection.requestMethod = method
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 15000
      connection.readTimeout = 20000
      connection.setRequestProperty("Accept", "application/json")
      if (body != null) {
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", contentType)
        connection.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
      }
      if (connection.responseCode !in 200..299) error("OAuth service unavailable")
      val text = connection.inputStream.bufferedReader().use { it.readText() }
      require(text.length <= 100000) { "Unexpected OAuth response" }
      return JSONObject(text)
    } finally { connection.disconnect() }
  }
}
