package io.github.astrasler.whooplens

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.*
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.RippleDrawable
import android.view.MotionEvent
import android.view.View
import android.widget.*
import androidx.core.view.ViewCompat
import kotlin.math.*

internal enum class TextRole { HAND, BODY, MONO }

internal object LensColors {
    val background = GlassTokens.ground
    val top = GlassTokens.groundTop
    val card = GlassTokens.solidReduced
    val inset = Color.rgb(14, 26, 30)
    val edge = GlassTokens.edgeReduced
    val text = GlassTokens.text
    val muted = GlassTokens.textSecondary
    val label = GlassTokens.label
    val teal = GlassTokens.teal
    val sand = GlassTokens.sand
    val amber = GlassTokens.stale
    val error = GlassTokens.error
    val onTeal = Color.rgb(3, 32, 31)
}

internal class LensUi(val context: Context) {
    var appearance: AppearanceState =
        resolveAppearance(
            AppearanceInputs(AppearanceChoice.AUTO, powerSave = false, blurAvailable = true, animatorScale = 1f)
        )

    fun dp(n: Int) = (n * context.resources.displayMetrics.density + 0.5f).toInt()

    private val inter by lazy { context.resources.getFont(R.font.inter) }
    private val mono by lazy { context.resources.getFont(R.font.jetbrains_mono) }
    private val hand by lazy { context.resources.getFont(R.font.covered_by_your_grace) }
    private val surfaces by lazy { GlassSurface(context) }

    fun applyElevation(view: View) = surfaces.applyElevation(view, appearance.mode)

    fun glassBackground(role: GlassRole, dashed: Boolean = false, edgeColor: Int? = null) =
        surfaces.background(role, appearance.mode, dashed, edgeColor)

    fun blurBehind(content: View, open: Boolean) = surfaces.blurBehind(content, appearance, open)

    fun text(
        value: String,
        size: Float = 14f,
        color: Int = LensColors.text,
        bold: Boolean = false,
        numbers: Boolean = false,
        role: TextRole? = null,
    ): TextView {
        val requested = role ?: if (numbers) TextRole.MONO else TextRole.BODY
        val resolved =
            if (requested == TextRole.HAND && (size < 20f || value.any { it.isDigit() })) TextRole.BODY
            else requested
        return TextView(context).apply {
            text = value
            textSize = if (resolved == TextRole.HAND) size.coerceAtLeast(20f) else size.coerceAtLeast(12f)
            setTextColor(color)
            typeface =
                Typeface.create(
                    when (resolved) {
                        TextRole.HAND -> hand
                        TextRole.MONO -> mono
                        TextRole.BODY -> inter
                    },
                    if (bold && resolved != TextRole.HAND) Typeface.BOLD else Typeface.NORMAL,
                )
            setLineSpacing(dp(3).toFloat(), 1f)
            includeFontPadding = false
            setPadding(0, dp(3), 0, dp(3))
        }
    }

