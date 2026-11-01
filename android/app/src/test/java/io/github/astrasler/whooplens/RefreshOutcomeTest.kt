package io.github.astrasler.whooplens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RefreshOutcomeTest {
    @Test
    fun successfulRefreshIsNotAnError() {
        val outcome = refreshOutcome(online = true, whoopFailed = false, healthFailed = false)
        assertEquals(REFRESH_DONE_MESSAGE, outcome.message)
        assertFalse(outcome.failed)
    }

    @Test
    fun anyFailedSourceShowsTheHandoffErrorText() {
        for ((whoop, health) in listOf(true to false, false to true, true to true)) {
            val outcome = refreshOutcome(online = true, whoopFailed = whoop, healthFailed = health)
            assertEquals("Couldn't load. Your saved data is still shown.", outcome.message)
            assertTrue(outcome.failed)
        }
    }

    @Test
    fun offlineIsReportedAsOfflineNotAsAnError() {
        val outcome = refreshOutcome(online = false, whoopFailed = true, healthFailed = true)
        assertEquals(REFRESH_OFFLINE_MESSAGE, outcome.message)
        assertFalse(outcome.failed)
    }

    @Test
    fun onlyFailedWhoopReadsCountAsReadFailures() {
        val failed = DataBatch(DataSource.WHOOP, 0L, notices = listOf("recovery" + WHOOP_READ_FAILED_NOTICE))
        val partial = DataBatch(DataSource.WHOOP, 0L, notices = listOf("WHOOP history is partial; more records may exist."))
        assertTrue(failed.readFailed())
        assertFalse(partial.readFailed())
        assertFalse(DataBatch(DataSource.WHOOP, 0L).readFailed())
        assertEquals("recovery unavailable. Retry WHOOP reads.", failed.notices.single())
    }
}
