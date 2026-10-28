package io.github.astrasler.whooplens


// that WidgetPresentation can call after its existing privacy/account checks (which stay first).

internal enum class WidgetTier { ONE_BY_ONE, STRIP, PANEL }

internal enum class WidgetSource(val glyph: String, val label: String) {
    WHOOP("W", "WHOOP"),
    HEALTH_CONNECT("HC", "Health Connect"),
}

internal const val STALE_AFTER_MS = 12 * 3600_000L
internal const val VALUE_MIN_SP = 18f
internal const val VALUE_MAX_SP_1X1 = 20f

/**
 * 1×1  → value, source glyph; amber age badge only when stale. Exact time/source in description.
 * 2×1 · 4×1 → value, unit, source label, age. Secondary metrics drop first, then the progress bar.
 * 2×2 · 4×2 → heading, values, source, exact time, comparison. At fontScale ≥ 1.3 the 4-up grid
 *             becomes 2×2.
 * Uses launcher-reported dp (WidgetSpace), never assumed cell counts.
 */
internal fun widgetTier(space: WidgetSpace): WidgetTier =
    when {
        space.width < 110 * space.fontScale || space.height < 60 * space.fontScale -> WidgetTier.ONE_BY_ONE
        space.height < 110 * space.fontScale -> WidgetTier.STRIP
        else -> WidgetTier.PANEL
    }

/** Fontscale ≥ 1.3 also forces the compact layout for strips (board: "compact at 1.3×"). */
internal fun effectiveTier(space: WidgetSpace): WidgetTier {
    val t = widgetTier(space)
    return if (space.fontScale >= 1.3f && t == WidgetTier.STRIP && space.width < 220) WidgetTier.ONE_BY_ONE else t
}

/** Short age for the badge: "19h", "2d". Null when fresh. */
internal fun staleBadge(ageMs: Long): String? {
    if (ageMs <= STALE_AFTER_MS) return null
    val h = ageMs / 3600_000L
    return if (h < 48) "${h}h" else "${h / 24}d"
}

internal data class CompactContent(
    val value: String,
    val glyph: String,
    val badge: String?,
    /** Spoken by TalkBack; carries what was moved out of the 1×1. */
    val description: String,
)

internal fun compactContent(
    title: String,
    value: String,
    source: WidgetSource,
    measuredAtText: String,
    ageMs: Long,
): CompactContent {
    val badge = staleBadge(ageMs)
    val freshness = if (badge == null) "updated $measuredAtText" else "not updated for $badge, last $measuredAtText"
    return CompactContent(
        value = value,
        glyph = source.glyph,
        badge = badge,
        description = "$title $value from ${source.label}, $freshness. Double-tap to open WhoopLens.",
    )
}