    fun column(pad: Int = 0) =
        LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(pad), dp(pad), dp(pad), dp(pad))
        }

    fun row() =
        LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
        }

    fun shape(color: Int = LensColors.card, radius: Int = 24, dashed: Boolean = false) =
        GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(color, LensColors.inset))
            .apply {
                cornerRadius = dp(radius).toFloat()
                setStroke(
                    dp(1),
                    LensColors.edge,
                    if (dashed) dp(4).toFloat() else 0f,
                    if (dashed) dp(3).toFloat() else 0f,
                )
            }

    fun add(parent: LinearLayout, view: View, gap: Int = 8) {
        parent.addView(view, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(gap) })
    }

    fun heading(parent: LinearLayout, title: String) {
        val view =
            text(title, 24f, LensColors.text, role = TextRole.HAND).apply {
                ViewCompat.setAccessibilityHeading(this, true)
            }
        add(parent, view, 8)
    }

    fun card(
        parent: LinearLayout,
        dashed: Boolean = false,
        edgeColor: Int? = null,
        block: (LinearLayout) -> Unit,
    ): LinearLayout {
        val c = column(18)
        c.background = glassBackground(GlassRole.CARD, dashed, edgeColor)
        surfaces.applyElevation(c, appearance.mode)
        add(parent, c, 16)
        block(c)
        return c
    }

    fun chip(parent: LinearLayout, source: DataSource) {
        val health = source == DataSource.HEALTH_CONNECT
        val color = if (health) LensColors.sand else LensColors.teal
        val t = text(source.label, 12f, color, true, role = TextRole.BODY)
        t.minHeight = dp(26)
        t.gravity = android.view.Gravity.CENTER_VERTICAL
        t.background = glassBackground(GlassRole.CHIP, health, color)
        t.setPadding(dp(10), dp(4), dp(10), dp(4))
        parent.addView(t, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(8) })
    }

    /**
     * Frosted, raised pills with a restrained highlight. Rendered natively so no
     * React/Framer runtime or continuous animation is needed on Android.
     */
    private fun liquidButtonBackground(primary: Boolean): android.graphics.drawable.Drawable {
        val fill = GradientDrawable(
            GradientDrawable.Orientation.TL_BR,
            if (primary) intArrayOf(Color.rgb(195, 255, 246), Color.rgb(112, 228, 218), Color.rgb(61, 188, 184))
            else if (appearance.mode == LensAppearance.REDUCED_TRANSPARENCY)
                intArrayOf(GlassTokens.solidReduced, GlassTokens.solidReduced)
            else intArrayOf(Color.argb(224, 70, 90, 103), Color.argb(208, 28, 45, 55)),
        ).apply {
            cornerRadius = dp(22).toFloat()
            setStroke(dp(1), if (primary) Color.argb(196, 255, 255, 255) else GlassTokens.edgeReduced)
        }
        if (appearance.mode != LensAppearance.GLASS) return fill
        val highlight = GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            intArrayOf(Color.argb(72, 255, 255, 255), Color.argb(8, 255, 255, 255), Color.TRANSPARENT),
        ).apply { cornerRadius = dp(22).toFloat() }
        return LayerDrawable(arrayOf(fill, highlight))
    }

    /** A one-time lift on pointer/press; respects Android reduced motion and saver mode. */
    @android.annotation.SuppressLint("ClickableViewAccessibility")
    private fun liftOnInteraction(view: View, amountDp: Int) {
        if (appearance.reduceMotion || appearance.mode != LensAppearance.GLASS) return
        fun move(raised: Boolean) {
            view.animate().cancel()
            view.animate()
                .translationY(if (raised) -dp(amountDp).toFloat() else 0f)
                .setDuration(if (raised) 120L else 160L)
                .start()
        }
        view.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> move(true)
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> move(false)
            }
            false // Preserve normal clicks, accessibility activation and focus.
        }
        view.setOnHoverListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_HOVER_ENTER -> move(true)
                MotionEvent.ACTION_HOVER_EXIT -> move(false)
            }
            false
        }
    }

    fun button(
        parent: LinearLayout,
        title: String,
        primary: Boolean = false,
        enabled: Boolean = true,
        action: () -> Unit,
    ): TextView {
        val b =
            text(title, 14f, if (primary) LensColors.onTeal else LensColors.teal, true, role = TextRole.BODY)
                .apply {
                gravity = android.view.Gravity.CENTER
                minHeight = dp(48)
                setPadding(dp(12), dp(12), dp(12), dp(12))
                isEnabled = enabled
                isFocusable = true
                isClickable = true
                background = RippleDrawable(
                    ColorStateList.valueOf(0x334FD8CF),
                    liquidButtonBackground(primary),
                    null,
                )
                if (!enabled) {
                    alpha = 0.65f
                    setTextColor(LensColors.muted)
                } else liftOnInteraction(this, 2)
                setOnClickListener { action() }
            }
        ViewCompat.setAccessibilityDelegate(
            b,
            object : androidx.core.view.AccessibilityDelegateCompat() {
                override fun onInitializeAccessibilityNodeInfo(
                    host: View,
                    info: androidx.core.view.accessibility.AccessibilityNodeInfoCompat,
                ) {
                    super.onInitializeAccessibilityNodeInfo(host, info)
                    info.className = "android.widget.Button"
                }
            },
        )
        add(parent, b, 8)
        return b
    }

    /**
     * Native counterpart of a glass StatsCard: title, real measurement,
     * source-specific icon and an optional, explicitly calculated baseline trend.
     */
    fun statsCard(
        parent: LinearLayout,
        title: String,
        value: String,
        icon: String,
        trend: String?,
        source: DataSource,
        action: () -> Unit,
    ): LinearLayout {
        val surface = card(parent, dashed = source == DataSource.HEALTH_CONNECT) { inner ->
            val heading = row()
            heading.addView(
                text(title, 12f, LensColors.muted, bold = true),
                LinearLayout.LayoutParams(0, -2, 1f),
            )
            heading.addView(text(icon, 19f, if (source == DataSource.WHOOP) LensColors.teal else LensColors.sand))
            add(inner, heading, 5)
            add(inner, text(value, 22f, bold = true, role = TextRole.MONO), 5)
            add(
                inner,
                text(trend ?: "Baseline unavailable", 12f, if (trend != null) LensColors.teal else LensColors.muted),
                0,
            )
        }
        surface.minimumHeight = dp(48)
        surface.descendantFocusability = android.view.ViewGroup.FOCUS_BLOCK_DESCENDANTS
        fun silenceChildren(group: android.view.ViewGroup) {
            for (i in 0 until group.childCount) {
                val child = group.getChildAt(i)
                child.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                if (child is android.view.ViewGroup) silenceChildren(child)
            }
        }
        silenceChildren(surface)
        surface.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        surface.accessibilityDelegate = object : View.AccessibilityDelegate() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: android.view.accessibility.AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                info.className = android.widget.Button::class.java.name
            }
        }
        surface.foreground = RippleDrawable(ColorStateList.valueOf(0x224FD8CF), null, shape())
        surface.contentDescription = "$title, $value. ${trend ?: "Baseline unavailable"}. ${source.label}. Open details."
        surface.isClickable = true
        surface.isFocusable = true
        surface.setOnClickListener { action() }
        liftOnInteraction(surface, 5)
        return surface
    }

    fun metric(
        parent: LinearLayout,
        m: Metric?,
        title: String,
        source: DataSource,
        showHeading: Boolean = true,
        onClick: (() -> Unit)? = null,
    ) =
        card(parent, dashed = source == DataSource.HEALTH_CONNECT) { c ->
            val stale =
                m?.measuredAt?.let { System.currentTimeMillis() - it > 12 * 3600000L } == true
            val missing = m?.value == null
            if (showHeading) heading(c, title)
            chip(c, source)
            add(
                c,
                text(
                    if (missing) "Not shared" else m?.display() ?: "Not shared",
                    if (missing) 16f else 22f,
                    if (missing) LensColors.muted else if (stale) LensColors.amber else LensColors.text,
                    bold = !missing,
                    role = if (missing) TextRole.BODY else TextRole.MONO,
                ),
                5,
            )
            add(
                c,
                text(
                    m?.measuredAt?.let {
                        "${if(stale)"Saved measurement"else"Measured"} ${dateTime(it)}"
                    } ?: "No available measurement",
                    12f,
                    if (stale) LensColors.amber else LensColors.muted,
                    role = if (m?.measuredAt != null) TextRole.MONO else TextRole.BODY,
                ),
                0,
            )
            m?.origin?.let { add(c, text("Writing app: $it", 12f, LensColors.muted), 0) }
            if (onClick != null) {
                c.isClickable = true
                c.isFocusable = true
                c.contentDescription =
                    "$title, ${m?.display()?:"Not shared"}, ${source.label}, ${m?.measuredAt?.let(::dateTime)?:"measurement time unavailable"}. Open measurements"
                c.foreground = RippleDrawable(ColorStateList.valueOf(0x224FD8CF), null, shape())
                c.setOnClickListener { onClick() }
            }
        }

    fun pair(parent: LinearLayout, left: (LinearLayout) -> Unit, right: (LinearLayout) -> Unit) {
        if (
            context.resources.configuration.fontScale > 1.3f ||
                context.resources.configuration.screenWidthDp < 360
        ) {
            left(parent)
            right(parent)
            return
        }
        val row = row()
        val a = column()
        val b = column()
        row.addView(a, LinearLayout.LayoutParams(0, -2, 1f).apply { rightMargin = dp(6) })
        row.addView(b, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = dp(6) })
        add(parent, row, 0)
        left(a)
        right(b)
    }
}

