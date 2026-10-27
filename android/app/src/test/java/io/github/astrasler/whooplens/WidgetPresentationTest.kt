package io.github.astrasler.whooplens

import android.appwidget.AppWidgetProviderInfo
import android.content.Intent
import android.view.Display
import org.junit.Assert.*
import org.junit.Test

class WidgetPresentationTest {
    private val now = 1800000000000L
    private val whoop =
        DataBatch(
            DataSource.WHOOP,
            now,
            listOf(
                Metric("recovery", "Recovery", 72.0, "%", DataSource.WHOOP, now),
                Metric("strain", "Strain", 12.3, "", DataSource.WHOOP, now),
                Metric("sleep", "Sleep", 450.0, "min", DataSource.WHOOP, now),
            ),
        )
    private val health =
        DataBatch(
            DataSource.HEALTH_CONNECT,
            now,
            listOf(
                Metric("steps", "Steps", 12000.0, "steps", DataSource.HEALTH_CONNECT, now),
                Metric("distance", "Distance", 8.0, "km", DataSource.HEALTH_CONNECT, now),
            ),
        )
    private val snapshot = DashboardSnapshot("A", whoop, health)
    private val keys = listOf("recovery", "strain", "sleep", "steps")

    private fun render(
        space: WidgetSpace = WidgetSpace(320f, 160f),
        data: DashboardSnapshot? = snapshot,
        account: String? = "A",
        privacy: WidgetPrivacy = WidgetPrivacy.DETAILED,
        locked: Boolean = false,
        chosen: List<String> = keys,
    ) = widgetPresentation(data, account, privacy, locked, chosen, space, now)

    @Test
    fun compactOnlyPrimary() {
        val result = render(WidgetSpace(56f, 56f))
        assertEquals("72%", result.primary)
        assertEquals("", result.supporting)
        assertEquals("", result.title)
        assertTrue(result.description.contains("WHOOP"))
    }

    @Test
    fun expandsProgressively() {
        val sizes = listOf(WidgetSpace(56f, 56f), WidgetSpace(150f, 100f), WidgetSpace(320f, 160f))
        assertEquals(listOf(0, 2, 4), sizes.map { it.supporting })
        assertTrue(render(sizes.last()).wide)
        assertFalse(render(WidgetSpace(320f, 160f, 2f)).wide)
        assertTrue(render(sizes.last()).supporting.contains("Strain"))
        assertTrue(render(sizes.last()).supporting.contains("Steps"))
        assertTrue(render(sizes.last()).footer.contains("Health Connect"))
    }

    @Test
    fun largeFontKeepsSupportingOnExpandedButNotCompact() {
        assertEquals(0, WidgetSpace(56f, 56f, 2f).supporting)
        assertEquals(1, WidgetSpace(320f, 160f, 2f).supporting)
    }

    @Test
    fun absentPrimaryNeverSubstitutesAnotherSourceOrZero() {
        val result = render(data = snapshot.copy(whoop = null))
        assertEquals("—", result.primary)
        assertTrue(result.description.contains("Not shared"))
    }

    @Test
    fun nullValuesAreUnavailableButZeroIsValid() {
        assertEquals(
            "0%",
            render(
                    data =
                        snapshot.copy(
                            whoop = whoop.copy(metrics = listOf(whoop.metrics[0].copy(value = 0.0)))
                        )
                )
                .primary,
        )
        assertEquals(
            "—",
            render(
                    data =
                        snapshot.copy(
                            whoop =
                                whoop.copy(metrics = listOf(whoop.metrics[0].copy(value = null)))
                        )
                )
                .primary,
        )
    }

    @Test
    fun missingCacheAndSelectionHaveClearStates() {
        assertEquals("—", render(data = null).primary)
        assertEquals("—", render(chosen = emptyList()).primary)
        assertTrue(render(data = null).description.contains("refresh"))
    }

    @Test
    fun staleMeasurementAndBatchAreFlagged() {
        for (old in
            listOf(
                whoop.copy(fetchedAt = now - 13 * 3600000L),
                whoop.copy(
                    metrics = listOf(whoop.metrics[0].copy(measuredAt = now - 13 * 3600000L))
                ),
            )) {
            val result = render(data = snapshot.copy(whoop = old))
            assertTrue(result.stale)
            assertTrue(result.footer.startsWith("Saved"))
            assertTrue(result.description.contains("Saved"))
        }
    }

    @Test
    fun supportingStaleAlsoFlagsWidget() {
        assertTrue(
            render(data = snapshot.copy(health = health.copy(fetchedAt = now - 13 * 3600000L)))
                .stale
        )
    }

