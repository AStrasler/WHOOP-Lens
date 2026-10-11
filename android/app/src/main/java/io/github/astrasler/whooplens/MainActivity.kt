package io.github.astrasler.whooplens

import android.os.Bundle
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

/** Only explicit user actions can sign in or request Health Connect permissions. */
class MainActivity : ComponentActivity() {
  private val auth = PrivateSession()
  private var verified = false
  private val permissions = setOf(
    HealthPermission.getReadPermission(StepsRecord::class),
    HealthPermission.getReadPermission(SleepSessionRecord::class),
    HealthPermission.getReadPermission(HeartRateRecord::class),
    HealthPermission.getReadPermission(ExerciseSessionRecord::class)
  )
  private val permissionsLauncher = registerForActivityResult(
    PermissionController.createRequestPermissionResultContract()
  ) { granted ->
    findViewById<TextView>(4001)?.text =
      "Health Connect: ${granted.size} of ${permissions.size} permissions granted. No data was read or uploaded."
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
    layout.addView(logoutButton)
    layout.addView(status)
    layout.addView(TextView(this).apply {
      text = "No records are read or uploaded by this version. Sign-in is kept only in memory."
    })
    setContentView(ScrollView(this).apply { addView(layout) })

    loginButton.setOnClickListener {
      val address = email.text.toString().trim()
      val secret = password.text.toString()
      password.text.clear()
      verified = false
      permissionsButton.isEnabled = false
      loginButton.isEnabled = false
      status.text = "Checking your private WHOOP Lens access..."
      Thread {
        val result = try { auth.signIn(address, secret) } catch (_: Exception) { false }
        runOnUiThread {
          verified = result
          loginButton.isEnabled = true
          permissionsButton.isEnabled = result && HealthConnectClient.getSdkStatus(this) == HealthConnectClient.SDK_AVAILABLE
          status.text = if (result) "Authorized account confirmed. No data accessed."
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
    logoutButton.setOnClickListener {
      auth.signOut()
      verified = false
      permissionsButton.isEnabled = false
      password.text.clear()
      status.text = "Signed out. No data was uploaded."
    }
  }

  override fun onDestroy() {
    auth.signOut()
    super.onDestroy()
  }
}