internal fun dateTime(time: Long): String =
    java.time.Instant.ofEpochMilli(time)
        .atZone(java.time.ZoneId.systemDefault())
        .format(java.time.format.DateTimeFormatter.ofPattern("MMM d · HH:mm"))

internal class RecoveryRing(
    context: Context,
    private val value: Double?,
    private val spoken: String? = null,
) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val d = resources.displayMetrics.density
        val size = min(width, height).toFloat()
        val inset = 10 * d
        val r = RectF((width - size) / 2 + inset, inset, (width + size) / 2 - inset, size - inset)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 12 * d
        paint.strokeCap = Paint.Cap.ROUND
        paint.shader = null
        paint.color = GlassTokens.edge
        canvas.drawArc(r, 0f, 360f, false, paint)
        value?.takeIf { it in 0.0..100.0 }?.let {
            paint.shader =
                LinearGradient(
                    r.left,
                    r.top,
                    r.right,
                    r.bottom,
                    intArrayOf(Color.rgb(184, 251, 245), Color.rgb(79, 216, 207), Color.rgb(42, 143, 137)),
                    floatArrayOf(0f, 0.55f, 1f),
                    Shader.TileMode.CLAMP,
                )
            canvas.drawArc(r, -90f, (it * 3.6).toFloat(), false, paint)
            paint.shader = null
        }
        if (recoveryPercentInsideRing(resources.configuration.fontScale)) {
            paint.style = Paint.Style.FILL
            paint.color = LensColors.text
            paint.textSize = 30 * resources.displayMetrics.scaledDensity
            paint.typeface = resources.getFont(R.font.jetbrains_mono)
            paint.textAlign = Paint.Align.CENTER
            canvas.drawText(
                value?.let { "${it.toInt()}%" } ?: "—",
                width / 2f,
                height / 2f + 8 * d,
                paint,
            )
        }
    }

    init {
        contentDescription = spoken ?: (value?.let { "Recovery $it percent, WHOOP" } ?: "Recovery not shared, WHOOP")
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }
}

