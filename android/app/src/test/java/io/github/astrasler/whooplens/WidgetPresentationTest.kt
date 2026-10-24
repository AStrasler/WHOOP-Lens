package io.github.astrasler.whooplens

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
