package io.github.astrasler.whooplens

import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class HeartRateHistoryTest {
    private val zone = ZoneId.systemDefault()
    private val now = Instant.parse("2026-10-28T20:00:00Z").toEpochMilli()
    private val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    // 30,000 samples: the latest 2,000 cover only two of the thirty days.
    private fun denseSamples() = (29 downTo 0).flatMap { offset ->
        val start = today.minusDays(offset.toLong()).atStartOfDay(zone).toInstant().toEpochMilli()
        (0 until 1000).map { sample -> Point(start + sample * 30000L, if (offset == 0) 75.0 else 65.0, "private.writer") }
    }

    private suspend fun aggregate(samples: List<Point>) =
        readHeartRateDailyHistory(now, zone, { true }) { from, to ->
            assertEquals(today.minusDays(29).atStartOfDay(), from)
            assertEquals(Instant.ofEpochMilli(now).atZone(zone).toLocalDateTime(), to)
            samples.filter { it.time >= from.atZone(zone).toInstant().toEpochMilli() && it.time < now }
                .groupBy { Instant.ofEpochMilli(it.time).atZone(zone).toLocalDate() }
                .map { (day, points) -> Point(day.atStartOfDay(zone).toInstant().toEpochMilli(), points.map { it.value!! }.average()) }
        }

    @Test fun thirtyDaysSurviveChartTruncationAndAccountBoundCacheEnvelope() = runBlocking {
        val samples = denseSamples()
        val chart = samples.takeLast(2000)
        assertNull(personalBaseline(chart, now, zone))
        val daily = aggregate(samples)
        val batch = DataBatch(DataSource.HEALTH_CONNECT, now, series = mapOf("heart" to chart, HEART_RATE_DAILY to daily))
        assertEquals(2000, batch.series["heart"]!!.size)
        assertEquals(30, batch.baselineSeries("heart").size)
        assertEquals(65.33333333333333, personalBaseline(batch.baselineSeries("heart"), now, zone)!!.second, 0.000001)
        assertTrue(daily.all { it.origin == null })
        val encoded = DashboardCodec.encode(DashboardSnapshot("A", health = batch))
        val restored = DashboardCodec.decode(encoded, "A")!!.health!!
        assertEquals(daily, restored.baselineSeries("heart"))
        assertNotNull(personalBaseline(restored.baselineSeries("heart"), now, zone))
        assertNull(DashboardCodec.decode(encoded, "B"))
    }

    @Test fun dailyReadIsIndependentOfFivePageRecordBudget() = runBlocking {
        val samples = denseSamples()
        var pages = 0
        val raw = readHealthPages<Point> {
            val end = samples.size - pages * 200
            pages++
            HealthPage(samples.subList(end - 200, end), "page-$pages")
        }
        assertEquals(5, pages)
        assertFalse(raw.complete)
        assertEquals(1000, raw.rows.size)
        assertNull(personalBaseline(raw.rows, now, zone))
        assertEquals(30, aggregate(samples).size)
        assertNotNull(personalBaseline(aggregate(samples), now, zone))
    }

    @Test fun missingDaysStayMissingAndOldRawCachesDoNotSupplyBaseline() = runBlocking {
        val daily = aggregate(denseSamples().take(13000))
        assertEquals(13, daily.size)
        assertNull(personalBaseline(daily, now, zone))
        val legacy = DataBatch(DataSource.HEALTH_CONNECT, now, series = mapOf("heart" to denseSamples()))
        assertTrue(legacy.baselineSeries("heart").isEmpty())
        val owner = DashboardOwner()
        val ticket = owner.select("A")
        owner.select("B")
        assertFalse(owner.accept("A", ticket, legacy.copy(series = mapOf(HEART_RATE_DAILY to daily))))
        assertNull(owner.snapshot!!.health)
        val current = owner.ticket()
        assertTrue(owner.accept("B", current, legacy))
        owner.forgetHealth()
        assertNull(owner.snapshot!!.health)
    }

    @Test fun accountInvalidationBeforeOrDuringReadRejectsDailyHistory() = runBlocking {
        var reads = 0
        try {
            readHeartRateDailyHistory(now, zone, { false }) { _, _ -> reads++; emptyList() }
            fail("Invalidated account read must fail")
        } catch (_: IllegalStateException) { }
        assertEquals(0, reads)
        var active = true
        try {
            readHeartRateDailyHistory(now, zone, { active }) { _, _ -> active = false; listOf(Point(now, 65.0)) }
            fail("Late account completion must fail")
        } catch (_: IllegalStateException) { }
    }

    @Test fun dailyHistoryIsBoundedDropsInvalidValuesAndDoesNotRetainOrigins() {
        val points = (0..60).map { Point(now - it * 86400000L, 65.0, "private.writer") } +
            listOf(Point(now, Double.NaN), Point(now + 86400000L, 80.0), Point(now, null))
        val daily = boundedHeartRateDays(points, now, zone)
        assertEquals(30, daily.size)
        assertEquals(30, daily.map { it.time }.distinct().size)
        assertTrue(daily.all { it.value == 65.0 && it.origin == null })
        val batch = DataBatch(DataSource.HEALTH_CONNECT, now, series = mapOf(HEART_RATE_DAILY to points))
        val restored = DashboardCodec.decode(DashboardCodec.encode(DashboardSnapshot("A", health = batch)), "A")!!.health!!
        assertEquals(30, restored.baselineSeries("heart").size)
    }
}
