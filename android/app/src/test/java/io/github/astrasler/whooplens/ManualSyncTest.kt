package io.github.astrasler.whooplens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.time.Instant
import java.time.LocalDate

class ManualSyncTest {

  @Test
  fun testUploadDisabledOnDraftBranch() {
    assertFalse("ENABLE_UPLOADS must be false on draft branch", ManualSync.ENABLE_UPLOADS)

    val now = Instant.now()
    val draft = ReviewedSteps(
      day = LocalDate.now().minusDays(1),
      start = now.minusSeconds(3600),
      end = now,
      count = 5000,
      preparedAtMs = System.currentTimeMillis()
    )

    val exception = assertThrows(IllegalStateException::class.java) {
      ManualSync.uploadApprovedSteps(draft, "mock-token")
    }
    assertEquals("Manual sync is not released", exception.message)
  }

  @Test
  fun testDeleteAccountDataReturnsDisabledWhenUploadsDisabled() {
    assertFalse(ManualSync.ENABLE_UPLOADS)
    var called = false
    val result = ManualSync.deleteAccountData("mock-token") {
      called = true
      throw AssertionError("Disabled deletion must not create a connection")
    }
    assertTrue("Must return DeletionResult.Disabled when uploads/sync are OFF", result is DeletionResult.Disabled)
    assertFalse(called)
  }

  @Test
  fun testInternalDeletionCannotBypassDisabledGate() {
    var called = false
    val result = ManualSync.executeDeletionRequest("mock-token") {
      called = true
      throw AssertionError("Connection provider must not be invoked")
    }
    assertTrue(result is DeletionResult.Disabled)
    assertFalse(called)
  }

  @Test
  fun testDeletionResponseRejectsMissingOrInvalidCount() {
    for (json in listOf(
      "{}",
      """{"deleted":null}""",
      """{"deleted":-1}""",
      """{"deleted":"3"}""",
      """{"deleted":3.5}""",
      """{"deleted":true}""",
      """{"deleted":2147483648}""",
      """{"deleted":[]}"""
    )) {
      val result = ManualSync.parseDeletionResponse(200, json)
      assertTrue("Should reject: $json", result is DeletionResult.Failed)
    }
    val zero = ManualSync.parseDeletionResponse(200, """{"deleted":0}""")
    assertTrue(zero is DeletionResult.Confirmed)
    assertEquals(0, (zero as DeletionResult.Confirmed).recordsDeleted)
  }

  @Test
  fun testParseDeletionResponseSuccess() {
    val json = """{"deleted": 3, "consent": "withdrawn", "source": "health_connect"}"""
    val result = ManualSync.parseDeletionResponse(200, json)
    assertTrue(result is DeletionResult.Confirmed)
    assertEquals(3, (result as DeletionResult.Confirmed).recordsDeleted)
  }

  @Test
  fun testParseDeletionResponseServerError() {
    val result = ManualSync.parseDeletionResponse(500, """{"error": "Internal error"}""")
    assertTrue(result is DeletionResult.Failed)
    assertEquals(500, (result as DeletionResult.Failed).statusCode)
  }

  @Test
  fun testParseDeletionResponseMalformedJson() {
    val result = ManualSync.parseDeletionResponse(200, "not-valid-json")
    assertTrue(result is DeletionResult.Failed)
    assertTrue((result as DeletionResult.Failed).reason.contains("Malformed"))
  }

  @Test
  fun testReviewedStepsValidation() {
    val now = Instant.now()
    val nowMs = System.currentTimeMillis()
    val valid = ReviewedSteps(
      day = LocalDate.of(2026, 10, 22),
      start = now.minusSeconds(86400),
      end = now,
      count = 8500,
      preparedAtMs = nowMs
    )
    assertTrue(valid.valid(nowMs))

    // Expired (> 5 minutes old)
    val expired = valid.copy(preparedAtMs = nowMs - (6 * 60 * 1000L))
    assertFalse(expired.valid(nowMs))

    // Negative count
    val negative = valid.copy(count = -1)
    assertFalse(negative.valid(nowMs))

    // Exceeds 10M limit
    val excessive = valid.copy(count = 10_000_001L)
    assertFalse(excessive.valid(nowMs))

    // End before start
    val inverted = valid.copy(start = now, end = now.minusSeconds(100))
    assertFalse(inverted.valid(nowMs))
  }

  @Test
  fun testExportJsonFormat() {
    val now = Instant.now()
    val nowMs = System.currentTimeMillis()
    val valid = ReviewedSteps(
      day = LocalDate.of(2026, 10, 22),
      start = now.minusSeconds(86400),
      end = now,
      count = 4321,
      preparedAtMs = nowMs
    )
    val jsonString = valid.exportJson()
    assertNotNull(jsonString)
    assertTrue(jsonString.contains(""""schema_version":2"""))
    assertTrue(jsonString.contains(""""source":"health_connect""""))
    assertTrue(jsonString.contains(""""metric":"steps_daily""""))
    assertTrue(jsonString.contains(""""count":4321"""))
  }
}
