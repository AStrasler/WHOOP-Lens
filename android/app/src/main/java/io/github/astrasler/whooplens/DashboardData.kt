package io.github.astrasler.whooplens

import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId
import org.json.JSONArray
import org.json.JSONObject

internal enum class DataSource(val label: String) {
    WHOOP("WHOOP"),
    HEALTH_CONNECT("Health Connect"),
}

internal data class Point(val time: Long, val value: Double?, val origin: String? = null)

internal data class Metric(
    val key: String,
    val title: String,
    val value: Double?,
    val unit: String,
    val source: DataSource,
    val measuredAt: Long?,
    val origin: String? = null,
) {
    fun display(): String =
        value?.let {
            if (unit == "min") duration(it)
            else
                java.text.DecimalFormat("#,##0.#").format(it) + if (unit.isBlank()) "" else " $unit"
        } ?: "Not shared"
}

internal fun duration(minutes: Double): String =
    "${minutes.toLong() / 60}h ${minutes.toLong() % 60}m"

internal data class SleepStage(val start: Long, val end: Long, val label: String)

internal data class SleepDetail(
    val start: Long,
    val end: Long,
    val origin: String,
    val stages: List<SleepStage>,
    val asleepMinutes: Double?,
)

internal data class ExerciseDetail(
    val start: Long,
    val end: Long,
    val title: String,
    val origin: String,
)

internal data class DataBatch(
    val source: DataSource,
    val fetchedAt: Long,
    val metrics: List<Metric> = emptyList(),
    val series: Map<String, List<Point>> = emptyMap(),
    val sleeps: List<SleepDetail> = emptyList(),
    val exercises: List<ExerciseDetail> = emptyList(),
    val notices: List<String> = emptyList(),
    val complete: Boolean = true,
) {
    fun metric(key: String): Metric? = metrics.find { it.key == key }

    fun stale(now: Long) = now - fetchedAt > 12 * 3600000L
}

internal data class DashboardSnapshot(
    val account: String,
    val whoop: DataBatch? = null,
    val health: DataBatch? = null,
)

internal class DashboardOwner {
    var snapshot: DashboardSnapshot? = null
        private set

    private var epoch = 0L

    fun select(account: String?): Long {
        if (snapshot?.account != account) {
            epoch++
            snapshot = account?.let { DashboardSnapshot(it) }
        }
        return epoch
    }

    fun ticket(): Long = epoch

    fun accept(account: String, ticket: Long, batch: DataBatch): Boolean {
        val current = snapshot ?: return false
        if (current.account != account || epoch != ticket) return false
        snapshot =
            if (batch.source == DataSource.WHOOP) current.copy(whoop = batch)
            else current.copy(health = batch)
        return true
    }

    fun forgetHealth() {
        snapshot = snapshot?.copy(health = null)
        epoch++
    }
}

internal fun chartSlots(
    points: List<Point>,
    days: Int,
    now: Long,
    zone: ZoneId = ZoneId.systemDefault(),
): List<Point> {
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val map =
        points
            .sortedBy { it.time }
            .groupBy { Instant.ofEpochMilli(it.time).atZone(zone).toLocalDate() }
    return (days - 1 downTo 0).map { n ->
        val d = today.minusDays(n.toLong())
        Point(d.atStartOfDay(zone).toInstant().toEpochMilli(), map[d]?.lastOrNull()?.value)
    }
}

internal fun statistics(points: List<Point>): Triple<Double, Double, Double>? {
    val values = points.mapNotNull { it.value?.takeIf(Double::isFinite) }
    if (values.isEmpty()) return null
    return Triple(values.average(), values.max(), values.min())
}

internal fun personalBaseline(
    points: List<Point>,
    now: Long,
    zone: ZoneId = ZoneId.systemDefault(),
): Triple<Double, Double, Double>? {
    val values = chartSlots(points, 30, now, zone).mapNotNull { it.value?.takeIf(Double::isFinite) }
    if (values.size < 14) return null
    val mean = values.average()
    val deviation = kotlin.math.sqrt(values.sumOf { (it - mean) * (it - mean) } / values.size)
    return Triple(mean - deviation, mean, mean + deviation)
}

