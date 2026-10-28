package io.github.astrasler.whooplens

import java.text.DecimalFormat
import kotlin.math.abs

internal val defaultHomeCards =
    listOf("Recovery", "Strain", "Sleep", "Activity", "Vitals", "Overview", "Sources")

internal fun homeCardOrder(saved: String?): List<String> =
    saved.orEmpty().split(',').filter { it in defaultHomeCards }.distinct()
        .let { it + defaultHomeCards.filterNot(it::contains) }

internal fun visibleHomeCards(order: List<String>, hidden: Set<String>) = order.filterNot { it in hidden }

internal data class DashboardPercentTrend(val amount: Double, val direction: Int, val previousAt: Long)

/** Compare recent completed observations only. Cycle completion is unavailable in this snapshot. */
internal fun dashboardPercentTrend(metric: Metric?, series: List<Point>): DashboardPercentTrend? {
    if (metric == null || metric.key == "steps" || metric.key == "strain") return null
    val current = metric.value?.takeIf { it.isFinite() } ?: return null
    val measured = metric.measuredAt ?: return null
    val previous = series.filter {
        it.time < measured && measured - it.time <= 48 * 3600000L && it.value?.isFinite() == true
    }.maxByOrNull { it.time } ?: return null
    // Values smaller than one unit are not a meaningful percentage denominator.
    if (abs(previous.value!!) < 1.0) return null
    val percent = (current - previous.value) / abs(previous.value) * 100.0
    if (!percent.isFinite()) return null
    return DashboardPercentTrend(abs(percent), percent.compareTo(0.0), previous.time)
}

internal fun dashboardTrendLabel(trend: DashboardPercentTrend?): String = when {
    trend == null -> "No recent comparison"
    trend.direction == 0 -> "No change"
    else -> (if (trend.direction > 0) "+" else "−") + when {
        trend.amount < 1.0 -> "<1%"
        trend.amount >= 1000.0 -> "≥1,000%"
        else -> DecimalFormat("0.#").format(trend.amount) + "%"
    }
}

internal fun dashboardPeriodLabel(key: String, trend: DashboardPercentTrend?): String = when (key) {
    "steps" -> "Today so far"
    "strain" -> "Cycle in progress or completion unverified"
    else -> dashboardTrendLabel(trend)
}

internal fun dashboardUpdatedAt(key: String, metric: Metric?, batch: DataBatch?): Long? =
    if (key == "steps") batch?.fetchedAt else metric?.measuredAt

/** Shared by the chart gate and renderer so isolated observations always get a mark. */
internal fun chartPointIndices(points: List<Point>): List<Int> =
    points.indices.filter { points[it].value?.isFinite() == true }

internal fun showOverviewChart(points: List<Point>) = chartPointIndices(points).size >= 2
