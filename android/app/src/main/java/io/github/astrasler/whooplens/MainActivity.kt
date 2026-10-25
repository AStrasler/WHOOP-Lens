package io.github.astrasler.whooplens

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.content.Intent
import android.content.ActivityNotFoundException
import android.content.res.ColorStateList
import android.view.View
import androidx.core.view.ViewCompat
import android.app.AlertDialog
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import androidx.activity.ComponentActivity
import androidx.core.net.toUri
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

/** Data is read only on explicit Preview; this version never uploads health records without confirmation. */
class MainActivity : ComponentActivity() {
  private fun Int.dp(): Int = (this * resources.displayMetrics.density + 0.5f).toInt()
  private val auth by lazy { AndroidSessions.get(applicationContext) }
  private val sessionHandler = Handler(Looper.getMainLooper())
  private var foreground = false
  private var restoringSession = false
  private val callbacks = CallbackGate()
  private var grantedPermissions = emptySet<String>()
  private var stepsBusy = false
  private var otherBusy = false
  private val sessionRefresh = object : Runnable {
    override fun run() { restoreSession() }
  }
  private var verified = false
  private var uiGeneration = 0L
  private var preparedSteps: ReviewedSteps? = null
  private var observedSessionGeneration: Long? = null

  // Direct view references to avoid ResourceType lint errors
  private lateinit var statusText: TextView
  private lateinit var accountStatusText: TextView
  private lateinit var healthStatusText: TextView
  private lateinit var loginButton: Button
  private lateinit var retryConnectionButton: Button
  private lateinit var permissionsButton: Button
  private lateinit var previewButton: Button
  private lateinit var otherPreviewButton: Button
  private lateinit var reviewButton: Button
  private lateinit var deleteButton: Button
  private lateinit var logoutButton: Button

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
    grantedPermissions = granted
    preparedSteps = null
    statusText.text = "Health Connect: ${granted.size} of ${permissions.size} permissions granted. No data uploaded."
    renderControls()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleOAuthCallback(intent)
  }

  private fun handleOAuthCallback(intent: Intent?) {
    val callback = intent?.data ?: return
    // Do not retain the authorization code on the Activity's Intent.
    intent.data = null
    if (callback.scheme != "https" || callback.host != "whooplens.tech" || callback.path != "/android/oauth/callback") return
    val authAttempt = auth.pendingAttempt() ?: return
    val callbackTicket = callbacks.begin() ?: return
    val attempt = uiGeneration
    if (::statusText.isInitialized) {
      accountStatusText.text = "Verifying Cloudflare authorization..."
    }
    Thread {
      val ok = try { auth.completeSignIn(callback.toString(), authAttempt) } catch (_: Exception) { false }
      runOnUiThread {
        if (!callbacks.finish(callbackTicket)) return@runOnUiThread
        if (attempt != uiGeneration || isDestroyed || isFinishing) return@runOnUiThread
        verified = ok
        if (::previewButton.isInitialized) previewButton.isEnabled = false
        if (::otherPreviewButton.isInitialized) otherPreviewButton.isEnabled = false
        if (::reviewButton.isInitialized) reviewButton.isEnabled = false
        if (::deleteButton.isInitialized) deleteButton.isEnabled = ok
        if (::statusText.isInitialized) {
          accountStatusText.text = if (ok)
            "Cloudflare authorization complete. No health data uploaded."
          else "Cloudflare sign-in failed or expired. Please retry."
        }
        loginButton.isEnabled = true
        if (ok) restoreSession()
        // Permissions are requested only after the authenticated callback.
        if (::permissionsButton.isInitialized) {
          permissionsButton.isEnabled = ok &&
            HealthConnectClient.getSdkStatus(this) == HealthConnectClient.SDK_AVAILABLE
        }
      }
    }.start()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val background = Color.rgb(12, 22, 27)
    val foreground = Color.rgb(239, 247, 249)
    val muted = Color.rgb(170, 193, 201)
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(background)
      setPadding(20.dp(), 24.dp(), 20.dp(), 28.dp())
    }
    val heading = TextView(this).apply {
      text = "WhoopLens"
      textSize = 27f
      setTextColor(foreground)
      setTypeface(null, Typeface.BOLD)
      setPadding(0, 0, 0, 4.dp())
      ViewCompat.setAccessibilityHeading(this, true)
    }
    fun section(title: String): TextView = TextView(this).apply {
      text = title
      textSize = 15f
      setTypeface(null, Typeface.BOLD)
      setTextColor(muted)
      setPadding(0, 20.dp(), 0, 6.dp())
      ViewCompat.setAccessibilityHeading(this, true)
    }
    fun action(button: Button) {
      button.isAllCaps = false
      button.textSize = 15f
      button.minHeight = 48.dp()
      button.setTextColor(ColorStateList(arrayOf(intArrayOf(android.R.attr.state_enabled), intArrayOf()),
        intArrayOf(foreground, muted)))
      button.background = GradientDrawable().apply {
        setColor(Color.rgb(29, 49, 57))
        cornerRadius = 13.dp().toFloat()
        setStroke(1.dp(), Color.rgb(57, 86, 97))
      }
      button.layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 9.dp() }
      layout.addView(button)
    }

    statusText = TextView(this).apply {
      text = getString(R.string.preview_ready)
      textSize = 14f
      setTextColor(foreground)
      setPadding(12.dp(), 10.dp(), 12.dp(), 10.dp())
      this.background = GradientDrawable().apply {
        setColor(Color.rgb(21, 39, 47))
        cornerRadius = 12.dp().toFloat()
      }
    }
    statusText.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    accountStatusText = TextView(this).apply {
      text = getString(R.string.account_checking)
      textSize = 14f
      setTextColor(muted)
      setPadding(0, 0, 0, 8.dp())
      accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    loginButton = Button(this).apply { text = "Sign in with Cloudflare" }
    retryConnectionButton = Button(this).apply {
      text = getString(R.string.retry_saved_connection)
      visibility = View.GONE
      setOnClickListener {
        accountStatusText.text = getString(R.string.account_checking)
        restoreSession()
      }
    }
    permissionsButton = Button(this).apply {
      text = "Choose Health Connect permissions"
      isEnabled = false
    }
    previewButton = Button(this).apply {
      text = "Preview yesterday's steps locally"
      isEnabled = false
    }
    otherPreviewButton = Button(this).apply {
      text = "Preview last 24h sleep, HR and exercise counts"
      isEnabled = false
    }
    reviewButton = Button(this).apply {
      text = "Review one-day steps sync"
      isEnabled = false
    }
    deleteButton = Button(this).apply {
      text = "Account & data deletion options"
      isEnabled = false
    }
    logoutButton = Button(this).apply { text = "Sign out" }
    val privacyButton = Button(this).apply {
      text = "Health Connect & Privacy Rationale"
    }

    val hcStatus = when (HealthConnectClient.getSdkStatus(this)) {
      HealthConnectClient.SDK_AVAILABLE -> "Health Connect is available."
      HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "Health Connect requires an update."
      else -> "Health Connect is unavailable on this phone."
    }
    layout.addView(heading)
    layout.addView(TextView(this).apply {
      text = "Private companion · Local health previews"
      textSize = 14f
      setTextColor(muted)
    })
    layout.addView(section("Account"))
    action(loginButton)
    action(retryConnectionButton)
    layout.addView(accountStatusText)
    layout.addView(statusText)
    layout.addView(section("Health Connect"))
    healthStatusText = TextView(this).apply {
      text = hcStatus
      textSize = 14f
      setTextColor(muted)
      setPadding(0, 0, 0, 9.dp())
    }
    layout.addView(healthStatusText)
    action(permissionsButton)
    action(Button(this).apply {
      text = getString(R.string.health_connect_settings)
      setOnClickListener { openExternal(Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)) }
    })
    layout.addView(section("Preview on this device"))
    action(previewButton)
    action(otherPreviewButton)
    layout.addView(section("Sync & Data Controls"))
    action(reviewButton)
    action(deleteButton)
    layout.addView(section("Session & Privacy"))
    action(privacyButton)
    action(logoutButton)
    layout.addView(TextView(this).apply {
      text = "No automatic sync. Preview data stays on this device. Upload is disabled."
      textSize = 13f
      setTextColor(muted)
      setPadding(0, 12.dp(), 0, 0)
    })
    setContentView(ScrollView(this).apply {
      setBackgroundColor(background)
      isFillViewport = true
      addView(layout)
      protectSystemBars(this@MainActivity, this)
    })
    handleOAuthCallback(intent)

    privacyButton.setOnClickListener {
      startActivity(Intent(this, PermissionsRationaleActivity::class.java))
    }

    loginButton.setOnClickListener {
      callbacks.cancel()
      sessionHandler.removeCallbacks(sessionRefresh)
      grantedPermissions = emptySet()
      stepsBusy = false
      otherBusy = false
      val attempt = ++uiGeneration
      val authAttempt = try { auth.beginSignIn() } catch (_: Exception) {
        verified = false
        preparedSteps = null
        renderControls()
        accountStatusText.text = getString(R.string.session_storage_unavailable)
        statusText.text = getString(R.string.preview_cleared)
        return@setOnClickListener
      }
      verified = false
      permissionsButton.isEnabled = false
      previewButton.isEnabled = false
      otherPreviewButton.isEnabled = false
      reviewButton.isEnabled = false
      deleteButton.isEnabled = false
      preparedSteps = null
      statusText.text = getString(R.string.preview_cleared)
      renderControls()
      retryConnectionButton.visibility = View.GONE
      loginButton.isEnabled = false
      accountStatusText.text = "Preparing secure Cloudflare sign-in..."
      Thread {
        val url = try { auth.authorizationUrl(authAttempt) } catch (_: Exception) { null }
        runOnUiThread {
          if (attempt != uiGeneration || isDestroyed || isFinishing) return@runOnUiThread
          loginButton.isEnabled = true
          if (url == null) accountStatusText.text = "Cloudflare OAuth registration unavailable."
          else {
            accountStatusText.text = "Complete sign-in in your browser."
            openExternal(Intent(Intent.ACTION_VIEW, url.toUri()).addCategory(Intent.CATEGORY_BROWSABLE))
          }
        }
      }.start()
    }
    permissionsButton.setOnClickListener {
      if (verified && auth.currentToken() != null &&
          HealthConnectClient.getSdkStatus(this) == HealthConnectClient.SDK_AVAILABLE) {
        permissionsLauncher.launch(permissions)
      } else {
        statusText.text = "Please sign in again or update Health Connect."
      }
    }

    previewButton.setOnClickListener {
      if (!verified || auth.currentToken() == null) {
        statusText.text = "Please sign in again before viewing your steps."
      } else {
        val attempt = uiGeneration
        stepsBusy = true
        previewButton.isEnabled = false
        statusText.text = "Reading yesterday's steps locally..."
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
            stepsBusy = false
            preparedSteps = draft?.takeIf { it.valid() }
            renderControls()
            statusText.text = if (preparedSteps == null)
              "Yesterday's steps unavailable or permission revoked. No data uploaded."
            else "${preparedSteps!!.describe()} Tap Review to inspect the proposed upload. Nothing has been sent."
          }
        }.start()
      }
    }

    otherPreviewButton.setOnClickListener {
      if (!verified || auth.currentToken() == null) {
        statusText.text = "Sign in again before reading local health records."
      } else {
        val attempt = uiGeneration
        otherBusy = true
        otherPreviewButton.isEnabled = false
        statusText.text = "Reading permitted Health Connect records locally..."
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
                val page = hc.readRecords(ReadRecordsRequest(
                  recordType = SleepSessionRecord::class, timeRangeFilter = range, pageSize = 50
                ))
                rows.add("Sleep sessions: ${page.records.size} shown" +
                  if (page.pageToken != null) getString(R.string.more_records_available) else "")
              } else rows.add("Sleep: permission not granted")
              if (granted.contains(HealthPermission.getReadPermission(HeartRateRecord::class))) {
                val page = hc.readRecords(ReadRecordsRequest(
                  recordType = HeartRateRecord::class, timeRangeFilter = range, pageSize = 50
                ))
                rows.add("Heart rate records: ${page.records.size} shown" +
                  if (page.pageToken != null) getString(R.string.more_records_available) else "")
              } else rows.add("Heart rate: permission not granted")
              if (granted.contains(HealthPermission.getReadPermission(ExerciseSessionRecord::class))) {
                val page = hc.readRecords(ReadRecordsRequest(
                  recordType = ExerciseSessionRecord::class, timeRangeFilter = range, pageSize = 50
                ))
                rows.add("Exercise sessions: ${page.records.size} shown" +
                  if (page.pageToken != null) getString(R.string.more_records_available) else "")
              } else rows.add("Exercise: permission not granted")
              getString(R.string.health_connect_source) + " " + rows.joinToString(". ")
            }
          } catch (_: Exception) { "Local preview unavailable; check Health Connect permissions." }
          runOnUiThread {
            if (attempt != uiGeneration || isDestroyed || isFinishing ||
              !verified || auth.currentToken() == null) return@runOnUiThread
            otherBusy = false
            renderControls()
            statusText.text = "$summary. No data uploaded."
          }
        }.start()
      }
    }

    reviewButton.setOnClickListener {
      val snapshot = preparedSteps
      if (!verified || auth.currentToken() == null || snapshot == null || !snapshot.valid()) {
        preparedSteps = null
        reviewButton.isEnabled = false
        statusText.text = "The reviewed preview expired or your session ended. Preview again."
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
              statusText.text = "Uploading one reviewed steps record..."
              Thread {
                val success = try {
                  val client = HealthConnectClient.getOrCreate(this@MainActivity)
                  val stillGranted = runBlocking {
                    client.permissionController.getGrantedPermissions()
                  }.contains(HealthPermission.getReadPermission(StepsRecord::class))
                  val token = auth.accessToken()
                  stillGranted && token != null && ManualSync.uploadApprovedSteps(snapshot, token)
                } catch (_: Exception) { false }
                runOnUiThread {
                  if (attempt != uiGeneration || isDestroyed || isFinishing ||
                    !verified || auth.currentToken() == null) return@runOnUiThread
                  statusText.text = if (success) "One steps record uploaded to your private account."
                    else "Upload was not confirmed. No automatic retry; preview again to retry."
                }
              }.start()
            }
          }
          .show()
      }
    }

    deleteButton.setOnClickListener {
      if (!verified || auth.currentToken() == null) {
        statusText.text = "Sign in before managing account data deletion."
      } else {
        AlertDialog.Builder(this)
          .setTitle("Account & Health Data Options")
          .setMessage(
            "Please distinguish between local session, device permissions, and server data:\n\n" +
            "• Local Session: Use 'Sign out' below to erase encrypted credentials and cached previews, and request server grant revocation.\n\n" +
            "• Device Permissions: Open Android Settings > Security & Privacy > Health Connect to view or revoke on-device permissions.\n\n" +
            "• Server-Held Data: Request deletion of any Health Connect records synced to your WhoopLens account. " +
            if (!ManualSync.ENABLE_UPLOADS)
              "(Note: Sync and deletion are currently OFF in this companion build. Existing server records may still exist.)"
            else "(This removes all synced records from the server; phone records are never deleted.)"
          )
          .setPositiveButton("Delete Server Records") { _, _ ->
            // Second explicit confirmation before sending destructive request
            AlertDialog.Builder(this)
              .setTitle("Confirm Server Data Deletion")
              .setMessage(
                if (!ManualSync.ENABLE_UPLOADS)
                  "Sync is currently disabled on this draft branch (ENABLE_UPLOADS = false). " +
                  "Server deletion is unavailable from this build. Existing server records may still exist.\n\n" +
                  "Would you like to open the web deletion request page instead?"
                else
                  "Are you sure you want to delete all Health Connect records stored on your WhoopLens server account? " +
                  "This action cannot be undone."
              )
              .setNegativeButton("Cancel", null)
              .setPositiveButton(if (!ManualSync.ENABLE_UPLOADS) "Open Web Deletion Page" else "Confirm Deletion") { _, _ ->
                if (!ManualSync.ENABLE_UPLOADS) {
                  openExternal(
                    Intent(Intent.ACTION_VIEW, "https://www.whooplens.tech/privacy/".toUri())
                      .addCategory(Intent.CATEGORY_BROWSABLE)
                  )
                } else {
                  val attempt = uiGeneration
                  deleteButton.isEnabled = false
                  statusText.text = "Requesting deletion of synced server records..."
                  Thread {
                    val result = try {
                      val token = auth.accessToken()
                      if (token == null) DeletionResult.Failed("Session expired")
                      else ManualSync.deleteAccountData(token)
                    } catch (e: Exception) {
                      DeletionResult.Failed(e.message ?: "Unknown error")
                    }
                    runOnUiThread {
                      if (attempt != uiGeneration || isDestroyed || isFinishing ||
                          !verified || auth.currentToken() == null) return@runOnUiThread
                      deleteButton.isEnabled = true
                      statusText.text = when (result) {
                        is DeletionResult.Confirmed ->
                          "Server confirmed: ${result.recordsDeleted} synced record(s) deleted."
                        is DeletionResult.Disabled ->
                          "Server sync and deletion are disabled in this build (ENABLE_UPLOADS is OFF). No remote data was modified."
                        is DeletionResult.Failed ->
                          "Deletion was not confirmed. Server records may have changed; check before retrying."
                      }
                    }
                  }.start()
                }
              }
              .show()
          }
          .setNeutralButton("Web Deletion Link") { _, _ ->
            openExternal(
              Intent(Intent.ACTION_VIEW, "https://www.whooplens.tech/privacy/".toUri())
                .addCategory(Intent.CATEGORY_BROWSABLE)
            )
          }
          .setNegativeButton("Cancel", null)
          .show()
      }
    }

    logoutButton.setOnClickListener {
      ++uiGeneration
      callbacks.cancel()
      sessionHandler.removeCallbacks(sessionRefresh)
      grantedPermissions = emptySet()
      stepsBusy = false
      otherBusy = false
      val revoke = try { auth.clearForSignOut() } catch (_: Exception) {
        verified = false
        preparedSteps = null
        renderControls()
        accountStatusText.text = getString(R.string.session_storage_unavailable)
        statusText.text = getString(R.string.preview_cleared)
        return@setOnClickListener
      }
      val signOutGeneration = uiGeneration
      Thread {
        val revoked = revoke()
        runOnUiThread {
          if (signOutGeneration == uiGeneration && !isDestroyed && !isFinishing)
            accountStatusText.text = if (revoked) "Signed out. Server grant revoked."
              else "Signed out locally. Server revocation could not be confirmed; existing grants expire on the server."
        }
      }.start()
      loginButton.isEnabled = true
      verified = false
      permissionsButton.isEnabled = false
      previewButton.isEnabled = false
      otherPreviewButton.isEnabled = false
      reviewButton.isEnabled = false
      deleteButton.isEnabled = false
      preparedSteps = null
      renderControls()
      accountStatusText.text = "Signed out. Local session cleared; no data uploaded."
      statusText.text = getString(R.string.preview_cleared)
    }
  }

  override fun onResume() {
    super.onResume()
    foreground = true
    sessionHandler.post(sessionRefresh)
  }

  override fun onPause() {
    foreground = false
    sessionHandler.removeCallbacks(sessionRefresh)
    super.onPause()
  }

  private fun renderControls() {
    val available = HealthConnectClient.getSdkStatus(this) == HealthConnectClient.SDK_AVAILABLE
    val controls = companionControls(verified && auth.currentToken() != null, available,
      grantedPermissions.contains(HealthPermission.getReadPermission(StepsRecord::class)),
      permissions.any { it != HealthPermission.getReadPermission(StepsRecord::class) && it in grantedPermissions },
      preparedSteps?.valid() == true)
    permissionsButton.isEnabled = controls.permissions
    previewButton.isEnabled = controls.steps && !stepsBusy
    otherPreviewButton.isEnabled = controls.other && !otherBusy
    reviewButton.isEnabled = controls.review
    deleteButton.isEnabled = verified
    loginButton.text = getString(if (verified || auth.hasStoredSession()) R.string.reconnect_account else R.string.sign_in_cloudflare)
    retryConnectionButton.visibility = if (!verified && auth.hasStoredSession()) View.VISIBLE else View.GONE
    healthStatusText.text = getString(if (available) R.string.health_connect_available else R.string.health_connect_help)
  }

  private fun scheduleSessionRefresh() {
    sessionHandler.removeCallbacks(sessionRefresh)
    if (!foreground || callbacks.active || auth.pendingAttempt() != null) return
    auth.nextRefreshDelayMs()?.let { sessionHandler.postDelayed(sessionRefresh, it) }
  }

  private fun restoreSession() {
    if (!foreground || restoringSession || callbacks.active || auth.pendingAttempt() != null) return
    restoringSession = true
    val attempt = uiGeneration
    Thread {
      val token = try { auth.accessToken() } catch (_: Exception) { null }
      val granted = if (token != null && HealthConnectClient.getSdkStatus(this) == HealthConnectClient.SDK_AVAILABLE) {
        try { runBlocking { HealthConnectClient.getOrCreate(this@MainActivity).permissionController.getGrantedPermissions() } }
        catch (_: Exception) { emptySet() }
      } else emptySet()
      runOnUiThread {
        restoringSession = false
        if (!foreground || attempt != uiGeneration || isDestroyed || isFinishing || callbacks.active) return@runOnUiThread
        val generation = auth.sessionGeneration()
        if (observedSessionGeneration != null && observedSessionGeneration != generation) {
          ++uiGeneration
          preparedSteps = null
          stepsBusy = false
          otherBusy = false
          statusText.text = getString(R.string.preview_cleared)
        }
        observedSessionGeneration = generation
        val wasVerified = verified
        verified = auth.currentToken() != null
        grantedPermissions = if (verified) granted else emptySet()
        if (!verified) {
          if (wasVerified || preparedSteps != null) statusText.text = getString(R.string.preview_cleared)
          preparedSteps = null
          stepsBusy = false
          otherBusy = false
        }
        renderControls()
        val message = getString(when {
          verified -> R.string.account_signed_in
          auth.hasStoredSession() -> R.string.account_retry_connection
          else -> R.string.account_signed_out
        })
        if (accountStatusText.text.toString() != message) accountStatusText.text = message
        scheduleSessionRefresh()
      }
    }.start()
  }

  private fun openExternal(intent: Intent) {
    try { startActivity(intent) }
    catch (_: ActivityNotFoundException) { accountStatusText.text = getString(R.string.external_app_unavailable) }
    catch (_: SecurityException) { accountStatusText.text = getString(R.string.external_app_unavailable) }
  }

  override fun onDestroy() {
    ++uiGeneration
    preparedSteps = null
    callbacks.cancel()
    sessionHandler.removeCallbacks(sessionRefresh)
    super.onDestroy()
  }
}
