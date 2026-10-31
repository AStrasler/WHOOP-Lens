package io.github.astrasler.whooplens

import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId
import org.json.JSONArray
import org.json.JSONObject

internal data class CloudSyncStatus(val account: String, val ready: Boolean, val code: String,
    val stored: Int = 0, val lastSyncAt: Long? = null, val paused: Boolean = true)
internal data class CloudSyncDraft(val account: String, val categories: Set<String>, val records: List<SyncRecord>,
    val preparedAtMs: Long, val omitted: Int) {
    fun valid(now: Long) = records.isNotEmpty() && records.size <= 100 && now >= preparedAtMs && now-preparedAtMs < 300000 && records.all { it.account == account && it.category in categories }
    fun review(): String = "Destination: your private WhoopLens account. Latest seven days; ${records.size} records.\n" +
        categories.joinToString(" · ") { key -> "$key: ${records.count { it.category == key }}" } +
        (if (omitted > 0) "\n$omitted older eligible records are outside this bounded preview." else "") +
        "\n\n" + records.joinToString("\n") { record ->
            val row=JSONObject(record.payload)
            "${record.category} · ${row.getString("observed_at")} · ${row.getJSONObject("payload")} ${row.getString("unit")} · ${row.optString("origin_package", "mixed/unknown origin")}"
        }
}
internal fun interface CloudSyncTransport {
    fun request(method: String, path: String, authorization: String, body: String?): Pair<Int, String>
}
internal object ManualSync {
    // Enables the reviewed client, not consent or production service activation.
    const val ENABLE_UPLOADS = true
    val categories: Map<String,String> = linkedMapOf("steps" to "Steps", "heart" to "Heart rate", "sleep" to "Sleep sessions", "exercise" to "Exercise sessions")
    fun draft(snapshot: DashboardSnapshot, owner: String, selected: Set<String>, granted: Set<String>, now: Long): CloudSyncDraft {
        require(snapshot.account == owner && selected.isNotEmpty() && categories.keys.containsAll(selected))
        val batch = snapshot.health ?: error("Refresh Health Connect first")
        require(now >= batch.fetchedAt && now-batch.fetchedAt < 300000) { "Refresh local records before review" }
        require(granted.containsAll(selected)) { "Read permission changed" }
        val rows=mutableListOf<SyncRecord>()
        fun add(category: String, metric: String, start: Long, end: Long?, origin: String?, unit: String, payload: JSONObject, stable: String) {
            if (category !in selected || start < now-7*86400000L || start > now || (end != null && (end < start || end > now))) return
            val key=MessageDigest.getInstance("SHA-256").digest(stable.toByteArray()).joinToString("") { "%02x".format(it) }
            val recordKey=if (category=="steps") stable else "$category:$key"
            val row=JSONObject().put("metric", metric).put("record_key", recordKey).put("observed_at", Instant.ofEpochMilli(start).toString()).put("unit",unit).put("payload",payload)
            if (end != null) row.put("ended_at",Instant.ofEpochMilli(end).toString())
            if (origin != null && origin.matches(Regex("[A-Za-z0-9_.]+"))) row.put("origin_package",origin)
            if (category == "steps") row.put("local_date",Instant.ofEpochMilli(start).atZone(ZoneId.systemDefault()).toLocalDate().toString())
            rows += SyncRecord(owner,category,recordKey,batch.fetchedAt,row.toString())
        }
        batch.series["steps"].orEmpty().forEach { point ->
            val count=point.value
            if (count != null && count.isFinite() && count in 0.0..10000000.0 && count == count.toLong().toDouble()) {
                val day=Instant.ofEpochMilli(point.time).atZone(ZoneId.systemDefault()).toLocalDate()
                val end=minOf(batch.fetchedAt,day.plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli())
                add("steps","steps_daily",point.time,end,null,"steps",JSONObject().put("count",count.toLong()),"daily:$day:local")
            }
        }
        batch.series["heart"].orEmpty().forEach { point ->
            val bpm=point.value
            if (bpm != null && bpm.isFinite() && bpm in 1.0..300.0 && bpm == bpm.toInt().toDouble())
                add("heart","heart_rate",point.time,null,point.origin,"bpm",JSONObject().put("bpm",bpm.toInt()),"${point.origin}|${point.time}")
        }
        batch.sleeps.forEach { sleep ->
            val minutes=sleep.asleepMinutes
            if (minutes != null && minutes.isFinite() && minutes >= 0)
                add("sleep","sleep_session",sleep.start,sleep.end,sleep.origin,"seconds",JSONObject().put("duration_seconds",minutes*60),"${sleep.origin}|${sleep.start}")
        }
        batch.exercises.forEach { exercise ->
            add("exercise","exercise_session",exercise.start,exercise.end,exercise.origin,"seconds",JSONObject().put("duration_seconds",(exercise.end-exercise.start)/1000.0).put("exercise_type",exercise.title.take(80)),"${exercise.origin}|${exercise.start}")
        }
        val bounded=rows.distinctBy { it.key() }.groupBy { it.category }.values.flatMap { it.sortedByDescending { r -> JSONObject(r.payload).getString("observed_at") }.take(25) }
        return CloudSyncDraft(owner,selected,bounded,now,rows.size-bounded.size)
    }
}
internal class CloudSyncClient(private val auth: PrivateSession, private val account: String,
    private val allowed: () -> Boolean = { true }, private val transport: CloudSyncTransport = httpCloudSyncTransport(),
    private val now: () -> Long = System::currentTimeMillis, private val grantedNow: (() -> Set<String>)? = null) {
    private fun exchange(method: String,path: String,body: String?=null,required: Set<String> = emptySet()): Pair<Int,String> {
        check(allowed() && auth.accountKey()==account)
        check(grantedNow == null || required.isEmpty() || grantedNow.invoke().containsAll(required))
        val token=auth.accessToken() ?: return 401 to ""
        check(allowed() && auth.accountKey()==account)
        check(grantedNow == null || required.isEmpty() || grantedNow.invoke().containsAll(required))
        val result=transport.request(method,path,"Bearer $token",body)
        check(allowed() && auth.accountKey()==account)
        return result
    }
    fun status(): CloudSyncStatus {
        return try {
            val (code,body)=exchange("GET","/v1/health-connect/sync-status")
            val json=try { JSONObject(body) } catch (_: Exception) { JSONObject() }
            if (code!=200 || json.optInt("sync_protocol")!=1 || !json.optBoolean("enabled"))
                CloudSyncStatus(account,false,when { code==401 || code==403 -> "sign_in_required";code==404 -> "activation_required";else -> json.optString("code","connection_unavailable") })
            else CloudSyncStatus(account,true,"ready",json.optInt("stored_records"),json.optString("last_sync_at").takeIf { it.isNotBlank() && it!="null" }?.let { Instant.parse(it).toEpochMilli() },json.optBoolean("paused",true))
        } catch (_: Exception) { CloudSyncStatus(account,false,"connection_unavailable") }
    }
    fun upload(draft: CloudSyncDraft,consent: SyncConsent,granted: Set<String>): Boolean {
        require(draft.account==account && draft.valid(now()))
        if (!consent.consented || consent.paused || consent.account!=account || consent.categories!=draft.categories || !granted.containsAll(draft.categories)) return false
        if (!status().ready) return false
        require(draft.valid(now())) // status/token refresh cannot extend an expired preview.
        val engine=PreparedCloudSync { _,rows ->
            val file=JSONObject().put("schema_version",2).put("source","health_connect").put("exported_at",Instant.ofEpochMilli(draft.preparedAtMs).toString()).put("records",JSONArray(rows.map { JSONObject(it.payload) }))
            val body=JSONObject().put("consent","store-health-connect-file").put("file",file)
            val (code,text)=exchange("POST","/v1/health-connect/sync",body.toString(),required=draft.categories)
            val response=try { JSONObject(text) } catch (_: Exception) { return@PreparedCloudSync false }
            code==200 && response.optInt("sync_protocol")==1 && response.optInt("stored",-1)==rows.size && response.optString("source")=="health_connect" && response.optString("synced_at").let { runCatching { Instant.parse(it) }.isSuccess }
        }
        return engine.transfer(account,consent,draft.records,granted,true,{ if (allowed()) auth.accessToken() else null },{ if (allowed()) auth.accountKey() else null })=="Synced"
    }
    fun pause(): Boolean {
        if (!status().ready) return false
        val (code,text)=exchange("POST","/v1/health-connect/pause",JSONObject().put("consent","pause-my-health-connect-sync").toString())
        return code==200 && runCatching { JSONObject(text).getBoolean("paused") }.getOrDefault(false)
    }
    fun withdraw(): Boolean {
        if (!status().ready) return false
        val (code,text)=exchange("DELETE","/v1/health-connect",JSONObject().put("consent","delete-my-health-connect-records").toString())
        return code==200 && runCatching { JSONObject(text).let { it.opt("deleted") is Int && it.getInt("deleted")>=0 && it.optString("consent")=="withdrawn" } }.getOrDefault(false)
    }
}
internal fun httpCloudSyncTransport()=CloudSyncTransport { method,path,authorization,body ->
    require(path in setOf("/v1/health-connect/sync-status","/v1/health-connect/sync","/v1/health-connect/pause","/v1/health-connect"))
    val connection=URL("https://whooplens.tech$path").openConnection() as HttpURLConnection
    try {
        connection.requestMethod=method;connection.instanceFollowRedirects=false
        connection.connectTimeout=10000;connection.readTimeout=20000
        connection.setRequestProperty("Authorization",authorization);connection.setRequestProperty("Accept","application/json")
        if (body!=null) { connection.doOutput=true;connection.setRequestProperty("Content-Type","application/json");connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) } }
        val status=connection.responseCode
        val stream=if (status in 200..299) connection.inputStream else connection.errorStream
        val text=stream?.use { it.readNBytes(16385).toString(Charsets.UTF_8) }.orEmpty()
        status to if (text.length<=16384) text else ""
    } finally { connection.disconnect() }
}
