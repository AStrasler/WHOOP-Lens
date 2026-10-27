package io.github.astrasler.whooplens

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.work.*
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal fun online(context: Context): Boolean {
    val cm = context.getSystemService(ConnectivityManager::class.java)
    return cm.getNetworkCapabilities(cm.activeNetwork)
        ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
}

internal fun backgroundReadsAvailable(context: Context): Boolean =
    try {
        HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE &&
            HealthConnectClient.getOrCreate(context)
                .features
                .getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) ==
                HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
    } catch (_: Exception) {
        false
    }

internal data class BackgroundDecision(val run: Boolean, val health: Boolean, val whoop: Boolean)

internal fun backgroundDecision(
    enabled: Boolean,
    expected: String?,
    current: String?,
    feature: Boolean,
    permission: Boolean,
    connected: Boolean,
) =
    BackgroundDecision(
        enabled && expected != null && expected == current,
        enabled && expected != null && expected == current && feature && permission,
        enabled && expected != null && expected == current && connected,
    )

/** One process-wide commit lock covers Activity and WorkManager writes and account invalidation. */
internal object DashboardRepository {
    private val lock = Any()

    fun clear(context: Context) = synchronized(lock) { DashboardCache(context).clear() }

    fun read(context: Context, auth: PrivateSession): DashboardSnapshot? =
        synchronized(lock) { auth.accountKey()?.let { DashboardCache(context).read(it) } }

    fun commit(context: Context, auth: PrivateSession, account: String, batch: DataBatch): Boolean =
        synchronized(lock) {
            if (auth.accountKey() != account) return false
            val previous = DashboardCache(context).read(account) ?: DashboardSnapshot(account)
            val old = if (batch.source == DataSource.WHOOP) previous.whoop else previous.health
            val next =
                if (batch.metrics.isEmpty() && batch.notices.isNotEmpty() && old != null)
                    old.copy(notices = batch.notices, complete = false)
                else if (old != null && batch.notices.isNotEmpty())
                    batch.copy(
                        metrics =
                            old.metrics.filterNot { m -> batch.metrics.any { it.key == m.key } } +
                                batch.metrics,
                        series = old.series + batch.series,
                        sleeps = if ("sleep" in batch.series) batch.sleeps else old.sleeps,
                        exercises =
                            if (batch.notices.any { it.startsWith("workouts unavailable") })
                                old.exercises
                            else batch.exercises,
                    )
                else batch
            val result =
                if (batch.source == DataSource.WHOOP) previous.copy(whoop = next)
                else previous.copy(health = next)
            if (auth.accountKey() != account) return false
            DashboardCache(context).write(result)
            return true
        }

    fun clearHealth(context: Context, auth: PrivateSession) =
        synchronized(lock) {
            val account = auth.accountKey() ?: return
            val s = DashboardCache(context).read(account) ?: return
            DashboardCache(context).write(s.copy(health = null))
        }
}

internal object BackgroundRefresh {
    private const val NAME = "whooplens-dashboard-refresh"

    fun schedule(context: Context, account: String) {
        val request =
            PeriodicWorkRequestBuilder<DashboardRefreshWorker>(
                    30,
                    TimeUnit.MINUTES,
                    10,
                    TimeUnit.MINUTES,
                )
                .setInputData(workDataOf("account" to account))
                .setConstraints(Constraints.Builder().setRequiresBatteryNotLow(true).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.UPDATE, request)
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(NAME)
    }
}

class DashboardRefreshWorker(context: Context, parameters: WorkerParameters) :
    CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result =
        withContext(Dispatchers.IO) {
            val c = applicationContext
            val prefs = c.getSharedPreferences("dashboard-options", Context.MODE_PRIVATE)
            val auth = AndroidSessions.get(c)
            val expected = inputData.getString("account")
            val current = auth.accountKey()
            if (!prefs.getBoolean("background", false) || expected == null || current != expected) {
                LensWidgets.updateAll(c)
                return@withContext Result.success()
            }
            val feature = backgroundReadsAvailable(c)
            val permissions =
                if (HealthConnectClient.getSdkStatus(c) == HealthConnectClient.SDK_AVAILABLE)
                    try {
                        HealthConnectClient.getOrCreate(c)
                            .permissionController
                            .getGrantedPermissions()
                    } catch (_: Exception) {
                        emptySet()
                    }
                else emptySet()
            val granted = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in permissions
            val decision = backgroundDecision(true, expected, current, feature, granted, online(c))
            var failure = false
            val prior = prefs.getStringSet("last-permissions", emptySet()).orEmpty()
            if (!permissions.containsAll(prior)) DashboardRepository.clearHealth(c, auth)
            prefs.edit().putStringSet("last-permissions", permissions).apply()
            if (decision.whoop && !isStopped) {
                val token = auth.accessToken()
                if (token != null && auth.accountKey() == expected) {
                    val batch =
                        WhoopDashboard(
                                WhoopReadClient(auth, expected) {
                                    !isStopped && prefs.getBoolean("background", false)
                                }::call
                            )
                            .load()
                    if (
                        auth.accountKey() == expected &&
                            !isStopped &&
                            prefs.getBoolean("background", false)
                    ) {
                        DashboardRepository.commit(c, auth, expected, batch)
                        failure = batch.notices.isNotEmpty()
                    }
                } else failure = true
            }
            if (decision.health && auth.accountKey() == expected && !isStopped) {
                try {
                    val (batch, still) =
                        HealthDashboard(c) {
                                !isStopped &&
                                    prefs.getBoolean("background", false) &&
                                    auth.accountKey() == expected
                            }
                            .load()
                    if (
                        !isStopped &&
                            HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in still
                    )
                        DashboardRepository.commit(c, auth, expected, batch)
                    else DashboardRepository.clearHealth(c, auth)
                } catch (_: Exception) {
                    DashboardRepository.clearHealth(c, auth)
                    failure = true
                }
            }
            if (auth.accountKey() == null) {
                DashboardRepository.clear(c)
                BackgroundRefresh.cancel(c)
            }
            if (auth.accountKey() == expected)
                prefs
                    .edit()
                    .putLong("background-at", System.currentTimeMillis())
                    .putString(
                        "background-status",
                        when {
                            failure -> "Some reads unavailable; will retry"
                            !decision.whoop && decision.health -> "Offline · local reads only"
                            !decision.whoop -> "Offline · no background reads available"
                            !feature || !granted ->
                                "WHOOP refreshed · background Health Connect not permitted"
                            else -> "Dashboard refreshed · no uploads"
                        },
                    )
                    .apply()
            LensWidgets.updateAll(c)
            // Periodic cadence retries naturally; no tight retry loop or expedited/foreground
            // service.
            Result.success()
        }
}