internal enum class WidgetPrivacy {
    HIDDEN,
    SUMMARY,
    DETAILED,
}

internal fun widgetText(
    snapshot: DashboardSnapshot?,
    sessionAccount: String?,
    privacy: WidgetPrivacy,
    locked: Boolean,
    lockSurface: Boolean,
    keys: List<String>,
    now: Long,
): String {
    if (sessionAccount == null || (snapshot != null && snapshot.account != sessionAccount))
        return "Sign in to WhoopLens\nNo data shown while signed out"
    // Locked and lock-surface text is chosen before any metric is formatted.
    if (locked || lockSurface)
        return if (privacy == WidgetPrivacy.HIDDEN || snapshot == null || locked) "Unlock to view"
        else "Overview ready\nUnlock to view"
    if (snapshot == null) return "No saved measurements\nOpen WhoopLens"
    if (privacy != WidgetPrivacy.DETAILED)
        return if (privacy == WidgetPrivacy.HIDDEN) "WhoopLens\nUnlock to view"
        else
            "WhoopLens\n${if(snapshot.whoop!=null || snapshot.health!=null) "Saved overview available" else "Open to refresh"} · unlock to view" +
                listOfNotNull(snapshot.whoop, snapshot.health).joinToString("", prefix = "") {
                    "\n${it.source.label} · read ${dateTime(it.fetchedAt)}"
                }
    val chosen =
        keys.mapNotNull { key ->
            val b =
                if (key in setOf("steps", "distance", "energy", "exercise")) snapshot.health
                else snapshot.whoop
            b?.metric(key)?.let { b to it }
        }
    if (chosen.isEmpty()) return "No shared measurements\nOpen WhoopLens"
    return chosen.joinToString("\n") { (_, m) ->
        m.title + "  " + m.display() + (if (isDailyTotal(m)) " · " + dailyTotalPeriodLabel(m, now) else "")
    } +
        chosen
            .groupBy { it.first.source }
            .values
            .joinToString("") { pairs ->
                val b = pairs.first().first
                val times = pairs.map { metricUpdatedAt(it.second, b) }
                val measured = if (times.any { it == null }) null else times.filterNotNull().minOrNull()
                "\n" +
                    b.source.label +
                    " · " +
                    (if (pairs.any { metricIsStale(it.second, b, now) }) "Saved " else "Read ") +
                    (measured?.let(::dateTime) ?: "refresh time unavailable")
            }
}

/** Future upload path. A local refresh can never opt in or call this sender. */
internal data class SyncConsent(
    val account: String,
    val categories: Set<String>,
    val consented: Boolean = false,
    val paused: Boolean = true,
)

internal data class SyncRecord(
    val account: String,
    val category: String,
    val recordId: String,
    val modified: Long,
    val payload: String,
) {
    fun key(): String =
        MessageDigest.getInstance("SHA-256")
            .digest("$account|$category|$recordId".toByteArray())
            .joinToString("") { "%02x".format(it) }
}

internal class PreparedCloudSync(private val send: (String, List<SyncRecord>) -> Boolean) {
    private val sent = mutableMapOf<String, Long>()

    fun transfer(
        account: String,
        consent: SyncConsent,
        records: List<SyncRecord>,
        granted: Set<String>,
        online: Boolean,
        token: () -> String?,
        currentAccount: () -> String?,
    ): String {
        if (!ManualSync.ENABLE_UPLOADS) return "Off in this build"
        if (
            !consent.consented ||
                consent.paused ||
                consent.account != account ||
                currentAccount() != account
        )
            return "Paused"
        if (!online) return "Offline"
        val eligible = pendingSyncRecords(account, consent, records, granted, sent)
        if (eligible.isEmpty()) return "Nothing to sync"
        val bearer = token() ?: return "Sign in required"
        if (currentAccount() != account) return "Account changed"
        if (!send(bearer, eligible)) return "Not confirmed"
        eligible.forEach { sent[it.key()] = it.modified }
        return "Synced"
    }
}

