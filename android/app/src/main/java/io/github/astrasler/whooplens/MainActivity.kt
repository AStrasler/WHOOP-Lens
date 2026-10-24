package io.github.astrasler.whooplens

import android.os.Bundle
import android.content.Intent
import android.net.Uri
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.runBlocking

/** Data is read only on explicit Preview; this version never uploads health records. */
class MainActivity : ComponentActivity() {
  private val auth = PrivateSession()
  private var verified = false
  private var uiGeneration = 0L
  private var preparedSteps: ReviewedSteps? = null
  private val permissions = setOf(
    HealthPermission.getReadPermission(StepsRecord::class),
    HealthPermission.getReadPermission(SleepSessionRecord::class),
    HealthPermission.getReadPermission(HeartRateRecord::class),
    HealthPermission.getReadPermission(ExerciseSessionRecord::class)
  )
  private val permissionsLauncher = registerForActivityResult(
    PermissionController.createRequestPermissionResultContract()
  ) { granted ->
    if (!verified || auth.currentToken() == null) return@registerForActivityResult
    findViewById<TextView>(4001)?.text =
      "Health Connect: " + granted.size + " of " + permissions.size + " permissions granted. No data uploaded."
    preparedSteps = null
    findViewById<Button>(4004)?.isEnabled = false
    findViewById<Button>(4002)?.isEnabled = verified &&
      granted.contains(HealthPermission.getReadPermission(StepsRecord::class))
    findViewById<Button>(4003)?.isEnabled = verified && granted.any {
      it == HealthPermission.getReadPermission(SleepSessionRecord::class) ||
      it == HealthPermission.getReadPermission(HeartRateRecord::class) ||
      it == HealthPermission.getReadPermission(ExerciseSessionRecord::class)
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleOAuthCallback(intent)
  }

  private fun handleOAuthCallback(intent: Intent?) {
    val callback = intent?.data ?: return
    if (callback.scheme != "https" || callback.host != "whooplens.tech" || callback.path != "/android/oauth/callback") return
    val attempt = uiGeneration
    findViewById<TextView>(4001)?.text = "Verifying Cloudflare authorization..."
    Thread {
      val ok = try { auth.completeSignIn(callback, attempt) } catch (_: Exception) { false }
      runOnUiThread {
        if (attempt != uiGeneration || isDestroyed || isFinishing) return@runOnUiThread
        verified = ok
        findViewById<Button>(4002)?.isEnabled = false
        findViewById<Button>(4003)?.isEnabled = false
        findViewById<Button>(4004)?.isEnabled = false
        findViewById<TextView>(4001)?.text = if (ok)
          "Cloudflare authorization complete. No health data uploaded."
        else "Cloudflare sign-in failed or expired. Please retry."
        // Permissions are requested only after the authenticated callback.
        findViewById<Button>(4005)?.isEnabled = ok &&
          HealthConnectClient.getSdkStatus(this) == HealthConnectClient.SDK_AVAILABLE
      }
    }.start()
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(40, 64, 40, 40)
    }
    val heading = TextView(this).apply { text = "WHOOP Lens Companion"; textSize = 23f }
    val status = TextView(this).apply {
      text = "Private beta. Sign in before requesting access to your health data."
      id = 4001
    }
    val loginButton = Button(this).apply { text = "Sign in with Cloudflare" }
    val permissionsButton = Button(this).apply {
      id = 4005
      text = "Choose Health Connect permissions"
      isEnabled = false
    }
    val previewButton = Button(this).apply {
      id = 4002
      text = "Preview yesterday's steps locally"
      isEnabled = false
    }
    val otherPreviewButton = Button(this).apply {
      id = 4003
      text = "Preview last 24h sleep, HR and exercise counts"
      isEnabled = false
    }
    val reviewButton = Button(this).apply {
      id = 4004
      text = "Review one-day steps sync"
      isEnabled = false
    }
    val deleteButton = Button(this).apply {
      text = "Delete uploaded steps for a chosen date"
      isEnabled = false
    }
    val logoutButton = Button(this).apply { text = "Sign out" }
    val hcStatus = when (HealthConnectClient.getSdkStatus(this)) {
      HealthConnectClient.SDK_AVAILABLE -> "Health Connect is available."
      HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "Health Connect requires an update."
      else -> "Health Connect is unavailable on this phone."
    }
    layout.addView(heading)
    layout.addView(TextView(this).apply { text = hcStatus })
    layout.addView(loginButton)
    layout.addView(permissionsButton)
    layout.addView(previewButton)
    layout.addView(otherPreviewButton)
    layout.addView(reviewButton)
    layout.addView(deleteButton)
    layout.addView(logoutButton)
    layout.addView(status)
    layout.addView(TextView(this).apply {
      text = "Steps are read on Preview, then reviewed separately. Upload remains disabled until the private backend is approved. No automatic synchronization."
    })
    setContentView(ScrollView(this).apply { addView(layout) })
    handleOAuthCallback(intent)

    loginButton.setOnClickListener {
      val attempt = ++uiGeneration
      val authAttempt = auth.beginSignIn()
      verified = false
      permissionsButton.isEnabled = false
      previewButton.isEnabled = false
      otherPreviewButton.isEnabled = false
      reviewButton.isEnabled = false
      deleteButton.isEnabled = false
      preparedSteps = null
      loginButton.isEnabled = false
      status.text = "Preparing secure Cloudflare sign-in..."
      Thread {
        val url = try { auth.authorizationUrl(authAttempt) } catch (_: Exception) { null }
        runOnUiThread {
          if (attempt != uiGeneration || isDestroyed || isFinishing) return@runOnUiThread
          loginButton.isEnabled = true
          if (url == null) status.text = "Cloudflare OAuth registration unavailable."
          else {
            status.text = "Complete sign-in in your browser."
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE))
          }
        }
      }.start()
    }
    permissionsButton.setOnClickListener {
      if (verified && auth.currentToken() != null &&
          HealthConnectClient.getSdkStatus(this) == HealthConnectClient.SDK_AVAILABLE) {
        permissionsLauncher.launch(permissions)
      } else {
        status.text = "Please sign in again or update Health Connect."
      }
    }

    previewButton.setOnClickListener {
      if (!verified || auth.currentToken() == null) {
        status.text = "Please sign in again before viewing your steps."
      } else {
        val attempt = uiGeneration
        previewButton.isEnabled = false
        status.text = "Reading yesterday's steps locally..."
        Thread {
          val draft = try {
            runBlocking {
              val hc = HealthConnectClient.getOrCreate(this@MainActivity)
              val granted = hc.permissionController.getGrantedPermissions()
              if (!granted.contains(HealthPermission.getReadPermission(StepsRecord::class)))
                throw SecurityException("Steps access not granted")
              val zone = ZoneId.systemDefault()
              val today = LocalDate.now(zone)
              val start = today.minusDays(1).atStartOfDay(zone).toInstant()
              val end = today.atStartOfDay(zone).toInstant()
              val steps = hc.aggregate(AggregateRequest(
                metrics = setOf(StepsRecord.COUNT_TOTAL),
                timeRangeFilter = TimeRangeFilter.between(start, end)
              ))[StepsRecord.COUNT_TOTAL]
              if (steps == null) null else ReviewedSteps(today.minusDays(1), start, end, steps)
            }
          } catch (_: Exception) { null }
          runOnUiThread {
            if (attempt != uiGeneration || isDestroyed || isFinishing ||
              !verified || auth.currentToken() == null) return@runOnUiThread
            previewButton.isEnabled = true
            preparedSteps = draft?.takeIf { it.valid() }
            reviewButton.isEnabled = preparedSteps != null
            status.text = if (preparedSteps == null)
              "Yesterday's steps unavailable or permission revoked. No data uploaded."
            else preparedSteps!!.describe() + " Tap Review to inspect the proposed upload. Nothing has been sent."
          }
        }.start()
      }
    }

    otherPreviewButton.setOnClickListener {
      if (!verified || auth.currentToken() == null) {
        status.text = "Sign in again before reading local health records."
      } else {
        val attempt = uiGeneration
        otherPreviewButton.isEnabled = false
        status.text = "Reading permitted Health Connect records locally..."
        Thread {
          val summary = try {
            runBlocking {
              val hc = HealthConnectClient.getOrCreate(this@MainActivity)
              val granted = hc.permissionController.getGrantedPermissions()
              val end = java.time.Instant.now()
              val start = end.minusSeconds(24L * 3600L)
              val range = TimeRangeFilter.between(start, end)
              val rows = mutableListOf<String>()
              if (granted.contains(HealthPermission.getReadPermission(SleepSessionRecord::class))) {
                val count = hc.readRecords(ReadRecordsRequest(
                  recordType = SleepSessionRecord::class, timeRangeFilter = range, pageSize = 50
                )).records.size
                rows.add("Sleep sessions (up to 50): " + count)
              } else rows.add("Sleep: permission not granted")
              if (granted.contains(HealthPermission.getReadPermission(HeartRateRecord::class))) {
                val count = hc.readRecords(ReadRecordsRequest(
                  recordType = HeartRateRecord::class, timeRangeFilter = range, pageSize = 50
                )).records.size
                rows.add("Heart rate records (up to 50): " + count)
              } else rows.add("Heart rate: permission not granted")
              if (granted.contains(HealthPermission.getReadPermission(ExerciseSessionRecord::class))) {
                val count = hc.readRecords(ReadRecordsRequest(
                  recordType = ExerciseSessionRecord::class, timeRangeFilter = range, pageSize = 50
                )).records.size
                rows.add("Exercise sessions (up to 50): " + count)
              } else rows.add("Exercise: permission not granted")
              rows.joinToString(". ")
            }
          } catch (_: Exception) { "Local preview unavailable; check Health Connect permissions." }
          runOnUiThread {
            if (attempt != uiGeneration || isDestroyed || isFinishing ||
              !verified || auth.currentToken() == null) return@runOnUiThread
            otherPreviewButton.isEnabled = true
            status.text = summary + " No data uploaded."
          }
        }.start()
      }
    }

    reviewButton.setOnClickListener {
      val snapshot = preparedSteps
      if (!verified || auth.currentToken() == null || snapshot == null || !snapshot.valid()) {
        preparedSteps = null
        reviewButton.isEnabled = false
        status.text = "The reviewed preview expired or your session ended. Preview again."
      } else {
        val enabled = ManualSync.ENABLE_UPLOADS
        AlertDialog.Builder(this)
          .setTitle("Review Health Connect upload")
          .setMessage(snapshot.describe() + "\n\n" + if (enabled)
            "Only the record shown would be uploaded after you confirm."
          else "Uploads are OFF until the private backend migration and release are approved.")
          .setNegativeButton("Cancel", null)
          .setPositiveButton(if (enabled) "Upload this record" else "OK") { _, _ ->
            if (enabled && verified && snapshot === preparedSteps && auth.currentToken() != null) {
              val attempt = uiGeneration
              preparedSteps = null
              reviewButton.isEnabled = false
              status.text = "Uploading one reviewed steps record..."
              Thread {
                val success = try {
                  val client = HealthConnectClient.getOrCreate(this@MainActivity)
                  val stillGranted = runBlocking {
                    client.permissionController.getGrantedPermissions()
                  }.contains(HealthPermission.getReadPermission(StepsRecord::class))
                  val token = auth.currentToken()
                  stillGranted && token != null && ManualSync.uploadApprovedSteps(snapshot, token)
                } catch (_: Exception) { false }
                runOnUiThread {
                  if (attempt != uiGeneration || isDestroyed || isFinishing ||
                    !verified || auth.currentToken() == null) return@runOnUiThread
                  status.text = if (success) "One steps record uploaded to your private account."
                    else "Upload was not confirmed. No automatic retry; preview again to retry."
                }
              }.start()
            }
          }
          .show()
      }
    }

    deleteButton.setOnClickListener {
      if (!ManualSync.ENABLE_UPLOADS || !verified || auth.currentToken() == null) {
        status.text = "Deletion is unavailable until private sync is released and you sign in."
      } else {
        val yesterday = LocalDate.now().minusDays(1)
        DatePickerDialog(this, { _, year, monthZeroBased, dayOfMonth ->
          val selected = LocalDate.of(year, monthZeroBased + 1, dayOfMonth)
          AlertDialog.Builder(this)
            .setTitle("Delete your uploaded steps?")
            .setMessage("Remove only the Health Connect steps aggregate dated " + selected +
              " from your signed-in WHOOP Lens account? This does not delete your phone's records.")
            .setNegativeButton("Keep", null)
            .setPositiveButton("Delete uploaded record") { _, _ ->
              val attempt = uiGeneration
              deleteButton.isEnabled = false
              status.text = "Requesting deletion for " + selected + "..."
              Thread {
                val removed = try {
                  val token = auth.currentToken()
                  if (token == null) -1 else ManualSync.deleteApprovedSteps(selected, token)
                } catch (_: Exception) { -1 }
                runOnUiThread {
                  if (attempt != uiGeneration || isDestroyed || isFinishing ||
                      !verified || auth.currentToken() == null) return@runOnUiThread
                  deleteButton.isEnabled = ManualSync.ENABLE_UPLOADS
                  status.text = when (removed) {
                    1 -> "Your uploaded steps for " + selected + " were deleted."
                    0 -> "No uploaded steps record was found for " + selected + "."
                    else -> "Deletion could not be confirmed; no automatic retry."
                  }
                }
              }.start()
            }
            .show()
        }, yesterday.year, yesterday.monthValue - 1, yesterday.dayOfMonth)
          .apply { datePicker.maxDate = System.currentTimeMillis(); show() }
      }
    }

    logoutButton.setOnClickListener {
      ++uiGeneration
      auth.signOut()
      loginButton.isEnabled = true
      verified = false
      permissionsButton.isEnabled = false
      previewButton.isEnabled = false
      otherPreviewButton.isEnabled = false
      reviewButton.isEnabled = false
      deleteButton.isEnabled = false
      preparedSteps = null
      status.text = "Signed out. No data was uploaded."
    }
  }

  override fun onDestroy() {
    ++uiGeneration
    preparedSteps = null
    auth.signOut()
    super.onDestroy()
  }
}
