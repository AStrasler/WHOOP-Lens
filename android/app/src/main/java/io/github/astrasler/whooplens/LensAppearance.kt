package io.github.astrasler.whooplens


// Pure decision logic (resolveAppearance) is separate from Android reads (LensAppearanceReader)
// so it can be unit-tested on the JVM.

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import android.provider.Settings
import android.view.WindowManager
import java.util.function.Consumer

/** The three visual modes on the design boards. */
internal enum class LensAppearance { GLASS, REDUCED_TRANSPARENCY, BATTERY_SAVER }

/** What the user chose in Settings › Appearance. AUTO follows the phone. */
internal enum class AppearanceChoice { AUTO, GLASS, REDUCED_TRANSPARENCY, BATTERY_SAVER }

internal enum class AppearanceReason {
    USER_CHOICE,
    POWER_SAVE,
    BLUR_UNAVAILABLE,
    DEFAULT,
}

internal data class AppearanceInputs(
    val choice: AppearanceChoice,
    /** PowerManager.isPowerSaveMode */
    val powerSave: Boolean,
    /** WindowManager.isCrossWindowBlurEnabled (false when the device or Android turned blur off). */
    val blurAvailable: Boolean,
    /** Settings.Global.ANIMATOR_DURATION_SCALE; 0 means "Remove animations". */
    val animatorScale: Float,
)

internal data class AppearanceState(
    val mode: LensAppearance,
    val reason: AppearanceReason,
    /** Whether the single allowed live blur (behind an open drawer or dialog) may run. */
    val liveBlur: Boolean,
    /** No sweeps or slides; instant changes or a 150 ms fade. */
    val reduceMotion: Boolean,
    /** Duration for user-triggered transitions, already scaled. 0 = instant. */
    val transitionMs: Long,
)

/**
 * Precedence:
 * 1. Reduced transparency chosen by the user wins over everything.
 * 2. User chose Battery saver, or Android battery saver is on → BATTERY_SAVER (even if the user chose Glass).
 * 3. Blur unavailable → BATTERY_SAVER surfaces (frosted tint, no live blur).
 * 4. Otherwise GLASS.
 */
internal fun resolveAppearance(i: AppearanceInputs): AppearanceState {
    val reduceMotion = i.animatorScale == 0f
    val (mode, reason) =
        when {
            i.choice == AppearanceChoice.REDUCED_TRANSPARENCY ->
                LensAppearance.REDUCED_TRANSPARENCY to AppearanceReason.USER_CHOICE
            i.choice == AppearanceChoice.BATTERY_SAVER ->
                LensAppearance.BATTERY_SAVER to AppearanceReason.USER_CHOICE
            i.powerSave -> LensAppearance.BATTERY_SAVER to AppearanceReason.POWER_SAVE
            !i.blurAvailable -> LensAppearance.BATTERY_SAVER to AppearanceReason.BLUR_UNAVAILABLE
            i.choice == AppearanceChoice.GLASS -> LensAppearance.GLASS to AppearanceReason.USER_CHOICE
            else -> LensAppearance.GLASS to AppearanceReason.DEFAULT
        }
    val base = 220L
    return AppearanceState(
        mode = mode,
        reason = reason,
        liveBlur = mode == LensAppearance.GLASS,
        reduceMotion = reduceMotion,
        transitionMs = if (reduceMotion) 0L else (base * i.animatorScale.coerceAtMost(2f)).toLong(),
    )
}

/** Reads the inputs from Android and notifies when any of them changes. */
internal class LensAppearanceReader(private val context: Context) {
    private val power = context.getSystemService(PowerManager::class.java)
    private val windows = context.getSystemService(WindowManager::class.java)

    fun read(choice: AppearanceChoice): AppearanceInputs =
        AppearanceInputs(
            choice = choice,
            powerSave = power?.isPowerSaveMode == true,
            // minSdk is 34, so this API (31+) is always present.
            blurAvailable = windows?.isCrossWindowBlurEnabled == true,
            animatorScale =
                Settings.Global.getFloat(
                    context.contentResolver,
                    Settings.Global.ANIMATOR_DURATION_SCALE,
                    1f,
                ),
        )

    /**
     * Call from onStart; call the returned function from onStop.
     * Animator scale has no broadcast — re-read it in onResume.
     */
    fun observe(onChange: () -> Unit): () -> Unit {
        val receiver =
            object : BroadcastReceiver() {
                override fun onReceive(c: Context, intent: Intent) = onChange()
            }
        context.registerReceiver(
            receiver,
            IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED),
            Context.RECEIVER_NOT_EXPORTED,
        )
        val blurListener = Consumer<Boolean> { onChange() }
        windows?.addCrossWindowBlurEnabledListener(context.mainExecutor, blurListener)
        return {
            context.unregisterReceiver(receiver)
            windows?.removeCrossWindowBlurEnabledListener(blurListener)
        }
    }
}
