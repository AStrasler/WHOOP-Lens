package io.github.astrasler.whooplens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LensDesignPolicyTest {
    private val ok =
        LockInputs(
            chosen = LockLevel.DETAILED,
            signedInAccount = "a",
            dataAccount = "a",
            deviceSecure = true,
            systemAllowsSensitive = true,
            platformSupported = true,
            newestDataAgeMs = 3600_000L,
            detailedConfirmed = true,
            selectedMetrics = listOf("recovery", "strain", "sleep", "hrv"),
        )

    @Test fun hiddenIsTheFloor() =
        assertEquals(LockLevel.HIDDEN, decideLockContent(ok.copy(chosen = LockLevel.HIDDEN)).level)

    @Test fun detailedCapsAtThreeEligibleMetrics() {
        val d = decideLockContent(ok.copy(selectedMetrics = listOf("ble_hr", "recovery", "recovery", "strain", "sleep", "hrv")))
        assertEquals(LockLevel.DETAILED, d.level)
        assertEquals(listOf("recovery", "strain", "sleep"), d.metrics)
    }

    @Test fun everyFallbackIsHidden() {
        val cases =
            mapOf(
                LockFallback.PLATFORM_UNSUPPORTED to ok.copy(platformSupported = false),
                LockFallback.SIGNED_OUT to ok.copy(signedInAccount = null),
                LockFallback.OTHER_ACCOUNT to ok.copy(dataAccount = "b"),
                LockFallback.SYSTEM_SETTING_UNKNOWN to ok.copy(systemAllowsSensitive = null),
                LockFallback.SYSTEM_HIDES_SENSITIVE to ok.copy(systemAllowsSensitive = false),
                LockFallback.DATA_TOO_OLD to ok.copy(newestDataAgeMs = 25 * 3600_000L),
                LockFallback.NO_SECURE_LOCK to ok.copy(deviceSecure = false),
                LockFallback.NOT_CONFIRMED to ok.copy(detailedConfirmed = false),
                LockFallback.NOTHING_SELECTED to ok.copy(selectedMetrics = listOf("ble_hr")),
            )
        cases.forEach { (why, input) ->
            val d = decideLockContent(input)
            assertEquals(why.name, LockLevel.HIDDEN, d.level)
            assertEquals(why, d.fallback)
            assertTrue(d.metrics.isEmpty())
        }
    }

    @Test fun summaryNeverCarriesMetrics() {
        val d = decideLockContent(ok.copy(chosen = LockLevel.SUMMARY, deviceSecure = false, detailedConfirmed = false))
        assertEquals(LockLevel.SUMMARY, d.level)
        assertTrue(d.metrics.isEmpty())
    }

    @Test fun raisingNeedsUnlockAndDetailedNeedsAuth() {
        assertFalse(canChangeLevel(LockLevel.HIDDEN, LockLevel.SUMMARY, deviceUnlocked = false, authenticatedJustNow = false))
        assertTrue(canChangeLevel(LockLevel.HIDDEN, LockLevel.SUMMARY, deviceUnlocked = true, authenticatedJustNow = false))
        assertFalse(canChangeLevel(LockLevel.SUMMARY, LockLevel.DETAILED, deviceUnlocked = true, authenticatedJustNow = false))
        assertTrue(canChangeLevel(LockLevel.DETAILED, LockLevel.HIDDEN, deviceUnlocked = false, authenticatedJustNow = false))
    }

    @Test fun appearancePrecedence() {
        val base = AppearanceInputs(AppearanceChoice.AUTO, powerSave = false, blurAvailable = true, animatorScale = 1f)
        assertEquals(LensAppearance.GLASS, resolveAppearance(base).mode)
        assertEquals(LensAppearance.BATTERY_SAVER, resolveAppearance(base.copy(powerSave = true)).mode)
        assertEquals(LensAppearance.BATTERY_SAVER, resolveAppearance(base.copy(blurAvailable = false)).mode)
        assertEquals(
            LensAppearance.REDUCED_TRANSPARENCY,
            resolveAppearance(base.copy(choice = AppearanceChoice.REDUCED_TRANSPARENCY, powerSave = true)).mode,
        )
        assertEquals(LensAppearance.BATTERY_SAVER, resolveAppearance(base.copy(choice = AppearanceChoice.BATTERY_SAVER)).mode)
        assertFalse(resolveAppearance(base.copy(powerSave = true)).liveBlur)
        val still = resolveAppearance(base.copy(animatorScale = 0f))
        assertTrue(still.reduceMotion)
        assertEquals(0L, still.transitionMs)
    }

    @Test fun compactWidgetRules() {
        assertNull(staleBadge(2 * 3600_000L))
        assertEquals("19h", staleBadge(19 * 3600_000L))
        assertEquals("3d", staleBadge(72 * 3600_000L))
        assertEquals(WidgetTier.ONE_BY_ONE, widgetTier(WidgetSpace(88f, 88f)))
        assertEquals(WidgetTier.STRIP, widgetTier(WidgetSpace(180f, 88f)))
        assertEquals(WidgetTier.PANEL, widgetTier(WidgetSpace(180f, 180f)))
        assertEquals(WidgetTier.ONE_BY_ONE, effectiveTier(WidgetSpace(180f, 100f, 1.3f)))
        val c = compactContent("Recovery", "72", WidgetSource.WHOOP, "7:05 AM", 19 * 3600_000L)
        assertEquals("19h", c.badge)
        assertTrue(c.description.contains("WHOOP") && c.description.contains("7:05 AM"))
    }
}
