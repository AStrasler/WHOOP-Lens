package io.github.astrasler.whooplens

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import java.util.concurrent.Callable
import java.util.concurrent.Executors

class PersistentSessionTest {
  private class Blob : CredentialBlob {
    var bytes: ByteArray? = null
    var failWrite = false
    override fun read(): ByteArray? = bytes?.clone()
    override fun writeAtomically(value: ByteArray) {
      if (failWrite) throw IllegalStateException("Synthetic disk failure")
      bytes = value.clone()
    }
    override fun clear() { bytes = null }
  }
  private class Keys : CredentialKeys {
    var key: SecretKey? = null
    override fun get(create: Boolean): SecretKey {
      if (key == null && create) key = javax.crypto.KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
      return key ?: error("Missing synthetic key")
    }
    override fun clear() { key = null }
  }
  private fun form(text: String): Map<String, String> = text.split("&").associate {
    val p = it.split("=", limit = 2)
    URLDecoder.decode(p[0], "UTF-8") to URLDecoder.decode(p[1], "UTF-8")
  }
  private class Fixture {
    val blob = Blob()
    val keys = Keys()
    val store = EncryptedSessionStorage(blob, keys)
    var time = 1000000L
    var refreshes = 0
    var revocations = 0
    var registrations = 0
    var lastRefresh = emptyMap<String, String>()
    var failure: Boolean? = null
    var afterRefresh: () -> Unit = {}
    val transport: (String, String, String?, String?) -> JSONObject = { url, _, _, body ->
      when {
        url.endsWith("oauth-authorization-server") -> JSONObject()
          .put("issuer", PrivateSession.ISSUER)
          .put("registration_endpoint", PrivateSession.ISSUER + "/register")
          .put("authorization_endpoint", PrivateSession.ISSUER + "/authorize")
          .put("token_endpoint", PrivateSession.ISSUER + "/token")
          .put("revocation_endpoint", PrivateSession.ISSUER + "/revoke")
        url.endsWith("/register") -> {
          registrations++
          assertTrue(JSONObject(body!!).getJSONArray("grant_types").toString().contains("refresh_token"))
          JSONObject().put("client_id", "client-$registrations")
        }
        url.endsWith("/revoke") -> { revocations++; JSONObject() }
        else -> {
          val fields = body!!.split("&").associate {
            val p = it.split("=", limit = 2)
            URLDecoder.decode(p[0], "UTF-8") to URLDecoder.decode(p[1], "UTF-8")
          }
          val client = fields.getValue("client_id")
          if (fields["grant_type"] == "refresh_token") {
            refreshes++
            lastRefresh = fields
            failure?.let { throw OAuthRequestFailed(it) }
            afterRefresh()
          }
          JSONObject().put("access_token", "access-$client-$refreshes").put("refresh_token", "refresh-$client-$refreshes")
            .put("token_type", "Bearer").put("expires_in", 3600)
        }
      }
    }
    fun process(): PrivateSession = PrivateSession(transport, { time }, store)
  }
  private fun signIn(s: PrivateSession) {
    val attempt = s.beginSignIn()
    val query = form(URI(s.authorizationUrl(attempt)).rawQuery)
    assertEquals("mcp:read offline_access", query["scope"])
    assertTrue(s.completeSignIn(PrivateSession.REDIRECT + "?code=synthetic&state=" + query["state"], attempt))
  }

