package io.github.astrasler.whooplens

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DashboardExerciseCacheTest {
    private fun records(source: DataSource) =
        (1..60).map { ExerciseDetail(it * 1000L, it * 1000L + 500, "Workout $it", source.label) }

    private fun snapshot(source: DataSource, exercises: List<ExerciseDetail>): DashboardSnapshot {
        val batch = DataBatch(source, 123456L, exercises = exercises)
        return if (source == DataSource.WHOOP) DashboardSnapshot("A", whoop = batch)
        else DashboardSnapshot("A", health = batch)
    }

    private fun roundTrip(source: DataSource, input: List<ExerciseDetail>): List<ExerciseDetail> {
        val decoded = DashboardCodec.decode(DashboardCodec.encode(snapshot(source, input)), "A")!!
        val batch = if (source == DataSource.WHOOP) decoded.whoop!! else decoded.health!!
        assertEquals(source, batch.source)
        assertEquals(123456L, batch.fetchedAt)
        return batch.exercises
    }

    @Test
    fun ascendingExercisesRetainNewestFiftyForBothSources() {
        DataSource.entries.forEach { source ->
            val input = records(source)
            assertEquals(input.reversed().take(50), roundTrip(source, input))
        }
    }

    @Test
    fun descendingExercisesRetainNewestFiftyForBothSources() {
        DataSource.entries.forEach { source ->
            val input = records(source).reversed()
            assertEquals(input.take(50), roundTrip(source, input))
        }
    }

    @Test
    fun mixedExercisesRetainNewestFiftyWithoutMutatingInput() {
        DataSource.entries.forEach { source ->
            val ascending = records(source)
            val input =
                ascending.filterIndexed { i, _ -> i % 2 == 0 } +
                    ascending.filterIndexed { i, _ -> i % 2 != 0 }.reversed()
            val before = input.toList()
            assertEquals(ascending.reversed().take(50), roundTrip(source, input))
            assertEquals(before, input)
        }
    }

    @Test
    fun identicalTimestampsPreserveInputOrderAtCutoff() {
        DataSource.entries.forEach { source ->
            val input = (1..60).map { ExerciseDetail(1000L, 2000L, "Tie $it", source.label) }
            assertEquals(input.take(50), roundTrip(source, input))
            assertEquals(roundTrip(source, input), roundTrip(source, input))
        }
    }

    @Test
    fun simultaneousSourcesRemainSeparateAndWrongAccountIsRejected() {
        val original =
            DashboardSnapshot(
                "A",
                whoop = snapshot(DataSource.WHOOP, records(DataSource.WHOOP)).whoop,
                health =
                    snapshot(DataSource.HEALTH_CONNECT, records(DataSource.HEALTH_CONNECT)).health,
            )
        val encoded = DashboardCodec.encode(original)
        val decoded = DashboardCodec.decode(encoded, "A")!!
        assertEquals(records(DataSource.WHOOP).reversed().take(50), decoded.whoop!!.exercises)
        assertEquals(
            records(DataSource.HEALTH_CONNECT).reversed().take(50),
            decoded.health!!.exercises,
        )
        assertNull(DashboardCodec.decode(encoded, "B"))
        val tampered = JSONObject(encoded)
        tampered.getJSONObject("whoop").put("source", DataSource.HEALTH_CONNECT.name)
        assertNull(DashboardCodec.decode(tampered.toString(), "A"))
    }

    @Test
    fun missingTimestampStillRejectsCacheAndEpochRemainsValid() {
        DataSource.entries.forEach { source ->
            val epoch = listOf(ExerciseDetail(0L, 500L, "Epoch", source.label))
            assertEquals(epoch, roundTrip(source, epoch))
            val json = JSONObject(DashboardCodec.encode(snapshot(source, epoch)))
            val key = if (source == DataSource.WHOOP) "whoop" else "health"
            json.getJSONObject(key).getJSONArray("exercise").getJSONArray(0).put(0, JSONObject.NULL)
            assertNull(DashboardCodec.decode(json.toString(), "A"))
        }
    }
}
