package io.github.astrasler.whooplens

import android.content.Intent
import android.content.ActivityNotFoundException
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.activity.ComponentActivity
import androidx.core.net.toUri

/**
 * Health Connect permissions rationale and privacy policy activity.
 * Displayed when the user taps the privacy policy link in Android's Health Connect permission dialog.
 */
class PermissionsRationaleActivity : ComponentActivity() {

  private fun Int.dp(): Int = (this * resources.displayMetrics.density + 0.5f).toInt()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    applyScreenCapturePrivacy(this)

    val background = LensColors.background
    val foreground = LensColors.text
    val muted = LensColors.muted
    val accent = LensColors.teal

    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(background)
      setPadding(20.dp(), 28.dp(), 20.dp(), 28.dp())
    }

    val title = TextView(this).apply {
      text = getString(R.string.title_rationale)
      textSize = 24f
      setTextColor(foreground)
      setTypeface(null, Typeface.BOLD)
      setPadding(0, 0, 0, 12.dp())
      ViewCompat.setAccessibilityHeading(this, true)
    }

    val subtitle = TextView(this).apply {
      text = "How WhoopLens accesses and protects your health data"
      textSize = 15f
      setTextColor(accent)
      setPadding(0, 0, 0, 20.dp())
    }

    fun paragraph(body: String): TextView = TextView(this).apply {
      text = body
      textSize = 14f
      setTextColor(muted)
      setLineSpacing(4.dp().toFloat(), 1f)
      setPadding(0, 0, 0, 14.dp())
    }

    val section1 = paragraph(
      "WhoopLens Companion reads only the Health Connect categories you choose. " +
        "These include steps, sleep stages, heart rate, exercise, distance, calories, floors, HRV, resting heart rate, oxygen saturation, respiration, body temperature, blood pressure, weight and body fat. " +
        "The source is Health Connect; Samsung Health sharing depends on your Samsung Health and Health Connect settings."
    )

    val section2 = paragraph(
      "• Local Refresh: Foreground automatic refresh can update your dashboard. Optional WorkManager background refresh is scheduled by Android, subject to battery limits. " +
        "Background Health Connect reads need a supported device and a separate background-read permission. No continuous sensors or location tracking are used.\n" +
        "• Local Cache: Dashboard measurements and credentials are encrypted with separate Android Keystore keys and excluded from backup. Health uploads and server deletion remain disabled. Widgets use only saved local data; detailed home widgets require a public-display opt-in. Lock-screen widgets hide measurements.\n" +
        "• Secure Sign-in: OAuth credentials are encrypted with an Android Keystore key and excluded from backup. " +
        "Sign out erases local credentials and requests server grant revocation when online.\n" +
        "• Revocable Access: You can revoke access at any time through Android Settings > Security & Privacy > Health Connect."
    )

    val buttonPolicy = Button(this).apply {
      text = "View Online Privacy Policy"
      isAllCaps = false
      textSize = 15f
      minHeight = 48.dp()
      setTextColor(foreground)
      this.background = GradientDrawable().apply {
        setColor(Color.rgb(29, 49, 57))
        cornerRadius = 12.dp().toFloat()
        setStroke(1.dp(), Color.rgb(57, 86, 97))
      }
      layoutParams = LinearLayout.LayoutParams(-1, -2).apply {
        topMargin = 12.dp()
        bottomMargin = 10.dp()
      }
      setOnClickListener {
        val policyIntent = Intent(Intent.ACTION_VIEW, "https://www.whooplens.tech/privacy/".toUri())
          .addCategory(Intent.CATEGORY_BROWSABLE)
        try { startActivity(policyIntent) }
        catch (_: ActivityNotFoundException) { Toast.makeText(this@PermissionsRationaleActivity, R.string.external_app_unavailable, Toast.LENGTH_LONG).show() }
        catch (_: SecurityException) { Toast.makeText(this@PermissionsRationaleActivity, R.string.external_app_unavailable, Toast.LENGTH_LONG).show() }
      }
    }

    val buttonClose = Button(this).apply {
      text = "Close"
      isAllCaps = false
      textSize = 15f
      minHeight = 48.dp()
      setTextColor(foreground)
      this.background = GradientDrawable().apply {
        setColor(Color.rgb(21, 39, 47))
        cornerRadius = 12.dp().toFloat()
      }
      layoutParams = LinearLayout.LayoutParams(-1, -2)
      setOnClickListener { finish() }
    }

    layout.addView(title)
    layout.addView(subtitle)
    layout.addView(section1)
    layout.addView(section2)
    layout.addView(buttonPolicy)
    layout.addView(buttonClose)

    setContentView(ScrollView(this).apply {
      setBackgroundColor(background)
      isFillViewport = true
      addView(layout)
      protectSystemBars(this@PermissionsRationaleActivity, this)
    })
  }
}
