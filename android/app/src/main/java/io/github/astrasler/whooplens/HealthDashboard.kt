package io.github.astrasler.whooplens

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.*
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.*
import kotlin.reflect.KClass

internal data class HealthCategory(
    val key: String,
    val title: String,
    val type: KClass<out Record>,
    val explanation: String,
) {
    val permission: String
        get() = HealthPermission.getReadPermission(type)
}

internal val healthCategories =
    listOf(
        HealthCategory(
            "steps",
            "Steps",
            StepsRecord::class,
            "Daily aggregate, with Health Connect's source priority.",
        ),
        HealthCategory(
            "sleep",
            "Sleep sessions",
            SleepSessionRecord::class,
            "Times and stages only when a writing app shares them.",
        ),
        HealthCategory(
            "heart",
            "Heart rate",
            HeartRateRecord::class,
            "Individual heart-rate samples and their writing apps.",
        ),
        HealthCategory(
            "exercise",
            "Exercise sessions",
            ExerciseSessionRecord::class,
            "Session type, duration and source. No exercise routes requested.",
        ),
        HealthCategory(
            "distance",
            "Distance",
            DistanceRecord::class,
            "Daily distance in kilometres.",
        ),
        HealthCategory(
            "energy",
            "Active energy",
            ActiveCaloriesBurnedRecord::class,
            "Active calories recorded by source apps.",
        ),
        HealthCategory(
            "floors",
            "Floors",
            FloorsClimbedRecord::class,
            "Daily floors climbed, if recorded.",
        ),
        HealthCategory(
            "hrv",
            "Heart rate variability",
            HeartRateVariabilityRmssdRecord::class,
            "RMSSD in milliseconds; kept separate from WHOOP.",
        ),
        HealthCategory(
            "rhr",
            "Resting heart rate",
            RestingHeartRateRecord::class,
            "Recorded resting rate, not inferred from other samples.",
        ),
        HealthCategory(
            "spo2",
            "Oxygen saturation",
            OxygenSaturationRecord::class,
            "Recorded oxygen saturation.",
        ),
        HealthCategory(
            "respiratory",
            "Respiratory rate",
            RespiratoryRateRecord::class,
            "Recorded breaths per minute.",
        ),
        HealthCategory(
            "temperature",
            "Body temperature",
            BodyTemperatureRecord::class,
            "Body temperature; not WHOOP skin temperature.",
        ),
        HealthCategory(
            "pressure",
            "Blood pressure",
            BloodPressureRecord::class,
            "Systolic and diastolic readings in mmHg.",
        ),
        HealthCategory("weight", "Weight", WeightRecord::class, "Recorded body mass."),
        HealthCategory("bodyfat", "Body fat", BodyFatRecord::class, "Recorded body fat percentage."),
    )

