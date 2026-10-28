package io.github.astrasler.whooplens

import android.content.Context
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONArray
import org.json.JSONObject

internal object DashboardCodec {
    fun encode(snapshot: DashboardSnapshot): String {
        fun batch(b: DataBatch?): Any {
            if (b == null) return JSONObject.NULL
            val j =
                JSONObject()
                    .put("source", b.source.name)
                    .put("time", b.fetchedAt)
                    .put("complete", b.complete)
                    .put("notices", JSONArray(b.notices))
            j.put(
                "metrics",
                JSONArray(
                    b.metrics.map { m ->
                        JSONObject()
                            .put("key", m.key)
                            .put("title", m.title)
                            .put("value", m.value ?: JSONObject.NULL)
                            .put("unit", m.unit)
                            .put("time", m.measuredAt ?: JSONObject.NULL)
                            .put("origin", m.origin ?: JSONObject.NULL)
                    }
                ),
            )
            val s = JSONObject()
            b.series.forEach { (key, points) ->
                val bounded = if (key == HEART_RATE_DAILY) boundedHeartRateDays(points, b.fetchedAt) else points
                s.put(
                    key,
                    JSONArray(
                        bounded.takeLast(500).map {
                            JSONArray()
                                .put(it.time)
                                .put(it.value ?: JSONObject.NULL)
                                .put(it.origin ?: JSONObject.NULL)
                        }
                    ),
                )
            }
            j.put("series", s)
            j.put(
                "sleeps",
                JSONArray(
                    b.sleeps.takeLast(30).map { r ->
                        JSONObject()
                            .put("start", r.start)
                            .put("end", r.end)
                            .put("origin", r.origin)
                            .put("minutes", r.asleepMinutes ?: JSONObject.NULL)
                            .put(
                                "stages",
                                JSONArray(
                                    r.stages.take(40).map {
                                        JSONArray().put(it.start).put(it.end).put(it.label)
                                    }
                                ),
                            )
                    }
                ),
            )
            j.put(
                "exercise",
                JSONArray(
                    b.exercises.sortedByDescending { it.start }.take(50).map {
                        JSONArray().put(it.start).put(it.end).put(it.title).put(it.origin)
                    }
                ),
            )
            return j
        }
        return JSONObject()
            .put("v", 1)
            .put("account", snapshot.account)
            .put("whoop", batch(snapshot.whoop))
            .put("health", batch(snapshot.health))
            .toString()
    }

    fun decode(text: String, account: String): DashboardSnapshot? =
        try {
            val j = JSONObject(text)
            require(j.getInt("v") == 1 && j.getString("account") == account)
            fun batch(key: String, source: DataSource): DataBatch? {
                val b = j.optJSONObject(key) ?: return null
                require(b.getString("source") == source.name)
                val m =
                    b.getJSONArray("metrics").objects().map {
                        Metric(
                            it.getString("key"),
                            it.getString("title"),
                            it.number("value"),
                            it.getString("unit"),
                            source,
                            it.number("time")?.toLong(),
                            it.optString("origin").takeIf { s -> s != "null" },
                        )
                    }
                val series = b.getJSONObject("series")
                val points =
                    series.keys().asSequence().associateWith { k ->
                        val a = series.getJSONArray(k)
                        val decoded = (0 until a.length()).map { n ->
                            val p = a.getJSONArray(n)
                            Point(
                                p.getLong(0),
                                (p.opt(1) as? Number)?.toDouble(),
                                p.optString(2).takeIf { it != "null" && it.isNotBlank() },
                            )
                        }
                        if (k == HEART_RATE_DAILY) boundedHeartRateDays(decoded, b.getLong("time")) else decoded
                    }
                val sleeps =
                    b.getJSONArray("sleeps").objects().map { s ->
                        val a = s.getJSONArray("stages")
                        SleepDetail(
                            s.getLong("start"),
                            s.getLong("end"),
                            s.getString("origin"),
                            (0 until a.length()).map {
                                val r = a.getJSONArray(it)
                                SleepStage(r.getLong(0), r.getLong(1), r.getString(2))
                            },
                            s.number("minutes"),
                        )
                    }
                val e = b.getJSONArray("exercise")
                val exercise =
                    (0 until e.length()).map {
                        val r = e.getJSONArray(it)
                        ExerciseDetail(r.getLong(0), r.getLong(1), r.getString(2), r.getString(3))
                    }
                val n = b.optJSONArray("notices") ?: JSONArray()
                return DataBatch(
                    source,
                    b.getLong("time"),
                    m,
                    points,
                    sleeps,
                    exercise,
                    ((0 until n.length()).map { n.getString(it) } +
                            "Local history: up to 500 samples per metric, 30 sleeps and 50 exercises. Bounded records, not complete lifetime totals.")
                        .distinct(),
                    b.getBoolean("complete"),
                )
            }
            DashboardSnapshot(
                account,
                batch("whoop", DataSource.WHOOP),
                batch("health", DataSource.HEALTH_CONNECT),
            )
        } catch (_: Exception) {
            null
        }
}

private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

internal class DashboardCache(context: Context) {
    private val storage = androidSessionStorage(context.applicationContext, true)

    @Synchronized
    fun read(account: String): DashboardSnapshot? =
        try {
            storage.read()?.let { DashboardCodec.decode(it, account) }
        } catch (_: Exception) {
            clear()
            null
        }

    @Synchronized
    fun write(snapshot: DashboardSnapshot) {
        try {
            storage.write(DashboardCodec.encode(snapshot))
        } catch (_: Exception) {
            clear()
        }
    }

    @Synchronized
    fun clear() {
        try {
            storage.clear()
        } catch (_: Exception) {
            /* ciphertext cannot be recovered without matching live account */
        }
    }
}

internal class WhoopReadClient(
    private val auth: PrivateSession,
    private val account: String,
    private val allowed: () -> Boolean = { true },
) {
    fun call(tool: String, args: JSONObject): JSONObject {
        require(tool in WhoopDashboard.tools)
        check(allowed() && auth.accountKey() == account)
        val token = auth.accessToken() ?: error("Sign in required")
        check(auth.accountKey() == account)
        val connection = URL(PrivateSession.RESOURCE).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 12000
            connection.readTimeout = 18000
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Accept", "application/json, text/event-stream")
            connection.setRequestProperty("MCP-Protocol-Version", "2025-11-25")
            connection.doOutput = true
            val body =
                JSONObject()
                    .put("jsonrpc", "2.0")
                    .put("id", 1)
                    .put("method", "tools/call")
                    .put("params", JSONObject().put("name", tool).put("arguments", args))
                    .toString()
            connection.outputStream.use { it.write(body.toByteArray()) }
            check(connection.responseCode == 200) { "WHOOP read unavailable" }
            val bytes = connection.inputStream.use { it.readNBytes(1000001) }
            require(bytes.size <= 1000000)
            check(allowed() && auth.accountKey() == account)
            return JSONObject(bytes.toString(Charsets.UTF_8))
        } finally {
            connection.disconnect()
        }
    }
}
