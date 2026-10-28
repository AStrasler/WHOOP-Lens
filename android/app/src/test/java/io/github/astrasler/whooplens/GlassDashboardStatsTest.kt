package io.github.astrasler.whooplens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GlassDashboardStatsTest {
    private fun metric(value: Double?, measuredAt: Long? = 200L) = Metric(
        "recovery", "Recovery", value, "%", DataSource.WHOOP, measuredAt,
    )

    @Test fun calculatesChangeOnlyAgainstEarlierActualRecord() {
        val points = listOf(Point(100L, 50.0), Point(200L, 75.0), Point(300L, 99.0))
        val trend = dashboardPercentTrend(metric(75.0), points)
        assertEquals(50.0, trend!!.amount, 0.001)
        assertEquals(1, trend.direction)
    }

    @Test fun aDecreaseIsNotLabeledAsAnImprovement() {
        val trend = dashboardPercentTrend(metric(40.0), listOf(Point(100L, 80.0)))
        assertEquals(-1, trend!!.direction)
        assertEquals(50.0, trend.amount, 0.001)
    }

    @Test fun noInventedPriorOrDivideByZero() {
        assertNull(dashboardPercentTrend(metric(null), listOf(Point(100L, 50.0))))
        assertNull(dashboardPercentTrend(metric(20.0), emptyList()))
        assertNull(dashboardPercentTrend(metric(20.0), listOf(Point(100L, 0.0))))
        assertNull(dashboardPercentTrend(metric(20.0, null), listOf(Point(100L, 10.0))))
        assertNull(dashboardPercentTrend(metric(20.0), listOf(Point(200L, 10.0))))
    }

    @Test fun missingAndNonFiniteHistoryIsIgnored() {
        val trend = dashboardPercentTrend(
            metric(20.0),
            listOf(Point(80L, 10.0), Point(100L, null), Point(190L, Double.NaN)),
        )
        assertEquals(100.0, trend!!.amount, 0.001)
    }

    @Test fun partialDayStepsNeverCompareAndUseRefreshTime() {
        val steps = metric(12345.0, 0L).copy(key = "steps", source = DataSource.HEALTH_CONNECT)
        val batch = DataBatch(DataSource.HEALTH_CONNECT, 123456L, listOf(steps))
        assertNull(dashboardPercentTrend(steps, listOf(Point(-86400000L, 20000.0))))
        assertEquals("Today so far", dashboardPeriodLabel("steps", null))
        assertEquals(123456L, dashboardUpdatedAt("steps", steps, batch))
        assertNull(dashboardUpdatedAt("steps", steps, null))
    }

    @Test fun unverifiedStrainCycleNeverCompares() {
        assertNull(dashboardPercentTrend(metric(5.0).copy(key = "strain"), listOf(Point(100L, 10.0))))
    }

    @Test fun tinyChangesRetainDirectionWithoutZeroPercent() {
        assertEquals("+<1%", dashboardTrendLabel(dashboardPercentTrend(metric(50.001), listOf(Point(100L, 50.0)))))
        assertEquals("−<1%", dashboardTrendLabel(dashboardPercentTrend(metric(49.999), listOf(Point(100L, 50.0)))))
        assertEquals("No change", dashboardTrendLabel(dashboardPercentTrend(metric(50.0), listOf(Point(100L, 50.0)))))
        assertEquals("+1.2%", dashboardTrendLabel(DashboardPercentTrend(1.24, 1, 100L)))
        assertEquals("−50%", dashboardTrendLabel(DashboardPercentTrend(50.0, -1, 100L)))
        assertEquals("+≥1,000%", dashboardTrendLabel(DashboardPercentTrend(10000.0, 1, 100L)))
    }

    @Test fun nearZeroBaselineAndOldComparisonAreSuppressed() {
        assertNull(dashboardPercentTrend(metric(10.0), listOf(Point(100L, 0.001))))
        val now = 3 * 86400000L
        assertNull(dashboardPercentTrend(metric(50.0, now), listOf(Point(now - 48 * 3600000L - 1, 25.0))))
        val recent = now - 48 * 3600000L
        assertEquals(recent, dashboardPercentTrend(metric(50.0, now), listOf(Point(recent, 25.0)))!!.previousAt)
    }

    @Test fun isolatedChartObservationsGetPointsAndPassTheGate() {
        val sparse = listOf(Point(0L, 20.0), Point(1L, null), Point(2L, 40.0), Point(3L, Double.NaN))
        assertEquals(listOf(0, 2), chartPointIndices(sparse))
        assertTrue(showOverviewChart(sparse))
        assertFalse(showOverviewChart(listOf(Point(0L, 20.0), Point(1L, null))))
        assertFalse(showOverviewChart(emptyList()))
        assertEquals(listOf(0, 1), chartPointIndices(listOf(Point(0L, 20.0), Point(1L, 40.0))))
    }

    @Test fun overviewHonorsSavedOrderAndHiddenState() {
        val order = homeCardOrder("Sleep,Overview,Recovery,Overview,unknown")
        assertEquals(listOf("Sleep", "Overview", "Recovery"), order.take(3))
        assertEquals(defaultHomeCards.size, order.size)
        assertFalse(visibleHomeCards(order, setOf("Overview")).contains("Overview"))
        assertEquals(order, visibleHomeCards(order, emptySet()))
        assertEquals("Recovery", homeCardOrder(null).first())
        assertTrue(homeCardOrder("Recovery,Strain,Sleep,Activity,Vitals,Sources").contains("Overview"))
    }
}
