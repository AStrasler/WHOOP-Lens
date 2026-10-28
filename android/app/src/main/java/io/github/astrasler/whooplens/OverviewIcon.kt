package io.github.astrasler.whooplens

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.view.View

/** Stroke icons avoid font fallback and Samsung emoji substitution. */
internal class OverviewIcon(ui: LensUi, private val key: String, color: Int) : View(ui.context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color
        style = Paint.Style.STROKE
        strokeWidth = 1.8f
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }

    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.save()
        canvas.scale(width / 24f, height / 24f)
        val path = Path()
        when (key) {
            "recovery" -> {
                path.moveTo(12f, 21f)
                path.cubicTo(-7f, 8f, 5f, -2f, 12f, 7f)
                path.cubicTo(19f, -2f, 31f, 8f, 12f, 21f)
            }
            "strain" -> {
                path.moveTo(4f, 19f); path.lineTo(20f, 5f)
                path.moveTo(10f, 5f); path.lineTo(20f, 5f); path.lineTo(20f, 15f)
            }
            "sleep" -> {
                path.moveTo(18f, 3f)
                path.cubicTo(0f, -2f, 0f, 26f, 21f, 19f)
                path.cubicTo(10f, 18f, 10f, 7f, 18f, 3f)
            }
            else -> {
                canvas.drawOval(4f, 3f, 10f, 14f, paint)
                canvas.drawOval(14f, 10f, 20f, 21f, paint)
            }
        }
        canvas.drawPath(path, paint)
        canvas.restore()
    }
}
