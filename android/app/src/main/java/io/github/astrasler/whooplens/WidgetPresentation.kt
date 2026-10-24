package io.github.astrasler.whooplens

/** Space budgets use launcher-reported dp, never pretend that dp are launcher cells. */
internal data class WidgetSpace(val width: Float, val height: Float, val fontScale: Float = 1f) {
    val labeled
        get() = width >= 110 * fontScale && height >= 60 * fontScale

    val footer
        get() = width >= 140 * fontScale && height >= 64 * fontScale

    val supporting
        get() =
            if (!footer) 0
            else
                ((height - 60 * fontScale) / (20 * fontScale))
                    .toInt()
                    .coerceIn(0, if (width >= 260) 4 else 2)
}

internal data class WidgetPresentation(
    val title: String,
    val primary: String,
    val supporting: String = "",
    val footer: String = "",
    val description: String = "",
    val stale: Boolean = false,
    val wide: Boolean = false,
)

internal fun widgetPresentation(
    snapshot: DashboardSnapshot?,
    account: String?,
    privacy: WidgetPrivacy,
    locked: Boolean,
    keys: List<String>,
    space: WidgetSpace,
    now: Long,
): WidgetPresentation {
    fun status(value: String, explanation: String) =
        WidgetPresentation(
            if (space.labeled) "WHOOP Lens" else "",
            value,
            description = explanation,
            footer = if (space.footer) "Tap to open" else "",
        )
    // Check ownership before selecting or formatting any cached metric.
    if (locked || privacy == WidgetPrivacy.HIDDEN)
        return status("Lock", "WHOOP Lens. Unlock to view.")
    if (account == null || (snapshot != null && snapshot.account != account))
        return status("Open", "Sign in to WHOOP Lens. No measurements displayed.")
    if (snapshot == null) return status("—", "No saved measurements. Open WHOOP Lens to refresh.")
    if (privacy != WidgetPrivacy.DETAILED)
        return status("Open", "Saved overview available. Open WHOOP Lens to view.")
    fun batch(key: String) =
        if (key in setOf("steps", "distance", "energy", "exercise")) snapshot.health
        else snapshot.whoop
    val selected = keys.map { key -> batch(key) to batch(key)?.metric(key) }
    val first = selected.firstOrNull()
    val metric = first?.second
    val stale =
        selected.take(1 + space.supporting).any { (b, m) ->
            b != null && (b.stale(now) || now - (m?.measuredAt ?: b.fetchedAt) > 12 * 3600000L)
        }
    val label =
        metric?.title ?: keys.firstOrNull()?.replaceFirstChar { it.uppercase() } ?: "WHOOP Lens"
    val exact = metric?.display() ?: "Not shared"
    val primary =
        metric?.value?.let { value ->
            if (metric.unit == "min") {
                if (space.width >= 100 * space.fontScale) duration(value).replace(" ", "")
                else
                    java.text
                        .DecimalFormat(if (space.width < 55) "0" else "0.#")
                        .format(value / 60) + "h"
            } else if (metric.key == "steps") {
                if (value >= 1000000) java.text.DecimalFormat("0.#").format(value / 1000000) + "M"
                else if (value >= 1000) java.text.DecimalFormat("0.#").format(value / 1000) + "k"
                else java.text.DecimalFormat("0").format(value)
            } else
                java.text.DecimalFormat("0.#").format(value) +
                    if (space.width < 55) "" else metric.unit.replace(" ", "")
        } ?: "—"
    val supporting =
        selected.drop(1).take(space.supporting).joinToString("\n") { (_, m) ->
            (when (m?.key) {
                "performance" -> "Performance"
                "respiratory" -> "Resp. rate"
                else -> m?.title ?: "Not shared"
            }) + "  " + (m?.display() ?: "\u2014")
        }
    val allDescription =
        selected.joinToString(". ") { (b, m) ->
            if (m == null) "Measurement not shared"
            else
                m.title +
                    ": " +
                    m.display() +
                    ". " +
                    (b?.source?.label ?: m.source.label) +
                    ". " +
                    (if (
                        b?.stale(now) == true ||
                            now - (m.measuredAt ?: b?.fetchedAt ?: now) > 12 * 3600000L
                    )
                        "Saved "
                    else "Read ") +
                    dateTime(m.measuredAt ?: b?.fetchedAt ?: now)
        }
    val sourceLabel =
        selected
            .take(1 + space.supporting)
            .mapNotNull { it.first?.source?.label }
            .distinct()
            .joinToString(" + ")
            .ifEmpty { "Not shared" }
    return WidgetPresentation(
        if (space.labeled) label else "",
        primary,
        supporting,
        if (space.footer) (if (stale) "Saved · " else "") + sourceLabel else "",
        label + ": " + exact + ". " + allDescription + ". Tap to open WHOOP Lens.",
        stale,
        space.width >= 260 * space.fontScale && space.height >= 110,
    )
}
