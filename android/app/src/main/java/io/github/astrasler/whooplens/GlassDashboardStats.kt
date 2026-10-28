package io.github.astrasler.whooplens

import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.widget.LinearLayout
import java.text.DecimalFormat
import kotlin.math.abs

/**
 * Native counterpart to the supplied React StatsCard / Recharts references.
 * Read-only: consumes the existing account-scoped dashboard snapshot and adds no network calls.
 */
internal data class DashboardPercentTrend(val amount: Double, val direction: Int)

internal fun dashboardPercentTrend(metric: Metric?, series: List<Point>): DashboardPercentTrend? {
    val current = metric?.value ?: return null
    val measured = metric.measuredAt ?: return null
    if (!current.isFinite()) return null
    val previous = series
        .filter { it.time < measured && it.value?.isFinite() == true }
        .maxByOrNull { it.time }?.value ?: return null
    if (previous == 0.0) return null
    val percent = (current - previous) / abs(previous) * 100.0
    if (!percent.isFinite()) return null
    return DashboardPercentTrend(
        amount = abs(percent),
        direction = percent.compareTo(0.0),
    )
}

internal object GlassDashboardStats {
    private data class Spec(
        val label: String,
        val key: String,
        val source: DataSource,
        val symbol: String,
    )

    private val specs = listOf(
        Spec("Recovery", "recovery", DataSource.WHOOP, "♥"),
        Spec("Strain", "strain", DataSource.WHOOP, "↗"),
        Spec("Sleep", "sleep", DataSource.WHOOP, "☾"),
        Spec("Steps", "steps", DataSource.HEALTH_CONNECT, "◉"),
    )

    fun render(
        root: LinearLayout,
        ui: LensUi,
        snapshot: DashboardSnapshot?,
        onOpen: (String, DataSource) -> Unit,
    ) {
        ui.heading(root, "At a glance")
        val oneColumn = ui.context.resources.configuration.fontScale > 1.3f ||
            ui.context.resources.configuration.screenWidthDp < 360
        for (group in specs.chunked(if (oneColumn) 1 else 2)) {
            if (oneColumn) {
                val spec = group.single()
                ui.add(root, card(ui, snapshot, spec) { onOpen(spec.key, spec.source) }, 8)
            } else {
                val row = ui.row().apply { gravity = Gravity.TOP }
                for ((index, spec) in group.withIndex()) {
                    row.addView(
                        card(ui, snapshot, spec) { onOpen(spec.key, spec.source) },
                        LinearLayout.LayoutParams(0, -2, 1f).apply {
                            if (index > 0) marginStart = ui.dp(6)
                            if (index == 0) marginEnd = ui.dp(6)
                        },
                    )
                }
                ui.add(root, row, 10)
            }
        }

        val recoveryPoints = chartSlots(
            snapshot?.whoop?.series?.get("recovery").orEmpty(),
            7,
            System.currentTimeMillis(),
        )
        if (recoveryPoints.count { it.value?.isFinite() == true } >= 2) {
            ui.card(root) { panel ->
                ui.heading(panel, "Recovery trend · 7 days")
                panel.addView(
                    TrendChart(ui.context, recoveryPoints, DataSource.WHOOP),
                    LinearLayout.LayoutParams(-1, ui.dp(150)),
                )
                ui.add(
                    panel,
                    ui.text("WHOOP · recorded values only · tap chart points", 12f, LensColors.muted),
                    4,
                )
                ui.button(panel, "View recovery history") {
                    onOpen("recovery", DataSource.WHOOP)
                }
            }
        }
    }

    private fun card(
        ui: LensUi,
        snapshot: DashboardSnapshot?,
        spec: Spec,
        onClick: () -> Unit,
    ): LinearLayout {
        val batch = if (spec.source == DataSource.WHOOP) snapshot?.whoop else snapshot?.health
        val metric = batch?.metric(spec.key)
        val trend = dashboardPercentTrend(metric, batch?.series?.get(spec.key).orEmpty())
        val isStale = batch?.stale(System.currentTimeMillis()) == true
        val tile = ui.column(14).apply {
            minimumHeight = ui.dp(184)
            background = ui.glassBackground(
                GlassRole.TILE,
                dashed = spec.source == DataSource.HEALTH_CONNECT,
            )
            elevation = ui.dp(10).toFloat()
            isClickable = true
            isFocusable = true
        }
        val titleRow = ui.row()
        titleRow.addView(
            ui.text(spec.label, 14f, LensColors.muted, bold = true),
            LinearLayout.LayoutParams(0, -2, 1f),
        )
        titleRow.addView(
            ui.text(spec.symbol, 19f, if (spec.source == DataSource.WHOOP) LensColors.teal else LensColors.sand),
        )
        ui.add(tile, titleRow, 6)

        val hasValue = metric?.value?.isFinite() == true
        ui.add(
            tile,
            ui.text(
                if (hasValue) metric!!.display() else "Not shared",
                if (hasValue) 22f else 14f,
                if (isStale) LensColors.amber else LensColors.text,
                bold = hasValue,
                role = if (hasValue) TextRole.MONO else TextRole.BODY,
            ),
            2,
        )

        val trendLabel = if (trend == null) {
            "No prior comparison"
        } else {
            val arrow = when {
                trend.direction > 0 -> "↑"
                trend.direction < 0 -> "↓"
                else -> "→"
            }
            arrow + " " + DecimalFormat("0.#").format(trend.amount) + "% vs previous"
        }
        ui.add(tile, ui.text(trendLabel, 12f, LensColors.muted), 4)
        ui.add(
            tile,
            ui.text(
                spec.source.label + (metric?.measuredAt?.let { " · " + dateTime(it) } ?: " · no measurement"),
                12f,
                if (isStale) LensColors.amber else LensColors.label,
            ),
            0,
        )

        tile.contentDescription = spec.label + ", " +
            (if (hasValue) metric!!.display() else "not shared") + ", " +
            trendLabel + ", " + spec.source.label + ". Open details"
        tile.foreground = RippleDrawable(
            ColorStateList.valueOf(0x224FD8CF),
            null,
            GradientDrawable().apply {
                cornerRadius = ui.dp(24).toFloat()
                setColor(0xFFFFFFFF.toInt())
            },
        )
        tile.setOnClickListener { onClick() }
        tile.setOnTouchListener { v: View, event: MotionEvent ->
            if (!ui.appearance.reduceMotion) {
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN ->
                        v.animate().translationY(-ui.dp(3).toFloat()).setDuration(120).start()
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL ->
                        v.animate().translationY(0f).setDuration(120).start()
                }
            }
            false
        }
        return tile
    }
}
