package io.github.astrasler.whooplens

import android.view.View
import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/** Protect the existing scroll layout from gesture bars, button navigation and display cutouts. */
internal fun protectSystemBars(activity: ComponentActivity, root: View) {
  activity.enableEdgeToEdge(
    statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    navigationBarStyle = SystemBarStyle.dark(Color.rgb(12, 22, 27))
  )
  val window = activity.window
  WindowCompat.getInsetsController(window, root).apply {
    isAppearanceLightStatusBars = false
    isAppearanceLightNavigationBars = false
  }
  val left = root.paddingLeft
  val top = root.paddingTop
  val right = root.paddingRight
  val bottom = root.paddingBottom
  ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
    val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
    view.setPadding(left + bars.left, top + bars.top, right + bars.right, bottom + bars.bottom)
    insets
  }
  ViewCompat.requestApplyInsets(root)
}
