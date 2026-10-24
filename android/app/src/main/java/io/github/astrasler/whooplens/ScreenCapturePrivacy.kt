package io.github.astrasler.whooplens

import android.app.Activity
import android.view.WindowManager

/** Normal health screens are shareable; credential content, if ever shown, must opt into protection. */
internal fun applyScreenCapturePrivacy(
    exposesCredentials: Boolean,
    setSecure: (Boolean) -> Unit,
    setRecentsCapture: (Boolean) -> Unit,
) {
    // Assign both directions: secure state must not survive navigation back to normal content.
    setSecure(exposesCredentials)
    setRecentsCapture(false)
}

internal fun applyScreenCapturePrivacy(activity: Activity, exposesCredentials: Boolean = false) {
    applyScreenCapturePrivacy(
        exposesCredentials,
        setSecure = { secure ->
            if (secure) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        },
        // Available since API 33; this app's minimum is API 34. Independent of screenshots/recording.
        setRecentsCapture = activity::setRecentsScreenshotEnabled,
    )
}