internal class StrainArc(context: Context, private val value: Double?, private val spoken: String) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    init {
        contentDescription = spoken
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = (64 * resources.displayMetrics.density).toInt().coerceAtLeast(suggestedMinimumHeight)
        setMeasuredDimension(w, h)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val stroke = 9f * resources.displayMetrics.density
        val pad = stroke / 2f + resources.displayMetrics.density
        val scale = min((width - 2 * pad) / 140f, (height - 2 * pad) / 76f)
        if (scale <= 0f) return
        canvas.save()
        canvas.translate((width - 140f * scale) / 2f, pad)
        canvas.scale(scale, scale)
        val oval = RectF(10f, 10f, 130f, 130f)
        paint.style = Paint.Style.STROKE
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeWidth = 9f
        paint.color = GlassTokens.edge
        canvas.drawArc(oval, 180f, strainArcSweep(21.0), false, paint)
        value?.takeIf { it.isFinite() && it >= 0 }?.let {
            paint.color = GlassTokens.teal
            canvas.drawArc(oval, 180f, strainArcSweep(it), false, paint)
        }
        canvas.restore()
    }
}

internal class TrendChart(
    context: Context,
    points: List<Point>,
    private val source: DataSource,
    private val bars: Boolean = false,
    private val baseline: Triple<Double, Double, Double>? = null,
) : View(context) {
    private val points = points.sortedBy { it.time }
    private val paint = Paint(3)
    internal var axisLabels: List<AxisLabel> = emptyList()
        private set
    private var selected: Int? = null
    private var touchSelection = false

    init {
        isClickable = true
        isFocusable = true
        contentDescription = description()
        setOnClickListener {
            if (points.isNotEmpty()) {
                if (!touchSelection) selected = nextChartPointIndex(points, selected)
                touchSelection = false
                contentDescription = description()
                announceForAccessibility(contentDescription)
                invalidate()
            }
        }
    }

    private fun description() = chartDescription(points, source, selected)

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.action == MotionEvent.ACTION_UP && points.isNotEmpty()) {
            val t =
                points.first().time +
                    ((event.x - 16 * resources.displayMetrics.density) / (width - 32 * resources.displayMetrics.density).coerceAtLeast(1f)).coerceIn(0f, 1f) * (points.last().time - points.first().time)
            selected = chartPointIndices(points).minByOrNull { abs(points[it].time - t) }
            touchSelection = true
            performClick()
            return true
        }
        return super.onTouchEvent(event)
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val drawableIndices = chartPointIndices(points)
        val values = drawableIndices.map { points[it].value!! }
        if (values.isEmpty()) {
            paint.color = LensColors.muted
            paint.textSize = 14 * resources.displayMetrics.scaledDensity
            canvas.drawText("Not shared", 16*resources.displayMetrics.density, height / 2f, paint)
            return
        }
        val low = if (bars) 0.0 else min(values.min(), baseline?.first ?: values.min()) * .95
        val high = max(max(values.max(), baseline?.third ?: values.max()) * 1.05, low + 1)
        val inset = 16f * resources.displayMetrics.density
        paint.textSize = 12f * resources.displayMetrics.scaledDensity
        val labelHeight = paint.fontMetrics.bottom - paint.fontMetrics.top
        val w = (width - 2 * inset).coerceAtLeast(1f)
        val h = (height - 2 * inset - labelHeight - 8 * resources.displayMetrics.density).coerceAtLeast(1f)
        fun x(i: Int) =
            inset +
                w * (points[i].time - points.first().time).toFloat() /
                    max(1L, points.last().time - points.first().time)
        fun y(v: Double) = inset + h * (1 - (v - low) / (high - low)).toFloat()
        baseline?.let { b ->
            paint.style = Paint.Style.FILL
            paint.color = 0x124FD8CF
            canvas.drawRect(inset, y(b.third), width - inset, y(b.first), paint)
            paint.color = LensColors.muted
            paint.strokeWidth = 1f
            paint.pathEffect = DashPathEffect(floatArrayOf(5f, 5f), 0f)
            canvas.drawLine(inset, y(b.second), width - inset, y(b.second), paint)
            paint.pathEffect = null
        }
        paint.color = LensColors.edge
        paint.strokeWidth = 1f
        for (i in 0..2) canvas.drawLine(
            inset,
            inset + h * i / 2,
            width - inset,
            inset + h * i / 2,
            paint,
        )
        paint.color = if (source == DataSource.WHOOP) LensColors.teal else LensColors.sand
        paint.strokeWidth = 2.3f * resources.displayMetrics.density
        paint.style = Paint.Style.STROKE
        paint.pathEffect =
            if (source == DataSource.HEALTH_CONNECT && !bars)
                DashPathEffect(floatArrayOf(10f, 7f), 0f)
            else null
        val path = Path()
        var open = false
        points.forEachIndexed { i, p ->
            val v = p.value
            if (v == null || !v.isFinite()) open = false
            else if (bars) {
                paint.strokeWidth = max(4f, w / max(1, points.size) * .62f)
                canvas.drawLine(x(i), inset + h, x(i), y(v), paint)
            } else {
                if (!open) path.moveTo(x(i), y(v)) else path.lineTo(x(i), y(v))
                open = true
            }
        }
        if (!bars) canvas.drawPath(path, paint)
        paint.pathEffect = null
        paint.style = Paint.Style.FILL
        if (!bars) drawableIndices.forEach { i ->
            canvas.drawCircle(x(i), y(points[i].value!!), 3.5f * resources.displayMetrics.density, paint)
        }
        paint.color = LensColors.muted
        paint.textSize = 12f * resources.displayMetrics.scaledDensity
        val axisFormat =
            java.time.format.DateTimeFormatter.ofPattern(
                if (points.last().time - points.first().time < 2 * 86400000L) "HH:mm" else "MMM d"
            )
        // Time-spaced ticks avoid dense clusters at the beginning of the series.
        // Measured text bounds, rather than sample indexes, decide which labels fit.
        val from = points.first().time
        val span = (points.last().time - from).coerceAtLeast(0L)
        val ticks = if (span == 0L) listOf(from) else listOf(from, from + span/2, from + span)
        val candidates = ticks.map { time ->
            val text = java.time.Instant.ofEpochMilli(time).atZone(java.time.ZoneId.systemDefault()).format(axisFormat)
            val anchor = if (span == 0L) inset + w/2 else inset + w*(time-from).toFloat()/span
            AxisCandidate(text, anchor, paint.measureText(text))
        }
        axisLabels = collisionFreeAxisLabels(candidates, inset, width-inset, 8*resources.displayMetrics.density)
        paint.textAlign = Paint.Align.LEFT
        val labelBaseline = height - 4*resources.displayMetrics.density - paint.fontMetrics.bottom
        axisLabels.forEach { label -> canvas.drawText(label.text, label.left, labelBaseline, paint) }
        paint.pathEffect = null
        paint.style = Paint.Style.FILL
        selected?.let { i ->
            points[i].value?.takeIf { it.isFinite() }?.let { v ->
                canvas.drawCircle(x(i), y(v), 6 * resources.displayMetrics.density, paint)
            }
        }
    }
}

