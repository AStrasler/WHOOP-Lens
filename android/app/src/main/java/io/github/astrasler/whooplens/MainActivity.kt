package io.github.astrasler.whooplens

import android.app.Activity
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.TextView
import androidx.health.connect.client.HealthConnectClient

/** Private beta shell; deliberately performs no health reads or uploads yet. */
class MainActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val layout = LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; setPadding(36,64,36,36) }
    layout.addView(TextView(this).apply { text="WHOOP Lens Companion"; textSize=24f })
    val status = when(HealthConnectClient.getSdkStatus(this)) {
      HealthConnectClient.SDK_AVAILABLE -> "Health Connect is available."
      HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "Health Connect needs an update."
      else -> "Health Connect is unavailable on this device."
    }
    layout.addView(TextView(this).apply { text=status })
    layout.addView(TextView(this).apply { text="Private beta scaffold: nothing is read or uploaded. Authorization and explicit sync must be completed before release." })
    setContentView(layout)
  }
}
