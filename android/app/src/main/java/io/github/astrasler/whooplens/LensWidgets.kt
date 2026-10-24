package io.github.astrasler.whooplens

import android.app.*
import android.appwidget.*
import android.content.*
import android.os.Bundle
import android.widget.RemoteViews

/** Widgets are cache consumers: no token refresh, Health Connect read, upload or network here. */
open class LensWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { LensWidgets.render(context, manager, it, javaClass) }
    }

    override fun onAppWidgetOptionsChanged(
        context: Context,
        manager: AppWidgetManager,
        id: Int,
        options: Bundle,
    ) {
        LensWidgets.render(context, manager, id, javaClass)
    }
}

class DailyWidget : LensWidget()

class RecoveryWidget : LensWidget()

class StepsWidget : LensWidget()

class SleepWidget : LensWidget()

class VitalsWidget : LensWidget()

class ExpandedWidget : LensWidget()

class PrivateLockWidget : LensWidget()

internal object LensWidgets {
    internal fun widgetViews(
        context: Context,
        text: String,
        compact: Boolean,
        lockSurface: Boolean,
        stale: Boolean,
    ): RemoteViews {
        val views =
            RemoteViews(
                context.packageName,
                if (compact) R.layout.lens_widget_compact else R.layout.lens_widget,
            )
        views.setTextViewText(
            R.id.widget_title,
            if (lockSurface) "WHOOP Lens · private" else "WHOOP Lens",
        )
        views.setTextViewText(R.id.widget_body, text)
        views.setContentDescription(R.id.widget_body, text)
        views.setTextColor(R.id.widget_body, if (stale) LensColors.amber else LensColors.text)
        views.setTextViewText(
            R.id.widget_footer,
            if (lockSurface) "Unlock to open" else "Read only · tap to open",
        )
        return views
    }

    private val profiles =
        mapOf<Class<out LensWidget>, List<String>>(
            DailyWidget::class.java to listOf("recovery", "strain", "sleep"),
            RecoveryWidget::class.java to listOf("recovery", "strain"),
            StepsWidget::class.java to listOf("steps", "distance", "exercise"),
            SleepWidget::class.java to listOf("sleep", "performance"),
            VitalsWidget::class.java to listOf("hrv", "rhr", "respiratory", "spo2"),
            ExpandedWidget::class.java to
                listOf(
                    "recovery",
                    "strain",
                    "sleep",
                    "hrv",
                    "rhr",
                    "steps",
                    "distance",
                    "exercise",
                ),
            PrivateLockWidget::class.java to emptyList(),
        )

    fun updateAll(context: Context) {
        val m = AppWidgetManager.getInstance(context)
        profiles.keys.forEach { type ->
            m.getAppWidgetIds(ComponentName(context, type)).forEach { render(context, m, it, type) }
        }
    }

    fun render(context: Context, manager: AppWidgetManager, id: Int, type: Class<out LensWidget>) {
        val prefs = context.getSharedPreferences("dashboard-options", Context.MODE_PRIVATE)
        val lock = context.getSystemService(KeyguardManager::class.java).isDeviceLocked
        val lockSurface =
            type == PrivateLockWidget::class.java ||
                manager
                    .getAppWidgetOptions(id)
                    .getInt(AppWidgetManager.OPTION_APPWIDGET_HOST_CATEGORY) ==
                    AppWidgetProviderInfo.WIDGET_CATEGORY_KEYGUARD
        val privacy =
            try {
                WidgetPrivacy.valueOf(prefs.getString("widget-privacy", "SUMMARY")!!)
            } catch (_: Exception) {
                WidgetPrivacy.SUMMARY
            }
        val auth = AndroidSessions.get(context)
        val account =
            try {
                auth.accountKey()
            } catch (_: Exception) {
                null
            }
        val cache = if (!lock && account != null) DashboardRepository.read(context, auth) else null
        val height =
            manager
                .getAppWidgetOptions(id)
                .getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180)
        val compact = type == StepsWidget::class.java || lockSurface || height < 120
        val keys =
            profiles[type]
                .orEmpty()
                .filter {
                    it in
                        prefs
                            .getStringSet("widget-keys", profiles.values.flatten().toSet())
                            .orEmpty()
                }
                .let { if (compact) it.take(1) else it }
        val text =
            if (lock) "WHOOP Lens\nUnlock to view"
            else
                widgetText(
                    cache,
                    account,
                    privacy,
                    false,
                    lockSurface,
                    keys,
                    System.currentTimeMillis(),
                )
        val stale =
            cache?.let {
                listOfNotNull(it.whoop, it.health).any { b -> b.stale(System.currentTimeMillis()) }
            } ?: false
        val views = widgetViews(context, text, compact, lockSurface, stale)
        val intent =
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        views.setOnClickPendingIntent(
            R.id.widget_root,
            PendingIntent.getActivity(
                context,
                id,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        manager.updateAppWidget(id, views)
    }
}

class LensApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        registerReceiver(
            object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    LensWidgets.updateAll(context)
                }
            },
            IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_OFF)
                addAction(Intent.ACTION_USER_PRESENT)
            },
            Context.RECEIVER_NOT_EXPORTED,
        )
    }
}
