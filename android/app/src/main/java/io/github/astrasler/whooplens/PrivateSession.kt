package io.github.astrasler.whooplens

import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.net.URLDecoder
import java.net.HttpURLConnection
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/** Production state is Keystore-encrypted. Error messages exclude credentials and upstream bodies. */
internal class PrivateSession(
  private val transport: ((String, String, String?, String?) -> JSONObject)? = null,
  private val now: () -> Long = System::currentTimeMillis,
  private val storage: SessionStorage = MemorySessionStorage()
) {
  companion object {
    const val ISSUER = "https://auth.whooplens.tech"
    const val RESOURCE = "https://whooplens.tech/mcp"
    const val REDIRECT = "https://whooplens.tech/android/oauth/callback"
  }
  private data class Saved(
    val account: String, val client: String, val endpoint: String, val revoke: String?,
    val access: String? = null, val refresh: String? = null, val expires: Long = 0,
    val nonce: String? = null, val verifier: String? = null, val pendingUntil: Long = 0, val refreshAt: Long = 0
  ) { override fun toString(): String = "OAuth credentials [redacted]" }
  private val lock = Any()
  private val refreshLock = Any()
  private var revision = 0L
  private var saved: Saved? = null
  private var loaded = false
  private var retryAfterMs = 0L
  private fun encode(v: Saved): String = JSONObject().put("version", 1).put("issuer", ISSUER).put("resource", RESOURCE)
    .put("account", v.account).put("client", v.client).put("endpoint", v.endpoint).put("revoke", v.revoke)
    .put("access", v.access).put("refresh", v.refresh).put("expires", v.expires)
    .put("nonce", v.nonce).put("verifier", v.verifier).put("pendingUntil", v.pendingUntil).put("refreshAt", v.refreshAt).toString()
  private fun loadLocked() {
    if (loaded) return
    loaded = true
    try {
      val json = JSONObject(storage.read() ?: return)
      require(json.getInt("version") == 1 && json.getString("issuer") == ISSUER && json.getString("resource") == RESOURCE)
      fun optional(key: String): String? = if (json.isNull(key) || !json.has(key)) null else json.getString(key)
      val r = Saved(json.getString("account"), json.getString("client"), trustedEndpoint(json.getString("endpoint")),
        optional("revoke")?.let { trustedEndpoint(it) }, optional("access"), optional("refresh"), json.getLong("expires"),
        optional("nonce"), optional("verifier"), json.getLong("pendingUntil"),
        if (json.has("refreshAt")) json.getLong("refreshAt") else json.getLong("expires") - 60000)
      require(r.account.matches(Regex("[A-Za-z0-9_-]{43}")) && r.client.length in 1..512)
      require(r.access == null || r.access.length in 1..16384)
      require(r.refresh == null || r.refresh.length in 1..16384)
      require((r.access != null && r.refresh != null && r.expires > 0) ||
        (r.nonce != null && r.verifier != null && r.pendingUntil > now()))
      saved = r
    } catch (_: Exception) { clearLocked() }
  }
  private fun saveLocked(record: Saved) {
    storage.write(encode(record)) // Commit the complete pair before publishing either token in memory.
    saved = record
  }
  private fun clearLocked() {
    revision++
    saved = null
    loaded = true
    retryAfterMs = 0
    storage.clear()
  }
  fun beginSignIn(): Long = synchronized(lock) { clearLocked(); revision }
  fun pendingAttempt(): Long? = synchronized(lock) {
    loadLocked()
    revision.takeIf { saved?.nonce != null && (saved?.pendingUntil ?: 0) > now() }
  }
  fun authorizationUrl(attempt: Long): String {
    val metadata = exchange("$ISSUER/.well-known/oauth-authorization-server", "GET", null, null)
    require(metadata.optString("issuer", ISSUER) == ISSUER) { "Invalid OAuth metadata" }
    val registration = trustedEndpoint(metadata.getString("registration_endpoint"))
    val authorize = trustedEndpoint(metadata.getString("authorization_endpoint"))
    val endpoint = trustedEndpoint(metadata.getString("token_endpoint"))
    val revoke = metadata.optString("revocation_endpoint").takeIf { it.isNotBlank() }?.let { trustedEndpoint(it) }
    val client = exchange(registration, "POST", "application/json", JSONObject()
      .put("client_name", "WhoopLens Android Companion").put("redirect_uris", JSONArray().put(REDIRECT))
      .put("grant_types", JSONArray().put("authorization_code").put("refresh_token"))
      .put("response_types", JSONArray().put("code")).put("token_endpoint_auth_method", "none").toString())
    val id = client.getString("client_id").takeIf { it.length in 1..512 } ?: error("Invalid OAuth registration")
    val verifier = randomUrlSafe()
    val nonce = randomUrlSafe()
    val challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(
      MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
    synchronized(lock) {
      check(attempt == revision) { "Sign-in cancelled" }
      saveLocked(Saved(randomUrlSafe(), id, endpoint, revoke, nonce = nonce, verifier = verifier, pendingUntil = now() + 600000))
    }
    return authorize + (if (URI(authorize).rawQuery == null) "?" else "&") + encodeForm(listOf(
      "response_type" to "code", "client_id" to id, "redirect_uri" to REDIRECT,
      "scope" to "mcp:read offline_access", "resource" to RESOURCE, "state" to nonce,
      "code_challenge" to challenge, "code_challenge_method" to "S256"))
  }
  fun completeSignIn(callback: String, attempt: Long): Boolean {
    val uri = try { URI(callback) } catch (_: Exception) { return false }
    if (uri.scheme != "https" || uri.host != "whooplens.tech" || uri.port != -1 ||
      uri.rawUserInfo != null || uri.rawFragment != null || uri.rawPath != "/android/oauth/callback") return false
    val query = try {
      (uri.rawQuery ?: return false).split("&").map {
        val pair = it.split("=", limit = 2)
        URLDecoder.decode(pair[0], "UTF-8") to URLDecoder.decode(pair.getOrElse(1) { "" }, "UTF-8")
      }.groupBy({ it.first }, { it.second })
    } catch (_: Exception) { return false }
    val code = query["code"]?.singleOrNull()?.takeIf { it.isNotBlank() && it.length <= 4096 } ?: return false
    val nonce = query["state"]?.singleOrNull() ?: return false
    if (query.containsKey("error") || (query.containsKey("iss") && query["iss"] != listOf(ISSUER))) return false
    val pending = synchronized(lock) {
      loadLocked()
      val r = saved ?: return false
      if (attempt != revision || r.nonce != nonce || r.verifier == null || r.pendingUntil <= now()) return false
      saved = null
      storage.clear() // Durable one-time consumption, including a failed exchange or process death.
      r
    }
    val response = try { postForm(pending.endpoint, listOf("grant_type" to "authorization_code", "code" to code,
      "redirect_uri" to REDIRECT, "client_id" to pending.client, "code_verifier" to pending.verifier!!, "resource" to RESOURCE))
    } catch (_: Exception) { return false }
    val record = tokenRecord(response, pending) ?: return false
    return synchronized(lock) {
      if (attempt != revision) false else try { saveLocked(record); true }
      catch (_: Exception) { clearLocked(); false }
    }
  }
  private fun tokenRecord(response: JSONObject, previous: Saved): Saved? {
    val access = (response.opt("access_token") as? String)?.takeIf { it.isNotBlank() && it.length <= 16384 } ?: return null
    val refresh = (response.opt("refresh_token") as? String)?.takeIf { it.isNotBlank() && it.length <= 16384 } ?: return null
    val seconds = (response.opt("expires_in") as? Int)?.toLong() ?: return null
    if (seconds !in 60..86400 || !response.optString("token_type").equals("Bearer", true)) return null
    val issued = now()
    val lifetime = seconds * 1000
    return previous.copy(access = access, refresh = refresh, expires = issued + lifetime,
      nonce = null, verifier = null, pendingUntil = 0, refreshAt = issued + lifetime - minOf(60000, lifetime / 10))
  }
  fun currentToken(): String? = synchronized(lock) {
    loadLocked()
    saved?.takeIf { now() < it.refreshAt }?.access
  }
  fun hasStoredSession(): Boolean = synchronized(lock) { loadLocked(); saved?.refresh != null }
  /** Opaque local grant identity, not a WHOOP user ID or credential. */
  fun accountKey(): String? = synchronized(lock) { loadLocked(); saved?.takeIf { it.refresh != null }?.account }
  fun sessionGeneration(): Long = synchronized(lock) { loadLocked(); revision }
  fun nextRefreshDelayMs(): Long? = synchronized(lock) {
    loadLocked()
    val record = saved ?: return null
    if (record.refresh == null) return null
    maxOf(record.refreshAt - now(), retryAfterMs - now(), 1000L)
  }
  /** Off the UI thread: single-flight refresh and an account/generation-checked atomic commit. */
  fun accessToken(): String? = synchronized(refreshLock) {
    val version: Long
    val previous: Saved
    synchronized(lock) {
      loadLocked()
      previous = saved ?: return null
      previous.access?.takeIf { now() < previous.refreshAt }?.let { return it }
      if (previous.refresh == null || now() < retryAfterMs) return null
      version = revision
    }
    val response = try { postForm(previous.endpoint, listOf("grant_type" to "refresh_token", "refresh_token" to previous.refresh!!,
      "client_id" to previous.client, "resource" to RESOURCE))
    } catch (error: OAuthRequestFailed) {
      synchronized(lock) {
        if (version == revision && saved?.account == previous.account) {
          if (error.terminal) clearLocked() else retryAfterMs = now() + 30000
        }
      }
      return null
    } catch (_: Exception) {
      synchronized(lock) { if (version == revision) retryAfterMs = now() + 30000 }
      return null
    }
    val rotated = tokenRecord(response, previous)
    synchronized(lock) {
      if (version != revision || saved?.account != previous.account) return null
      if (rotated == null) { clearLocked(); return null }
      try { saveLocked(rotated) } catch (_: Exception) { clearLocked(); return null }
      retryAfterMs = 0
      rotated.access
    }
  }
  /** Erase locally now; invoke the returned revocation task on a background thread. */
  fun clearForSignOut(): () -> Boolean {
    val previous = synchronized(lock) { loadLocked(); val old = saved; clearLocked(); old }
    return {
      if (previous?.revoke == null || previous.refresh == null) false
      else try { postForm(previous.revoke, listOf("token" to previous.refresh, "token_type_hint" to "refresh_token", "client_id" to previous.client)); true }
      catch (_: Exception) { false }
    }
  }
  fun signOut(): Boolean = clearForSignOut().invoke()
  private fun randomUrlSafe(): String = ByteArray(32).also { SecureRandom().nextBytes(it) }
    .let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
  private fun trustedEndpoint(value: String): String {
    val uri = URI(value)
    require(uri.scheme == "https" && uri.host == "auth.whooplens.tech" && uri.port == -1 &&
      uri.rawUserInfo == null && uri.rawFragment == null) { "Untrusted OAuth endpoint" }
    return value
  }
  private fun encodeForm(values: List<Pair<String, String>>): String = values.joinToString("&") {
    URLEncoder.encode(it.first, "UTF-8") + "=" + URLEncoder.encode(it.second, "UTF-8")
  }
  private fun postForm(url: String, values: List<Pair<String, String>>): JSONObject =
    exchange(url, "POST", "application/x-www-form-urlencoded", encodeForm(values))
  private fun exchange(url: String, method: String, contentType: String?, body: String?): JSONObject {
    trustedEndpoint(url)
    transport?.let { return it(url, method, contentType, body) }
    val connection = URL(url).openConnection() as HttpURLConnection
    try {
      connection.requestMethod = method
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 15000
      connection.readTimeout = 20000
      connection.setRequestProperty("Accept", "application/json")
      if (body != null) {
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", contentType)
        connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      }
      val status = connection.responseCode
      if (status !in 200..299) {
        val text = connection.errorStream?.use { it.readNBytes(16385).toString(Charsets.UTF_8) }.orEmpty()
        val category = try { JSONObject(text).optString("error") } catch (_: Exception) { "" }
        throw OAuthRequestFailed(status == 401 || status == 403 || category in setOf("invalid_grant", "invalid_client", "unauthorized_client", "access_denied"))
      }
      val bytes = connection.inputStream.use { it.readNBytes(100001) }
      require(bytes.size <= 100000) { "Unexpected OAuth response" }
      val text = bytes.toString(Charsets.UTF_8)
      return if (text.isBlank()) JSONObject() else JSONObject(text)
    } catch (error: OAuthRequestFailed) { throw error }
    catch (_: Exception) { throw OAuthRequestFailed(false) }
    finally { connection.disconnect() }
  }
}
internal class OAuthRequestFailed(val terminal: Boolean) : Exception("OAuth request unavailable")