internal fun pendingSyncRecords(
    account: String,
    consent: SyncConsent,
    records: List<SyncRecord>,
    granted: Set<String>,
    sent: Map<String, Long>,
): List<SyncRecord> {
    if (consent.account != account || !consent.consented || consent.paused) return emptyList()
    return records
        .filter {
            it.account == account && it.category in consent.categories && it.category in granted
        }
        .sortedByDescending { it.modified }
        .distinctBy { it.key() }
        .filter { sent[it.key()] != it.modified }
}

/** Only the existing allowlisted WHOOP read tools can reach this transport. */
internal class WhoopDashboard(private val request: (String, JSONObject) -> JSONObject) {
    companion object {
        val tools = setOf("get_recovery", "get_sleep", "get_cycles", "get_workouts")
    }

    fun load(now: Long = System.currentTimeMillis()): DataBatch {
        val metrics = mutableListOf<Metric>()
        val series = mutableMapOf<String, MutableList<Point>>()
        val sleeps = mutableListOf<SleepDetail>()
        val exercises = mutableListOf<ExerciseDetail>()
        val notices = mutableListOf<String>()
        var complete = true
        for (tool in tools) {
            try {
                val rows = mutableListOf<JSONObject>()
                var cursor: String? = null
                val seen = mutableSetOf<String>()
                for (page in 0 until 4) {
                    val args = JSONObject().put("limit", 25).put("auto_page", false)
                    cursor?.let { args.put("next_token", it) }
                    val envelope = request(tool, args)
                    require(!envelope.has("error"))
                    val result = envelope.getJSONObject("result")
                    require(!result.optBoolean("isError"))
                    val data =
                        result.optJSONObject("structuredContent")
                            ?: JSONObject(
                                result.getJSONArray("content").getJSONObject(0).getString("text")
                            )
                    require(
                        data.optString("source") == "whoop" &&
                            data.optString("source_authority") == "authoritative"
                    ) {
                        "Wrong measurement source"
                    }
                    if (!data.optBoolean("complete", true)) {
                        complete = false
                        notices.add("WHOOP history is partial; more records may exist.")
                    }
                    val records = data.optJSONArray("records") ?: JSONArray()
                    for (i in 0 until records.length()) rows.add(records.getJSONObject(i))
                    cursor = data.optString("next_token").takeIf { it.isNotBlank() && it != "null" }
                    if (cursor == null) break
                    require(seen.add(cursor)) { "Repeated page" }
                    if (page == 3) complete = false
                }
                // Cycles are contiguous: an open cycle's start is the previous cycle's end.
                // Dating strain by end ties those records and can keep yesterday's strain.
                val timeKeys =
                    if (tool == "get_cycles") listOf("start", "created_at", "end")
                    else listOf("end", "start", "created_at")
                fun recordTime(r: JSONObject) = stamp(r, timeKeys)
                val unique =
                    rows
                        .distinctBy { it.optString("id", it.optString("cycle_id", it.toString())) }
                        .sortedBy { recordTime(it) ?: Long.MIN_VALUE }
                fun add(
                    key: String,
                    title: String,
                    unit: String,
                    values: List<Pair<JSONObject, Double?>>,
                ) {
                    series[key] =
                        values
                            .mapNotNull { (r, v) -> recordTime(r)?.let { Point(it, v) } }
                            .toMutableList()
                    val latest = values.lastOrNull()
                    metrics.add(
                        Metric(
                            key,
                            title,
                            latest?.second,
                            unit,
                            DataSource.WHOOP,
                            latest?.first?.let { recordTime(it) },
                        )
                    )
                }
                fun scored(field: String) =
                    unique.map {
                        it to
                            if (it.optString("score_state") == "SCORED")
                                it.optJSONObject("score")?.number(field)
                            else null
                    }
                when (tool) {
                    "get_recovery" -> {
                        add("recovery", "Recovery", "%", scored("recovery_score"))
                        add("hrv", "HRV", "ms", scored("hrv_rmssd_milli"))
                        add("rhr", "Resting HR", "bpm", scored("resting_heart_rate"))
                        add("spo2", "Blood oxygen", "%", scored("spo2_percentage"))
                        add("temperature", "Skin temperature", "°C", scored("skin_temp_celsius"))
                    }
                    "get_cycles" -> add("strain", "Strain", "/ 21", scored("strain"))
                    "get_sleep" -> {
                        val main = unique.filter { !it.optBoolean("nap") }
                        val times =
                            main.map { r ->
                                val st =
                                    if (r.optString("score_state") == "SCORED")
                                        r.optJSONObject("score")?.optJSONObject("stage_summary")
                                    else null
                                val total =
                                    listOf(
                                            "total_light_sleep_time_milli",
                                            "total_slow_wave_sleep_time_milli",
                                            "total_rem_sleep_time_milli",
                                        )
                                        .map { st?.number(it) }
                                r to
                                    if (total.all { it != null }) total.sumOf { it!! } / 60000
                                    else null
                            }
                        for ((field, key, title) in
                            listOf(
                                Triple("total_rem_sleep_time_milli", "rem", "REM"),
                                Triple("total_light_sleep_time_milli", "light", "Light"),
                                Triple("total_slow_wave_sleep_time_milli", "deep", "Deep"),
                                Triple("total_awake_time_milli", "awake", "Awake"),
                            )) add(
                            key,
                            title,
                            "min",
                            main.map { r ->
                                r to
                                    if (r.optString("score_state") == "SCORED")
                                        r.optJSONObject("score")
                                            ?.optJSONObject("stage_summary")
                                            ?.number(field)
                                            ?.div(60000)
                                    else null
                            },
                        )
                        add("sleep", "Sleep", "min", times)
                        add(
                            "performance",
                            "Sleep performance",
                            "%",
                            main.map {
                                it to
                                    if (it.optString("score_state") == "SCORED")
                                        it.optJSONObject("score")
                                            ?.number("sleep_performance_percentage")
                                    else null
                            },
                        )
                        add("respiratory", "Respiratory rate", "rpm", scored("respiratory_rate"))
                        main.forEach { r ->
                            val start = parseTime(r.optString("start"))
                            val end = parseTime(r.optString("end"))
                            if (start != null && end != null)
                                sleeps.add(
                                    SleepDetail(
                                        start,
                                        end,
                                        "WHOOP · stage totals only",
                                        emptyList(),
                                        times.find { it.first === r }?.second,
                                    )
                                )
                        }
                    }
                    "get_workouts" ->
                        unique.forEach { r ->
                            val start = parseTime(r.optString("start"))
                            val end = parseTime(r.optString("end"))
                            if (start != null && end != null)
                                exercises.add(
                                    ExerciseDetail(
                                        start,
                                        end,
                                        r.optString("sport_name").ifBlank { "WHOOP workout" },
                                        "WHOOP",
                                    )
                                )
                        }
                }
            } catch (_: Exception) {
                notices.add("${tool.removePrefix("get_")} unavailable. Retry WHOOP reads.")
                complete = false
            }
        }
        return DataBatch(
            DataSource.WHOOP,
            now,
            metrics,
            series,
            sleeps,
            exercises,
            notices,
            complete,
        )
    }
}

internal fun JSONObject.number(key: String): Double? =
    (opt(key) as? Number)?.toDouble()?.takeIf { it.isFinite() }

internal fun parseTime(value: String): Long? =
    try {
        Instant.parse(value).toEpochMilli()
    } catch (_: Exception) {
        null
    }

private fun stamp(
    r: JSONObject,
    keys: List<String> = listOf("end", "start", "created_at"),
): Long? = keys.firstNotNullOfOrNull { parseTime(r.optString(it)) }
