package io.github.astrasler.whooplens

// Handoff §9 functional states: what the app says after a foreground refresh.
// Error: coral banner + 48 dp Retry; the last good values stay on screen.

/** Suffix of the notice WhoopDashboard adds when a WHOOP read fails. */
internal const val WHOOP_READ_FAILED_NOTICE = " unavailable. Retry WHOOP reads."

internal const val REFRESH_FAILED_MESSAGE = "Couldn't load. Your saved data is still shown."
internal const val REFRESH_OFFLINE_MESSAGE = "Offline · local reads only. Saved WHOOP values are dated."
internal const val REFRESH_DONE_MESSAGE = "Refresh finished · no cloud uploads"

internal data class RefreshOutcome(val message: String, val failed: Boolean)

/** True when at least one WHOOP read in this batch failed (partial history alone is not a failure). */
internal fun DataBatch.readFailed(): Boolean = notices.any { it.endsWith(WHOOP_READ_FAILED_NOTICE) }

/**
 * Offline is reported as offline, not as an error: there is nothing to retry yet.
 * Otherwise any failed source makes the refresh an error.
 */
internal fun refreshOutcome(online: Boolean, whoopFailed: Boolean, healthFailed: Boolean): RefreshOutcome =
    when {
        !online -> RefreshOutcome(REFRESH_OFFLINE_MESSAGE, failed = false)
        whoopFailed || healthFailed -> RefreshOutcome(REFRESH_FAILED_MESSAGE, failed = true)
        else -> RefreshOutcome(REFRESH_DONE_MESSAGE, failed = false)
    }
