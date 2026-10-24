package io.github.astrasler.whooplens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.util.Base64

class PrivateSessionTest {
  private fun parameters(value: String): Map<String, String> = value.split("&").associate {
    val parts = it.split("=", limit = 2)
    URLDecoder.decode(parts[0], "UTF-8") to URLDecoder.decode(parts[1], "UTF-8")
  }

  private class Fixture {
    var time = 1000L
    var exchanges = 0
    var tokenBody = JSONObject("""{"access_token":"synthetic-token","refresh_token":"synthetic-refresh","token_type":"Bearer","expires_in":3600}""")
    var exchanged = emptyMap<String, String>()
    var duringExchange: () -> Unit = {}
    var metadataHost = PrivateSession.ISSUER
    val session = PrivateSession({ url, _, _, body ->
      when {
        url.endsWith("oauth-authorization-server") -> JSONObject()
          .put("registration_endpoint", "$metadataHost/register")
          .put("authorization_endpoint", "$metadataHost/authorize")
          .put("token_endpoint", "$metadataHost/token")
        url.endsWith("/register") -> {
          val registered = JSONObject(body!!)
          assertEquals(PrivateSession.REDIRECT, registered.getJSONArray("redirect_uris").getString(0))
          assertEquals("none", registered.getString("token_endpoint_auth_method"))
          JSONObject().put("client_id", "synthetic-client")
        }
        else -> {
          exchanges++
          exchanged = body!!.split("&").associate {
            val pair = it.split("=", limit = 2)
            URLDecoder.decode(pair[0], "UTF-8") to URLDecoder.decode(pair[1], "UTF-8")
          }
          duringExchange()
          tokenBody
        }
      }
    }, { time })
  }

  @Test fun pkceExchangeReplayExpiryAndSignOut() {
    val f = Fixture()
    val attempt = f.session.beginSignIn()
    val query = parameters(URI(f.session.authorizationUrl(attempt)).rawQuery)
    assertEquals("S256", query["code_challenge_method"])
    val callback = PrivateSession.REDIRECT + "?code=synthetic-code&state=" + query["state"]
    assertTrue(f.session.completeSignIn(callback, attempt))
    assertEquals("synthetic-token", f.session.currentToken())
    val verifier = f.exchanged.getValue("code_verifier")
    assertTrue(verifier.length in 43..128)
    val challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(
      MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
    assertEquals(query["code_challenge"], challenge)
    assertEquals(PrivateSession.REDIRECT, f.exchanged["redirect_uri"])
    assertEquals(PrivateSession.RESOURCE, f.exchanged["resource"])
    assertFalse(f.session.completeSignIn(callback, attempt))
    assertEquals(1, f.exchanges)
    f.time += 3600_000L
    assertNull(f.session.currentToken())
    f.session.signOut()
    assertNull(f.session.currentToken())
  }

  @Test fun invalidCallbacksNeverExchangeCodes() {
    val f = Fixture()
    val attempt = f.session.beginSignIn()
    val state = parameters(URI(f.session.authorizationUrl(attempt)).rawQuery).getValue("state")
    val valid = PrivateSession.REDIRECT + "?code=synthetic&state=$state"
    for (bad in listOf(
      valid.replace("https:", "http:"), valid.replace("whooplens.tech", "whooplens.tech.evil.invalid"),
      valid.replace("whooplens.tech", "user@whooplens.tech"), valid.replace("whooplens.tech", "whooplens.tech:444"),
      valid + "#fragment", valid + "&state=$state", valid + "&code=another", valid + "&error=denied",
      valid + "&iss=https%3A%2F%2Fevil.invalid", valid.replace("state=$state", "state=wrong"),
      valid.replace("code=synthetic", "code="), valid.replace("/oauth/callback", "/oauth/callback/extra")
    )) assertFalse(bad, f.session.completeSignIn(bad, attempt))
    assertEquals(0, f.exchanges)
    f.session.signOut()
    assertFalse(f.session.completeSignIn(valid, attempt))
    assertEquals(0, f.exchanges)
  }

  @Test fun staleOrMalformedTokenExchangesCannotCreateSessions() {
    for (body in listOf(
      """{"access_token":"synthetic","expires_in":3600}""",
      """{"access_token":123,"token_type":"Bearer","expires_in":3600}""",
      """{"access_token":"synthetic","token_type":"Bearer","expires_in":"3600"}""",
      """{"access_token":"synthetic","token_type":"Bearer","expires_in":-1}"""
    )) {
      val f = Fixture()
      f.tokenBody = JSONObject(body)
      val attempt = f.session.beginSignIn()
      val state = parameters(URI(f.session.authorizationUrl(attempt)).rawQuery).getValue("state")
      val callback = PrivateSession.REDIRECT + "?code=synthetic&state=$state"
      assertFalse(f.session.completeSignIn(callback, attempt))
      assertNull(f.session.currentToken())
      assertFalse(f.session.completeSignIn(callback, attempt))
      assertEquals(1, f.exchanges)
    }
    val f = Fixture()
    val attempt = f.session.beginSignIn()
    val state = parameters(URI(f.session.authorizationUrl(attempt)).rawQuery).getValue("state")
    f.duringExchange = { f.session.signOut() }
    assertFalse(f.session.completeSignIn(PrivateSession.REDIRECT + "?code=synthetic&state=$state", attempt))
    assertNull(f.session.currentToken())
  }

  @Test fun discoveryRejectsUntrustedEndpoints() {
    val f = Fixture()
    f.metadataHost = "https://evil.invalid"
    val attempt = f.session.beginSignIn()
    org.junit.Assert.assertThrows(IllegalArgumentException::class.java) { f.session.authorizationUrl(attempt) }
    assertEquals(0, f.exchanges)
  }

  @Test
  fun testInitialStateHasNoToken() {
    val session = PrivateSession()
    assertNull(session.currentToken())
  }

  @Test
  fun testBeginSignInIncrementsRevisionAndClearsState() {
    val session = PrivateSession()
    val rev1 = session.beginSignIn()
    val rev2 = session.beginSignIn()
    assertTrue(rev2 > rev1)
    assertNull(session.currentToken())
  }

  @Test
  fun testSignOutClearsSession() {
    val session = PrivateSession()
    session.beginSignIn()
    session.signOut()
    assertNull(session.currentToken())
  }

  @Test
  fun testEndpointsMatchDomain() {
    assertEquals("https://auth.whooplens.tech", PrivateSession.ISSUER)
    assertEquals("https://whooplens.tech/mcp", PrivateSession.RESOURCE)
    assertEquals("https://whooplens.tech/android/oauth/callback", PrivateSession.REDIRECT)
  }
}