    @Test
    fun privacyNeverExposesMetrics() {
        for (mode in listOf(WidgetPrivacy.HIDDEN, WidgetPrivacy.SUMMARY)) {
            val r = render(privacy = mode)
            assertFalse(r.toString().contains("72"))
            assertFalse(r.description.contains("Recovery"))
        }
        assertFalse(render(locked = true).toString().contains("72"))
    }

    @Test
    fun logoutAndSwitchRejectOldCacheBeforeFormatting() {
        for (account in listOf(null, "B")) {
            val result = render(account = account)
            assertEquals("Open", result.primary)
            assertFalse(result.toString().contains("72"))
            assertFalse(result.description.contains("WHOOP. Read"))
        }
    }

    @Test
    fun stepsAreCompactButExactValueIsAccessible() {
        val result = render(chosen = listOf("steps", "distance"))
        assertEquals("12k", result.primary)
        assertTrue(result.description.contains("12,000"))
        assertTrue(result.footer.contains("Health Connect"))
        assertTrue(result.supporting.contains("Distance"))
    }

    @Test
    fun oneByOneAtLargeFontKeepsASingleAbbreviatedPrimary() {
        val space = WidgetSpace(57f, 102f, 2f)
        assertFalse(space.labeled)
        assertFalse(space.footer)
        assertEquals(0, space.supporting)
        val result = render(space, chosen = listOf("steps", "distance"))
        assertEquals("12k", result.primary)
        assertEquals("", result.title)
        assertEquals("", result.supporting)
        assertEquals("", result.footer)
        assertFalse(result.wide)
        assertTrue(result.description.contains("12,000"))
    }

    @Test
    fun intendedMaxEnvelopeUsesTwoColumnsAtNormalFontAndStacksWhenScaled() {
        val normal = WidgetSpace(320f, 250f, 1f)
        assertTrue(normal.labeled)
        assertTrue(normal.footer)
        assertEquals(4, normal.supporting)
        val expanded = render(normal)
        assertTrue(expanded.wide)
        assertTrue(expanded.supporting.lines().size <= 4)
        val scaled = WidgetSpace(320f, 250f, 2f)
        assertFalse(render(scaled).wide)
        assertEquals(3, scaled.supporting)
        assertEquals(0, WidgetSpace(40f, 40f, 2f).supporting)
    }

    @Test
    fun lockedKeyguardAndScreenOffOmitHealthValues() {
        val forbidden = listOf("72", "12.3", "7h", "12,000", "12k", "Recovery", "WHOOP", "Steps")
        val rich = render(locked = true)
        val text = widgetText(snapshot, "A", WidgetPrivacy.DETAILED, true, true, keys, now)
        for (secret in forbidden) {
            assertFalse(rich.toString().contains(secret))
            assertFalse(rich.description.contains(secret))
            assertFalse(text.contains(secret))
        }
        assertEquals("Lock", rich.primary)
        assertEquals("Unlock to view", text)
    }

    @Test
    fun concealMatrixWithholdsMeasurementsAndScreenOnRestoresOnlyWhenUnlocked() {
        val keyguard = AppWidgetProviderInfo.WIDGET_CATEGORY_KEYGUARD
        assertTrue(widgetConcealsMeasurements(true, false, false, 0))
        assertTrue(widgetConcealsMeasurements(false, true, false, 0))
        assertTrue(widgetConcealsMeasurements(false, false, true, 0))
        assertTrue(widgetConcealsMeasurements(false, false, false, keyguard))
        assertFalse(widgetConcealsMeasurements(false, false, false, AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN))
        assertFalse(displaysAreOff(null))
        assertFalse(displaysAreOff(intArrayOf()))
        assertFalse(displaysAreOff(intArrayOf(Display.STATE_ON)))
        assertTrue(displaysAreOff(intArrayOf(Display.STATE_OFF, Display.STATE_OFF)))
        assertTrue(concealAfterScreenBroadcast(Intent.ACTION_SCREEN_OFF, false, false, false))
        assertTrue(concealAfterScreenBroadcast(Intent.ACTION_SCREEN_ON, false, true, true))
        assertFalse(concealAfterScreenBroadcast(Intent.ACTION_SCREEN_ON, false, false, true))
        assertFalse(concealAfterScreenBroadcast(Intent.ACTION_USER_PRESENT, false, false, true))
        assertTrue(concealAfterScreenBroadcast(Intent.ACTION_USER_PRESENT, true, false, true))
        assertTrue(concealAfterScreenBroadcast("android.intent.action.BOOT_COMPLETED", false, false, true))
    }

    @Test
    fun refreshUsesNewCacheAndDoesNotRetainPreviousValue() {
        assertEquals("72%", render().primary)
        assertEquals(
            "90%",
            render(
                    data =
                        snapshot.copy(
                            whoop =
                                whoop.copy(metrics = listOf(whoop.metrics[0].copy(value = 90.0)))
                        )
                )
                .primary,
        )
    }
}
