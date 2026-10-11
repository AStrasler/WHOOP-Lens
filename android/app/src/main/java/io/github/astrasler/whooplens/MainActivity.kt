package io.github.astrasler.whooplens

import android.os.Bundle
import android.app.AlertDialog
import android.text.InputType
import android.widget.Button
import android.widget.EditText
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

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(40, 64, 40, 40)
    }
    val heading = TextView(this).apply { text = "WHOOP Lens Companion"; textSize = 23f }
    val email = EditText(this).apply {
      hint = "Authorized email"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
    }
    val password = EditText(this).apply {
      hint = "Password"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
    }
    val status = TextView(this).apply {
      text = "Private beta. Sign in before requesting access to your health data."
      id = 4001
    }
    val loginButton = Button(this).apply { text = "Sign in" }
    val permissionsButton = Button(this).apply {
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
    val logoutButton = Button(this).apply { text = "Sign out" }
    val hcStatus = when (HealthConnectClient.getSdkStatus(this)) {
      HealthConnectClient.SDK_AVAILABLE -> "Health Connect is available."
      HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "Health Connect requires an update."
      else -> "Health Connect is unavailable on this phone."
    }
    layout.addView(heading)
    layout.addView(TextView(this).apply { text = hcStatus })
    layout.addView(email)
    layout.addView(password)
    layout.addView(loginButton)
    layout.addView(permissionsButton)
    layout.addView(previewButton)
    layout.addView(otherPreviewButton)
    layout.addView(reviewButton)
    layout.addView(logoutButton)
    layout.addView(status)
    layout.addView(TextView(this).apply {
      text = "Steps are read on Preview, then reviewed separately. Upload remains disabled until the private backend is approved. No automatic synchronization."
    })
    setContentView(ScrollView(this).apply { addView(layout) })

    loginButton.setOnClickListener {
      val attempt = ++uiGeneration
      val authAttempt = auth.beginSignIn()
      val address = email.text.toString().trim()
      val secret = password.text.toString()
      password.text.clear()
      verified = false
      permissionsButton.isEnabled = false
      previewButton.isEnabled = false
      otherPreviewButton.isEnabled = false
      reviewButton.isEnabled = false
      preparedSteps = null
      loginButton.isEnabled = false
      status.text = "Checking your private WHOOP Lens access..."
      Thread {
        val result = try { auth.signIn(address, secret, authAttempt) } catch (_: Exception) { false }
        runOnUiThread {
          if (attempt != uiGeneration || isDestroyed || isFinishing) return@runOnUiThread
          verified = result
          loginButton.isEnabled = true
          permissionsButton.isEnabled = result &&
            HealthConnectClient.getSdkStatus(this) == HealthConnectClient.SDK_AVAILABLE
          status.text = if (result) "Authorized account confirmed. No health data accessed."
            else "Sign-in failed or this account is not yet connected to WHOOP Lens."
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

    logoutButton.setOnClickListener {
      ++uiGeneration
      auth.signOut()
      loginButton.isEnabled = true
      verified = false
      permissionsButton.isEnabled = false
      previewButton.isEnabled = false
      otherPreviewButton.isEnabled = false
      reviewButton.isEnabled = false
      preparedSteps = null
      password.text.clear()
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
