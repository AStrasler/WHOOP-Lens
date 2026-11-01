package io.github.astrasler.whooplens

import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DashboardTest {
    @Test
    fun emptySignedInWidgetRequestsRefreshNotLogin() {
        assertTrue(
            widgetText(null, "A", WidgetPrivacy.SUMMARY, false, false, emptyList(), 0)
                .contains("No saved measurements")
        )
        assertFalse(
            widgetText(null, "A", WidgetPrivacy.SUMMARY, false, false, emptyList(), 0)
                .contains("Sign in")
        )
    }

    private val now = Instant.parse("2026-10-24T12:00:00Z").toEpochMilli()
    private val metric = Metric("recovery", "Recovery", 72.0, "%", DataSource.WHOOP, now)
    private val snapshot = DashboardSnapshot("A", DataBatch(DataSource.WHOOP, now, listOf(metric)))

    private fun result(
        records: JSONArray = JSONArray(),
        next: String? = null,
        source: String = "whoop",
        complete: Boolean = true,
    ): JSONObject {
        val data =
            JSONObject()
                .put("source", source)
                .put("source_authority", "authoritative")
                .put("records", records)
                .put("next_token", next ?: JSONObject.NULL)
                .put("complete", complete)
        return JSONObject()
            .put(
                "result",
                JSONObject()
                    .put(
                        "content",
                        JSONArray()
                            .put(JSONObject().put("type", "text").put("text", data.toString())),
                    ),
            )
    }

    private fun recovery(value: Any = 72.0) =
        JSONObject()
            .put("cycle_id", 1)
            .put("created_at", "2026-10-24T10:00:00Z")
            .put("score_state", "SCORED")
            .put("score", JSONObject().put("recovery_score", value))

    @Test
    fun missingIsNotZero() {
        assertEquals("Not shared", metric.copy(value = null).display())
        assertEquals("0 %", metric.copy(value = 0.0).display())
        assertNull(statistics(listOf(Point(now, null))))
    }

    @Test
    fun chartGapsAndDayOrder() {
        val p =
            chartSlots(listOf(Point(now, 3.0), Point(now - 1000, 1.0)), 3, now, ZoneId.of("UTC"))
        assertNull(p[0].value)
        assertNull(p[1].value)
        assertEquals(3.0, p[2].value)
    }

    @Test
    fun statisticsExcludeMissing() {
        assertEquals(
            Triple(3.0, 4.0, 2.0),
            statistics(listOf(Point(now, 2.0), Point(now, null), Point(now, 4.0))),
        )
    }

    @Test
    fun baselineUsesOwnRecordedDaysOnly() {
        assertNull(personalBaseline(listOf(Point(now, 64.0)), now))
        val points = (0..13).map { Point(now - it * 86400000L, 64.0) }
        assertEquals(Triple(64.0, 64.0, 64.0), personalBaseline(points, now))
        assertNull(personalBaseline(points.map { it.copy(time = now) }, now))
    }

    @Test
    fun lateAccountResultIsRejected() {
        val owner = DashboardOwner()
        val a = owner.select("A")
        owner.select("B")
        assertFalse(owner.accept("A", a, snapshot.whoop!!))
        assertNull(owner.snapshot?.whoop)
    }

    @Test
    fun signOutRejectsLateResult() {
        val owner = DashboardOwner()
        val a = owner.select("A")
        owner.select(null)
        assertFalse(owner.accept("A", a, snapshot.whoop!!))
        assertNull(owner.snapshot)
    }

    @Test
    fun healthRevocationInvalidatesPendingRead() {
        val owner = DashboardOwner()
        val a = owner.select("A")
        owner.forgetHealth()
        assertFalse(owner.accept("A", a, DataBatch(DataSource.HEALTH_CONNECT, now)))
    }

    @Test
    fun widgetNoDataAcrossAccounts() {
        assertFalse(
            widgetText(snapshot, "B", WidgetPrivacy.DETAILED, false, false, listOf("recovery"), now)
                .contains("72")
        )
    }

    @Test
    fun allLockModesHideMeasurements() {
        for (mode in WidgetPrivacy.entries) {
            assertFalse(
                widgetText(snapshot, "A", mode, true, false, listOf("recovery"), now).contains("72")
            )
            assertFalse(
                widgetText(snapshot, "A", mode, false, true, listOf("recovery"), now).contains("72")
            )
        }
    }

    @Test
    fun homePrivacyDefaultAndSelection() {
        assertFalse(
            widgetText(snapshot, "A", WidgetPrivacy.SUMMARY, false, false, listOf("recovery"), now)
                .contains("72")
        )
        assertTrue(
            widgetText(snapshot, "A", WidgetPrivacy.DETAILED, false, false, listOf("recovery"), now)
                .contains("72")
        )
        assertFalse(
            widgetText(snapshot, "A", WidgetPrivacy.DETAILED, false, false, emptyList(), now)
                .contains("72")
        )
    }

    @Test
    fun staleWidgetsAreDated() {
        val text =
            widgetText(
                snapshot,
                "A",
                WidgetPrivacy.DETAILED,
                false,
                false,
                listOf("recovery"),
                now + 13 * 3600000L,
            )
        assertTrue(text.contains("Saved"))
        assertTrue(text.contains("WHOOP"))
    }

    @Test
    fun cacheRoundtripAndAccountSeparation() {
        val text = DashboardCodec.encode(snapshot)
        assertEquals(72.0, DashboardCodec.decode(text, "A")!!.whoop!!.metric("recovery")!!.value)
        assertNull(DashboardCodec.decode(text, "B"))
        assertNull(DashboardCodec.decode("corrupt", "A"))
    }

    @Test
    fun originsSurviveCache() {
        val s =
            snapshot.copy(
                health =
                    DataBatch(
                        DataSource.HEALTH_CONNECT,
                        now,
                        series = mapOf("heart" to listOf(Point(now, 80.0, "com.vendor.app"))),
                    )
            )
        assertEquals(
            "com.vendor.app",
            DashboardCodec.decode(DashboardCodec.encode(s), "A")!!
                .health!!
                .series["heart"]!![0]
                .origin,
        )
    }

    @Test
    fun cacheIsBounded() {
        val s =
            snapshot.copy(
                whoop =
                    snapshot.whoop!!.copy(
                        series = mapOf("recovery" to (0..999).map { Point(it.toLong(), null) })
                    )
            )
        assertEquals(
            500,
            DashboardCodec.decode(DashboardCodec.encode(s), "A")!!.whoop!!.series["recovery"]!!.size,
        )
    }

    @Test
    fun dashboardStorageEncryptsAndRejectsCorruption() {
        var bytes: ByteArray? = null
        val blob =
            object : CredentialBlob {
                override fun read() = bytes

                override fun writeAtomically(value: ByteArray) {
                    bytes = value
                }

                override fun clear() {
                    bytes = null
                }
            }
        val key = javax.crypto.spec.SecretKeySpec(ByteArray(32) { it.toByte() }, "AES")
        val keys =
            object : CredentialKeys {
                override fun get(create: Boolean) = key

                override fun clear() {}
            }
        val storage = EncryptedSessionStorage(blob, keys, maxPlaintextBytes = 1000000)
        val plain = DashboardCodec.encode(snapshot)
        storage.write(plain)
        assertFalse(bytes!!.toString(Charsets.UTF_8).contains(plain))
        assertEquals(
            72.0,
            DashboardCodec.decode(storage.read()!!, "A")!!.whoop!!.metric("recovery")!!.value,
        )
        bytes!![20] = (bytes!![20].toInt() xor 1).toByte()
        try {
            storage.read()
            fail("Corruption accepted")
        } catch (_: javax.crypto.AEADBadTagException) {}
    }

    @Test
    fun whoopReadsAreAllowlistedAndAttributed() {
        val calls = mutableSetOf<String>()
        val b =
            WhoopDashboard { tool, _ ->
                    calls.add(tool)
                    result(if (tool == "get_recovery") JSONArray().put(recovery()) else JSONArray())
                }
                .load(now)
        assertEquals(WhoopDashboard.tools, calls)
        assertEquals(72.0, b.metric("recovery")!!.value)
        assertEquals(DataSource.WHOOP, b.metric("recovery")!!.source)
        assertNull(b.metric("hrv")!!.value)
    }

    @Test
    fun wrongSourceNeverBecomesWhoop() {
        val b =
            WhoopDashboard { _, _ ->
                    result(JSONArray().put(recovery()), source = "health_connect")
                }
                .load(now)
        assertTrue(b.metrics.isEmpty())
        assertFalse(b.complete)
        assertFalse(b.notices.isEmpty())
    }

    @Test
    fun unscoredRecoveryNeverUsesItsNumericFields() {
        val r = recovery().put("score_state", "PENDING_SCORE")
        val b =
            WhoopDashboard { tool, _ ->
                    result(if (tool == "get_recovery") JSONArray().put(r) else JSONArray())
                }
                .load(now)
        assertNull(b.metric("recovery")!!.value)
    }

    @Test
    fun malformedAndServerErrorsAreGeneric() {
        val b = WhoopDashboard { _, _ -> JSONObject().put("error", "private diagnostic") }.load(now)
        assertTrue(b.metrics.isEmpty())
        assertTrue(b.notices.none { it.contains("private diagnostic") })
    }

    @Test
    fun whoopPaginationUsesOpaqueCursorAndDeduplicates() {
        var pages = 0
        val b =
            WhoopDashboard { tool, args ->
                    if (tool == "get_recovery") {
                        pages++
                        if (pages == 1) result(JSONArray().put(recovery()), "opaque=cursor")
                        else {
                            assertEquals("opaque=cursor", args.getString("next_token"))
                            result(JSONArray().put(recovery()))
                        }
                    } else result()
                }
                .load(now)
        assertEquals(2, pages)
        assertEquals(1, b.series["recovery"]!!.size)
    }

    @Test
    fun whoopPaginationHasHardCap() {
        var calls = 0
        val b =
            WhoopDashboard { _, _ ->
                    calls++
                    result(next = "cursor$calls")
                }
                .load(now)
        assertEquals(16, calls)
        assertFalse(b.complete)
    }

    @Test
    fun serverPartialWithoutCursorStaysPartial() {
        val b = WhoopDashboard { _, _ -> result(complete = false) }.load(now)
        assertFalse(b.complete)
    }

    @Test
    fun openCycleStrainFollowsCycleStartNotPreviousEnd() {
        val previous =
            cycle(1, "2026-10-23T12:00:00Z", "2026-10-24T12:00:00Z", 10.0)
        val open = cycle(2, "2026-10-24T12:00:00Z", null, 15.0)
        val openStart = Instant.parse("2026-10-24T12:00:00Z").toEpochMilli()
        val previousStart = Instant.parse("2026-10-23T12:00:00Z").toEpochMilli()
        for (records in
            listOf(JSONArray().put(open).put(previous), JSONArray().put(previous).put(open))) {
            val b =
                WhoopDashboard { tool, _ ->
                        result(if (tool == "get_cycles") records else JSONArray())
                    }
                    .load(now)
            assertEquals(15.0, b.metric("strain")!!.value)
            assertEquals(openStart, b.metric("strain")!!.measuredAt)
            assertEquals(listOf(previousStart, openStart), b.series["strain"]!!.map { it.time })
            assertEquals(listOf(10.0, 15.0), b.series["strain"]!!.map { it.value })
        }
    }

    private fun cycle(id: Int, start: String, end: String?, strain: Double) =
        JSONObject()
            .put("id", id)
            .put("cycle_id", id)
            .put("score_state", "SCORED")
            .put("start", start)
            .put("score", JSONObject().put("strain", strain))
            .apply { if (end != null) put("end", end) }

    @Test
    fun sleepTotalsDontInventTimeline() {
        val r =
            JSONObject()
                .put("id", "sleep")
                .put("score_state", "SCORED")
                .put("start", "2026-10-23T23:00:00Z")
                .put("end", "2026-10-24T07:00:00Z")
                .put(
                    "score",
                    JSONObject()
                        .put(
                            "stage_summary",
                            JSONObject()
                                .put("total_light_sleep_time_milli", 60000)
                                .put("total_slow_wave_sleep_time_milli", 120000)
                                .put("total_rem_sleep_time_milli", 180000),
                        ),
                )
        val b =
            WhoopDashboard { tool, _ ->
                    result(if (tool == "get_sleep") JSONArray().put(r) else JSONArray())
                }
                .load(now)
        assertEquals(6.0, b.metric("sleep")!!.value)
        assertTrue(b.sleeps.single().stages.isEmpty())
    }

    @Test
    fun healthEmptyCursorTerminates() = runBlocking {
        var calls = 0
        val p = readHealthPages {
            calls++
            HealthPage(listOf(1), "")
        }
        assertEquals(1, calls)
        assertTrue(p.complete)
    }

    @Test
    fun healthPaginationHasBoundAndPartial() = runBlocking {
        var calls = 0
        val p = readHealthPages {
            calls++
            HealthPage(listOf(calls), calls.toString())
        }
        assertEquals(5, calls)
        assertEquals(5, p.rows.size)
        assertFalse(p.complete)
    }

    @Test
    fun healthRepeatedCursorIsRejected() = runBlocking {
        try {
            readHealthPages { HealthPage(emptyList<Int>(), "same") }
            fail("Repeated cursor accepted")
        } catch (_: IllegalStateException) {}
    }

    @Test
    fun missingSleepStagesNeverAssumeSessionDuration() {
        assertNull(asleepMinutes(emptyList()))
        assertNull(
            asleepMinutes(
                listOf(SleepStage(0, 60000, "Unknown"), SleepStage(60000, 120000, "Awake"))
            )
        )
    }

    @Test
    fun sleepDoesNotDoubleCountOverlappingStages() {
        assertEquals(
            2.0,
            asleepMinutes(
                listOf(
                    SleepStage(0, 90000, "Light"),
                    SleepStage(60000, 120000, "Deep"),
                    SleepStage(120000, 180000, "Awake"),
                )
            )!!,
            0.001,
        )
    }

    @Test
    fun backgroundOptInAndOwnership() {
        assertFalse(backgroundDecision(false, "A", "A", true, true, true).run)
        assertFalse(backgroundDecision(true, "A", "B", true, true, true).run)
        assertFalse(backgroundDecision(true, null, null, true, true, true).run)
    }

    @Test
    fun backgroundOfflineAllowsOnlyPermittedLocalReads() {
        val b = backgroundDecision(true, "A", "A", true, true, false)
        assertTrue(b.health)
        assertFalse(b.whoop)
    }

    @Test
    fun backgroundPermissionAndFeatureBothRequired() {
        assertFalse(backgroundDecision(true, "A", "A", false, true, true).health)
        assertFalse(backgroundDecision(true, "A", "A", true, false, true).health)
    }

    @Test
    fun cloudConsentPrecedesTokenAndNetwork() {
        var sent = false
        val engine = PreparedCloudSync { _, _ ->
            sent = true
            true
        }
        assertEquals(
            "Paused",
            engine.transfer(
                "A",
                SyncConsent("A", setOf("steps")),
                listOf(SyncRecord("A", "steps", "1", 1, "{}")),
                setOf("steps"),
                true,
                { throw AssertionError("Token touched") },
                { "A" },
            ),
        )
        assertFalse(sent)
    }

    @Test
    fun preparedSyncUsesNewestRevisionAndNoCrossAccount() {
        val old = SyncRecord("A", "steps", "1", 1, "{}")
        val recent = old.copy(modified = 2)
        val wrong = old.copy(account = "B")
        val consent = SyncConsent("A", setOf("steps"), true, false)
        assertEquals(
            listOf(recent),
            pendingSyncRecords("A", consent, listOf(old, wrong, recent), setOf("steps"), emptyMap()),
        )
        assertTrue(
            pendingSyncRecords(
                    "A",
                    consent,
                    listOf(recent),
                    setOf("steps"),
                    mapOf(recent.key() to 2L),
                )
                .isEmpty()
        )
        assertNotEquals(old.key(), wrong.key())
    }

    @Test
    fun syncPauseConsentAndRevocation() {
        val r = SyncRecord("A", "steps", "1", 1, "{}")
        for (c in
            listOf(
                SyncConsent("A", setOf("steps")),
                SyncConsent("B", setOf("steps"), true, false),
            )) assertTrue(
            pendingSyncRecords("A", c, listOf(r), setOf("steps"), emptyMap()).isEmpty()
        )
        assertTrue(
            pendingSyncRecords(
                    "A",
                    SyncConsent("A", setOf("steps"), true, false),
                    listOf(r),
                    emptySet(),
                    emptyMap(),
                )
                .isEmpty()
        )
    }
}
