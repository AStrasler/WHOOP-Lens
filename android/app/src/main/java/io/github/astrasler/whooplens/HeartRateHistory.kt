package io.github.astrasler.whooplens

import java.time.Instant
import java.time.ZoneId

internal const val HEART_RATE_DAILY = "heart_daily"

/** Daily aggregates only; missing days remain missing, never zero-filled. */
internal fun boundedHeartRateDays(
    points: List<Point>,
    now: Long,
    zone: ZoneId = ZoneId.systemDefault(),
): List<Point> {
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val first = today.minusDays(29)
    return points.asSequence()
        .filter { it.time <= now && it.value?.let { v -> v.isFinite() && v > 0 } == true }
        .groupBy { Instant.ofEpochMilli(it.time).atZone(zone).toLocalDate() }
        .filterKeys { it >= first && it <= today }
        .toSortedMap()
        .map { (day, values) ->
            Point(day.atStartOfDay(zone).toInstant().toEpochMilli(), values.maxByOrNull { it.time }!!.value)
        }
}

/** The aggregate read is independent of the raw-record pagination/chart budget. */
internal suspend fun readHeartRateDailyHistory(
    now: Long,
    zone: ZoneId,
    allowed: () -> Boolean,
    read: suspend (start: java.time.LocalDateTime, end: java.time.LocalDateTime) -> List<Point>,
): List<Point> {
    check(allowed())
    val end = Instant.ofEpochMilli(now).atZone(zone).toLocalDateTime()
    val start = end.toLocalDate().minusDays(29).atStartOfDay()
    val points = read(start, end)
    check(allowed())
    return boundedHeartRateDays(points, now, zone)
}

internal fun DataBatch.baselineSeries(key: String): List<Point> =
    if (source == DataSource.HEALTH_CONNECT && key == "heart")
        boundedHeartRateDays(series[HEART_RATE_DAILY].orEmpty(), fetchedAt)
    else series[key].orEmpty()
