package io.github.astrasler.whooplens

import org.junit.Assert.*
import org.junit.Test

class ScreenCapturePrivacyTest {
    @Test fun normalContentAllowsCaptureAndKeepsRecentsPrivate() {
        var secure = true
        var recents = true
        applyScreenCapturePrivacy(false, { secure = it }, { recents = it })
        assertFalse(secure)
        assertFalse(recents)
    }

    @Test fun credentialContentIsProtectedIndependentlyOfRecents() {
        var secure = false
        var recents = true
        applyScreenCapturePrivacy(true, { secure = it }, { recents = it })
        assertTrue(secure)
        assertFalse(recents)
    }

    @Test fun navigationClearsProtectionAndNeverLeavesStickySecureState() {
        val secureStates = mutableListOf<Boolean>()
        val recentsStates = mutableListOf<Boolean>()
        for (sensitive in listOf(false, true, false, false, true, false)) {
            applyScreenCapturePrivacy(sensitive, secureStates::add, recentsStates::add)
        }
        assertEquals(listOf(false, true, false, false, true, false), secureStates)
        assertEquals(List(6) { false }, recentsStates)
    }
}
