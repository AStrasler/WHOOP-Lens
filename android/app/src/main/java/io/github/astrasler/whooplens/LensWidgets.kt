package io.github.astrasler.whooplens

import android.app.*
import android.appwidget.*
import android.content.*
import android.hardware.display.DisplayManager
import android.os.Bundle
import android.util.SizeF
import android.view.View
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
    @Volatile internal var screenConcealed: Boolean = false
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
            if (lockSurface) "WhoopLens · private" else "WhoopLens",
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

    internal val profiles =
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

    internal fun responsiveViews(context: Context, content: WidgetPresentation): RemoteViews {
        val views =
            RemoteViews(
                context.packageName,
                if (content.wide) R.layout.lens_widget_wide else R.layout.lens_widget_responsive,
            )
        for ((id, text) in
            listOf(
                R.id.widget_title to content.title,
                R.id.widget_body to content.primary,
                R.id.widget_supporting to content.supporting,
                R.id.widget_footer to content.footer,
            )) {
            views.setTextViewText(id, text)
            views.setViewVisibility(id, if (text.isEmpty()) View.GONE else View.VISIBLE)
        }
        views.setInt(R.id.widget_supporting, "setMaxLines", content.supporting.lines().size)
        views.setContentDescription(R.id.widget_root, content.description)
        views.setTextColor(
            R.id.widget_body,
            if (content.stale) LensColors.amber else LensColors.text,
        )
        return views
    }

    fun updateAll(context: Context) {
        val m = AppWidgetManager.getInstance(context)
        profiles.keys.forEach { type ->
            m.getAppWidgetIds(ComponentName(context, type)).forEach { render(context, m, it, type) }
        }
    }

    fun render(context: Context, manager: AppWidgetManager, id: Int, type: Class<out LensWidget>) {
        val prefs = context.getSharedPreferences("dashboard-options", Context.MODE_PRIVATE)
        val options = manager.getAppWidgetOptions(id)
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        val conceal =
            widgetConcealsMeasurements(
                keyguard?.isDeviceLocked == true,
                keyguard?.isKeyguardLocked == true,
                screenConcealed ||
                    displaysAreOff(
                        context
                            .getSystemService(DisplayManager::class.java)
                            ?.displays
                            ?.map { it.state }
                            ?.toIntArray()
                    ),
                options.getInt(AppWidgetManager.OPTION_APPWIDGET_HOST_CATEGORY),
            )
        val nonNumeric = type == PrivateLockWidget::class.java
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
        val cache = if (!conceal && account != null) DashboardRepository.read(context, auth) else null
        val keys =
            profiles[type].orEmpty().filter {
                it in prefs.getStringSet("widget-keys", profiles.values.flatten().toSet()).orEmpty()
            }
        val now = System.currentTimeMillis()
        val intent =
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val open =
            PendingIntent.getActivity(
                context,
                id,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        fun clickable(view: RemoteViews) =
            view.apply { setOnClickPendingIntent(R.id.widget_root, open) }
        val views =
            if (nonNumeric) {
                clickable(
                    widgetViews(
                        context,
                        widgetText(cache, account, privacy, conceal, true, keys, now),
                        true,
                        true,
                        false,
                    )
                )
            } else {
                val sizes =
                    options
                        .getParcelableArrayList(
                            AppWidgetManager.OPTION_APPWIDGET_SIZES,
                            SizeF::class.java,
                        )
                        ?.filter { it.width > 0 && it.height > 0 }
                        ?.distinct()
                        ?.take(16)
                val supported =
                    if (!sizes.isNullOrEmpty()) sizes
                    else
                        listOf(
                                SizeF(
                                    options
                                        .getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 56)
                                        .toFloat(),
                                    options
                                        .getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 56)
                                        .toFloat(),
                                ),
                                SizeF(
                                    options
                                        .getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 56)
                                        .toFloat(),
                                    options
                                        .getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 56)
                                        .toFloat(),
                                ),
                            )
                            .distinct()
                RemoteViews(
                    supported.associateWith { size ->
                        val space =
                            WidgetSpace(
                                size.width,
                                size.height,
                                context.resources.configuration.fontScale,
                            )
                        clickable(
                            responsiveViews(
                                context,
                                widgetPresentation(
                                    cache,
                                    account,
                                    privacy,
                                    conceal,
                                    keys,
                                    space,
                                    now,
                                ),
                            )
                        )
                    }
                )
            }
        manager.updateAppWidget(id, views)
    }
}

class LensApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        registerReceiver(
            object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    val keyguard = context.getSystemService(KeyguardManager::class.java)
                    LensWidgets.screenConcealed =
                        concealAfterScreenBroadcast(
                            intent.action,
                            keyguard?.isDeviceLocked == true,
                            keyguard?.isKeyguardLocked == true,
                            LensWidgets.screenConcealed,
                        )
                    LensWidgets.updateAll(context)
                }
            },
            IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_OFF)
                addAction(Intent.ACTION_SCREEN_ON)
                addAction(Intent.ACTION_USER_PRESENT)
            },
            Context.RECEIVER_NOT_EXPORTED,
        )
    }
}
