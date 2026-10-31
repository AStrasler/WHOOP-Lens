package io.github.astrasler.whooplens

internal data class AxisCandidate(val text: String, val anchor: Float, val width: Float)
internal data class AxisLabel(val text: String, val left: Float, val width: Float)

/** Endpoints first, then interior ticks only when their measured bounds fit. */
internal fun collisionFreeAxisLabels(candidates: List<AxisCandidate>, left: Float, right: Float, gap: Float): List<AxisLabel> {
    if (!left.isFinite() || !right.isFinite() || right <= left) return emptyList()
    val ordered = candidates.distinctBy { it.text }
    val priority = if (ordered.size < 2) ordered else listOf(ordered.first(), ordered.last()) + ordered.drop(1).dropLast(1)
    val placed = mutableListOf<AxisLabel>()
    for (tick in priority) {
        if (!tick.width.isFinite() || tick.width <= 0 || tick.width > right-left) continue
        val start = (tick.anchor-tick.width/2).coerceIn(left, right-tick.width)
        if (placed.none { start < it.left+it.width+gap && start+tick.width+gap > it.left })
            placed += AxisLabel(tick.text, start, tick.width)
    }
    return placed.sortedBy { it.left }
}
internal fun chartHeightDp(fontScale: Float) = 150 + ((fontScale.coerceAtLeast(1f)-1f)*28).toInt()
