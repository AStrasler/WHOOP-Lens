package io.github.astrasler.whooplens

import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.widget.LinearLayout
import android.text.TextUtils
import android.util.TypedValue
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button

/**
 * Native counterpart to the supplied React StatsCard / Recharts references.
 * Read-only: consumes the existing account-scoped dashboard snapshot and adds no network calls.
 */
internal object GlassDashboardStats {
    private data class Spec(
        val label: String,
        val key: String,
        val source: DataSource,
    )

    private val specs = listOf(
        Spec("Recovery", "recovery", DataSource.WHOOP),
        Spec("Strain", "strain", DataSource.WHOOP),
        Spec("Sleep", "sleep", DataSource.WHOOP),
        Spec("Steps", "steps", DataSource.HEALTH_CONNECT),
    )

    fun render(
        root: LinearLayout,
        ui: LensUi,
        snapshot: DashboardSnapshot?,
        onOpen: (String, DataSource) -> Unit,
    ) {
        ui.heading(root, "Overview")
        ui.add(root, ui.text("Recent comparisons and refresh status · measurements in your Home cards", 12f, LensColors.muted))
        val columns = metricsPerRow(ui.context.resources.configuration.fontScale,
            ui.context.resources.configuration.screenWidthDp).coerceAtMost(2)
        val oneColumn = columns == 1
        for (group in specs.chunked(columns)) {
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
        if (showOverviewChart(recoveryPoints)) {
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
        val trendLabel = dashboardPeriodLabel(spec.key, trend)
        val updatedAt = dashboardUpdatedAt(spec.key, metric, batch)
        val freshness = updatedAt?.let { "Updated " + dateTime(it) } ?: "Update time unavailable"
        val isStale = batch?.stale(System.currentTimeMillis()) == true
        val tile = ui.column(14).apply {
            minimumHeight = ui.dp(184)
            background = ui.glassBackground(
                GlassRole.TILE,
                dashed = spec.source == DataSource.HEALTH_CONNECT,
            )
            ui.applyElevation(this)
            isClickable = true
            isFocusable = true
            accessibilityDelegate = object : View.AccessibilityDelegate() {
                override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
                    super.onInitializeAccessibilityNodeInfo(host, info)
                    info.className = Button::class.java.name
                }
            }
            // The tile announces one complete description rather than each child separately.
            descendantFocusability = android.view.ViewGroup.FOCUS_BLOCK_DESCENDANTS
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }
        val titleRow = ui.row()
        titleRow.addView(
            ui.text(spec.label, 14f, LensColors.muted, bold = true),
            LinearLayout.LayoutParams(0, -2, 1f),
        )
        titleRow.addView(
            OverviewIcon(ui, spec.key, if (spec.source == DataSource.WHOOP) LensColors.teal else LensColors.sand),
            LinearLayout.LayoutParams(ui.dp(24), ui.dp(24)),
        )
        ui.add(tile, titleRow, 6)

        val hasValue = metric?.value?.isFinite() == true
        ui.add(
            tile,
            ui.text(
                if (hasValue) trendLabel else "Not shared",
                if (hasValue && trend != null) 22f else 14f,
                if (isStale) LensColors.amber else LensColors.text,
                bold = hasValue,
                role = if (hasValue && trend != null) TextRole.MONO else TextRole.BODY,
            ).apply {
                setSingleLine(true)
                ellipsize = TextUtils.TruncateAt.END
                setAutoSizeTextTypeUniformWithConfiguration(12, 22, 1, TypedValue.COMPLEX_UNIT_SP)
            },
            2,
        )

        val comparison = trend?.let { "Compared with " + dateTime(it.previousAt) }
            ?: if (spec.key == "strain") "No cycle comparison" else if (spec.key == "steps") "Daily total is partial" else "Prior record must be within 48 hours"
        ui.add(tile, ui.text(comparison, 12f, LensColors.muted), 4)
        val status = if (isStale) "Stale" else if (batch == null) "Not refreshed" else "Cached snapshot"
        ui.add(tile, ui.text(spec.source.label + " · " + freshness + " · " + status,
            12f, if (isStale) LensColors.amber else LensColors.label), 0)

        tile.contentDescription = spec.label + ", " +
            (if (hasValue) trendLabel else "not shared") + ", " + comparison + ", " +
            spec.source.label + ", " + freshness + ", " + status + ". Open details"
        tile.foreground = if (ui.appearance.reduceMotion) null else RippleDrawable(
            ColorStateList.valueOf(0x224FD8CF),
            null,
            GradientDrawable().apply {
                cornerRadius = ui.dp(GlassTokens.radiusTile).toFloat()
                setColor(0xFFFFFFFF.toInt())
            },
        )
        fun silenceChildren(group: android.view.ViewGroup) {
            for (i in 0 until group.childCount) {
                val child = group.getChildAt(i)
                child.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                if (child is android.view.ViewGroup) silenceChildren(child)
            }
        }
        silenceChildren(tile)
        tile.setOnClickListener { onClick() }
        tile.setOnTouchListener { v: View, event: MotionEvent ->
            if (ui.appearance.reduceMotion) {
                v.animate().cancel()
                v.translationY = 0f
            } else {
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
