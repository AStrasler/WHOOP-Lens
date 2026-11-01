package io.github.astrasler.whooplens

import android.app.Instrumentation
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.TextView

/**
 * #102 native widget checks on an emulator. Separate test APK only; synthetic fixtures, no
 * personal data. Covers all seven providers' installed metadata, text fit at launcher-like sizes
 * from 1x1 through 4x2 at 100%, 130% and 200% fonts, and accessibility descriptions. This is a
 * native RemoteViews render, not a Samsung One UI placement test.
 */
class WidgetFitInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        start()
    }

    private val failures = mutableListOf<String>()
    private var checks = 0

    private fun expect(ok: Boolean, what: () -> String) {
        checks++
        if (!ok) failures += what()
    }

    private fun measured(context: Context, view: View, widthDp: Float, heightDp: Float) {
        val density = context.resources.displayMetrics.density
        val w = (widthDp * density).toInt()
        val h = (heightDp * density).toInt()
        view.measure(
            View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY),
        )
        view.layout(0, 0, w, h)
    }

    /** Text fits when it is laid out, not ellipsized, and inside its view in both axes. */
    private fun fits(text: TextView): Boolean {
        val layout = text.layout ?: return false
        if (text.width <= 0 || text.height <= 0 || layout.lineCount == 0) return false
        val available = text.width - text.totalPaddingLeft - text.totalPaddingRight + 1
        val tall = text.height - text.totalPaddingTop - text.totalPaddingBottom + 1
        return (0 until layout.lineCount).all {
            layout.getEllipsisCount(it) == 0 && layout.getLineWidth(it) <= available
        } && layout.height <= tall
    }

    private fun visibleTexts(view: View): List<TextView> =
        when {
            view.visibility != View.VISIBLE -> emptyList()
            view is TextView -> listOf(view)
            view is ViewGroup -> (0 until view.childCount).flatMap { visibleTexts(view.getChildAt(it)) }
            else -> emptyList()
        }

    override fun onStart() {
        val results = Bundle()
        try {
            val providers = AppWidgetManager.getInstance(targetContext).installedProviders
            // Metadata for all seven providers, including the status widget.
            for (type in LensWidgets.profiles.keys) {
                val info = providers.single { it.provider.className == type.name }
                val name = type.simpleName
                expect(info.targetCellWidth == 1 && info.targetCellHeight == 1) { "$name target cell" }
                val density = targetContext.resources.displayMetrics.density
                expect(info.minResizeWidth <= (40 * density + 1) && info.minResizeHeight <= (40 * density + 1)) {
                    "$name min resize ${info.minResizeWidth}x${info.minResizeHeight}px"
                }
                expect(info.maxResizeWidth > info.minResizeWidth && info.maxResizeHeight > info.minResizeHeight) {
                    "$name max resize"
                }
                expect(info.resizeMode == (AppWidgetProviderInfo.RESIZE_HORIZONTAL or AppWidgetProviderInfo.RESIZE_VERTICAL)) {
                    "$name resize mode"
                }
                expect(info.previewLayout == R.layout.lens_widget_preview) { "$name preview" }
                expect(info.widgetCategory and AppWidgetProviderInfo.WIDGET_CATEGORY_KEYGUARD == 0) {
                    "$name opts into keyguard"
                }
                if (Build.VERSION.SDK_INT >= 36)
                    expect(info.widgetCategory and AppWidgetProviderInfo.WIDGET_CATEGORY_NOT_KEYGUARD != 0) {
                        "$name missing not_keyguard"
                    }
            }

            val now = System.currentTimeMillis()
            fun m(key: String, title: String, value: Double, unit: String, s: DataSource) =
                Metric(key, title, value, unit, s, now, if (s == DataSource.HEALTH_CONNECT) "com.example.test-writer" else null)
            val w = DataSource.WHOOP
            val h = DataSource.HEALTH_CONNECT
            val snapshot =
                DashboardSnapshot(
                    "fit-test",
                    DataBatch(w, now, listOf(
                        m("recovery", "Recovery", 72.0, "%", w), m("strain", "Strain", 11.4, "/ 21", w),
                        m("sleep", "Sleep", 458.0, "min", w), m("hrv", "HRV", 64.0, "ms", w),
                        m("rhr", "Resting HR", 52.0, "bpm", w), m("respiratory", "Respiratory rate", 15.2, "rpm", w),
                        m("spo2", "Blood oxygen", 97.0, "%", w), m("performance", "Sleep performance", 91.0, "%", w),
                    )),
                    DataBatch(h, now, listOf(
                        m("steps", "Steps", 18412.0, "steps", h), m("distance", "Distance", 6.1, "km", h),
                        m("exercise", "Exercise", 42.0, "min", h),
                    )),
                )
            // Launcher-like bounds from one cell to four by two: the Android table's handset cells
            // (57dp wide, 51dp landscape height minimum) and wider cells like a 4-column grid on a
            // large phone. Not measured One UI cells.
            val widths = listOf(57f, 96f, 130f, 180f, 276f, 320f, 384f)
            val heights = listOf(51f, 56f, 102f, 130f, 220f, 250f, 262f)
            val fonts = listOf(1f, 1.3f, 2f)
            var renders = 0

            for (font in fonts) {
                val context = targetContext.createConfigurationContext(
                    Configuration(targetContext.resources.configuration).apply { fontScale = font })
                // Status widget: every lock-surface text at every size.
                val statusTexts = WidgetPrivacy.values().flatMap { privacy ->
                    listOf(null, "fit-test").flatMap { account ->
                        listOf(true, false).map { locked ->
                            widgetText(snapshot, account, privacy, locked, true, emptyList(), now)
                        }
                    }
                }.distinct()
                for (width in widths) for (height in heights) for (text in statusTexts) {
                    runOnMainSync {
                        val view = LensWidgets.statusViews(context, text, width, height).apply(context, null)
                        measured(context, view, width, height)
                        val body = view.findViewById<TextView>(R.id.widget_body)
                        val label = "Status ${width}x$height font=$font text=${text.replace('\n', '|')}"
                        expect(fits(body)) {
                            "$label does not fit (lines=${body.layout?.lineCount} textHeight=${body.layout?.height} box=${body.height})"
                        }
                        expect(visibleTexts(view).all(::fits)) { "$label: a visible line is clipped" }
                        val described = body.contentDescription?.toString() ?: body.text.toString()
                        expect(described == text || body.text.toString() == text) { "$label: full status not accessible" }
                    }
                    renders++
                }
                // Measurement widgets: primary value fits; the whole widget is described.
                for ((type, keys) in LensWidgets.profiles.filterKeys { it != PrivateLockWidget::class.java })
                    for (width in widths) for (height in heights) for (privacy in listOf(WidgetPrivacy.DETAILED, WidgetPrivacy.SUMMARY)) {
                        runOnMainSync {
                            val content = widgetPresentation(snapshot, "fit-test", privacy, false, keys,
                                WidgetSpace(width, height, font), now)
                            val view = LensWidgets.responsiveViews(context, content).apply(context, null)
                            measured(context, view, width, height)
                            val label = "${type.simpleName} ${width}x$height font=$font $privacy"
                            val primary = view.findViewById<TextView>(R.id.widget_body)
                            expect(fits(primary)) {
                                "$label primary '${primary.text}' textHeight=${primary.layout?.height} box=${primary.height}"
                            }
                            val description = view.findViewById<View>(R.id.widget_root).contentDescription?.toString().orEmpty()
                            expect(description.isNotBlank()) { "$label has no accessibility description" }
                            if (privacy == WidgetPrivacy.SUMMARY)
                                expect(listOf("18,412", "18412", "11.4", "458").none { description.contains(it) }) {
                                    "$label summary description reveals a measurement"
                                }
                        }
                        renders++
                    }
            }
            results.putInt("widget_fit_checks", checks)
            results.putInt("widget_fit_renders", renders)
            if (failures.isEmpty()) {
                results.putString("result", "PASS: $renders widget renders, $checks checks")
                finish(Activity_RESULT_OK, results)
            } else {
                results.putString("result", "FAIL: ${failures.size} of $checks checks\n" + failures.take(60).joinToString("\n"))
                finish(Activity_RESULT_FAILED, results)
            }
        } catch (t: Throwable) {
            results.putString("result", "FAIL: " + t.stackTraceToString().take(3000))
            finish(Activity_RESULT_FAILED, results)
        }
    }

    private companion object {
        const val Activity_RESULT_OK = -1
        const val Activity_RESULT_FAILED = 0
    }
}
