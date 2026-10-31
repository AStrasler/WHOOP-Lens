package io.github.astrasler.whooplens

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ManualSyncTest {
    private val owner="a".repeat(43)
    private val now=java.time.Instant.parse("2026-10-31T12:00:00Z").toEpochMilli()
    private fun session(): PrivateSession {
        val storage=MemorySessionStorage()
        storage.write(JSONObject().put("version",1).put("issuer",PrivateSession.ISSUER).put("resource",PrivateSession.RESOURCE)
            .put("account",owner).put("client","synthetic").put("endpoint","https://auth.whooplens.tech/token")
            .put("access","synthetic-access").put("refresh","synthetic-refresh").put("expires",now+3600000)
            .put("refreshAt",now+1800000).put("pendingUntil",0).toString())
        return PrivateSession(null,{now},storage)
    }
    private fun snapshot()=DashboardSnapshot(owner,health=DataBatch(DataSource.HEALTH_CONNECT,now,
        series=mapOf("steps" to listOf(Point(now-60000,100.0)),"heart" to (0..30).map { Point(now-it*1000,70.0,"com.example.writer") }),
        sleeps=listOf(SleepDetail(now-3600000,now-1000,"com.example.writer",emptyList(),30.0)),
        exercises=listOf(ExerciseDetail(now-300000,now-1000,"Walk","com.example.writer"))))
    private val all=setOf("steps","heart","sleep","exercise")
    private val ready="""{"sync_protocol":1,"enabled":true,"stored_records":0,"paused":true,"last_sync_at":null}"""
    @Test fun draftsAreBoundedSelectedScopedAndDoNotInventSleep() {
        val draft=ManualSync.draft(snapshot(),owner,all,all,now)
        assertEquals(28,draft.records.size)
        assertEquals(6,draft.omitted)
        assertTrue(draft.valid(now));assertFalse(draft.valid(now+300000))
        assertEquals(1800.0,JSONObject(draft.records.single { it.category=="sleep" }.payload).getJSONObject("payload").getDouble("duration_seconds"),0.001)
        val steps=ManualSync.draft(snapshot(),owner,setOf("steps"),all,now)
        assertEquals(1,steps.records.size)
        assertThrows(IllegalArgumentException::class.java) { ManualSync.draft(snapshot(),"b".repeat(43),all,all,now) }
        assertThrows(IllegalArgumentException::class.java) { ManualSync.draft(snapshot(),owner,all,emptySet(),now) }
    }
    @Test fun consentPausePermissionsAndExpiryPrecedeAnyNetwork() {
        val draft=ManualSync.draft(snapshot(),owner,all,all,now)
        val client=CloudSyncClient(session(),owner,transport=CloudSyncTransport { _,_,_,_ -> throw AssertionError("No network without consent") },now={now})
        assertFalse(client.upload(draft,SyncConsent(owner,all),all))
        assertFalse(client.upload(draft,SyncConsent(owner,all,true,true),all))
        assertFalse(client.upload(draft,SyncConsent(owner,all,true,false),emptySet()))
        assertThrows(IllegalArgumentException::class.java) { client.upload(draft.copy(preparedAtMs=now-300001),SyncConsent(owner,all,true,false),all) }
    }
    @Test fun protocolConsentAndConfirmedCountsAreRequiredForSuccess() {
        val draft=ManualSync.draft(snapshot(),owner,setOf("steps"),all,now)
        var posts=0
        val client=CloudSyncClient(session(),owner,transport=CloudSyncTransport { method,path,auth,body ->
            assertEquals("Bearer synthetic-access",auth)
            if (method=="GET") 200 to ready else {
                posts++;assertEquals("/v1/health-connect/sync",path)
                val json=JSONObject(body!!);assertEquals("store-health-connect-file",json.getString("consent"))
                assertFalse(json.has("user_id"));assertEquals(1,json.getJSONObject("file").getJSONArray("records").length())
                200 to """{"sync_protocol":1,"stored":1,"source":"health_connect","synced_at":"2026-10-31T12:00:00Z"}"""
            }
        },now={now})
        assertTrue(client.upload(draft,SyncConsent(owner,draft.categories,true,false),all));assertEquals(1,posts)
        val legacy=CloudSyncClient(session(),owner,transport=CloudSyncTransport { method,_,_,_ -> assertEquals("GET",method);200 to "{}" },now={now})
        assertFalse(legacy.upload(draft,SyncConsent(owner,draft.categories,true,false),all))
    }
    @Test fun failedUploadsRemainUnconfirmedAndCanBeRetriedWithStableKeys() {
        val draft=ManualSync.draft(snapshot(),owner,setOf("steps"),all,now)
        val bodies=mutableListOf<String>()
        var success=false
        val client=CloudSyncClient(session(),owner,transport=CloudSyncTransport { method,_,_,body ->
            if (method=="GET") 200 to ready else { bodies+=body!!;if(success) 200 to """{"sync_protocol":1,"stored":1,"source":"health_connect","synced_at":"2026-10-31T12:00:00Z"}""" else 503 to "{}" }
        },now={now})
        val consent=SyncConsent(owner,draft.categories,true,false)
        assertFalse(client.upload(draft,consent,all));success=true
        assertTrue(client.upload(draft,consent,all));assertEquals(bodies[0],bodies[1])
    }
    @Test fun pauseWithdrawalAndLastSyncUseAuthenticatedServerResponses() {
        val paths=mutableListOf<String>()
        val client=CloudSyncClient(session(),owner,transport=CloudSyncTransport { method,path,_,body ->
            paths+=path
            when(method) {
                "GET" -> 200 to """{"sync_protocol":1,"enabled":true,"stored_records":2,"paused":false,"last_sync_at":"2026-10-31T12:00:00Z"}"""
                "POST" -> { assertEquals("pause-my-health-connect-sync",JSONObject(body!!).getString("consent"));200 to """{"paused":true}""" }
                else -> { assertEquals("delete-my-health-connect-records",JSONObject(body!!).getString("consent"));200 to """{"deleted":2,"consent":"withdrawn"}""" }
            }
        },now={now})
        assertEquals(now,client.status().lastSyncAt);assertTrue(client.pause());assertTrue(client.withdraw())
        assertTrue(paths.contains("/v1/health-connect/pause"));assertTrue(paths.contains("/v1/health-connect"))
    }
    @Test fun staleAccountAndUnavailableActivationCannotUpload() {
        val auth=session()
        val client=CloudSyncClient(auth,owner,transport=CloudSyncTransport { _,_,_,_ -> auth.beginSignIn();200 to ready },now={now})
        assertFalse(client.status().ready)
        for ((status,body) in listOf(401 to "{}",404 to "{}",503 to """{"code":"migration_required"}""")) {
            val unavailable=CloudSyncClient(session(),owner,transport=CloudSyncTransport { _,_,_,_ -> status to body },now={now}).status()
            assertFalse(unavailable.ready)
        }
    }
    @Test fun permissionRevocationAfterReadinessPreventsTheUpload() {
        val draft=ManualSync.draft(snapshot(),owner,setOf("steps"),all,now)
        var permissions=all
        val client=CloudSyncClient(session(),owner,transport=CloudSyncTransport { method,_,_,_ ->
            assertEquals("GET",method);permissions=emptySet();200 to ready
        },now={now},grantedNow={permissions})
        assertThrows(IllegalStateException::class.java) { client.upload(draft,SyncConsent(owner,draft.categories,true,false),all) }
    }

}
