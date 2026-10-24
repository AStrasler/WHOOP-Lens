package io.github.astrasler.whooplens

import org.junit.Assert.*
import org.junit.Test

class CompanionControlsTest {
  @Test fun grantedPermissionsRestorePreviewsWithoutAnotherChooser() {
    val restored = companionControls(true, true, true, true, false)
    assertTrue(restored.steps)
    assertTrue(restored.other)
    assertFalse(restored.review)
  }
  @Test fun signingOutOrUnavailableHealthConnectDisablesEveryHealthControl() {
    for (state in listOf(companionControls(false, true, true, true, true),
      companionControls(true, false, true, true, true))) {
      assertFalse(state.permissions)
      assertFalse(state.steps)
      assertFalse(state.other)
      assertFalse(state.review)
    }
  }
  @Test fun revokingStepsDisablesPreparedReviewButRetainsOtherSelectedPermissions() {
    val state = companionControls(true, true, false, true, true)
    assertFalse(state.steps)
    assertFalse(state.review)
    assertTrue(state.other)
  }
  @Test fun staleOrDuplicatedCallbackCannotBlockNextAccount() {
    val gate = CallbackGate()
    val old = gate.begin()!!
    assertNull(gate.begin())
    gate.cancel()
    assertFalse(gate.active)
    val current = gate.begin()!!
    assertFalse(gate.finish(old))
    assertTrue(gate.active)
    assertTrue(gate.finish(current))
    assertFalse(gate.active)
    assertFalse(gate.finish(current))
    assertNotNull(gate.begin())
  }
}
