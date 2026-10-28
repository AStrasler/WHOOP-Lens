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

    private fun night(day: String, bed: String, wake: String): SleepDetail {
        val start = Instant.parse("${day}T${bed}:00Z").toEpochMilli()
        val sameDayEnd = Instant.parse("${day}T${wake}:00Z").toEpochMilli()
        return SleepDetail(
            start,
            if (sameDayEnd <= start) sameDayEnd + 86400000L else sameDayEnd,
            "whoop",
            emptyList(),
            null,
        )
    }

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

    @Test fun sleepTimingKeepsMidnightNeighborsTogetherRegardlessOfInputOrder() {
        val nights = listOf(
            night("2026-10-27", "23:50", "07:00"),
            night("2026-10-26", "00:10", "07:00"),
        )
        assertEquals(100, sleepTiming(nights, now, zone = zone).consistencyPercent)
        assertEquals(100, sleepTiming(nights.reversed(), now, zone = zone).consistencyPercent)
        val withOutlier = nights + night("2026-10-25", "04:00", "11:00")
        assertEquals(67, sleepTiming(withOutlier, now, zone = zone).consistencyPercent)
    }

    @Test fun sleepTimingAlsoHandlesWakeTimesAcrossMidnightAndDaytimeSleep() {
        val midnightWakes = listOf(
            night("2026-10-27", "16:00", "23:50"),
            night("2026-10-26", "16:10", "00:10"),
        )
        assertEquals(100, sleepTiming(midnightWakes, now, zone = zone).consistencyPercent)
        val daytime = listOf(
            night("2026-10-27", "08:00", "16:00"),
            night("2026-10-26", "08:10", "16:10"),
        )
        assertEquals(100, sleepTiming(daytime, now, zone = zone).consistencyPercent)
    }

    @Test fun heartRateComparisonNeedsHistoricalDaysButKeepsTodaysValue() {
        val history = (1..14).map { day -> Point(now - day * 86400000L, 65.0) } + Point(now, 75.0)
        val today = history.filter { it.time > now - 86400000L }
        val latest = today.last().value
        assertNull(personalBaseline(today, now, zone))
        assertEquals("+9.3", baselineDelta(latest, personalBaseline(history, now, zone)))
        assertEquals("—", baselineDelta(latest, personalBaseline(history.take(3), now, zone)))
    }

    @Test fun strainArcStaysWithinTheUpperSemicircleAtEveryProgress() {
        assertEquals(0f, strainArcSweep(0.0), 0f)
        assertEquals(90f, strainArcSweep(10.5), 0f)
        assertEquals(180f, strainArcSweep(21.0), 0f)
        assertEquals(180f, strainArcSweep(30.0), 0f)
        for (value in listOf(0.0, 10.5, 21.0)) {
            for (step in 0..100) {
                val angle = Math.toRadians(180.0 + strainArcSweep(value) * step / 100.0)
                val y = 70.0 + 60.0 * kotlin.math.sin(angle)
                assertTrue("stroke above viewBox: $y", y - 4.5 >= 0.0)
                assertTrue("stroke below viewBox: $y", y + 4.5 <= 76.0)
            }
        }
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
