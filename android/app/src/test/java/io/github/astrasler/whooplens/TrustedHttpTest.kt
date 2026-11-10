package io.github.astrasler.whooplens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class TrustedHttpTest {
    @Test
    fun acceptsOnlyTheExpectedHttpsHost() {
        assertEquals(
            "https://whooplens.tech/v1/announcements",
            trustedHttpsUrl("https://whooplens.tech/v1/announcements", "whooplens.tech"),
        )
        for (url in listOf(
            "http://whooplens.tech/v1/announcements",
            "https://evil.example/v1/announcements",
            "https://whooplens.tech:443/v1/announcements",
            "https://user:pass@whooplens.tech/v1/announcements",
            "https://whooplens.tech/v1/announcements#fragment",
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                trustedHttpsUrl(url, "whooplens.tech")
            }
        }
    }
}
