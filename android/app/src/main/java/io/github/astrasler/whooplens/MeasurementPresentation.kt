package io.github.astrasler.whooplens

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Daily aggregate timestamps identify a bucket, not the time it was refreshed. */
internal fun isDailyTotal(metric: Metric?) =
    metric?.source == DataSource.HEALTH_CONNECT && metric.key in setOf("steps", "distance", "energy", "floors")

/** A partial refresh can retain a previous metric under the new batch timestamp. */
internal fun dailyTotalRefreshFailed(metric: Metric?, batch: DataBatch?): Boolean =
    isDailyTotal(metric) && batch?.notices?.any {
        it.startsWith("${metric?.title} could not be read.")
    } == true

internal fun metricUpdatedAt(metric: Metric?, batch: DataBatch?): Long? =
    if (dailyTotalRefreshFailed(metric, batch)) null
    else if (isDailyTotal(metric)) batch?.fetchedAt else metric?.measuredAt ?: batch?.fetchedAt

internal fun dailyTotalPeriodLabel(
    metric: Metric?,
    now: Long,
    zone: ZoneId = ZoneId.systemDefault(),
): String {
    val recorded = metric?.measuredAt?.let { Instant.ofEpochMilli(it).atZone(zone).toLocalDate() }
        ?: return "Recorded date unavailable"
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    return if (recorded == today) "Today so far"
    else "Recorded " + recorded.format(DateTimeFormatter.ofPattern("MMM d, yyyy"))
}

internal fun metricIsStale(metric: Metric?, batch: DataBatch?, now: Long): Boolean {
    if (batch == null) return false
    if (dailyTotalRefreshFailed(metric, batch)) return true
    val updatedAt = metricUpdatedAt(metric, batch) ?: return batch.stale(now)
    return batch.stale(now) || now - updatedAt > 12 * 3600000L ||
        (isDailyTotal(metric) && dailyTotalPeriodLabel(metric, now) != "Today so far")
}

internal fun nextChartPointIndex(points: List<Point>, selected: Int?): Int? {
    val indices = chartPointIndices(points)
    if (indices.isEmpty()) return null
    return indices[(indices.indexOf(selected) + 1) % indices.size]
}

internal fun chartDescription(points: List<Point>, source: DataSource, selected: Int?): String {
    val point = selected?.let { points.getOrNull(it) }
    return if (point != null) {
        val value = point.value?.takeIf { it.isFinite() }
            ?.let { java.text.DecimalFormat("0.#").format(it) } ?: "Not shared"
        "${source.label}, ${dateTime(point.time)}, $value"
    } else {
        "${source.label} chart. ${chartPointIndices(points).size} available points. Gaps mean missing data. Tap to read each point; full measurements below."
    }
}
