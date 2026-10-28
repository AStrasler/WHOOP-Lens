package io.github.astrasler.whooplens

import android.appwidget.AppWidgetProviderInfo
import android.content.Intent
import android.view.Display
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Design visuals sit on top of the merged repair branches.
 * These checks keep widget concealment, announcement privacy, and BLE claims intact.
 */
class GlassOverlapTest {
    @Test fun lockedWidgetsStayFreeOfMeasurements() {
        val now = 1_700_000_000_000L
        val snapshot =
            DashboardSnapshot(
                account = "member",
                whoop =
                    DataBatch(
                        source = DataSource.WHOOP,
                        fetchedAt = now,
                        metrics =
                            listOf(
                                Metric("recovery", "Recovery", 72.0, "%", DataSource.WHOOP, now),
                                Metric("strain", "Strain", 14.2, "", DataSource.WHOOP, now),
                            ),
                    ),
            )
        for (privacy in WidgetPrivacy.entries) {
            val text =
                widgetText(
                    snapshot,
                    "member",
                    privacy,
                    locked = true,
                    lockSurface = false,
                    keys = listOf("recovery", "strain"),
                    now = now,
                )
            assertFalse(text, text.contains("72"))
            assertFalse(text, text.contains("14"))
            assertEquals("Unlock to view", text)
        }
        val presentation =
            widgetPresentation(
                snapshot,
                "member",
                WidgetPrivacy.DETAILED,
                locked = true,
                keys = listOf("recovery"),
                space = WidgetSpace(180f, 110f),
                now = now,
            )
        assertEquals("Lock", presentation.primary)
        assertFalse(presentation.primary.contains("72"))
        assertFalse(presentation.toString().contains("72"))
    }

    @Test fun concealmentMatrixStillBlocksEveryLockedSurface() {
        assertTrue(
            widgetConcealsMeasurements(
                deviceLocked = false,
                keyguardLocked = true,
                screenConcealed = false,
                hostCategory = AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN,
            )
        )
        assertTrue(
            widgetConcealsMeasurements(
                deviceLocked = false,
                keyguardLocked = false,
                screenConcealed = true,
                hostCategory = AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN,
            )
        )
        assertTrue(
            widgetConcealsMeasurements(
                deviceLocked = false,
                keyguardLocked = false,
                screenConcealed = false,
                hostCategory = AppWidgetProviderInfo.WIDGET_CATEGORY_KEYGUARD,
            )
        )
        assertFalse(
            widgetConcealsMeasurements(
                deviceLocked = false,
                keyguardLocked = false,
                screenConcealed = false,
                hostCategory = AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN,
            )
        )
        assertTrue(concealAfterScreenBroadcast(Intent.ACTION_SCREEN_OFF, false, false, false))
        assertFalse(concealAfterScreenBroadcast(Intent.ACTION_USER_PRESENT, false, false, true))
        assertTrue(displaysAreOff(intArrayOf(Display.STATE_OFF, Display.STATE_OFF)))
        assertFalse(displaysAreOff(intArrayOf(Display.STATE_ON)))
    }

    @Test fun memberNoticesStayPublicAndAccountScoped() {
        val now = InstantMillis.parse("2026-10-28T12:00:00Z")
        val id = "0123456789abcdef0123456789abcdef"
        val payload =
            """
            {"enabled":true,"announcements":[
              {"id":"$id","kind":"maintenance","title":"Scheduled maintenance","body":"WhoopLens may be briefly unavailable.","starts_at":"2026-10-28T00:00:00Z","expires_at":"2026-10-29T00:00:00Z"},
              {"id":"abcdefabcdefabcdefabcdefabcdefab","kind":"outage","title":"Recovery score delayed","body":"Checking heart rate.","starts_at":"2026-10-28T00:00:00Z","expires_at":null}
            ]}
            """.trimIndent()
        val inbox = ServiceAnnouncements.parse("member", payload, now)
        assertEquals(1, inbox.notices.size)
        assertEquals("Scheduled maintenance", inbox.notices.single().title)
        assertTrue(ServiceAnnouncements.forAccount(inbox, "other").notices.isEmpty())
        assertEquals("maintenance", ServiceAnnouncements.banner(inbox.notices)?.kind)
        assertEquals(AnnouncementClient.ENDPOINT, "https://whooplens.tech/v1/announcements")
    }

    @Test fun sharedBleFamilyIsNotAProductClaim() {
        assertEquals("fd4b0001-cce1-4033-93ce-002d5875f58a", WHOOP5_SERVICE)
        assertEquals("fd4b0001 shared by 5.0 and MG. Product unverified.", LABEL_SHARED)
        assertFalse(LABEL_SHARED.contains("compatible"))
    }
}

private object InstantMillis {
    fun parse(text: String) = java.time.Instant.parse(text).toEpochMilli()
}
