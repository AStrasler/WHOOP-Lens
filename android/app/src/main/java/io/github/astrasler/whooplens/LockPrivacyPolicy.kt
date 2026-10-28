package io.github.astrasler.whooplens

// At a glance lock-screen policy from the approved boards.
// Widget rendering does not call this while LOCK_SCREEN_PLATFORM_VERIFIED is false.
// A locked phone keeps the stricter #108 conceal path: no measurements.

import android.app.KeyguardManager
import android.content.Context
import android.provider.Settings

internal enum class LockLevel { HIDDEN, SUMMARY, DETAILED }

internal enum class LockFallback {
    NONE,
    SIGNED_OUT,
    MISSING_DATA_ACCOUNT,
    OTHER_ACCOUNT,
    NO_SECURE_LOCK,
    SYSTEM_HIDES_SENSITIVE,
    SYSTEM_SETTING_UNKNOWN,
    PLATFORM_UNSUPPORTED,
    DATA_TOO_OLD,
    NOT_CONFIRMED,
    NOTHING_SELECTED,
}

/** Metrics that may ever appear on a verified lock screen. Health Connect previews and Direct BLE never do. */
internal val LOCK_ELIGIBLE_METRICS = listOf("recovery", "strain", "sleep", "hrv", "rhr", "steps")
internal const val LOCK_MAX_METRICS = 3
internal const val SUMMARY_MAX_AGE_MS = 24 * 3600_000L

internal data class LockInputs(
    val chosen: LockLevel,
    val signedInAccount: String?,
    val dataAccount: String?,
    /** KeyguardManager.isDeviceSecure */
    val deviceSecure: Boolean,
    /** Android "show sensitive content" on lock screen. null = couldn't read → treat as hidden. */
    val systemAllowsSensitive: Boolean?,
    /** Verified on device (issue #102). Default false. */
    val platformSupported: Boolean,
    val newestDataAgeMs: Long?,
    /** Set only after the confirmation dialog AND device authentication succeeded. */
    val detailedConfirmed: Boolean,
    val selectedMetrics: List<String>,
)

internal data class LockDecision(
    val level: LockLevel,
    val metrics: List<String>,
    val fallback: LockFallback,
)

internal fun decideLockContent(i: LockInputs): LockDecision {
    fun hidden(why: LockFallback) = LockDecision(LockLevel.HIDDEN, emptyList(), why)
    if (i.chosen == LockLevel.HIDDEN) return hidden(LockFallback.NONE)
    if (!i.platformSupported) return hidden(LockFallback.PLATFORM_UNSUPPORTED)
    if (i.signedInAccount.isNullOrBlank()) return hidden(LockFallback.SIGNED_OUT)
    if (i.dataAccount.isNullOrBlank()) return hidden(LockFallback.MISSING_DATA_ACCOUNT)
    if (i.dataAccount != i.signedInAccount) return hidden(LockFallback.OTHER_ACCOUNT)
    if (i.systemAllowsSensitive == null) return hidden(LockFallback.SYSTEM_SETTING_UNKNOWN)
    if (!i.systemAllowsSensitive) return hidden(LockFallback.SYSTEM_HIDES_SENSITIVE)
    val age = i.newestDataAgeMs ?: return hidden(LockFallback.DATA_TOO_OLD)
    if (age > SUMMARY_MAX_AGE_MS) return hidden(LockFallback.DATA_TOO_OLD)
    if (i.chosen == LockLevel.SUMMARY) return LockDecision(LockLevel.SUMMARY, emptyList(), LockFallback.NONE)
    if (!i.deviceSecure) return hidden(LockFallback.NO_SECURE_LOCK)
    if (!i.detailedConfirmed) return hidden(LockFallback.NOT_CONFIRMED)
    val metrics = i.selectedMetrics.distinct().filter { it in LOCK_ELIGIBLE_METRICS }.take(LOCK_MAX_METRICS)
    if (metrics.isEmpty()) return hidden(LockFallback.NOTHING_SELECTED)
    return LockDecision(LockLevel.DETAILED, metrics, LockFallback.NONE)
}

/**
 * Raising the level only happens in the unlocked app; DETAILED additionally needs confirmation and
 * device authentication (BiometricPrompt with DEVICE_CREDENTIAL allowed). Lowering is always allowed.
 */
internal fun canChangeLevel(
    from: LockLevel,
    to: LockLevel,
    deviceUnlocked: Boolean,
    authenticatedJustNow: Boolean,
): Boolean =
    when {
        to.ordinal <= from.ordinal -> true
        !deviceUnlocked -> false
        to == LockLevel.DETAILED -> authenticatedJustNow
        else -> true
    }

/** Events that reset the stored level to HIDDEN and clear the confirmation and metric choice. */
internal enum class LockResetEvent { SIGN_OUT, ACCOUNT_SWITCH, REINSTALL, LOCK_REMOVED }

internal object LockSystemReader {
    fun deviceSecure(context: Context) =
        context.getSystemService(KeyguardManager::class.java)?.isDeviceSecure == true

    /**
     * UNVERIFIED: Android has no public API for "sensitive notification content on lock screen".
     * Any failure returns null, which the policy treats as hidden. Confirm on the S26 Ultra (#102).
     */
    fun systemAllowsSensitive(context: Context): Boolean? =
        try {
            val show = Settings.Secure.getInt(context.contentResolver, "lock_screen_show_notifications", -1)
            val priv = Settings.Secure.getInt(context.contentResolver, "lock_screen_allow_private_notifications", -1)
            if (show < 0 || priv < 0) null else show == 1 && priv == 1
        } catch (_: Exception) {
            null
        }
}
