package io.github.astrasler.whooplens

import java.time.Instant
import java.time.ZoneId
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Samsung / One UI lock-screen widgets are not verified (issue #102).
 * While this is false, [effectiveLockContent] cannot show health data.
 */
internal const val LOCK_SCREEN_PLATFORM_VERIFIED = false

internal const val GLANCE_PENDING_COPY =
    "At a glance is opt-in. Hidden is the default. Samsung lock-screen support is pending physical testing under issue #102, so Summary and Detailed are stored only and are not shown. Measurements stay off the lock screen."

/** Display words for the existing WHOOP recovery score. Not a new measurement. */
internal fun recoveryStatus(value: Double?): String =
    when {
        value == null || !value.isFinite() -> "Not scored"
        value >= 67.0 -> "Well recovered"
        value >= 34.0 -> "Moderate"
        else -> "Low recovery"
    }

internal fun metricsPerRow(fontScale: Float, screenWidthDp: Int): Int =
    if (fontScale > 1.3f || screenWidthDp < 360) 1 else 3

internal fun recoveryPercentInsideRing(fontScale: Float) = fontScale <= 1.6f

internal data class SleepTiming(val recorded: Int, val window: Int, val consistencyPercent: Int?)

/**
 * Timing consistency uses only nights that have a sleep record.
 * A recorded night counts when both bed and wake are within 60 minutes of the
 * median of recorded nights. Missing nights are excluded and never filled in.
 * Fewer than two recorded nights does not invent a percentage.
 */
internal fun sleepTiming(
    sleeps: List<SleepDetail>,
    now: Long,
    windowDays: Int = 14,
    zone: ZoneId = ZoneId.systemDefault(),
): SleepTiming {
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val byNight =
        (0 until windowDays).map { offset ->
            val day = today.minusDays(offset.toLong())
            sleeps
                .filter { Instant.ofEpochMilli(it.start).atZone(zone).toLocalDate() == day }
                .maxByOrNull { it.end - it.start }
        }
    val recorded = byNight.filterNotNull()
    if (recorded.size < 2) return SleepTiming(recorded.size, windowDays, null)
    fun minute(time: Long) =
        Instant.ofEpochMilli(time).atZone(zone).let { it.hour * 60 + it.minute }
    fun circ(a: Int, b: Int): Int {
        val d = abs(a - b) % 1440
        return min(d, 1440 - d)
    }
    fun median(values: List<Int>): Int {
        val sorted = values.sorted()
        return if (sorted.size % 2 == 1) sorted[sorted.size / 2]
        else (sorted[sorted.size / 2 - 1] + sorted[sorted.size / 2]) / 2
    }
    val beds = recorded.map { minute(it.start) }
    val wakes = recorded.map { minute(it.end) }
    val bedUsual = median(beds)
    val wakeUsual = median(wakes)
    val close =
        recorded.indices.count { circ(beds[it], bedUsual) <= 60 && circ(wakes[it], wakeUsual) <= 60 }
    return SleepTiming(recorded.size, windowDays, (100.0 * close / recorded.size).roundToInt())
}

/** Delta against the existing personal baseline. Missing baseline stays a dash. */
internal fun baselineDelta(value: Double?, baseline: Triple<Double, Double, Double>?): String {
    if (value == null || !value.isFinite() || baseline == null) return "\u2014"
    val delta = value - baseline.second
    if (abs(delta) < 0.05) return "steady"
    val formatted = java.text.DecimalFormat("0.#").format(abs(delta))
    return if (delta > 0) "+$formatted" else "\u2212$formatted"
}

internal fun effectiveLockContent(inputs: LockInputs): LockDecision =
    decideLockContent(
        inputs.copy(platformSupported = inputs.platformSupported && LOCK_SCREEN_PLATFORM_VERIFIED)
    )

/**
 * Clearance from the top of the 140×76 viewBox to the top of the strain stroke.
 * Must stay at least 5. A stroke that would leave the box returns a negative value.
 */
internal fun strainArcClearance(viewHeight: Float = 76f, stroke: Float = 9f, radius: Float = 60f, baseline: Float = 70f): Float {
    val above = (baseline - radius) - stroke / 2f
    val below = viewHeight - baseline - stroke / 2f
    return if (below < 0f) below else above
}
