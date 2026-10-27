package io.github.astrasler.whooplens

internal data class HealthPage<T>(val rows: List<T>, val next: String?)

internal data class HealthPages<T>(val rows: List<T>, val complete: Boolean)

internal suspend fun <T> readHealthPages(read: suspend (String?) -> HealthPage<T>): HealthPages<T> {
    val rows = mutableListOf<T>()
    val seen = mutableSetOf<String>()
    var cursor: String? = null
    repeat(5) {
        val p = read(cursor)
        rows.addAll(p.rows)
        cursor = p.next?.takeIf { it.isNotBlank() }
        if (cursor == null) return HealthPages(rows, true)
        check(seen.add(cursor!!)) { "Repeated page" }
    }
    return HealthPages(rows, false)
}

internal fun asleepMinutes(stages: List<SleepStage>): Double? {
    val known =
        stages
            .filter { it.label in setOf("REM", "Deep", "Light", "Asleep") && it.end > it.start }
            .sortedBy { it.start }
    if (known.isEmpty()) return null
    var end = Long.MIN_VALUE
    var total = 0L
    for (stage in known) {
        total += (stage.end - maxOf(stage.start, end)).coerceAtLeast(0)
        end = maxOf(end, stage.end)
    }
    return total / 60000.0
}
