package io.github.astrasler.whooplens


// Replaces LensUi.shape()/card() backgrounds; layout code in MainActivity stays as is.

import android.content.Context
import android.graphics.Color
import android.graphics.RenderEffect
import android.graphics.Shader
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.view.View

/** Token values mirror tokens.json. Colors are ARGB. */
internal object GlassTokens {
    // Ground
    val ground = Color.rgb(6, 9, 11) // #06090B
    val groundTop = Color.rgb(10, 18, 25) // #0A1219
    val groundReduced = Color.rgb(10, 18, 21) // #0A1215

    // Text
    val text = Color.rgb(242, 248, 248) // #F2F8F8
    val textSecondary = Color.rgb(195, 212, 212) // #C3D4D4
    val label = Color.rgb(169, 192, 193) // #A9C0C1
    val teal = Color.rgb(143, 243, 234) // #8FF3EA  WHOOP on glass
    val tealDeep = Color.rgb(79, 216, 207) // #4FD8CF  fills, ring gradient end
    val sand = Color.rgb(242, 221, 178) // #F2DDB2  Health Connect
    val stale = Color.rgb(255, 203, 143) // #FFCB8F
    val error = Color.rgb(255, 199, 189) // #FFC7BD  errors, Direct BLE

    // Glass surface
    val tint = Color.argb(148, 18, 27, 31) // rgba(18,27,31,.58)
    val tintSaver = Color.argb(224, 20, 30, 34) // rgba(20,30,34,.88)
    val tintTopBar = Color.argb(209, 18, 27, 31) // .82 — top bar has no live blur
    val solidReduced = Color.rgb(21, 34, 39) // #152227
    val edge = Color.argb(41, 205, 222, 226) // rgba(205,222,226,.16)
    val edgeReduced = Color.rgb(38, 56, 62) // #26383E
    val sheenStart = Color.argb(19, 255, 255, 255) // 7.5%
    val sheenMid = Color.argb(5, 255, 255, 255) // 2%
    val sheenEnd = Color.argb(9, 255, 255, 255) // 3.5%
    val lightCatch = Color.argb(23, 255, 255, 255) // 9%
    val highlight = Color.argb(41, 230, 245, 246) // inset top highlight .16

    const val radiusCard = 26
    const val radiusTile = 24
    const val radiusTopBar = 22
    const val radiusDrawer = 30
    const val radiusButton = 18
    const val blurBehindDrawer = 28f
}

internal enum class GlassRole { CARD, TILE, TOP_BAR, DRAWER, CHIP }

internal class GlassSurface(private val context: Context) {
    private fun dp(v: Number) = v.toFloat() * context.resources.displayMetrics.density

    private fun radius(role: GlassRole) =
        when (role) {
            GlassRole.CARD -> GlassTokens.radiusCard
            GlassRole.TILE -> GlassTokens.radiusTile
            GlassRole.TOP_BAR -> GlassTokens.radiusTopBar
            GlassRole.DRAWER -> GlassTokens.radiusDrawer
            GlassRole.CHIP -> 999
        }

    /**
     * Background for a glass surface. No per-frame blur: in GLASS mode the tint sits over the
     * pre-blurred aurora window background, which reads as frosted glass.
     *
     * @param dashedEdge Health Connect source cards and the Experimental BLE card use a dashed edge.
     */
    fun background(
        role: GlassRole,
        mode: LensAppearance,
        dashedEdge: Boolean = false,
        edgeColor: Int? = null,
    ): Drawable {
        val r = dp(radius(role))
        val dash = if (dashedEdge) dp(5) else 0f
        val gap = if (dashedEdge) dp(4) else 0f
        if (mode == LensAppearance.REDUCED_TRANSPARENCY) {
            return GradientDrawable().apply {
                cornerRadius = r
                setColor(GlassTokens.solidReduced)
                setStroke(dp(1).toInt(), edgeColor ?: GlassTokens.edgeReduced, dash, gap)
            }
        }
        val tint =
            GradientDrawable().apply {
                cornerRadius = r
                setColor(
                    when {
                        mode == LensAppearance.BATTERY_SAVER -> GlassTokens.tintSaver
                        role == GlassRole.TOP_BAR -> GlassTokens.tintTopBar
                        else -> GlassTokens.tint
                    }
                )
            }
        // 160° sheen: 7.5% → 2% (50%) → 3.5%. GradientDrawable supports a center color.
        val sheen =
            GradientDrawable(
                    GradientDrawable.Orientation.TL_BR,
                    intArrayOf(GlassTokens.sheenStart, GlassTokens.sheenMid, GlassTokens.sheenEnd),
                )
                .apply { cornerRadius = r }
        // Corner light catch: radial, top-left.
        val catchLight =
            GradientDrawable().apply {
                cornerRadius = r
                gradientType = GradientDrawable.RADIAL_GRADIENT
                colors = intArrayOf(GlassTokens.lightCatch, Color.TRANSPARENT)
                setGradientCenter(0.12f, -0.08f)
                gradientRadius = dp(220)
            }
        val stroke =
            GradientDrawable().apply {
                cornerRadius = r
                setColor(Color.TRANSPARENT)
                setStroke(dp(1).toInt(), edgeColor ?: GlassTokens.edge, dash, gap)
            }
        // Inset top highlight: a 1 dp line, inset by the corner radius.
        val highlight =
            GradientDrawable().apply {
                setColor(GlassTokens.highlight)
                setSize(1, dp(1).toInt())
            }
        val layers =
            if (mode == LensAppearance.BATTERY_SAVER) arrayOf(tint, sheen, stroke, highlight)
            else arrayOf(tint, sheen, catchLight, stroke, highlight)
        return LayerDrawable(layers).apply {
            val h = layers.size - 1
            setLayerGravity(h, android.view.Gravity.TOP or android.view.Gravity.FILL_HORIZONTAL)
            setLayerInset(h, r.toInt(), dp(1).toInt(), r.toInt(), 0)
        }
    }

    /** Elevation shadow for glass cards (0 14 36 @ 38%). Views need an outline; use elevation. */
    fun applyElevation(view: View, mode: LensAppearance) {
        view.elevation = dp(if (mode == LensAppearance.REDUCED_TRANSPARENCY) 6 else 10)
        view.outlineAmbientShadowColor = Color.argb(97, 0, 0, 0)
        view.outlineSpotShadowColor = Color.argb(97, 0, 0, 0)
        view.clipToOutline = true
    }

    /**
     * The one allowed live blur: blur the screen content while the drawer or a dialog is open.
     * Pass null to clear. Skipped entirely unless AppearanceState.liveBlur is true.
     */
    fun blurBehind(content: View, state: AppearanceState, open: Boolean) {
        content.setRenderEffect(
            if (open && state.liveBlur)
                RenderEffect.createBlurEffect(
                    dp(GlassTokens.blurBehindDrawer),
                    dp(GlassTokens.blurBehindDrawer),
                    Shader.TileMode.CLAMP,
                )
            else null
        )
    }
}