internal class SleepTimeline(context: Context, private val sleep: SleepDetail) : View(context) {
    private val paint = Paint(3)

    init {
        contentDescription =
            "Health Connect sleep-stage timeline. Only shared intervals are drawn. Full stage times follow below."
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val labels = listOf("Awake", "REM", "Light", "Deep")
        val d = resources.displayMetrics.density
        paint.textSize = 12 * resources.displayMetrics.scaledDensity
        paint.typeface = resources.getFont(R.font.jetbrains_mono)
        val left = labels.maxOf { paint.measureText(it) } + 12*d
        val row = height / 4f
        paint.typeface = resources.getFont(R.font.jetbrains_mono)
        labels.forEachIndexed { i, label ->
            paint.color = LensColors.label
            canvas.drawText(label, 0f, row * i + row * .6f, paint)
        }
        val stageColor =
            mapOf(
                "Awake" to Color.rgb(230, 241, 241),
                "REM" to Color.rgb(184, 251, 245),
                "Light" to Color.rgb(79, 216, 207),
                "Deep" to Color.rgb(35, 128, 122),
            )
        sleep.stages.forEach { s ->
            val lane = labels.indexOf(s.label)
            if (lane >= 0) {
                val x =
                    left +
                        (width - left) * (s.start - sleep.start).toFloat() /
                            (sleep.end - sleep.start).coerceAtLeast(1)
                val end =
                    left +
                        (width - left) * (s.end - sleep.start).toFloat() /
                            (sleep.end - sleep.start).coerceAtLeast(1)
                paint.color = stageColor[s.label] ?: LensColors.sand
                paint.alpha = 255
                canvas.drawRoundRect(
                    x,
                    row * lane + 3 * d,
                    end,
                    row * (lane + 1) - 3 * d,
                    3 * d,
                    3 * d,
                    paint,
                )
            }
        }
    }
}

