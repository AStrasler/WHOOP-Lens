package io.github.astrasler.whooplens

import android.app.Activity
import android.app.Instrumentation
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.view.MotionEvent
import android.view.View
import android.widget.TextView
import androidx.core.graphics.ColorUtils
import java.io.File

/** Synthetic component renders only; never signs in or reads health data. */
class GlassyAcceptanceInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        val result = Bundle()
        try {
            var renders = 0
            val directory = File(targetContext.getExternalFilesDir(null), "glassy-acceptance").apply { mkdirs() }
            for (width in listOf(360, 412, 480)) for (font in listOf(1f, 2f))
                for (choice in listOf(AppearanceChoice.GLASS, AppearanceChoice.REDUCED_TRANSPARENCY, AppearanceChoice.BATTERY_SAVER)) {
                    runOnMainSync {
                        val config = Configuration(targetContext.resources.configuration).apply {
                            fontScale = font; screenWidthDp = width
                        }
                        val context = targetContext.createConfigurationContext(config)
                        val ui = LensUi(context)
                        ui.appearance = resolveAppearance(AppearanceInputs(choice, false, true, 0f))
                        val root = ui.column(18)
                        var opened = 0
                        val button = ui.button(root, "Open recovery measurements", primary = true) { opened++ }
                        val tiles = mutableListOf<View>()
                        ui.pair(root, { parent ->
                            tiles += ui.statsCard(parent, "HRV", "64 ms", "♥", "↑ 10% vs baseline", DataSource.WHOOP) { opened++ }
                        }, { parent ->
                            tiles += ui.statsCard(parent, "Resting HR", "52 bpm", "◉", null, DataSource.WHOOP) { opened++ }
                        })
                        val pixels = ui.dp(width)
                        root.measure(View.MeasureSpec.makeMeasureSpec(pixels, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
                        root.layout(0, 0, pixels, root.measuredHeight)
                        check(button.height >= ui.dp(48))
                        button.performClick()
                        for (tile in tiles) {
                            check(tile.height >= ui.dp(48) && tile.isFocusable)
                            check(tile.createAccessibilityNodeInfo().className == "android.widget.Button")
                            tile.performClick()
                            val event = MotionEvent.obtain(0, 0, MotionEvent.ACTION_DOWN, 1f, 1f, 0)
                            tile.dispatchTouchEvent(event); event.recycle()
                            check(tile.translationY == 0f) // Remove animations is active in every render.
                        }
                        check(opened == 3)
                        fun checkText(view: View) {
                            if (view is TextView) {
                                val layout = view.layout
                                check(layout != null && layout.height <= view.height - view.paddingTop - view.paddingBottom)
                                for (line in 0 until layout.lineCount) check(layout.getLineWidth(line) <= layout.width + 1)
                            }
                            if (view is android.view.ViewGroup) for (i in 0 until view.childCount) checkText(view.getChildAt(i))
                        }
                        checkText(root)
                        // Worst primary gradient stop and secondary opaque backing.
                        check(ColorUtils.calculateContrast(LensColors.onTeal, android.graphics.Color.rgb(61,188,184)) >= 4.5)
                        check(ColorUtils.calculateContrast(LensColors.teal, android.graphics.Color.rgb(70,90,103)) >= 4.5)
                        val bitmap = Bitmap.createBitmap(pixels, root.height, Bitmap.Config.ARGB_8888)
                        val canvas = Canvas(bitmap); canvas.drawColor(LensColors.background); root.draw(canvas)
                        File(directory, "${width}dp-${(font*100).toInt()}-${choice.name}.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                        bitmap.recycle(); renders++
                    }
                }
            result.putString("result", "PASS: $renders synthetic width/font/appearance renders; independent clicks, text fit, contrast, touch targets, accessibility roles and remove-animations. Not Samsung hardware approval.")
            finish(Activity.RESULT_OK, result)
        } catch (error: Throwable) {
            result.putString("failure", error.toString()); finish(Activity.RESULT_CANCELED, result)
        }
    }
}
