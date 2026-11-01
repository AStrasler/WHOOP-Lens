package io.github.astrasler.whooplens

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Process-wide Direct BLE session. The activity and the connected-device foreground service share
 * one controller, so a session survives leaving the screen, switching apps and locking the phone.
 * All access is on the main looper.
 */
internal object BleRuntime {
    private var controller: BleSessionController? = null
    private val listeners = linkedSetOf<(BleViewState) -> Unit>()
    private var serviceRequested = false
    private val main by lazy { Handler(Looper.getMainLooper()) }

    fun controller(context: Context): BleSessionController {
        controller?.let {
            return it
        }
        val app = context.applicationContext
        return BleSessionController(
                AndroidBleTransport(app),
                BleCache(androidBleStorage(app)),
                { AndroidSessions.get(app).accountKey() },
                { blePermissions(app) },
                BleTimer { delay, action ->
                    val task = Runnable { action() }
                    main.postDelayed(task, delay)
                    ({ main.removeCallbacks(task) })
                },
                System::currentTimeMillis,
                SystemClock::elapsedRealtime,
            ) { state ->
                listeners.toList().forEach { it(state) }
                syncService(app, state)
            }
            .also { controller = it }
    }

    fun observe(listener: (BleViewState) -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    internal fun serviceStopped() {
        serviceRequested = false
    }

    private fun syncService(app: Context, state: BleViewState) {
        val keep = BleBackgroundPolicy.keepsService(state.phase)
        if (keep && !serviceRequested) {
            serviceRequested = true
            try {
                // Sessions start only from an explicit Connect/Reconnect tap on the visible screen,
                // which is when Android allows a connected-device foreground service to start.
                ContextCompat.startForegroundService(app, Intent(app, BleSessionService::class.java))
            } catch (_: Exception) {
                serviceRequested = false
            }
        }
        // Stopping is left to the service itself: it always calls startForeground before it stops,
        // which avoids Android's "did not call startForeground" crash when a session ends quickly.
    }
}

/** Keeps an active Direct BLE session alive in the background. No values in the notification. */
@SuppressLint("MissingPermission") // notify() is only called after canNotify() confirms POST_NOTIFICATIONS.
class BleSessionService : Service() {
    private var unobserve: (() -> Unit)? = null
    private var shown: Pair<BlePhase, String?>? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val controller = BleRuntime.controller(this)
        if (intent?.action == ACTION_STOP) {
            controller.stop()
            finish()
            return START_NOT_STICKY
        }
        val state = controller.state
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification(state),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } catch (_: Exception) {
            // Android refused the foreground service (for example, Nearby Devices was revoked).
            // Do not leave a session running that the member cannot see.
            controller.stop()
            finish()
            return START_NOT_STICKY
        }
        if (!BleBackgroundPolicy.keepsService(state.phase)) {
            finish()
            return START_NOT_STICKY
        }
        shown = state.phase to state.selected?.id
        if (unobserve == null)
            unobserve = BleRuntime.observe { next ->
                if (!BleBackgroundPolicy.keepsService(next.phase)) finish()
                else if (shown != (next.phase to next.selected?.id)) {
                    shown = next.phase to next.selected?.id
                    if (canNotify())
                        getSystemService(NotificationManager::class.java)
                            ?.notify(NOTIFICATION_ID, notification(next))
                }
            }
        return START_NOT_STICKY
    }

    /** Swiping WhoopLens away from Recents is an explicit close: end the session. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        BleRuntime.controller(this).stop()
        finish()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        unobserve?.invoke()
        unobserve = null
        BleRuntime.serviceStopped()
        super.onDestroy()
    }

    private fun finish() {
        BleRuntime.serviceStopped()
        unobserve?.invoke()
        unobserve = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun canNotify() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    private fun notification(state: BleViewState): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager?.createNotificationChannel(
            NotificationChannel(CHANNEL, "Direct BLE session", NotificationManager.IMPORTANCE_LOW)
                .apply {
                    description = "Shown while a Direct BLE session runs in the background."
                    setShowBadge(false)
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                }
        )
        val (title, text) = BleBackgroundPolicy.notification(state)
        val open =
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java)
                    .putExtra(EXTRA_PAGE, PAGE)
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val stop =
            PendingIntent.getService(
                this,
                1,
                Intent(this, BleSessionService::class.java).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val public =
            NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_ble_session)
                .setContentTitle("Direct BLE session active")
                .build()
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_ble_session)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open)
            .addAction(0, "Stop", stop)
            .build()
    }

    companion object {
        const val ACTION_STOP = "io.github.astrasler.whooplens.ble.STOP"
        const val EXTRA_PAGE = "io.github.astrasler.whooplens.PAGE"
        const val PAGE = "Direct BLE"
        private const val CHANNEL = "direct-ble-session"
        private const val NOTIFICATION_ID = 4107
    }
}
