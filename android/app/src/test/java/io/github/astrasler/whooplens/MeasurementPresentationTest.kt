package io.github.astrasler.whooplens

import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test

class MeasurementPresentationTest {
    private val zone = ZoneId.of("America/Chicago")
    private val now = Instant.parse("2026-10-28T23:00:00Z").toEpochMilli()
    private fun steps(day: String) = Metric("steps", "Steps", 12345.0, "steps", DataSource.HEALTH_CONNECT,
        java.time.LocalDate.parse(day).atStartOfDay(zone).toInstant().toEpochMilli())

    @Test fun dailyRefreshUsesFetchTimeButInstantMeasurementsKeepMeasurementTime() {
        val metric = steps("2026-10-28")
        val batch = DataBatch(DataSource.HEALTH_CONNECT, now, listOf(metric))
        assertEquals(now, metricUpdatedAt(metric, batch))
        assertNull(metricUpdatedAt(metric, null))
        assertEquals(100L, metricUpdatedAt(metric.copy(key = "heart", measuredAt = 100L), batch))
        assertEquals(100L, metricUpdatedAt(metric.copy(source = DataSource.WHOOP, measuredAt = 100L), batch))
    }

    @Test fun dailyLabelsUseCalendarDateAndNeverGuessAnUnknownDate() {
        assertEquals("Today so far", dailyTotalPeriodLabel(steps("2026-10-28"), now, zone))
        val old = dailyTotalPeriodLabel(steps("2026-10-27"), now, zone)
        assertTrue(old.startsWith("Recorded "))
        assertTrue(old.contains("27") && old.contains("2026"))
        assertEquals("Recorded date unavailable", dailyTotalPeriodLabel(null, now, zone))
        assertEquals("Recorded date unavailable", dailyTotalPeriodLabel(steps("2026-10-28").copy(measuredAt = null), now, zone))
        assertFalse(dailyTotalPeriodLabel(steps("2026-10-29"), now, zone).contains("Today"))
    }

    @Test fun localCalendarDatesSurviveDaylightSavingBoundary() {
        val time = Instant.parse("2026-11-02T05:30:00Z").toEpochMilli() // Nov 1, 23:30 CST
        assertEquals("Today so far", dailyTotalPeriodLabel(steps("2026-11-01"), time, zone))
        assertFalse(dailyTotalPeriodLabel(steps("2026-10-31"), time, zone).contains("Today"))
    }

    @Test fun chartsCountCycleAndDescribeOnlyFiniteMeasurements() {
        val points = listOf(Point(0, null), Point(1, Double.NaN), Point(2, 25.0),
            Point(3, Double.POSITIVE_INFINITY), Point(4, 50.0))
        assertTrue(chartDescription(points, DataSource.WHOOP, null).contains("2 available points"))
        assertEquals(2, nextChartPointIndex(points, null))
        assertEquals(4, nextChartPointIndex(points, 2))
        assertEquals(2, nextChartPointIndex(points, 4))
        assertNull(nextChartPointIndex(listOf(Point(0, null), Point(1, Double.NaN)), null))
        assertTrue(chartDescription(points, DataSource.WHOOP, 1).endsWith("Not shared"))
        assertTrue(chartDescription(points, DataSource.WHOOP, 3).endsWith("Not shared"))
        assertTrue(chartDescription(points, DataSource.WHOOP, 2).endsWith("25"))
        assertFalse(chartDescription(points, DataSource.WHOOP, 1).contains("NaN"))
    }

    @Test fun freshEveningStepsWidgetDoesNotAgeFromMidnight() {
        val localNow = Instant.ofEpochMilli(now).atZone(ZoneId.systemDefault())
        val midnight = localNow.toLocalDate().atStartOfDay(localNow.zone).toInstant().toEpochMilli()
        val metric = steps("2026-10-28").copy(measuredAt = midnight)
        val batch = DataBatch(DataSource.HEALTH_CONNECT, now, listOf(metric))
        val snapshot = DashboardSnapshot("A", health = batch)
        val result = widgetPresentation(snapshot, "A", WidgetPrivacy.DETAILED, false,
            listOf("steps"), WidgetSpace(320f, 160f), now)
        assertFalse(result.stale)
        assertNull(result.badge)
        assertTrue(result.description.contains("Read " + dateTime(now)))
        assertTrue(result.description.contains("Today so far"))
        val legacy = widgetText(snapshot, "A", WidgetPrivacy.DETAILED, false, false, listOf("steps"), now)
        assertTrue(legacy.contains("Read " + dateTime(now)))
        assertFalse(legacy.contains("Saved "))
    }