internal class HealthDashboard(
    private val context: Context,
    private val allowed: () -> Boolean = { true },
) {
    suspend fun load(now: Long = System.currentTimeMillis()): Pair<DataBatch, Set<String>> {
        check(allowed())
        val hc = HealthConnectClient.getOrCreate(context)
        val granted = hc.permissionController.getGrantedPermissions()
        val zone = ZoneId.systemDefault()
        val end = Instant.ofEpochMilli(now)
        val start = end.atZone(zone).toLocalDate().minusDays(29).atStartOfDay(zone).toInstant()
        val range = TimeRangeFilter.between(start, end)
        val metrics = mutableListOf<Metric>()
        val series = mutableMapOf<String, List<Point>>()
        // Always replace cached daily history, including on denial/read failure.
        series[HEART_RATE_DAILY] = emptyList()
        val sleeps = mutableListOf<SleepDetail>()
        val exercises = mutableListOf<ExerciseDetail>()
        val notices = mutableListOf<String>()
        var complete = true
        fun allowed(type: KClass<out Record>) = HealthPermission.getReadPermission(type) in granted
        fun add(key: String, title: String, unit: String, points: List<Point>, origin: String?) {
            val sorted = points.sortedBy { it.time }
            series[key] = sorted
            val latest = sorted.lastOrNull()
            metrics.add(
                Metric(
                    key,
                    title,
                    latest?.value,
                    unit,
                    DataSource.HEALTH_CONNECT,
                    latest?.time,
                    origin,
                )
            )
        }
        // Cumulative values use aggregation to honour Health Connect deduplication/source
        // priorities.
        suspend fun aggregate(
            key: String,
            title: String,
            unit: String,
            block: suspend () -> List<Point>,
        ) {
            try {
                check(allowed())
                val points = block()
                series[key] = points
                val today = end.atZone(zone).toLocalDate()
                val p =
                    points.findLast {
                        Instant.ofEpochMilli(it.time).atZone(zone).toLocalDate() == today
                    }
                metrics.add(
                    Metric(
                        key,
                        title,
                        p?.value,
                        unit,
                        DataSource.HEALTH_CONNECT,
                        p?.time,
                        "Health Connect aggregate · mixed/unknown origin",
                    )
                )
            } catch (_: Exception) {
                notices.add("$title could not be read. Check permission and retry.")
                complete = false
            }
        }
        val localRange =
            TimeRangeFilter.between(
                LocalDateTime.ofInstant(start, zone),
                LocalDateTime.ofInstant(end, zone),
            )
        if (allowed(StepsRecord::class))
            aggregate("steps", "Steps", "steps") {
                hc.aggregateGroupByPeriod(
                        AggregateGroupByPeriodRequest(
                            setOf(StepsRecord.COUNT_TOTAL),
                            localRange,
                            Period.ofDays(1),
                        )
                    )
                    .map {
                        Point(
                            it.startTime.atZone(zone).toInstant().toEpochMilli(),
                            it.result[StepsRecord.COUNT_TOTAL]?.toDouble(),
                        )
                    }
            }
        if (allowed(DistanceRecord::class))
            aggregate("distance", "Distance", "km") {
                hc.aggregateGroupByPeriod(
                        AggregateGroupByPeriodRequest(
                            setOf(DistanceRecord.DISTANCE_TOTAL),
                            localRange,
                            Period.ofDays(1),
                        )
                    )
                    .map {
                        Point(
                            it.startTime.atZone(zone).toInstant().toEpochMilli(),
                            it.result[DistanceRecord.DISTANCE_TOTAL]?.inKilometers,
                        )
                    }
            }
        if (allowed(ActiveCaloriesBurnedRecord::class))
            aggregate("energy", "Active energy", "kcal") {
                hc.aggregateGroupByPeriod(
                        AggregateGroupByPeriodRequest(
                            setOf(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL),
                            localRange,
                            Period.ofDays(1),
                        )
                    )
                    .map {
                        Point(
                            it.startTime.atZone(zone).toInstant().toEpochMilli(),
                            it.result[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]
                                ?.inKilocalories,
                        )
                    }
            }
        if (allowed(FloorsClimbedRecord::class))
            aggregate("floors", "Floors", "floors") {
                hc.aggregateGroupByPeriod(
                        AggregateGroupByPeriodRequest(
                            setOf(FloorsClimbedRecord.FLOORS_CLIMBED_TOTAL),
                            localRange,
                            Period.ofDays(1),
                        )
                    )
                    .map {
                        Point(
                            it.startTime.atZone(zone).toInstant().toEpochMilli(),
                            it.result[FloorsClimbedRecord.FLOORS_CLIMBED_TOTAL],
                        )
                    }
            }
        suspend fun <T : Record> records(type: KClass<T>): List<T> {
            if (!allowed(type)) return emptyList()
            val out = mutableListOf<T>()
            try {
                val pages = readHealthPages { cursor ->
                    check(allowed())
                    val r =
                        hc.readRecords(
                            ReadRecordsRequest(
                                type,
                                range,
                                pageSize = 200,
                                pageToken = cursor,
                                ascendingOrder = false,
                            )
                        )
                    HealthPage(r.records, r.pageToken)
                }
                out.addAll(pages.rows)
                if (!pages.complete) {
                    complete = false
                    notices.add(
                        "${healthCategories.find { it.type==type }?.title}: latest 1,000 records shown; more available."
                    )
                }
            } catch (_: Exception) {
                notices.add(
                    "${healthCategories.find { it.type==type }?.title} unavailable. Permission may have changed."
                )
                complete = false
                return emptyList()
            }
            return out.distinctBy { it.metadata.id }
        }
        val sleep = records(SleepSessionRecord::class)
        sleep.forEach { r ->
            val stages =
                r.stages.map {
                    SleepStage(
                        it.startTime.toEpochMilli(),
                        it.endTime.toEpochMilli(),
                        when (it.stage) {
                            SleepSessionRecord.STAGE_TYPE_AWAKE -> "Awake"
                            SleepSessionRecord.STAGE_TYPE_REM -> "REM"
                            SleepSessionRecord.STAGE_TYPE_DEEP -> "Deep"
                            SleepSessionRecord.STAGE_TYPE_LIGHT -> "Light"
                            SleepSessionRecord.STAGE_TYPE_SLEEPING -> "Asleep"
                            else -> "Unknown"
                        },
                    )
                }
            val minutes = asleepMinutes(stages)
            sleeps.add(
                SleepDetail(
                    r.startTime.toEpochMilli(),
                    r.endTime.toEpochMilli(),
                    r.metadata.dataOrigin.packageName,
                    stages,
                    minutes,
                )
            )
        }
        add(
            "sleep",
            "Sleep (known stages)",
            "min",
            sleeps.map { Point(it.end, it.asleepMinutes) },
            sleeps.maxByOrNull { it.end }?.origin,
        )
        if (allowed(HeartRateRecord::class)) {
            try {
                series[HEART_RATE_DAILY] = readHeartRateDailyHistory(now, zone, allowed) { from, to ->
                    hc.aggregateGroupByPeriod(
                        AggregateGroupByPeriodRequest(
                            setOf(HeartRateRecord.BPM_AVG),
                            TimeRangeFilter.between(from, to),
                            Period.ofDays(1),
                        )
                    ).map { bucket ->
                        Point(
                            bucket.startTime.atZone(zone).toInstant().toEpochMilli(),
                            bucket.result[HeartRateRecord.BPM_AVG]?.toDouble(),
                        )
                    }
                }
            } catch (_: Exception) {
                notices.add("Heart-rate baseline unavailable. Check permission and retry.")
                complete = false
            }
        }
        val heart = records(HeartRateRecord::class)
        val heartPoints =
            heart
                .flatMap { r ->
                    r.samples.map {
                        Point(
                            it.time.toEpochMilli(),
                            it.beatsPerMinute.toDouble(),
                            r.metadata.dataOrigin.packageName,
                        )
                    }
                }
                .sortedBy { it.time }
        // Limit chart density, never imply unobserved intermediate samples.
        add(
            "heart",
            "Heart rate",
            "bpm",
            heartPoints.takeLast(2000),
            heart.maxByOrNull { it.endTime }?.metadata?.dataOrigin?.packageName,
        )
        if (heartPoints.size > 2000) {
            notices.add("Heart-rate chart shows latest 2,000 samples.")
            complete = false
        }
        records(ExerciseSessionRecord::class).forEach { r ->
            exercises.add(
                ExerciseDetail(
                    r.startTime.toEpochMilli(),
                    r.endTime.toEpochMilli(),
                    r.title?.take(100) ?: "Exercise · type ${r.exerciseType}",
                    r.metadata.dataOrigin.packageName,
                )
            )
        }
        val today = end.atZone(zone).toLocalDate()
        val todayStart = today.atStartOfDay(zone).toInstant().toEpochMilli()
        val todayExercise = exercises.filter { it.end > todayStart }
        metrics.add(
            Metric(
                "exercise",
                "Exercise",
                todayExercise
                    .takeIf { it.isNotEmpty() }
                    ?.sumOf {
                        (minOf(it.end, now) - maxOf(it.start, todayStart)).coerceAtLeast(0) /
                            60000.0
                    },
                "min",
                DataSource.HEALTH_CONNECT,
                todayExercise.maxOfOrNull { it.end },
                "Session durations · overlaps not deduplicated",
            )
        )
        val hrv = records(HeartRateVariabilityRmssdRecord::class)
        add(
            "hrv",
            "HRV",
            "ms",
            hrv.map {
                Point(
                    it.time.toEpochMilli(),
                    it.heartRateVariabilityMillis,
                    it.metadata.dataOrigin.packageName,
                )
            },
            hrv.maxByOrNull { it.time }?.metadata?.dataOrigin?.packageName,
        )
        val rhr = records(RestingHeartRateRecord::class)
        add(
            "rhr",
            "Resting HR",
            "bpm",
            rhr.map {
                Point(
                    it.time.toEpochMilli(),
                    it.beatsPerMinute.toDouble(),
                    it.metadata.dataOrigin.packageName,
                )
            },
            rhr.maxByOrNull { it.time }?.metadata?.dataOrigin?.packageName,
        )
        val oxygen = records(OxygenSaturationRecord::class)
        add(
            "spo2",
            "Blood oxygen",
            "%",
            oxygen.map {
                Point(
                    it.time.toEpochMilli(),
                    it.percentage.value,
                    it.metadata.dataOrigin.packageName,
                )
            },
            oxygen.maxByOrNull { it.time }?.metadata?.dataOrigin?.packageName,
        )
        val resp = records(RespiratoryRateRecord::class)
        add(
            "respiratory",
            "Respiratory rate",
            "rpm",
            resp.map { Point(it.time.toEpochMilli(), it.rate, it.metadata.dataOrigin.packageName) },
            resp.maxByOrNull { it.time }?.metadata?.dataOrigin?.packageName,
        )
        val temp = records(BodyTemperatureRecord::class)
        add(
            "bodytemperature",
            "Body temperature",
            "°C",
            temp.map {
                Point(
                    it.time.toEpochMilli(),
                    it.temperature.inCelsius,
                    it.metadata.dataOrigin.packageName,
                )
            },
            temp.maxByOrNull { it.time }?.metadata?.dataOrigin?.packageName,
        )
        val bp = records(BloodPressureRecord::class)
        add(
            "systolic",
            "Systolic pressure",
            "mmHg",
            bp.map {
                Point(
                    it.time.toEpochMilli(),
                    it.systolic.inMillimetersOfMercury,
                    it.metadata.dataOrigin.packageName,
                )
            },
            bp.maxByOrNull { it.time }?.metadata?.dataOrigin?.packageName,
        )
        add(
            "diastolic",
            "Diastolic pressure",
            "mmHg",
            bp.map {
                Point(
                    it.time.toEpochMilli(),
                    it.diastolic.inMillimetersOfMercury,
                    it.metadata.dataOrigin.packageName,
                )
            },
            bp.maxByOrNull { it.time }?.metadata?.dataOrigin?.packageName,
        )
        val weight = records(WeightRecord::class)
        add(
            "weight",
            "Weight",
            "kg",
            weight.map {
                Point(
                    it.time.toEpochMilli(),
                    it.weight.inKilograms,
                    it.metadata.dataOrigin.packageName,
                )
            },
            weight.maxByOrNull { it.time }?.metadata?.dataOrigin?.packageName,
        )
        val fat = records(BodyFatRecord::class)
        add(
            "bodyfat",
            "Body fat",
            "%",
            fat.map {
                Point(
                    it.time.toEpochMilli(),
                    it.percentage.value,
                    it.metadata.dataOrigin.packageName,
                )
            },
            fat.maxByOrNull { it.time }?.metadata?.dataOrigin?.packageName,
        )
        check(allowed())
        val stillGranted = hc.permissionController.getGrantedPermissions()
        require(
            stillGranted.containsAll(
                granted.intersect(healthCategories.map { it.permission }.toSet())
            )
        ) {
            "Permissions changed during read"
        }
        return DataBatch(
            DataSource.HEALTH_CONNECT,
            now,
            metrics,
            series,
            sleeps.sortedBy { it.end },
            exercises.sortedByDescending { it.start },
            notices,
            complete,
        ) to stillGranted
    }
}