  @Test fun restartRestoresEncryptedSessionWithoutNetwork() {
    val f = Fixture()
    val first = f.process()
    signIn(first)
    val disk = f.blob.bytes!!
    assertFalse(disk.toString(Charsets.UTF_8).contains("refresh-client"))
    assertFalse(disk.toString(Charsets.UTF_8).contains("access-client"))
    val restarted = f.process()
    assertEquals(first.currentToken(), restarted.accessToken())
    assertEquals(0, f.refreshes)
  }
  @Test fun upgradingExistingCredentialFormatPreservesTheSession() {
    val f = Fixture()
    signIn(f.process())
    val older = JSONObject(f.store.read()!!)
    older.remove("refreshAt")
    f.store.write(older.toString())
    assertEquals("access-client-1-0", f.process().currentToken())
    assertEquals(3540000L, f.process().nextRefreshDelayMs())
  }
  @Test fun expiredAccessRotatesAndPersistsWholePair() {
    val f = Fixture()
    signIn(f.process())
    f.time += 3600000
    val restarted = f.process()
    assertEquals("access-client-1-1", restarted.accessToken())
    assertEquals("refresh-client-1-0", f.lastRefresh["refresh_token"])
    assertEquals(PrivateSession.RESOURCE, f.lastRefresh["resource"])
    assertEquals("access-client-1-1", f.process().currentToken())
    f.time += 3600000
    assertEquals("access-client-1-2", f.process().accessToken())
    assertEquals("refresh-client-1-1", f.lastRefresh["refresh_token"])
  }
  @Test fun accountGenerationChangesOnAccountSwitchButNotRefresh() {
    val f = Fixture()
    val session = f.process()
    signIn(session)
    val first = session.sessionGeneration()
    f.time += 3600000
    assertNotNull(session.accessToken())
    assertEquals(first, session.sessionGeneration())
    signIn(session)
    assertTrue(session.sessionGeneration() > first)
  }
  @Test fun refreshSchedulingUsesExpiryAndStopsForSignedOutOrPendingSessions() {
    val f = Fixture()
    val session = f.process()
    assertNull(session.nextRefreshDelayMs())
    session.authorizationUrl(session.beginSignIn())
    assertNull(session.nextRefreshDelayMs())
    signIn(session)
    assertEquals(3540000L, session.nextRefreshDelayMs())
    repeat(10) { assertNotNull(session.accessToken()) }
    assertEquals(0, f.refreshes)
    f.time += 3600000
    f.failure = false
    assertNull(session.accessToken())
    assertTrue(session.hasStoredSession())
    assertEquals(30000L, session.nextRefreshDelayMs())
    session.signOut()
    assertFalse(session.hasStoredSession())
    assertNull(session.nextRefreshDelayMs())
  }
  @Test fun pendingPkceSurvivesRestartButConsumedStateCannotReplay() {
    val f = Fixture()
    val first = f.process()
    val attempt = first.beginSignIn()
    val query = form(URI(first.authorizationUrl(attempt)).rawQuery)
    val callback = PrivateSession.REDIRECT + "?code=synthetic&state=" + query["state"]
    val restarted = f.process()
    assertTrue(restarted.completeSignIn(callback, restarted.pendingAttempt()!!))
    assertFalse(f.process().completeSignIn(callback, 0))
  }
  @Test fun invalidRefreshClearsStoredCredentials() {
    val f = Fixture()
    signIn(f.process())
    f.time += 3600000
    f.failure = true
    assertNull(f.process().accessToken())
    assertNull(f.blob.bytes)
    assertNull(f.keys.key)
    assertNull(f.process().currentToken())
  }
  @Test fun transientRefreshKeepsEncryptedCredentialsAndUsesBoundedBackoff() {
    val f = Fixture()
    signIn(f.process())
    f.time += 3600000
    val session = f.process()
    f.failure = false
    assertNull(session.accessToken())
    assertNotNull(f.blob.bytes)
    f.failure = null
    assertNull(session.accessToken())
    assertEquals(1, f.refreshes)
    f.time += 30001
    assertEquals("access-client-1-2", session.accessToken())
  }
  @Test fun corruptCiphertextAndWrongBindingFailClosed() {
    val f = Fixture()
    signIn(f.process())
    val bytes = f.blob.bytes!!
    bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
    assertNull(f.process().currentToken())
    assertNull(f.blob.bytes)
    signIn(f.process())
    val other = EncryptedSessionStorage(f.blob, f.keys, "different-app-or-resource")
    assertThrows(Exception::class.java) { other.read() }
  }
  @Test fun signOutErasesBeforeRevokingAndCannotRestore() {
    val f = Fixture()
    val session = f.process()
    signIn(session)
    val revoke = session.clearForSignOut()
    assertNull(f.blob.bytes)
    assertNull(f.keys.key)
    assertNull(f.process().currentToken())
    assertTrue(revoke())
    assertEquals(1, f.revocations)
  }
  @Test fun signOutDuringRefreshCannotResurrectSession() {
    val f = Fixture()
    val session = f.process()
    signIn(session)
    f.time += 3600000
    f.afterRefresh = { session.signOut() }
    assertNull(session.accessToken())
    assertNull(f.process().currentToken())
    assertNull(f.blob.bytes)
  }
  @Test fun offlineRevocationStillErasesLocalCredentials() {
    val f = Fixture()
    val offline = PrivateSession({ url, method, type, body ->
      if (url.endsWith("/revoke")) throw OAuthRequestFailed(false)
      f.transport(url, method, type, body)
    }, { f.time }, f.store)
    signIn(offline)
    assertFalse(offline.signOut())
    assertNull(f.blob.bytes)
    assertNull(f.keys.key)
    assertNull(f.process().currentToken())
  }
  @Test fun switchingAccountRejectsLatePreviousAccountRefresh() {
    val f = Fixture()
    val session = f.process()
    signIn(session)
    f.time += 3600000
    f.afterRefresh = { signIn(session) }
    assertNull(session.accessToken())
    assertEquals("access-client-2-1", session.currentToken())
    assertEquals("access-client-2-1", f.process().currentToken())
  }
  @Test fun failedRotationStorageCommitNeverPublishesNewTokens() {
    val f = Fixture()
    val session = f.process()
    signIn(session)
    f.time += 3600000
    f.blob.failWrite = true
    assertNull(session.accessToken())
    assertNull(session.currentToken())
    assertNull(f.process().currentToken())
  }
  @Test fun concurrentRequestsUseSingleRefresh() {
    val f = Fixture()
    val session = f.process()
    signIn(session)
    f.time += 3600000
    f.afterRefresh = { Thread.sleep(40) }
    val pool = Executors.newFixedThreadPool(2)
    try {
      val results = pool.invokeAll(listOf(Callable { session.accessToken() }, Callable { session.accessToken() }))
      assertEquals(listOf("access-client-1-1", "access-client-1-1"), results.map { it.get() })
      assertEquals(1, f.refreshes)
    } finally { pool.shutdownNow() }
  }
  @Test fun encryptionRandomizesIvAndAtomicWriteFailureKeepsPreviousCiphertext() {
    val f = Fixture()
    f.store.write("synthetic credential")
    val original = f.blob.bytes!!.clone()
    f.blob.failWrite = true
    assertThrows(Exception::class.java) { f.store.write("replacement") }
    assertArrayEquals(original, f.blob.bytes)
    assertEquals("synthetic credential", f.store.read())
    f.blob.failWrite = false
    f.store.write("synthetic credential")
    assertFalse(original.contentEquals(f.blob.bytes!!))
  }
}