    @Test fun aFreshFetchOfYesterdayDoesNotMakeItsStepsTodaysTotal() {
        val localNow = Instant.ofEpochMilli(now).atZone(ZoneId.systemDefault())
        val yesterday = localNow.toLocalDate().minusDays(1).atStartOfDay(localNow.zone).toInstant().toEpochMilli()
        val metric = steps("2026-10-27").copy(measuredAt = yesterday)
        val batch = DataBatch(DataSource.HEALTH_CONNECT, now, listOf(metric))
        val snapshot = DashboardSnapshot("A", health = batch)
        val result = widgetPresentation(snapshot, "A", WidgetPrivacy.DETAILED, false,
            listOf("steps"), WidgetSpace(320f, 160f), now)
        assertTrue(result.stale)
        assertTrue(result.footer.contains("Recorded "))
        assertFalse(result.description.contains("Today so far"))
        assertFalse(dashboardPeriodLabel("steps", null, metric, now).contains("Today so far"))
        val legacy = widgetText(snapshot, "A", WidgetPrivacy.DETAILED, false, false, listOf("steps"), now)
        assertTrue(legacy.contains("Saved " + dateTime(now)))
        assertTrue(legacy.contains("Recorded "))
        assertTrue(metricIsStale(metric.copy(measuredAt = null), batch, now))
    }

    @Test fun oldFetchStillMarksCurrentDayTotalStale() {
        val metric = steps("2026-10-28")
        assertTrue(metricIsStale(metric, DataBatch(DataSource.HEALTH_CONNECT, now - 13 * 3600000L), now))
    }

    @Test fun failedDailyReadCannotBorrowOtherMetricsNewRefreshTime() {
        val midnight = Instant.ofEpochMilli(now).atZone(ZoneId.systemDefault()).toLocalDate()
            .atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
        val metric = steps("2026-10-28").copy(measuredAt = midnight)
        val batch = DataBatch(DataSource.HEALTH_CONNECT, now, listOf(metric),
            notices = listOf("Steps could not be read. Check permission and retry."), complete = false)
        val cached = DashboardCodec.decode(DashboardCodec.encode(DashboardSnapshot("A", health = batch)), "A")!!
        assertNull(metricUpdatedAt(cached.health!!.metric("steps"), cached.health))
        assertNull(dashboardUpdatedAt("steps", metric, batch))
        assertTrue(metricIsStale(metric, batch, now))
        val result = widgetPresentation(cached, "A", WidgetPrivacy.DETAILED, false,
            listOf("steps"), WidgetSpace(320f, 160f), now)
        assertTrue(result.stale)
        assertTrue(result.description.contains("time unavailable"))
        assertFalse(result.description.contains(dateTime(now)))
        assertNull(result.badge) // The old successful refresh time is not in this snapshot; don't invent it.
        val legacy = widgetText(cached, "A", WidgetPrivacy.DETAILED, false, false, listOf("steps"), now)
        assertTrue(legacy.contains("Saved refresh time unavailable"))
        assertFalse(legacy.contains(dateTime(now)))
    }

    @Test fun aDifferentCategoryFailureDoesNotHideSuccessfulStepsRefresh() {
        val metric = steps("2026-10-28")
        val batch = DataBatch(DataSource.HEALTH_CONNECT, now, listOf(metric),
            notices = listOf("Active energy could not be read. Check permission and retry."), complete = false)
        assertEquals(now, metricUpdatedAt(metric, batch))
        assertFalse(dailyTotalRefreshFailed(metric, batch))
    }
}
