package io.github.astrasler.whooplens

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WhoopReadClientTest {
    @Test
    fun callOpensTheTrustedResourceEndpoint() {
        val account = "a".repeat(43)
        val session = session(account)
        var opened: URL? = null
        val connection = RecordingConnection(URL("https://whooplens.tech/mcp"))
        val result =
            WhoopReadClient(session, account, openConnection = {
                opened = it
                connection
            }).call("get_recovery", JSONObject())

        assertEquals(PrivateSession.RESOURCE, opened?.toString())
        assertTrue(connection.requestBody.toString(Charsets.UTF_8).contains("\"name\":\"get_recovery\""))
        assertEquals("{}", result.toString())
    }

    private fun session(account: String): PrivateSession {
        val storage = MemorySessionStorage()
        storage.write(
            JSONObject()
                .put("version", 1)
                .put("issuer", PrivateSession.ISSUER)
                .put("resource", PrivateSession.RESOURCE)
                .put("account", account)
                .put("client", "synthetic-client")
                .put("endpoint", "https://auth.whooplens.tech/token")
                .put("revoke", "https://auth.whooplens.tech/revoke")
                .put("access", "synthetic-access-token")
                .put("refresh", "synthetic-refresh-token")
                .put("expires", 9_000_000_000_000L)
                .put("refreshAt", 9_000_000_000_000L)
                .put("pendingUntil", 0)
                .toString(),
        )
        return PrivateSession(null, { 1_000L }, storage)
    }

    private class RecordingConnection(url: URL) : HttpURLConnection(url) {
        val requestBody = ByteArrayOutputStream()

        override fun connect() = Unit
        override fun disconnect() = Unit
        override fun usingProxy() = false
        override fun getResponseCode() = 200
        override fun getInputStream() = ByteArrayInputStream("{}".toByteArray())
        override fun getOutputStream() = requestBody
    }
}
