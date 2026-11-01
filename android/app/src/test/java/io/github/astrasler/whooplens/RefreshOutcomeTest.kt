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

    @Test
    fun healthConnectFailureNoticesCountButRecordLimitsDoNot() {
        val hc = { notices: List<String> -> DataBatch(DataSource.HEALTH_CONNECT, 0L, notices = notices) }
        // Exact wording HealthDashboard produced before these constants existed.
        assertTrue(hc(listOf("Steps" + HEALTH_READ_FAILED_NOTICE)).readFailed())
        assertEquals("Steps could not be read. Check permission and retry.", "Steps" + HEALTH_READ_FAILED_NOTICE)
        assertTrue(hc(listOf("Sleep" + HEALTH_RECORDS_FAILED_NOTICE)).readFailed())
        assertEquals("Sleep unavailable. Permission may have changed.", "Sleep" + HEALTH_RECORDS_FAILED_NOTICE)
        assertTrue(hc(listOf("Heart-rate baseline" + HEALTH_BASELINE_FAILED_NOTICE)).readFailed())
        assertEquals(
            "Heart-rate baseline unavailable. Check permission and retry.",
            "Heart-rate baseline" + HEALTH_BASELINE_FAILED_NOTICE,
        )
        assertFalse(hc(listOf("Steps: latest 1,000 records shown; more available.")).readFailed())
        assertFalse(hc(listOf("Heart-rate chart shows latest 2,000 samples.")).readFailed())
    }
}
