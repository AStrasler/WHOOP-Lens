package io.github.astrasler.whooplens

internal data class CompanionControls(
  val permissions: Boolean, val steps: Boolean, val other: Boolean, val review: Boolean
)

internal fun companionControls(signedIn: Boolean, available: Boolean, stepsGranted: Boolean,
  otherGranted: Boolean, validPreview: Boolean): CompanionControls {
  val permitted = signedIn && available
  return CompanionControls(permitted, permitted && stepsGranted, permitted && otherGranted,
    permitted && stepsGranted && validPreview)
}

/** A cancelled or duplicated browser callback must not block the next session restore. */
internal class CallbackGate {
  private var ticket = 0L
  var active = false
    private set
  fun begin(): Long? = if (active) null else (++ticket).also { active = true }
  fun finish(value: Long): Boolean {
    if (value != ticket || !active) return false
    active = false
    return true
  }
  fun cancel() { ticket++; active = false }
}
