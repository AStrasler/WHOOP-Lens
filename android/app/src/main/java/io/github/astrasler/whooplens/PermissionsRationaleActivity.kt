package io.github.astrasler.whooplens

import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
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

    val background = Color.rgb(12, 22, 27)
    val foreground = Color.rgb(239, 247, 249)
    val muted = Color.rgb(170, 193, 201)
    val accent = Color.rgb(0, 229, 255)

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
    }

    val subtitle = TextView(this).apply {
      text = "How WHOOP Lens accesses and protects your health data"
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
      "WHOOP Lens Companion connects to Android Health Connect to read your fitness data on-demand. " +
        "When permitted, it reads daily step totals and aggregates so you can review them alongside your WHOOP metrics."
    )

    val section2 = paragraph(
      "• On-Demand Only: The companion does not perform background tracking or continuous monitoring. " +
        "Data is read only when you explicitly tap to preview or sync.\n" +
        "• No Third-Party Sharing: Health data is never sold, shared with advertisers, or transferred to third parties.\n" +
        "• User-Controlled Sync: Uploads to your private account require a deliberate, itemized confirmation step.\n" +
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
        val policyIntent = Intent(Intent.ACTION_VIEW, "https://whooplens.tech/privacy".toUri())
          .addCategory(Intent.CATEGORY_BROWSABLE)
        startActivity(policyIntent)
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
    })
  }
}
