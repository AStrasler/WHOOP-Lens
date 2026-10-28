package io.github.astrasler.whooplens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
}
