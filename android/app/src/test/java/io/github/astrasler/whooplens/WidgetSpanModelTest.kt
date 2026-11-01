package io.github.astrasler.whooplens

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/**
 * #102: models AOSP Launcher3's dp-to-span rule (LauncherAppWidgetProviderInfo.getSpanX/Y:
 * ceil((size + padding + spacing) / (cell + spacing))) to justify the maxResize hints. Samsung
 * One UI is closed source; this is evidence for the choice, not a One UI result.
 */
class WidgetSpanModelTest {
    private fun span(sizeDp: Float, cellDp: Float, paddingDp: Float) =
        maxOf(1, kotlin.math.ceil((sizeDp + paddingDp) / cellDp).toInt())

    private fun hint(name: String): Pair<Float, Float> {
        val root =
            generateSequence(File("").absoluteFile) { it.parentFile }
                .first { File(it, "android/app/src/main/res/xml").isDirectory }
        val xml = File(root, "android/app/src/main/res/xml/$name.xml").readText()
        fun dp(attr: String) = Regex("""android:$attr="(\d+)dp"""").find(xml)!!.groupValues[1].toFloat()
        return dp("maxResizeWidth") to dp("maxResizeHeight")
    }

    private val providers =
        listOf("daily", "recovery", "steps", "sleep", "vitals", "expanded", "private_lock").map { "widget_$it" }

    @Test
    fun heightHintStopsAtTwoRowsAndReachesTwoOnPhoneGrids() {
        // Row pitch for 4-6 row phone grids is roughly 100-165dp. "Padding" folds the widget
        // padding and cell spacing Launcher3 adds (about 12-20dp on current grids).
        for (name in providers) {
            val (_, height) = hint(name)
            for (row in listOf(100f, 108f, 117f, 130f, 140f, 165f))
                for (padding in listOf(12f, 16f, 20f)) {
                    val rows = span(height, row, padding)
                    assertEquals("$name row=$row pad=$padding", 2, rows)
                }
        }
    }

    @Test
    fun widthHintReachesFourColumnsOnFourColumnGridsAndCapsCommonFiveColumnGrids() {
        for (name in providers) {
            val (width, _) = hint(name)
            for (padding in listOf(12f, 16f, 20f)) {
                // Four columns: the grid itself caps at 4; the hint must not stop at 3 for
                // column pitches up to 96dp (4-column grids on 360-412dp-wide phones).
                for (cell in listOf(84f, 90f, 96f))
                    assertTrue("$name 4-col cell=$cell pad=$padding", minOf(4, span(width, cell, padding)) == 4)
                // Five columns at pitches of 76dp and up (5-column grids on phones about 400dp wide
                // and wider) stay at 4.
                for (cell in listOf(76f, 78f, 83f))
                    assertTrue("$name 5-col cell=$cell pad=$padding -> ${span(width, cell, padding)}",
                        span(width, cell, padding) <= 4)
            }
        }
    }

    @Test
    fun narrowFiveColumnGridsAreTheDocumentedLimit() {
        // Below about 76dp column pitch Launcher3's rounding allows a fifth column. Recorded so a
        // future hint change has to revisit the limitation in docs/android-widget-sizing.md.
        val (width, _) = hint("widget_daily")
        assertEquals(5, span(width, 70f, 16f))
    }
}
