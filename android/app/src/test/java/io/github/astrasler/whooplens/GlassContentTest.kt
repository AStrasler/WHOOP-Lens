package io.github.astrasler.whooplens

import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GlassContentTest {
    private val zone = ZoneId.of("UTC")
    private val now = Instant.parse("2026-10-28T12:00:00Z").toEpochMilli()

    private fun night(day: String, bed: String, wake: String) =
        SleepDetail(
            Instant.parse("${day}T${bed}:00Z").toEpochMilli(),
            Instant.parse("${day}T${wake}:00Z").toEpochMilli(),
            "whoop",
            emptyList(),
            null,
        )

    @Test fun recoveryWordsFollowExistingScoreZones() {
        assertEquals("Not scored", recoveryStatus(null))
        assertEquals("Not scored", recoveryStatus(Double.NaN))
        assertEquals("Well recovered", recoveryStatus(67.0))
        assertEquals("Well recovered", recoveryStatus(100.0))
        assertEquals("Moderate", recoveryStatus(66.9))
        assertEquals("Moderate", recoveryStatus(34.0))
        assertEquals("Low recovery", recoveryStatus(33.9))
        assertEquals("Low recovery", recoveryStatus(0.0))
    }

    @Test fun sleepTimingIgnoresMissingNightsAndNeedsTwoRecords() {
        val one = sleepTiming(listOf(night("2026-10-27", "23:00", "07:00")), now, zone = zone)
        assertEquals(1, one.recorded)
        assertEquals(14, one.window)
        assertNull(one.consistencyPercent)

        val close =
            sleepTiming(
                listOf(
                    night("2026-10-27", "23:00", "07:00"),
                    night("2026-10-26", "23:10", "07:05"),
                ),
                now,
                zone = zone,
            )
        assertEquals(2, close.recorded)
        assertEquals(100, close.consistencyPercent)

        val mixed =
            sleepTiming(
                listOf(
                    night("2026-10-27", "23:00", "07:00"),
                    night("2026-10-26", "23:00", "07:00"),
                    night("2026-10-25", "03:00", "11:00"),
                ),
                now,
                zone = zone,
            )
        assertEquals(3, mixed.recorded)
        assertEquals(67, mixed.consistencyPercent)
    }

    @Test fun baselineDeltaUsesThePersonalMean() {
        val band = Triple(60.0, 65.0, 70.0)
        assertEquals("—", baselineDelta(null, band))
        assertEquals("—", baselineDelta(70.0, null))
        assertEquals("steady", baselineDelta(65.0, band))
        assertEquals("+5", baselineDelta(70.0, band))
        assertEquals("−5", baselineDelta(60.0, band))
    }

    @Test fun strainArcKeepsFivePointsAboveTheApex() {
        assertTrue(strainArcClearance() >= 5f)
        assertTrue(strainArcClearance(viewHeight = 70f) < 0f)
    }

    @Test fun unverifiedPlatformKeepsGlanceHidden() {
        assertFalse(LOCK_SCREEN_PLATFORM_VERIFIED)
        val detailed =
            LockInputs(
                chosen = LockLevel.DETAILED,
                signedInAccount = "a",
                dataAccount = "a",
                deviceSecure = true,
                systemAllowsSensitive = true,
                platformSupported = true,
                newestDataAgeMs = 1_000L,
                detailedConfirmed = true,
                selectedMetrics = listOf("recovery", "strain", "sleep"),
            )
        val forced = effectiveLockContent(detailed)
        assertEquals(LockLevel.HIDDEN, forced.level)
        assertEquals(LockFallback.PLATFORM_UNSUPPORTED, forced.fallback)
        assertTrue(forced.metrics.isEmpty())
        val hidden = effectiveLockContent(detailed.copy(chosen = LockLevel.HIDDEN))
        assertEquals(LockLevel.HIDDEN, hidden.level)
        assertEquals(LockFallback.NONE, hidden.fallback)
    }

    @Test fun blankDataAccountCannotShowGlance() {
        val input =
            LockInputs(
                chosen = LockLevel.SUMMARY,
                signedInAccount = "a",
                dataAccount = " ",
                deviceSecure = true,
                systemAllowsSensitive = true,
                platformSupported = true,
                newestDataAgeMs = 1_000L,
                detailedConfirmed = false,
                selectedMetrics = emptyList(),
            )
        val decision = decideLockContent(input)
        assertEquals(LockLevel.HIDDEN, decision.level)
        assertEquals(LockFallback.MISSING_DATA_ACCOUNT, decision.fallback)
        assertEquals(LockFallback.MISSING_DATA_ACCOUNT, decideLockContent(input.copy(dataAccount = null)).fallback)
    }
}
