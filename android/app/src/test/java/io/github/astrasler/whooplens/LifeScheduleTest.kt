package io.github.astrasler.whooplens

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LifeScheduleTest {
    private val account = "a".repeat(43)
    private fun session(): PrivateSession {
        val storage = MemorySessionStorage()
        storage.write(JSONObject().put("version", 1).put("issuer", PrivateSession.ISSUER)
            .put("resource", PrivateSession.RESOURCE).put("account", account).put("client", "synthetic-client")
            .put("endpoint", "https://auth.whooplens.tech/token").put("revoke", "https://auth.whooplens.tech/revoke")
            .put("access", "synthetic-access").put("refresh", "synthetic-refresh")
            .put("expires", 9_000_000_000_000L).put("refreshAt", 9_000_000_000_000L).put("pendingUntil", 0).toString())
        return PrivateSession(null, { 1000L }, storage)
    }
    @Test fun defaultIsNeverAnAutomaticWrite() {
        for (value in listOf(null, "", "inferred", "FIXED")) assertEquals(LifeSchedule.UNPREDICTABLE, LifeSchedule.effective(value))
        var methods = mutableListOf<String>()
        val client = LifeScheduleClient(session(), account) { method, _, body ->
            methods.add(method); assertNull(body)
            200 to """{"life_schedule":"invalid","explicit":true}"""
        }
        assertEquals(LifeSchedule.UNPREDICTABLE, client.read()!!.selection)
        assertFalse(client.read()!!.explicit)
        assertTrue(methods.all { it == "GET" })
    }
    @Test fun onlyConfirmedSelectionsSendAuthenticatedWrites() {
        for (selection in LifeSchedule.entries) {
            var writes = 0
            val client = LifeScheduleClient(session(), account) { method, auth, body ->
                assertEquals("PUT", method); assertEquals("Bearer synthetic-access", auth)
                val json = JSONObject(body!!)
                assertEquals(selection.value, json.getString("life_schedule"))
                assertEquals("user_selected_life_schedule", json.getString("confirmation"))
                assertFalse(json.has("user_id")); writes++
                200 to JSONObject().put("life_schedule", selection.value).put("explicit", true).toString()
            }
            assertThrows(IllegalArgumentException::class.java) { client.select(selection, false) }
            assertEquals(0, writes)
            assertEquals(selection, client.select(selection, true)!!.selection)
            assertEquals(1, writes)
        }
    }
    @Test fun errorsAndOtherAccountsCannotExposeSelections() {
        for (status in listOf(401,403,500,503)) {
            val client = LifeScheduleClient(session(), account) { _, _, _ -> status to """{"life_schedule":"fixed"}""" }
            assertNull(client.read())
        }
        var called = false
        assertThrows(IllegalStateException::class.java) {
            LifeScheduleClient(session(), "b".repeat(43)) { _, _, _ -> called=true;200 to "{}" }.read()
        }
        assertFalse(called)
    }
    @Test fun lateResponseAfterSignoutIsDiscarded() {
        val session = session()
        val client = LifeScheduleClient(session, account) { _, _, _ ->
            session.beginSignIn()
            200 to """{"life_schedule":"fixed","explicit":true}"""
        }
        assertNull(client.read())
    }
}
