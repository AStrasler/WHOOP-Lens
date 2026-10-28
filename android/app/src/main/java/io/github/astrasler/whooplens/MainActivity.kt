package io.github.astrasler.whooplens

import android.app.AlertDialog
import android.app.KeyguardManager
import android.content.*
import android.os.*
import android.view.*
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import java.time.*
import java.util.concurrent.Executors
import kotlinx.coroutines.runBlocking

class MainActivity : ComponentActivity() {
    private val auth by lazy { AndroidSessions.get(applicationContext) }
    private val prefs by lazy { getSharedPreferences("dashboard-options", MODE_PRIVATE) }
    private val ui by lazy { LensUi(this) }
    private val io = Executors.newFixedThreadPool(2)
    private val handler = Handler(Looper.getMainLooper())
    private val callbacks = CallbackGate()
    @Volatile private var uiGeneration = 0L
    private var account: String? = null
    private var snapshot: DashboardSnapshot? = null
    private var granted = emptySet<String>()
    @Volatile private var foreground = false
    private var busy = false
    private var loading = false
    private var page = "Home"
    private var arrangeDraft: Pair<MutableList<String>, MutableSet<String>>? = null
    private var edgeTracking = false
    private var edgeStartX = 0f
    private var edgeStartY = 0f
    private var detail: String? = null
    private var detailSource = DataSource.WHOOP
    private var rangeDays = 7
    private var activityDays = 7
    private var message = ""
    private var notices = ServiceAnnouncements.empty("")
    private val dismissedNotices = mutableSetOf<String>()
    private var drawer: View? = null
    private lateinit var frame: FrameLayout
    private var bleScreen: BleScreenBinding? = null
    private val ble by lazy {
        BleSessionController(
            AndroidBleTransport(this),
            BleCache(androidBleStorage(this)),
            { auth.accountKey() },
            { blePermissions(this) },
            BleTimer { delay, action ->
                val task = Runnable { action() }
                handler.postDelayed(task, delay)
                ({ handler.removeCallbacks(task) })
            },
            System::currentTimeMillis,
            SystemClock::elapsedRealtime,
        ) {
            if (foreground && page == "Direct BLE" && !isDestroyed)
                bleScreen?.update(it, SystemClock.elapsedRealtime())
        }
    }
    private var pendingBleScan = false
    private val blePermissionsLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            pendingBleScan = page == "Direct BLE" && account != null
            if (foreground && pendingBleScan) {
                pendingBleScan = false
                ble.scan()
            }
        }
    private val bleTick =
        object : Runnable {
            override fun run() {
                if (foreground && page == "Direct BLE") {
                    ble.checkAccess()
                    bleScreen?.update(ble.state, SystemClock.elapsedRealtime())
                    handler.postDelayed(this, 5000)
                }
            }
        }
    private val periodic =
        object : Runnable {
            override fun run() {
                if (foreground) {
                    if (prefs.getBoolean("local-refresh", true)) refresh(false)
                    handler.postDelayed(this, 300000)
                }
            }
        }
    private val sessionTick = Runnable { resumeAccount() }
    private val permissionsLauncher =
        registerForActivityResult(PermissionController.createRequestPermissionResultContract()) {
            if (auth.accountKey() != account) return@registerForActivityResult
            DashboardRepository.clearHealth(this, auth)
            snapshot = null
            message = "Permissions updated. Nothing has been sent."
            resumeAccount()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyScreenCapturePrivacy(this)
        page = savedInstanceState?.getString("page") ?: "Home"
        frame = FrameLayout(this)
        setContentView(frame)
        protectSystemBars(this, frame)
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    when {
                        drawer != null -> closeDrawer()
                        detail != null -> {
                            detail = null
                            render()
                        }
                        page != "Home" -> {
                            page = "Home"
                            render()
                        }
                        else -> finish()
                    }
                }
            },
        )
        render()
        handleOAuthCallback(intent)
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (account != null && drawer == null && detail == null) {
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    edgeTracking = ev.x <= ui.dp(24)
                    edgeStartX = ev.x
                    edgeStartY = ev.y
                }
                MotionEvent.ACTION_MOVE ->
                    if (
                        edgeTracking &&
                            ev.x - edgeStartX > ui.dp(72) &&
                            kotlin.math.abs(ev.y - edgeStartY) < ui.dp(64)
                    ) {
                        edgeTracking = false
                        showDrawer()
                        return true
                    }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> edgeTracking = false
            }
        } else edgeTracking = false
        return super.dispatchTouchEvent(ev)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("page", page)
        super.onSaveInstanceState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleOAuthCallback(intent)
    }

    override fun onStart() {
        super.onStart()
        stopAppearance = LensAppearanceReader(this).observe { if (!isDestroyed) render() }
    }

    override fun onStop() {
        stopAppearance?.invoke()
        stopAppearance = null
        super.onStop()
    }

    private var stopAppearance: (() -> Unit)? = null

    private fun syncAppearance() {
        val choice =
            when (prefs.getString("appearance", "AUTO")) {
                "REDUCED_TRANSPARENCY" -> AppearanceChoice.REDUCED_TRANSPARENCY
                "BATTERY_SAVER" -> AppearanceChoice.BATTERY_SAVER
                else -> AppearanceChoice.AUTO
            }
        val inputs =
            try {
                LensAppearanceReader(this).read(choice)
            } catch (_: Exception) {
                AppearanceInputs(choice, powerSave = false, blurAvailable = true, animatorScale = 1f)
            }
        var state = resolveAppearance(inputs)
        if (prefs.getBoolean("reduced-motion", false)) state = state.copy(reduceMotion = true, transitionMs = 0)
        ui.appearance = state
        window.setBackgroundDrawableResource(
            when (state.mode) {
                LensAppearance.REDUCED_TRANSPARENCY -> R.color.lens_ground_reduced
                LensAppearance.BATTERY_SAVER -> R.drawable.lens_aurora_saver
                LensAppearance.GLASS -> R.drawable.lens_aurora_background
            }
        )
    }

    override fun onResume() {
        super.onResume()
        applyScreenCapturePrivacy(this)
        foreground = true
        if (pendingBleScan && page == "Direct BLE") {
            pendingBleScan = false
            ble.scan()
        }
        resumeAccount()
        handler.postDelayed(periodic, 300000)
        handler.postDelayed(bleTick, 5000)
    }

    override fun onPause() {
        foreground = false
        ble.stop()
        handler.removeCallbacks(bleTick)
        handler.removeCallbacks(periodic)
        handler.removeCallbacks(sessionTick)
        handler.removeCallbacks(noticeTick)
        super.onPause()
    }

    override fun onDestroy() {
        ble.stop()
        ++uiGeneration
        callbacks.cancel()
        handler.removeCallbacksAndMessages(null)
        io.shutdownNow()
        super.onDestroy()
    }

    private fun locked() = getSystemService(KeyguardManager::class.java).isDeviceLocked

    private fun resumeAccount() {
        if (busy || callbacks.active || auth.pendingAttempt() != null) return
        busy = true
        val attempt = uiGeneration
        io.execute {
            try {
                auth.accessToken()
            } catch (_: Exception) {}
            val current = auth.accountKey()
            val permissions =
                if (
                    current != null &&
                        HealthConnectClient.getSdkStatus(this) == HealthConnectClient.SDK_AVAILABLE
                )
                    try {
                        runBlocking {
                            HealthConnectClient.getOrCreate(this@MainActivity)
                                .permissionController
                                .getGrantedPermissions()
                        }
                    } catch (_: Exception) {
                        emptySet()
                    }
                else emptySet()
            val cache = if (current != null) DashboardRepository.read(this, auth) else null
            runOnUiThread {
                busy = false
                if (attempt != uiGeneration || isDestroyed || !foreground) return@runOnUiThread
                if (account != current) {
                    ++uiGeneration
                    account = current
                    snapshot = null
                    message = ""
                    notices = ServiceAnnouncements.empty(current ?: "")
                    dismissedNotices.clear()
                    resetGlance()
                    arrangeDraft = null
                    if (page == "Arrange Home") page = "Home"
                    ble.selectAccount()
                }
                val old = prefs.getStringSet("last-permissions", emptySet()).orEmpty()
                granted = permissions
                if (current == null) {
                    ble.forget()
                    notices = ServiceAnnouncements.empty("")
                    dismissedNotices.clear()
                    DashboardRepository.clear(this)
                    BackgroundRefresh.cancel(this)
                    prefs
                        .edit()
                        .putBoolean("sync-consent", false)
                        .putBoolean("background", false)
                        .remove("sync-account")
                        .apply()
                    snapshot = null
                } else if (!permissions.containsAll(old)) {
                    DashboardRepository.clearHealth(this, auth)
                    snapshot = DashboardRepository.read(this, auth)
                } else snapshot = cache
                prefs.edit().putStringSet("last-permissions", permissions).apply()
                if (current != null && prefs.getBoolean("background", false))
                    BackgroundRefresh.schedule(this, current)
                LensWidgets.updateAll(this)
                render()
                scheduleSession()
                if (current != null && prefs.getBoolean("local-refresh", true)) refresh(false)
                if (current != null) loadNotices(current)
            }
        }
    }

    /** Pulls service notices for this account. An empty or disabled response shows nothing. */
    private fun loadNotices(owner: String) {
        val attempt = uiGeneration
        io.execute {
            val raw =
                try {
                    AnnouncementClient(auth, owner).fetch()
                } catch (_: Exception) {
                    """{"enabled":false,"announcements":[]}"""
                }
            val parsed = ServiceAnnouncements.parse(owner, raw, System.currentTimeMillis())
            runOnUiThread {
                if (attempt != uiGeneration || account != owner || isDestroyed) return@runOnUiThread
                notices = parsed
                if (drawer == null) render()
            }
        }
    }

    private fun scheduleSession() {
        handler.removeCallbacks(sessionTick)
        if (foreground) auth.nextRefreshDelayMs()?.let { handler.postDelayed(sessionTick, it) }
    }

    private fun refresh(force: Boolean) {
        val owner = account ?: return
        if (loading || locked()) return
        val whoop =
            online(this) &&
                (force ||
                    snapshot?.whoop == null ||
                    System.currentTimeMillis() - (snapshot?.whoop?.fetchedAt ?: 0) > 900000)
        val health =
            HealthConnectClient.getSdkStatus(this) == HealthConnectClient.SDK_AVAILABLE &&
                healthCategories.any { it.permission in granted } &&
                (force ||
                    snapshot?.health == null ||
                    System.currentTimeMillis() - (snapshot?.health?.fetchedAt ?: 0) > 300000)
        if (!whoop && !health) {
            if (!online(this)) message = "Offline · showing dated saved values."
            render()
            return
        }
        loading = true
        render()
        val attempt = uiGeneration
        io.execute {
            if (whoop && auth.accountKey() == owner) {
                val b =
                    WhoopDashboard(
                            WhoopReadClient(auth, owner) { foreground && attempt == uiGeneration }::
                                call
                        )
                        .load()
                if (attempt == uiGeneration) DashboardRepository.commit(this, auth, owner, b)
            }
            if (health && auth.accountKey() == owner)
                try {
                    val (b, _) =
                        runBlocking {
                            HealthDashboard(this@MainActivity) {
                                    foreground &&
                                        attempt == uiGeneration &&
                                        auth.accountKey() == owner
                                }
                                .load()
                        }
                    if (attempt == uiGeneration && foreground)
                        DashboardRepository.commit(this, auth, owner, b)
                } catch (_: Exception) {
                    DashboardRepository.clearHealth(this, auth)
                }
            val cache = DashboardRepository.read(this, auth)
            runOnUiThread {
                if (attempt != uiGeneration || isDestroyed) return@runOnUiThread
                loading = false
                if (auth.accountKey() != owner) {
                    resumeAccount()
                    return@runOnUiThread
                }
                snapshot = cache
                message =
                    if (!online(this)) "Offline · local reads only. Saved WHOOP values are dated."
                    else "Refresh finished · no cloud uploads"
                LensWidgets.updateAll(this)
                if (foreground) render()
                scheduleSession()
            }
        }
    }

    private fun signIn() {
        ++uiGeneration
        callbacks.cancel()
        BackgroundRefresh.cancel(this)
        DashboardRepository.clear(this)
        snapshot = null
        account = null
        granted = emptySet()
        loading = false
        prefs
            .edit()
            .putBoolean("background", false)
            .putBoolean("sync-consent", false)
            .putString("widget-privacy", "SUMMARY")
            .putString("glance-level", "HIDDEN")
            .putBoolean("glance-confirmed", false)
            .remove("glance-metrics")
            .remove("sync-account")
            .apply()
        val authAttempt =
            try {
                auth.beginSignIn()
            } catch (_: Exception) {
                message = "Secure credential storage unavailable. Retry sign-in."
                render()
                return
            }
        LensWidgets.updateAll(this)
        val attempt = uiGeneration
        busy = true
        message = "Opening Cloudflare authorization…"
        render()
        io.execute {
            val url =
                try {
                    auth.authorizationUrl(authAttempt)
                } catch (_: Exception) {
                    null
                }
            runOnUiThread {
                if (attempt != uiGeneration || isDestroyed) return@runOnUiThread
                busy = false
                if (url != null)
                    openExternal(
                        Intent(Intent.ACTION_VIEW, url.toUri())
                            .addCategory(Intent.CATEGORY_BROWSABLE)
                    )
                else {
                    message = "Cloudflare sign-in unavailable. Check connection and retry."
                    render()
                }
            }
        }
    }

    private fun handleOAuthCallback(intent: Intent?) {
        val callback = intent?.data ?: return
        intent.data = null
        if (
            callback.scheme != "https" ||
                callback.host != "whooplens.tech" ||
                callback.path != "/android/oauth/callback"
        )
            return
        val authAttempt = auth.pendingAttempt() ?: return
        val ticket = callbacks.begin() ?: return
        val attempt = uiGeneration
        message = "Verifying Cloudflare authorization…"
        render()
        io.execute {
            val ok =
                try {
                    auth.completeSignIn(callback.toString(), authAttempt)
                } catch (_: Exception) {
                    false
                }
            runOnUiThread {
                if (!callbacks.finish(ticket) || attempt != uiGeneration || isDestroyed)
                    return@runOnUiThread
                message =
                    if (ok) "Cloudflare authorization complete"
                    else "Sign-in failed or expired. Retry."
                if (ok) resumeAccount() else render()
            }
        }
    }

    private fun signOut() {
        dialog(
            "Sign out of WhoopLens?",
            "Erases encrypted sign-in and cached previews on this phone. Asks the server to revoke this phone's grant when online. Health Connect permissions stay in Android settings.",
            "Sign out",
        ) {
            ble.forget()
            ++uiGeneration
            callbacks.cancel()
            BackgroundRefresh.cancel(this)
            handler.removeCallbacks(sessionTick)
            snapshot = null
            account = null
            granted = emptySet()
            loading = false
            busy = false
            val revoke =
                try {
                    auth.clearForSignOut()
                } catch (_: Exception) {
                    message = "Credential storage unavailable. Retry sign-out."
                    null
                }
            DashboardRepository.clear(this)
            prefs
                .edit()
                .putBoolean("background", false)
                .putBoolean("sync-consent", false)
                .putString("widget-privacy", "SUMMARY")
                .putString("glance-level", "HIDDEN")
                .putBoolean("glance-confirmed", false)
                .remove("glance-metrics")
                .remove("sync-account")
                .remove("sync-categories")
                .apply()
            LensWidgets.updateAll(this)
            render()
            revoke?.let {
                io.execute {
                    val confirmed = it()
                    runOnUiThread {
                        if (account == null && !isDestroyed) {
                            message =
                                if (confirmed) "Signed out · local data erased and grant revoked"
                                else "Signed out locally · server revocation unconfirmed"
                            render()
                        }
                    }
                }
            }
        }
    }

    private fun dialog(
        title: String,
        body: String,
        positive: String = "OK",
        action: () -> Unit = {},
    ) {
        val content = if (::frame.isInitialized && frame.childCount > 0) frame.getChildAt(0) else null
        content?.let { ui.blurBehind(it, true) }
        AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(body)
            .setNegativeButton("Cancel", null)
            .setPositiveButton(positive) { _, _ -> action() }
            .setOnDismissListener { content?.let { if (drawer == null) ui.blurBehind(it, false) } }
            .show()
    }

    private fun openExternal(intent: Intent) {
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            message = "No supported app can open this action."
            render()
        } catch (_: SecurityException) {
            message = "Android blocked this action."
            render()
        }
    }

    private fun healthSettings() =
        openExternal(Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS))

    private fun permissionFlow() {
        if (account == null) return
        if (HealthConnectClient.getSdkStatus(this) != HealthConnectClient.SDK_AVAILABLE) {
            dialog(
                "Health Connect unavailable",
                "Update Health Connect or Android. Samsung Health must share records with Health Connect before they can appear.",
            )
            return
        }
        val choices = healthCategories.map { it.permission in granted }.toBooleanArray()
        AlertDialog.Builder(this)
            .setTitle("Choose what WhoopLens can read")
            .setMultiChoiceItems(
                healthCategories.map { it.title + "\n" + it.explanation }.toTypedArray(),
                choices,
            ) { _, n, checked ->
                choices[n] = checked
            }
            .setNegativeButton("Not now", null)
            .setPositiveButton("Continue") { _, _ ->
                val permissions =
                    healthCategories
                        .filterIndexed { i, _ -> choices[i] }
                        .map { it.permission }
                        .toSet()
                if (permissions.isEmpty()) {
                    dialog(
                        "No categories selected",
                        "No extra access requested. Revoke existing access in Android Health Connect settings if desired.",
                    )
                    return@setPositiveButton
                }
                dialog(
                    "Android controls the next screen",
                    "You choose each read permission. Auto-refresh updates only this phone. Background reads need a separate opt-in. Nothing is uploaded or deleted.",
                    "Continue to Health Connect",
                ) {
                    permissionsLauncher.launch(permissions)
                }
            }
            .show()
    }

    private val noticeTick = Runnable {
        if (foreground && !isDestroyed) render()
    }

    /** Redraws at the next notice expiry so a cached banner does not outlive its window. */
    private fun scheduleNoticeExpiry() {
        handler.removeCallbacks(noticeTick)
        if (!foreground || account == null) return
        val now = System.currentTimeMillis()
        val at = ServiceAnnouncements.nextExpiryEpochMs(visibleNotices(now), now) ?: return
        handler.postDelayed(noticeTick, (at - now + 1L).coerceAtLeast(1L))
    }

    private fun visibleNotices(now: Long = System.currentTimeMillis()) =
        ServiceAnnouncements.current(notices, account, now).notices

    private fun resetGlance() {
        prefs
            .edit()
            .putString("glance-level", "HIDDEN")
            .putBoolean("glance-confirmed", false)
            .remove("glance-metrics")
            .apply()
    }

    private fun glanceLevel(): LockLevel =
        try {
            LockLevel.valueOf(prefs.getString("glance-level", "HIDDEN")!!)
        } catch (_: Exception) {
            LockLevel.HIDDEN
        }

    private fun saveGlance(level: LockLevel, confirmed: Boolean) {
        val editor =
            prefs
                .edit()
                .putString("glance-level", level.name)
                .putBoolean("glance-confirmed", confirmed && level == LockLevel.DETAILED)
        if (level != LockLevel.DETAILED) editor.remove("glance-metrics")
        else if (confirmed && prefs.getStringSet("glance-metrics", emptySet()).isNullOrEmpty())
            editor.putStringSet("glance-metrics", linkedSetOf("recovery", "strain", "sleep"))
        editor.apply()
        render()
    }

    private fun chooseGlance(level: LockLevel) {
        val from = glanceLevel()
        if (level.ordinal <= from.ordinal) {
            saveGlance(level, confirmed = false)
            return
        }
        if (locked()) return
        if (level == LockLevel.SUMMARY) {
            if (canChangeLevel(from, level, deviceUnlocked = true, authenticatedJustNow = false))
                saveGlance(level, confirmed = false)
            return
        }
        dialog(
            "Show measurements on the lock screen?",
            "This stores a Detailed opt-in. It does not enable a Samsung lock screen. Issue #102 is still pending physical testing. Measurements stay off the lock screen.",
            "Continue",
        ) {
            confirmGlanceDetailed()
        }
    }

    private fun confirmGlanceDetailed() {
        val authenticators =
            android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_WEAK or
                android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL
        try {
            val prompt =
                android.hardware.biometrics.BiometricPrompt.Builder(this)
                    .setTitle("Confirm detailed At a glance")
                    .setSubtitle("Pending Samsung testing")
                    .setDescription(
                        "Stored on this phone only. Measurements stay off the lock screen until issue #102 is verified."
                    )
                    .setAllowedAuthenticators(authenticators)
                    .build()
            prompt.authenticate(
                android.os.CancellationSignal(),
                mainExecutor,
                object : android.hardware.biometrics.BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(
                        result: android.hardware.biometrics.BiometricPrompt.AuthenticationResult
                    ) {
                        if (canChangeLevel(glanceLevel(), LockLevel.DETAILED, deviceUnlocked = true, authenticatedJustNow = true))
                            saveGlance(LockLevel.DETAILED, confirmed = true)
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        message = "Detailed At a glance was not confirmed."
                        render()
                    }
                },
            )
        } catch (_: Exception) {
            message = "This phone could not confirm Detailed At a glance. Hidden stays in effect."
            render()
        }
    }

    private fun chooseGlanceMetrics() {
        if (locked() || glanceLevel() != LockLevel.DETAILED || !prefs.getBoolean("glance-confirmed", false)) return
        val keys = LOCK_ELIGIBLE_METRICS
        val selected = prefs.getStringSet("glance-metrics", emptySet()).orEmpty()
        val choices = keys.map { it in selected }.toBooleanArray()
        AlertDialog.Builder(this)
            .setTitle("Stored At a glance measurements")
            .setMessage("Up to three. These stay on this phone and are not shown until issue #102 is verified. Measurements stay off the lock screen.")
            .setMultiChoiceItems(keys.toTypedArray(), choices) { _, i, checked -> choices[i] = checked }
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Save") { _, _ ->
                val picked = keys.filterIndexed { i, _ -> choices[i] }
                if (picked.size > LOCK_MAX_METRICS) {
                    message = "Choose at most three At a glance measurements."
                    render()
                    return@setPositiveButton
                }
                prefs.edit().putStringSet("glance-metrics", picked.toSet()).apply()
                render()
            }
            .show()
    }

    private fun glanceDecision(): LockDecision {
        val newest = listOfNotNull(snapshot?.whoop?.fetchedAt, snapshot?.health?.fetchedAt).maxOrNull()
        return effectiveLockContent(
            LockInputs(
                chosen = glanceLevel(),
                signedInAccount = account,
                dataAccount = snapshot?.account,
                deviceSecure = LockSystemReader.deviceSecure(this),
                systemAllowsSensitive = LockSystemReader.systemAllowsSensitive(this),
                platformSupported = LOCK_SCREEN_PLATFORM_VERIFIED,
                newestDataAgeMs = newest?.let { System.currentTimeMillis() - it },
                detailedConfirmed = prefs.getBoolean("glance-confirmed", false),
                selectedMetrics = prefs.getStringSet("glance-metrics", emptySet()).orEmpty().toList(),
            )
        )
    }

    private fun render() {
        applyScreenCapturePrivacy(this)
        if (!::frame.isInitialized) return
        syncAppearance()
        scheduleNoticeExpiry()
        bleScreen = null
        if (
            page != "Direct BLE" &&
                ble.state.phase in
                    setOf(BlePhase.SCANNING, BlePhase.CONNECTING, BlePhase.LIVE, BlePhase.RETRYING)
        )
            ble.stop()
        drawer = null
        frame.removeAllViews()
        val scroll = ScrollView(this)
        val root = ui.column(16)
        scroll.addView(root)
        frame.addView(scroll)
        val bar = ui.row()
        bar.minimumHeight = ui.dp(48)
        bar.background =
            ui.glassBackground(
                GlassRole.TOP_BAR,
                edgeColor = if (page == "Arrange Home") LensColors.teal else null,
            )
        bar.setPadding(ui.dp(4), ui.dp(4), ui.dp(8), ui.dp(4))
        val nav = ui.column()
        ui.button(nav, if (detail != null) "‹" else "☰", enabled = account != null) {
                if (detail != null) {
                    detail = null
                    render()
                } else showDrawer()
            }
            .contentDescription =
            if (detail != null) "Back to overview" else "Open navigation drawer"
        bar.addView(nav, LinearLayout.LayoutParams(ui.dp(48), -2))
        val titleText =
            if (account == null) "WhoopLens"
            else
                detail?.let { metric(it, detailSource)?.title ?: it }
                    ?: if (page == "Home") "Today" else page
        val titles = ui.column()
        val title =
            ui.text(
                titleText,
                30f,
                role = TextRole.HAND,
            )
        ViewCompat.setAccessibilityHeading(title, true)
        titles.addView(title)
        if (page == "Home" && detail == null && account != null)
            titles.addView(
                ui.text(
                    LocalDate.now().format(java.time.format.DateTimeFormatter.ofPattern("EEE · MMM d")),
                    12f,
                    LensColors.muted,
                    role = TextRole.MONO,
                )
            )
        bar.addView(titles, LinearLayout.LayoutParams(0, -2, 1f))
        if (page == "Home" && detail == null && account != null) {
            val edit = ui.column()
            ui.button(edit, "Edit") {
                    arrangeDraft =
                        cardOrder().toMutableList() to
                            prefs.getStringSet("home-hidden", emptySet()).orEmpty().toMutableSet()
                    page = "Arrange Home"
                    render()
                }
                .contentDescription = "Edit Home layout"
            bar.addView(edit, LinearLayout.LayoutParams(-2, -2))
        }
        if (page == "Arrange Home" && detail == null && account != null) {
            val cancel = ui.column()
            ui.button(cancel, "Cancel") {
                    arrangeDraft = null
                    page = "Home"
                    render()
                }
                .contentDescription = "Cancel Home layout edits"
            bar.addView(cancel, LinearLayout.LayoutParams(-2, -2))
        }
        ui.add(root, bar, 0)
        if (locked()) {
            ui.card(root) { ui.add(it, ui.text("Unlock to view your private dashboard")) }
            return
        }
        if (loading) {
            val refreshing = snapshot != null
            ui.add(
                root,
                ui.text(
                        if (refreshing) "Refreshing…" else "Reading permitted sources…",
                        12f,
                        LensColors.teal,
                        role = TextRole.MONO,
                    )
                    .apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE },
            )
            root.addView(
                ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
                    isIndeterminate = true
                },
                LinearLayout.LayoutParams(-1, ui.dp(4)),
            )
        }
        if (message.isNotEmpty()) {
            val failed = message.contains("unavailable", true) || message.contains("blocked", true)
            ui.add(
                root,
                ui.text(
                        message,
                        12f,
                        when {
                            failed -> LensColors.error
                            !online(this) -> LensColors.amber
                            else -> LensColors.muted
                        },
                    )
                    .apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE },
            )
        }
        if (account == null) {
            signedOut(root)
            return
        }
        renderNoticeBanner(root)
        if (detail != null) {
            metricDetail(root)
            return
        }
        when (page) {
            "Home" -> home(root)
            "Activity" -> activity(root)
            "Sleep" -> sleep(root)
            "Vitals" -> vitals(root)
            "Health Connect" -> health(root)
            "Arrange Home" -> customize(root)
            "Direct BLE" ->
                bleScreen =
                    renderBleScreen(
                        ui,
                        root,
                        ble.state,
                        SystemClock.elapsedRealtime(),
                        {
                            if (blePermissions(this)) ble.scan()
                            else
                                blePermissionsLauncher.launch(
                                    arrayOf(
                                        android.Manifest.permission.BLUETOOTH_SCAN,
                                        android.Manifest.permission.BLUETOOTH_CONNECT,
                                    )
                                )
                        },
                        { ble.connect(it) },
                        { ble.stop() },
                    )
            "Open Source Licenses & Credits" -> renderOpenSourceCredits(ui, root)
            else -> settings(root)
        }
    }

    private fun signedOut(root: LinearLayout) {
        ui.card(root) { c ->
            ui.add(c, ui.text("WhoopLens", 30f, role = TextRole.HAND))
            ui.add(
                c,
                ui.text(
                    "Private, invite-only companion. Sign in to see your WHOOP and Health Connect overview."
                ),
            )
            ui.button(c, "Sign in with Cloudflare", true, !busy) { signIn() }
            ui.add(
                c,
                ui.text(
                    "Opens your browser. WhoopLens never sees your password. Credentials use Keystore encryption.",
                    12f,
                    LensColors.muted,
                ),
            )
        }
        if (auth.hasStoredSession()) ui.button(root, "Retry saved connection") { resumeAccount() }
        ui.button(root, "Privacy policy") {
            openExternal(Intent(Intent.ACTION_VIEW, "https://www.whooplens.tech/privacy/".toUri()))
        }
    }

    private fun metric(key: String, source: DataSource) =
        if (source == DataSource.WHOOP) snapshot?.whoop?.metric(key)
        else snapshot?.health?.metric(key)

    private fun metricCard(root: LinearLayout, key: String, title: String, source: DataSource) {
        val card =
            ui.metric(root, metric(key, source), title, source) {
                detail = key
                detailSource = source
                rangeDays = 7
                render()
            }
        val series =
            if (source == DataSource.WHOOP) snapshot?.whoop?.baselineSeries(key).orEmpty()
            else snapshot?.health?.baselineSeries(key).orEmpty()
        ui.add(
            card,
            ui.text(
                "Vs your baseline " +
                    baselineDelta(
                        metric(key, source)?.value,
                        personalBaseline(series, System.currentTimeMillis()),
                    ),
                12f,
                LensColors.muted,
                role = TextRole.MONO,
            ),
            0,
        )
    }

    private fun freshness(root: LinearLayout, b: DataBatch?) {
        if (b == null) return
        val ageHours = (System.currentTimeMillis() - b.fetchedAt) / 3600000L
        val stale = b.stale(System.currentTimeMillis()) || !online(this)
        ui.add(
            root,
            ui.text(
                if (b.stale(System.currentTimeMillis()))
                    b.source.label + " · Not updated for " + ageHours + "h · last " + dateTime(b.fetchedAt)
                else
                    b.source.label +
                        " · " +
                        (if (!online(this)) "Saved" else "Read") +
                        " " +
                        dateTime(b.fetchedAt) +
                        (if (!b.complete) " · partial" else ""),
                12f,
                if (stale) LensColors.amber else LensColors.muted,
                role = TextRole.BODY,
            ),
        )
        b.notices.forEach { ui.add(root, ui.text(it, 12f, LensColors.amber)) }
    }

    private val defaultCards =
        listOf("Recovery", "Strain", "Sleep", "Activity", "Vitals", "Sources")

    private fun cardOrder() =
        prefs
            .getString("home-order", defaultCards.joinToString(","))!!
            .split(',')
            .filter { it in defaultCards }
            .distinct()
            .let { it + defaultCards.filterNot(it::contains) }

    private fun renderNoticeBanner(root: LinearLayout) {
        val banner = ServiceAnnouncements.banner(visibleNotices().filter { it.id !in dismissedNotices }) ?: return
        ui.card(root) { c ->
            ui.add(c, ui.text(banner.kind.replaceFirstChar { it.uppercase() }, 12f, LensColors.amber, true))
            ui.add(
                c,
                ui.text(banner.title, 16f, bold = true).apply {
                    accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
                },
            )
            ui.add(c, ui.text(banner.body, 14f))
            ui.button(c, "Dismiss notice") {
                dismissedNotices.add(banner.id)
                render()
            }
        }
    }

    private fun renderNoticeInbox(root: LinearLayout) {
        val visible = visibleNotices()
        if (visible.isEmpty()) return
        ui.heading(root, "Service notices")
        visible.forEach { notice ->
            ui.card(root) { c ->
                ui.add(c, ui.text(notice.kind.replaceFirstChar { it.uppercase() }, 12f, LensColors.amber, true))
                ui.add(c, ui.text(notice.title, 16f, bold = true))
                ui.add(c, ui.text(notice.body, 14f))
            }
        }
    }

    private fun home(root: LinearLayout) {
        renderNoticeInbox(root)
        freshness(root, snapshot?.whoop)
        freshness(root, snapshot?.health)
        GlassDashboardStats.render(root, ui, snapshot) { key, source ->
            detail = key
            detailSource = source
            rangeDays = 7
            render()
        }
        val hidden = prefs.getStringSet("home-hidden", emptySet()).orEmpty()
        val visible = cardOrder().filterNot { it in hidden }
        visible.forEachIndexed { index, key ->
            if (key == "Sleep" && visible.getOrNull(index - 1) == "Strain") return@forEachIndexed
            when (key) {
                "Recovery" ->
                    ui.card(root) { c ->
                        val m = metric("recovery", DataSource.WHOOP)
                        val header = ui.row()
                        header.addView(ui.text("Recovery", 24f, role = TextRole.HAND), LinearLayout.LayoutParams(0, -2, 1f))
                        ui.chip(header, DataSource.WHOOP)
                        ui.add(c, header, 4)
                        val spoken =
                            "Recovery " +
                                (m?.value?.let { "${it.toInt()} percent" } ?: "not shared") +
                                ", WHOOP, " +
                                (m?.measuredAt?.let { "updated " + dateTime(it) } ?: "time unavailable")
                        val ring = RecoveryRing(this, m?.value, spoken)
                        ring.alpha = if (snapshot?.whoop?.stale(System.currentTimeMillis()) == true) .6f else 1f
                        val ringBox = ui.column()
                        ringBox.gravity = Gravity.CENTER_HORIZONTAL
                        ringBox.addView(ring, LinearLayout.LayoutParams(ui.dp(188), ui.dp(188)))
                        if (!recoveryPercentInsideRing(resources.configuration.fontScale))
                            ringBox.addView(
                                ui.text(m?.value?.let { "${it.toInt()}%" } ?: "—", 22f, role = TextRole.MONO, bold = true)
                            )
                        ui.add(c, ringBox, 4)
                        val status = recoveryStatus(m?.value)
                        ui.add(c, ui.text(status, 26f, LensColors.teal, role = TextRole.HAND), 8)
                        val stats =
                            listOf(
                                (metric("hrv", DataSource.WHOOP)?.display() ?: "—") to "HRV",
                                (metric("rhr", DataSource.WHOOP)?.display() ?: "—") to "Resting HR",
                                (m?.measuredAt?.let(::dateTime) ?: "—") to "Scored",
                            )
                        val columns = metricsPerRow(resources.configuration.fontScale, resources.configuration.screenWidthDp)
                        if (columns == 1) {
                            stats.forEach { (value, label) ->
                                ui.add(c, ui.text(value, 15f, role = TextRole.MONO, bold = true), 0)
                                ui.add(c, ui.text(label, 12f, LensColors.muted), 4)
                            }
                        } else {
                            val row = ui.row()
                            stats.forEach { (value, label) ->
                                val cell = ui.column()
                                cell.addView(ui.text(value, 15f, role = TextRole.MONO, bold = true))
                                cell.addView(ui.text(label, 12f, LensColors.muted))
                                row.addView(cell, LinearLayout.LayoutParams(0, -2, 1f))
                            }
                            ui.add(c, row, 0)
                        }
                        c.isClickable = true
                        c.isFocusable = true
                        c.contentDescription = spoken + ". Open measurements"
                        c.setOnClickListener {
                            detail = "recovery"
                            detailSource = DataSource.WHOOP
                            render()
                        }
                    }
                "Strain" ->
                    if (visible.getOrNull(index + 1) == "Sleep")
                        ui.pair(
                            root,
                            { column -> strainTile(column) },
                            { column -> sleepTile(column) },
                        )
                    else strainTile(root)
                "Sleep" -> metricCard(root, "sleep", "Sleep", DataSource.WHOOP)
                "Activity" ->
                    ui.card(root, dashed = true) { c ->
                        ui.heading(c, "Activity")
                        ui.chip(c, DataSource.HEALTH_CONNECT)
                        val steps = metric("steps", DataSource.HEALTH_CONNECT)
                        ui.add(
                            c,
                            ui.text(
                                steps?.display() ?: "Allow Steps or record activity",
                                if (steps?.value == null) 16f else 32f,
                                bold = steps?.value != null,
                                role = if (steps?.value == null) TextRole.BODY else TextRole.MONO,
                            ),
                        )
                        ui.add(
                            c,
                            ui.text(
                                (metric("distance", DataSource.HEALTH_CONNECT)?.display()
                                    ?: "— km") +
                                    " · " +
                                    (metric("energy", DataSource.HEALTH_CONNECT)?.display()
                                        ?: "— kcal"),
                                14f,
                                LensColors.muted,
                            ),
                        )
                        ui.button(c, "View activity") {
                            page = "Activity"
                            render()
                        }
                    }
                "Vitals" ->
                    ui.card(root) { c ->
                        ui.heading(c, "Vitals")
                        ui.chip(c, DataSource.WHOOP)
                        for (k in listOf("rhr", "hrv", "respiratory", "spo2", "temperature")) {
                            val m = metric(k, DataSource.WHOOP)
                            val row = ui.row()
                            row.minimumHeight = ui.dp(52)
                            row.addView(
                                ui.text(m?.title ?: k, 12f, LensColors.muted),
                                LinearLayout.LayoutParams(0, -2, 1f),
                            )
                            row.addView(ui.text(m?.display() ?: "Not shared", 14f, numbers = true))
                            row.isClickable = true
                            row.isFocusable = true
                            row.contentDescription =
                                (m?.title ?: k) +
                                    ", " +
                                    (m?.display() ?: "Not shared") +
                                    ", WHOOP. Open details"
                            row.setOnClickListener {
                                detail = k
                                detailSource = DataSource.WHOOP
                                render()
                            }
                            ui.add(c, row, 0)
                        }
                    }
                "Sources" ->
                    ui.card(root) { c ->
                        ui.heading(c, "Sources & freshness")
                        ui.chip(c, DataSource.WHOOP)
                        ui.add(
                            c,
                            ui.text(
                                "Authoritative WHOOP recovery, strain, sleep and vitals",
                                12f,
                                LensColors.muted,
                            ),
                        )
                        freshness(c, snapshot?.whoop)
                        ui.chip(c, DataSource.HEALTH_CONNECT)
                        ui.add(
                            c,
                            ui.text(
                                "Local Android records · writing apps labelled",
                                12f,
                                LensColors.muted,
                            ),
                        )
                        freshness(c, snapshot?.health)
                    }
            }
        }
        ui.add(
            root,
            ui.text(
                "Health Connect stays on this phone. Uploads and deletion are off in this build.",
                12f,
                LensColors.sand,
            ),
        )
        ui.button(root, "Arrange cards") {
            page = "Arrange Home"
            render()
        }
        ui.button(root, "Refresh dashboard", enabled = !loading) { refresh(true) }
    }

    private fun tabs(
        root: LinearLayout,
        labels: List<String>,
        selected: Int,
        action: (Int) -> Unit,
    ) {
        val r = if (resources.configuration.fontScale > 1.3f) ui.column() else ui.row()
        labels.forEachIndexed { i, s ->
            val col = ui.column()
            ui.button(col, s, i == selected) { action(i) }
            r.addView(
                col,
                if (r.orientation == LinearLayout.HORIZONTAL) LinearLayout.LayoutParams(0, -2, 1f)
                else LinearLayout.LayoutParams(-1, -2),
            )
        }
        ui.add(root, r)
    }

    private fun chart(
        root: LinearLayout,
        points: List<Point>,
        source: DataSource,
        bars: Boolean = false,
        baseline: Triple<Double, Double, Double>? = null,
    ) {
        root.addView(
            TrendChart(this, points, source, bars, baseline),
            LinearLayout.LayoutParams(-1, ui.dp(150)),
        )
        ui.add(
            root,
            ui.text(source.label + " · gaps mean not shared · tap a point", 12f, LensColors.muted),
        )
    }

    private fun activity(root: LinearLayout) {
        tabs(root, listOf("Day", "Week", "Month"), listOf(1, 7, 30).indexOf(activityDays)) {
            activityDays = listOf(1, 7, 30)[it]
            render()
        }
        ui.card(root, dashed = true) { c ->
            ui.chip(c, DataSource.HEALTH_CONNECT)
            ui.heading(c, "Steps")
            ui.add(c, ui.text(activityDays.toString() + " days", 12f, LensColors.muted, role = TextRole.MONO), 4)
            val p =
                chartSlots(
                    snapshot?.health?.series?.get("steps").orEmpty(),
                    activityDays,
                    System.currentTimeMillis(),
                )
            val v = p.mapNotNull { it.value }
            ui.add(
                c,
                ui.text(
                    if (v.isEmpty()) "Not shared"
                    else java.text.DecimalFormat("#,##0").format(v.sum()) + " steps",
                    28f,
                    bold = true,
                    numbers = true,
                ),
            )
            chart(c, p, DataSource.HEALTH_CONNECT, true)
            ui.add(
                c,
                ui.text(
                    v.size.toString() +
                        " of " +
                        activityDays +
                        " days recorded. Missing days excluded, never zero-filled.",
                    12f,
                    LensColors.muted,
                ),
            )
        }
        ui.pair(
            root,
            { metricCard(it, "distance", "Distance", DataSource.HEALTH_CONNECT) },
            { metricCard(it, "energy", "Active energy", DataSource.HEALTH_CONNECT) },
        )
        ui.pair(
            root,
            { metricCard(it, "strain", "Activity strain", DataSource.WHOOP) },
            { metricCard(it, "floors", "Floors", DataSource.HEALTH_CONNECT) },
        )
        ui.heading(root, "Exercise sessions")
        val sessions = snapshot?.health?.exercises.orEmpty() + snapshot?.whoop?.exercises.orEmpty()
        if (sessions.isEmpty())
            ui.card(root) { ui.add(it, ui.text("No exercise sessions shared in the read window.")) }
        sessions
            .sortedByDescending { it.start }
            .take(30)
            .forEach { e ->
                ui.card(root) { c ->
                    ui.chip(
                        c,
                        if (e.origin == "WHOOP") DataSource.WHOOP else DataSource.HEALTH_CONNECT,
                    )
                    ui.add(c, ui.text(e.title, 17f, bold = true))
                    ui.add(
                        c,
                        ui.text(
                            dateTime(e.start) + " · " + duration((e.end - e.start) / 60000.0),
                            16f,
                            numbers = true,
                        ),
                    )
                    ui.button(c, "Session details") {
                        dialog(
                            e.title,
                            dateTime(e.start) +
                                " – " +
                                dateTime(e.end) +
                                "\nWriting app: " +
                                e.origin +
                                "\nDistance, pace and average heart rate are not inferred.",
                        )
                    }
                }
            }
        ui.add(
            root,
            ui.text(
                "Totals follow Health Connect source priority. Sessions can overlap. WHOOP stays separate.",
                12f,
                LensColors.muted,
            ),
        )
        freshness(root, snapshot?.health)
    }

    private fun strainTile(parent: LinearLayout) {
        val strain = metric("strain", DataSource.WHOOP)
        ui.card(parent) { c ->
            ui.heading(c, "Strain")
            ui.chip(c, DataSource.WHOOP)
            val spoken =
                "Strain " + (strain?.display() ?: "not shared") + " of 21, WHOOP"
            c.addView(StrainArc(this, strain?.value, spoken), LinearLayout.LayoutParams(-1, ui.dp(64)))
            ui.add(
                c,
                ui.text(strain?.display() ?: "—", 26f, bold = true, role = if (strain?.value == null) TextRole.BODY else TextRole.MONO),
                0,
            )
            c.isClickable = true
            c.isFocusable = true
            c.contentDescription = spoken
            c.setOnClickListener {
                detail = "strain"
                detailSource = DataSource.WHOOP
                render()
            }
        }
    }

    private fun sleepTile(parent: LinearLayout) {
        val sleep = metric("sleep", DataSource.WHOOP)
        val performance = metric("performance", DataSource.WHOOP)
        ui.card(parent) { c ->
            ui.heading(c, "Sleep")
            ui.chip(c, DataSource.WHOOP)
            ui.add(
                c,
                ui.text(sleep?.display() ?: "—", 26f, bold = true, role = if (sleep?.value == null) TextRole.BODY else TextRole.MONO),
                0,
            )
            ui.add(
                c,
                ui.text(
                    "Performance " + (performance?.display() ?: "—"),
                    12f,
                    LensColors.muted,
                    role = if (performance?.value == null) TextRole.BODY else TextRole.MONO,
                ),
                0,
            )
            c.isClickable = true
            c.isFocusable = true
            c.contentDescription = "Sleep " + (sleep?.display() ?: "not shared") + ", WHOOP"
            c.setOnClickListener {
                detail = "sleep"
                detailSource = DataSource.WHOOP
                render()
            }
        }
    }

    private fun sleep(root: LinearLayout) {
        val timing = sleepTiming(snapshot?.whoop?.sleeps.orEmpty(), System.currentTimeMillis())
        ui.card(root) { c ->
            ui.heading(c, "Consistency")
            ui.add(c, ui.text("Recorded nights only. Missing nights are left out.", 13f, LensColors.muted))
            ui.pair(
                c,
                { tile ->
                    ui.add(
                        tile,
                        ui.text(
                            timing.consistencyPercent?.let { "$it%" } ?: "—",
                            22f,
                            LensColors.teal,
                            bold = true,
                            role = if (timing.consistencyPercent == null) TextRole.BODY else TextRole.MONO,
                        ),
                    )
                    ui.add(tile, ui.text("Timing consistency", 13f, bold = true))
                    ui.add(
                        tile,
                        ui.text(
                            "How close bed and wake times stayed to the recorded-night median.",
                            12f,
                            LensColors.muted,
                        ),
                    )
                },
                { tile ->
                    ui.add(
                        tile,
                        ui.text("${timing.recorded} of ${timing.window}", 22f, bold = true, role = TextRole.MONO),
                    )
                    ui.add(tile, ui.text("Nights recorded", 13f, bold = true))
                    ui.add(tile, ui.text("Nights without a sleep record are excluded.", 12f, LensColors.muted))
                },
            )
        }
        val order =
            if (prefs.getString("sleep-source", "both") == "health")
                listOf(DataSource.HEALTH_CONNECT, DataSource.WHOOP)
            else listOf(DataSource.WHOOP, DataSource.HEALTH_CONNECT)
        order.forEach { metricCard(root, "sleep", "Sleep · " + it.label, it) }
        ui.heading(root, "Compare sources")
        order.forEach { s ->
            ui.card(root) { c ->
                ui.chip(c, s)
                val b = if (s == DataSource.WHOOP) snapshot?.whoop else snapshot?.health
                val last = b?.sleeps?.lastOrNull()
                ui.add(
                    c,
                    ui.text(
                        last?.let {
                            dateTime(it.start) +
                                " – " +
                                dateTime(it.end) +
                                "\nWriting app: " +
                                it.origin
                        } ?: "No sleep session available",
                        12f,
                        LensColors.muted,
                    ),
                )
                if (last != null) {
                    if (last.stages.isEmpty())
                        ui.add(
                            c,
                            ui.text(
                                if (s == DataSource.WHOOP)
                                    "WHOOP exposes stage totals, not a chronological stage timeline."
                                else
                                    "Stages not shared. Session duration is not assumed to be time asleep.",
                                12f,
                                LensColors.sand,
                            ),
                        )
                    else {
                        c.addView(
                            SleepTimeline(this, last),
                            LinearLayout.LayoutParams(-1, ui.dp(112)),
                        )
                        last.stages.take(60).forEach { stage ->
                            ui.add(
                                c,
                                ui.text(
                                    stage.label +
                                        " · " +
                                        dateTime(stage.start) +
                                        " · " +
                                        duration((stage.end - stage.start) / 60000.0),
                                    12f,
                                    LensColors.sand,
                                ),
                            )
                        }
                    }
                    if (s == DataSource.WHOOP)
                        for (stageKey in listOf("rem", "light", "deep", "awake")) ui.add(
                            c,
                            ui.text(
                                stageKey.uppercase() +
                                    " " +
                                    (metric(stageKey, DataSource.WHOOP)?.display() ?: "Not shared"),
                                12f,
                                LensColors.muted,
                            ),
                        )
                }
            }
        }
        metricCard(root, "performance", "Sleep performance", DataSource.WHOOP)
        ui.card(root) { c ->
            ui.heading(c, "Two-week history")
            val p =
                chartSlots(
                    snapshot?.whoop?.series?.get("sleep").orEmpty(),
                    14,
                    System.currentTimeMillis(),
                )
            chart(c, p, DataSource.WHOOP, true)
            ui.add(
                c,
                ui.text(
                    statistics(p)?.let { "Recorded-night average " + duration(it.first) }
                        ?: "No recorded nights",
                    14f,
                    LensColors.muted,
                ),
            )
            ui.add(
                c,
                ui.text(
                    "No consistency score is invented. History depends on actual records and permissions.",
                    12f,
                    LensColors.muted,
                ),
            )
        }
        ui.heading(root, "Weekly recorded-night averages")
        for (n in 0..3) {
            val p =
                chartSlots(
                        snapshot?.whoop?.series?.get("sleep").orEmpty(),
                        28,
                        System.currentTimeMillis(),
                    )
                    .take(28 - n * 7)
                    .takeLast(7)
            ui.card(root) {
                ui.add(
                    it,
                    ui.text(
                        "Week " +
                            (n + 1) +
                            ": " +
                            (statistics(p)?.let { s -> duration(s.first) } ?: "Not shared"),
                        16f,
                        numbers = true,
                    ),
                )
                ui.chip(it, DataSource.WHOOP)
            }
        }
    }

    private fun vitals(root: LinearLayout) {
        ui.card(root, dashed = true) { c ->
            ui.chip(c, DataSource.HEALTH_CONNECT)
            ui.heading(c, "Heart rate · today")
            val history = snapshot?.health?.series?.get("heart").orEmpty()
            val now = System.currentTimeMillis()
            val p =
                history.filter {
                    it.time > now - 86400000
                }
            val s = statistics(p)
            ui.add(
                c,
                ui.text(
                    s?.let { it.third.toInt().toString() + "–" + it.second.toInt() + " bpm" }
                        ?: "No readings shared",
                    28f,
                    numbers = true,
                ),
            )
            chart(c, p, DataSource.HEALTH_CONNECT)
            val latest = p.lastOrNull { it.value != null }?.value
            ui.add(
                c,
                ui.text(
                    "Vs your baseline " +
                        baselineDelta(latest, personalBaseline(snapshot?.health?.baselineSeries("heart").orEmpty(), now)),
                    12f,
                    LensColors.muted,
                    role = TextRole.MONO,
                ),
            )
            ui.button(c, "Heart-rate measurements") {
                detail = "heart"
                detailSource = DataSource.HEALTH_CONNECT
                render()
            }
        }
        for (k in listOf("hrv", "rhr", "respiratory", "spo2", "temperature")) metricCard(
            root,
            k,
            metric(k, DataSource.WHOOP)?.title ?: k,
            DataSource.WHOOP,
        )
        ui.heading(root, "Additional local readings")
        val extra =
            listOf(
                "hrv",
                "rhr",
                "respiratory",
                "spo2",
                "bodytemperature",
                "systolic",
                "diastolic",
                "weight",
                "bodyfat",
            )
        extra
            .filter { metric(it, DataSource.HEALTH_CONNECT)?.value != null }
            .forEach { k ->
                metricCard(
                    root,
                    k,
                    metric(k, DataSource.HEALTH_CONNECT)?.title ?: k,
                    DataSource.HEALTH_CONNECT,
                )
            }
        val missing = extra.filter { metric(it, DataSource.HEALTH_CONNECT)?.value == null }
        if (missing.isNotEmpty())
            ui.card(root, dashed = true) { c ->
                ui.chip(c, DataSource.HEALTH_CONNECT)
                ui.add(c, ui.text("Not shared", 17f, bold = true))
                ui.add(
                    c,
                    ui.text(
                        missing.joinToString(", ") +
                            ". Review category permissions and source-app sharing in Health Connect.",
                        12f,
                        LensColors.muted,
                    ),
                )
            }
        ui.add(
            root,
            ui.text(
                "Body temperature is not skin temperature. Readings describe measurements, not medical status. Sources are never substituted.",
                12f,
                LensColors.muted,
            ),
        )
    }

    private fun metricDetail(root: LinearLayout) {
        val k = detail ?: return
        val b = if (detailSource == DataSource.WHOOP) snapshot?.whoop else snapshot?.health
        tabs(root, listOf("7 days", "30 days", "90 days"), listOf(7, 30, 90).indexOf(rangeDays)) {
            rangeDays = listOf(7, 30, 90)[it]
            render()
        }
        ui.metric(root, metric(k, detailSource), metric(k, detailSource)?.title ?: k, detailSource)
        val p = chartSlots(b?.series?.get(k).orEmpty(), rangeDays, System.currentTimeMillis())
        ui.card(root) { c ->
            val baseline = personalBaseline(b?.baselineSeries(k).orEmpty(), System.currentTimeMillis())
            chart(c, p, detailSource, baseline = baseline)
            ui.add(
                c,
                ui.text(
                    if (baseline == null)
                        "Baseline unavailable: at least 14 recorded days are needed."
                    else if (detailSource == DataSource.HEALTH_CONNECT && k == "heart")
                        "Shaded: 30-day mean ± standard deviation of recorded daily heart-rate averages. Observed variation, not a medical range."
                    else
                        "Shaded: personal 30-day mean ± standard deviation. Observed variation, not a medical range.",
                    12f,
                    LensColors.muted,
                ),
            )
            ui.add(
                c,
                ui.text(
                    statistics(p)?.let {
                        "Average %.1f · High %.1f · Low %.1f".format(it.first, it.second, it.third)
                    } ?: "No shared readings",
                    14f,
                    LensColors.muted,
                ),
            )
            ui.add(
                c,
                ui.text(
                    p.count { it.value != null }.toString() +
                        " recorded days. Daily points use latest samples, not daily averages. No interpolation. The read window may be shorter than this range.",
                    12f,
                    LensColors.muted,
                ),
            )
        }
        ui.heading(root, "Measurements · " + detailSource.label)
        b?.series
            ?.get(k)
            .orEmpty()
            .filter { it.time > System.currentTimeMillis() - rangeDays * 86400000L }
            .takeLast(100)
            .reversed()
            .forEach { r ->
                ui.add(
                    root,
                    ui.text(
                            dateTime(r.time) +
                                "\n" +
                                (r.value?.let { java.text.DecimalFormat("0.##").format(it) }
                                    ?: "Not shared") +
                                (r.origin?.let { "\nWriting app: " + it } ?: ""),
                            14f,
                            numbers = true,
                        )
                        .apply {
                            isFocusable = true
                            minHeight = ui.dp(48)
                        },
                )
            }
        freshness(root, b)
    }

    private fun health(root: LinearLayout) {
        ui.card(root, dashed = true) { c ->
            ui.heading(
                c,
                if (HealthConnectClient.getSdkStatus(this) == HealthConnectClient.SDK_AVAILABLE)
                    "Available on this phone"
                else "Health Connect needs an update",
            )
            ui.add(
                c,
                ui.text(
                    healthCategories.count { it.permission in granted }.toString() +
                        " of " +
                        healthCategories.size +
                        " read categories granted",
                    17f,
                    bold = true,
                ),
            )
            ui.add(c, ui.text("Read only · choose categories individually", 12f, LensColors.sand))
        }
        ui.card(root, dashed = true) { c ->
            ui.heading(c, "Data categories")
            healthCategories.forEach { cat ->
                ui.add(
                    c,
                    ui.text(
                        cat.title +
                            " · " +
                            (if (cat.permission in granted) "Granted" else "Not granted"),
                        14f,
                        if (cat.permission in granted) LensColors.sand else LensColors.muted,
                        true,
                    ),
                )
                ui.add(c, ui.text(cat.explanation, 12f, LensColors.muted))
            }
            ui.button(c, "Review permissions", true) { permissionFlow() }
            ui.button(c, "Open Health Connect settings") { healthSettings() }
        }
        ui.card(root, dashed = true) { c ->
            ui.heading(c, "Preview on this phone")
            ui.button(c, "Refresh permitted local records", true, !loading) { refresh(true) }
            freshness(c, snapshot?.health)
            ui.add(
                c,
                ui.text("Stored encrypted on this phone only · not uploaded", 12f, LensColors.sand),
            )
            ui.button(c, "Review upload (off)") {
                dialog(
                    "Review Health Connect upload",
                    (metric("steps", DataSource.HEALTH_CONNECT)?.display() ?: "No steps shared") +
                        "\nHealth Connect aggregate · mixed/unknown origin.\nUploads are OFF. Nothing has been sent.",
                )
            }
        }
        ui.card(root, dashed = true) { c ->
            ui.heading(c, "Refresh & sync")
            toggle(c, "Automatic foreground refresh", prefs.getBoolean("local-refresh", true)) {
                prefs.edit().putBoolean("local-refresh", it).apply()
            }
            backgroundOptions(c)
            ui.add(
                c,
                ui.text(
                    "Cloud uploads · Off in this build\nServer deletion · Off in this build",
                    14f,
                    LensColors.amber,
                ),
            )
            ui.add(
                c,
                ui.text(
                    "Up to 30 days of Health Connect history; Android may allow less. Limited pages are marked. Samsung Health must share records with Health Connect.",
                    12f,
                    LensColors.muted,
                ),
            )
        }
    }

    private fun toggle(
        parent: LinearLayout,
        title: String,
        checked: Boolean,
        onChange: (Boolean) -> Unit,
    ) {
        val row = ui.row()
        row.minimumHeight = ui.dp(48)
        row.addView(ui.text(title), LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(
            Switch(this).apply {
                isChecked = checked
                contentDescription = title
                minWidth = ui.dp(52)
                minHeight = ui.dp(52)
                setOnCheckedChangeListener { _, v -> onChange(v) }
            }
        )
        ui.add(parent, row)
    }

    private fun backgroundOptions(c: LinearLayout) {
        toggle(c, "Background dashboard refresh", prefs.getBoolean("background", false)) { enabled
            ->
            if (!enabled) {
                prefs.edit().putBoolean("background", false).apply()
                BackgroundRefresh.cancel(this)
                render()
            } else
                dialog(
                    "Background refresh",
                    "Android schedules updates roughly every 30 minutes, possibly later under battery restrictions. WHOOP needs network. Health Connect needs separate background permission. Uploads stay OFF.",
                    "Enable local background refresh",
                ) {
                    prefs.edit().putBoolean("background", true).apply()
                    account?.let { BackgroundRefresh.schedule(this, it) }
                    render()
                }
        }
        val feature = backgroundReadsAvailable(this)
        ui.add(
            c,
            ui.text(
                if (feature)
                    "Background Health Connect: " +
                        (if (HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in granted)
                            "Granted"
                        else "Not granted")
                else "Background Health Connect unavailable on this device/version",
                12f,
                LensColors.muted,
            ),
        )
        if (feature)
            ui.button(c, "Allow background Health Connect reads") {
                dialog(
                    "Background Health Connect reads",
                    "Read already permitted categories while the app is closed. Only encrypted local cache and widgets update. No uploads. Android may delay or revoke access.",
                    "Choose in Android",
                ) {
                    permissionsLauncher.launch(
                        setOf(HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND)
                    )
                }
            }
        val last = prefs.getLong("background-at", 0)
        ui.add(
            c,
            ui.text(
                if (last == 0L) "Background last run: Never"
                else "Last run " + dateTime(last) + "\n" + prefs.getString("background-status", ""),
                12f,
                LensColors.muted,
            ),
        )
        ui.add(
            c,
            ui.text(
                "Doze, battery saver and Samsung sleeping-app restrictions may delay jobs. Force-stop prevents jobs until reopening. No exact alarms or battery-exemption request.",
                12f,
                LensColors.muted,
            ),
        )
    }

    private fun settings(root: LinearLayout) {
        ui.button(root, "Direct BLE · experimental") {
            ble.selectAccount()
            page = "Direct BLE"
            handler.removeCallbacks(bleTick)
            handler.postDelayed(bleTick, 5000)
            render()
        }
        ui.button(root, "Open Source Licenses & Credits") {
            page = "Open Source Licenses & Credits"
            render()
        }
        ui.card(root) { c ->
            ui.heading(c, "Signed in · Cloudflare")
            ui.add(
                c,
                ui.text(
                    "Invited account\nSession · Keystore-encrypted\nAccess · server checks every authenticated request"
                ),
            )
            ui.button(c, "Reconnect account") {
                dialog(
                    "Reconnect account",
                    "Clears saved session and local previews before opening Cloudflare sign-in.",
                    "Reconnect",
                ) {
                    signIn()
                }
            }
            ui.button(c, "Retry saved connection") { resumeAccount() }
        }
        ui.card(root) { c ->
            ui.heading(c, "When both sources have sleep")
            tabs(
                c,
                listOf("WHOOP first", "HC first", "Both"),
                when (prefs.getString("sleep-source", "both")) {
                    "whoop" -> 0
                    "health" -> 1
                    else -> 2
                },
            ) {
                prefs
                    .edit()
                    .putString("sleep-source", listOf("whoop", "health", "both")[it])
                    .apply()
                render()
            }
            ui.add(
                c,
                ui.text(
                    "Preference changes ordering. Every value keeps its source.",
                    12f,
                    LensColors.muted,
                ),
            )
        }
        ui.card(root) { c ->
            ui.heading(c, "Appearance")
            val choice = prefs.getString("appearance", "AUTO") ?: "AUTO"
            val state = ui.appearance
            listOf(
                    "AUTO" to ("Glass" to "Translucent surfaces over a calm aurora. Yields to battery saver or when blur is off."),
                    "REDUCED_TRANSPARENCY" to ("Reduced transparency" to "Solid surfaces. Same layout and labels."),
                    "BATTERY_SAVER" to ("Battery saver" to "Frosted look without live blur. Also follows Android battery saver."),
                )
                .forEach { (id, copy) ->
                    val on = choice == id || (id == "AUTO" && choice !in setOf("REDUCED_TRANSPARENCY", "BATTERY_SAVER"))
                    val row = ui.row()
                    row.minimumHeight = ui.dp(56)
                    row.isClickable = true
                    row.isFocusable = true
                    row.contentDescription = copy.first + ". " + copy.second
                    row.setOnClickListener {
                        prefs.edit().putString("appearance", id).apply()
                        render()
                    }
                    row.addView(
                        ui.text(if (on) "●" else "○", 16f, if (on) LensColors.teal else LensColors.muted, role = TextRole.BODY),
                        LinearLayout.LayoutParams(ui.dp(32), -2),
                    )
                    val labels = ui.column()
                    labels.addView(ui.text(copy.first, 15f, bold = true))
                    labels.addView(ui.text(copy.second, 12f, LensColors.muted))
                    row.addView(labels, LinearLayout.LayoutParams(0, -2, 1f))
                    ui.add(c, row, 4)
                }
            val reason =
                when (state.reason) {
                    AppearanceReason.POWER_SAVE -> "Battery saver is on."
                    AppearanceReason.BLUR_UNAVAILABLE -> "Your phone turned off blur."
                    else -> null
                }
            if (reason != null) ui.add(c, ui.text(reason, 12f, LensColors.amber))
            toggle(c, "Reduced motion", prefs.getBoolean("reduced-motion", false)) {
                prefs.edit().putBoolean("reduced-motion", it).apply()
                render()
            }
            ui.add(
                c,
                ui.text(
                    "Text size follows Android, up to 200%. Motion also follows Remove animations.",
                    12f,
                    LensColors.muted,
                ),
            )
        }
        ui.card(root) { c ->
            ui.heading(c, "Widgets & privacy")
            val mode = prefs.getString("widget-privacy", "SUMMARY")
            tabs(
                c,
                listOf("Hidden", "Summary", "Detailed"),
                listOf("HIDDEN", "SUMMARY", "DETAILED").indexOf(mode),
            ) { n ->
                val value = listOf("HIDDEN", "SUMMARY", "DETAILED")[n]
                val save = {
                    prefs.edit().putString("widget-privacy", value).apply()
                    LensWidgets.updateAll(this)
                    render()
                }
                if (n == 2)
                    dialog(
                        "Public home-screen measurements",
                        "Detailed widgets copy measurements onto the home screen. Anyone who can see that home screen can read them, including launcher copies. Measurements are withheld while the phone is locked. Choose Summary for privacy.",
                        "Use detailed home widgets",
                        save,
                    )
                else save()
            }
            ui.add(
                c,
                ui.text(
                    "Six resizable home widgets, from 1\u00d71 through an intended 4\u00d72. Samsung lock screen, Brief widgets, and Now Bar are not part of this app. Measurements stay off the lock screen.",
                    12f,
                    LensColors.muted,
                ),
            )
            ui.button(c, "Choose widget measurements") {
                val keys =
                    listOf(
                        "recovery",
                        "strain",
                        "sleep",
                        "hrv",
                        "rhr",
                        "steps",
                        "distance",
                        "exercise",
                    )
                val choices =
                    keys
                        .map { it in prefs.getStringSet("widget-keys", keys.toSet()).orEmpty() }
                        .toBooleanArray()
                AlertDialog.Builder(this)
                    .setTitle("Detailed home widgets")
                    .setMultiChoiceItems(keys.toTypedArray(), choices) { _, i, b -> choices[i] = b }
                    .setPositiveButton("Save") { _, _ ->
                        prefs
                            .edit()
                            .putStringSet(
                                "widget-keys",
                                keys.filterIndexed { i, _ -> choices[i] }.toSet(),
                            )
                            .apply()
                        LensWidgets.updateAll(this)
                    }
                    .setNegativeButton("Cancel", null)
                    .show()
            }
        }
        ui.card(root) { c ->
            ui.heading(c, "At a glance")
            ui.add(c, ui.text(GLANCE_PENDING_COPY, 13f, LensColors.muted))
            val selected = glanceLevel()
            tabs(c, listOf("Hidden", "Summary", "Detailed"), selected.ordinal) { n ->
                chooseGlance(LockLevel.entries[n])
            }
            val decision = glanceDecision()
            ui.add(
                c,
                ui.text(
                    "Chosen " +
                        selected.name.lowercase() +
                        ". Effective " +
                        decision.level.name.lowercase() +
                        " · " +
                        decision.fallback.name.lowercase().replace('_', ' ') +
                        ".",
                    12f,
                    LensColors.amber,
                ),
            )
            ui.add(
                c,
                ui.text(
                    "Hidden shows the mark and Unlock to view. Summary and Detailed need an explicit opt-in in the unlocked app and still do not appear until issue #102 is verified.",
                    12f,
                    LensColors.muted,
                ),
            )
            if (selected == LockLevel.DETAILED && prefs.getBoolean("glance-confirmed", false))
                ui.button(c, "Choose stored measurements") { chooseGlanceMetrics() }
        }
        ui.card(root) { c ->
            ui.heading(c, "Cloud synchronization · prepared only")
            ui.add(c, ui.text("Off in this build · last cloud sync: Never", 14f, LensColors.amber))
            ui.add(
                c,
                ui.text(
                    "Dashboard refresh never authorizes transfer. A separately verified backend contract, consent and release are required.",
                    12f,
                    LensColors.muted,
                ),
            )
            ui.button(c, "Prepare category choices") { cloudChoices() }
            ui.button(c, "Pause / clear future sync consent") {
                prefs
                    .edit()
                    .putBoolean("sync-consent", false)
                    .putBoolean("sync-paused", true)
                    .remove("sync-categories")
                    .apply()
                message = "Future sync paused. No transfer occurred."
                render()
            }
        }
        ui.button(root, "Health Connect & privacy") {
            page = "Health Connect"
            render()
        }
        ui.button(root, "Account & data options") {
            dialog(
                "Your data, by where it lives",
                "On this phone: sign-out erases credentials and cached previews.\nHealth Connect: revoke permissions in Android settings. No phone records deleted.\nOn the server: deletion is OFF in this app. Existing records may remain. Use the privacy request page.",
                "Open web request page",
            ) {
                openExternal(
                    Intent(Intent.ACTION_VIEW, "https://www.whooplens.tech/privacy/".toUri())
                )
            }
        }
        ui.button(root, "Online privacy policy") {
            openExternal(Intent(Intent.ACTION_VIEW, "https://www.whooplens.tech/privacy/".toUri()))
        }
        ui.button(root, "Help") {
            dialog(
                "WhoopLens help",
                "Missing data means a source did not share it, permission is missing, or a read failed. Check source notices, Health Connect sharing and connection. WHOOP remains authoritative. Not medical advice.",
            )
        }
        ui.button(root, "Sign out") { signOut() }
        ui.add(
            root,
            ui.text("WhoopLens Companion · not affiliated with WHOOP", 12f, LensColors.muted),
        )
    }

    private fun cloudChoices() {
        val selected = BooleanArray(healthCategories.size)
        AlertDialog.Builder(this)
            .setTitle("Prepare future cloud-sync categories")
            .setMultiChoiceItems(healthCategories.map { it.title }.toTypedArray(), selected) {
                _,
                i,
                b ->
                selected[i] = b
            }
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Review") { _, _ ->
                dialog(
                    "Uploads remain OFF",
                    "Records could leave this phone only after a separately approved backend contract, consent and release. Saving choices does not activate or schedule transfer.",
                    "Save preparation only",
                ) {
                    prefs
                        .edit()
                        .putString("sync-account", account)
                        .putBoolean("sync-consent", false)
                        .putBoolean("sync-paused", true)
                        .putStringSet(
                            "sync-categories",
                            healthCategories
                                .filterIndexed { i, _ -> selected[i] }
                                .map { it.key }
                                .toSet(),
                        )
                        .apply()
                    message = "Future choices saved locally. Uploads OFF."
                    render()
                }
            }
            .show()
    }

    private fun customize(root: LinearLayout) {
        ui.add(
            root,
            ui.text(
                "Drag a card, or use arrows. Hidden cards stay one tap away. Done saves this order on the phone.",
                14f,
                LensColors.muted,
            ),
        )
        val draft =
            arrangeDraft
                ?: (cardOrder().toMutableList() to
                        prefs.getStringSet("home-hidden", emptySet()).orEmpty().toMutableSet())
                    .also { arrangeDraft = it }
        val order = draft.first
        val hidden = draft.second
        fun refresh() {
            render()
        }
        order.forEachIndexed { i, name ->
            val card =
                ui.card(root) { c ->
                    ui.add(c, ui.text(name, 17f, bold = true))
                    toggle(c, "Show " + name, name !in hidden) {
                        if (it) hidden.remove(name) else hidden.add(name)
                        refresh()
                    }
                    tabs(c, listOf("↑ Move up", "↓ Move down"), -1) { n ->
                        val j = if (n == 0) i - 1 else i + 1
                        if (j in order.indices) {
                            java.util.Collections.swap(order, i, j)
                            refresh()
                        }
                    }
                }
            card.setOnLongClickListener {
                it.startDragAndDrop(
                    ClipData.newPlainText("home-card", name),
                    View.DragShadowBuilder(it),
                    name,
                    0,
                )
                true
            }
            card.setOnDragListener { _, event ->
                when (event.action) {
                    DragEvent.ACTION_DRAG_STARTED -> event.localState is String
                    DragEvent.ACTION_DROP -> {
                        val from = order.indexOf(event.localState as? String)
                        if (from >= 0) {
                            val v = order.removeAt(from)
                            order.add(i.coerceAtMost(order.size), v)
                            refresh()
                        }
                        true
                    }
                    else -> true
                }
            }
        }
        ui.button(root, "Reset to default order") {
            order.clear()
            order.addAll(defaultCards)
            hidden.clear()
            refresh()
        }
        ui.button(root, "Cancel") {
            arrangeDraft = null
            page = "Home"
            render()
        }
        ui.button(root, "Done", true) {
            prefs
                .edit()
                .putString("home-order", order.joinToString(","))
                .putStringSet("home-hidden", hidden)
                .apply()
            arrangeDraft = null
            page = "Home"
            render()
        }
    }

    private fun showDrawer() {
        val scrim =
            FrameLayout(this).apply {
                setBackgroundColor(0x99000000.toInt())
                setOnClickListener { closeDrawer() }
            }
        val behind = frame.getChildAt(0) ?: return
        behind.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        ui.blurBehind(behind, true)
        val scroll = ScrollView(this).apply { isFillViewport = true }
        val panel =
            ui.column(24).apply {
                background = ui.glassBackground(GlassRole.DRAWER)
                isClickable = true
            }
        scroll.addView(panel)
        scrim.addView(
            scroll,
            FrameLayout.LayoutParams(
                ui.dp(328).coerceAtMost(resources.displayMetrics.widthPixels - ui.dp(32)),
                -1,
            ),
        )
        frame.addView(scrim)
        drawer = scrim
        panel.addView(
            ImageView(this).apply {
                setImageResource(R.drawable.lens_mark)
                contentDescription = "WhoopLens pulse-ring logo"
            },
            LinearLayout.LayoutParams(ui.dp(64), ui.dp(64)).apply { bottomMargin = ui.dp(12) },
        )
        ui.add(panel, ui.text("WhoopLens", 28f, role = TextRole.HAND))
        ui.add(panel, ui.text("Signed in · Cloudflare", 12f, LensColors.muted))
        ui.chip(panel, DataSource.WHOOP)
        ui.chip(panel, DataSource.HEALTH_CONNECT)
        for (destination in
            listOf("Home", "Activity", "Sleep", "Vitals", "Health Connect", "Account & Settings")) {
            val item =
                ui.text(
                    destination,
                    15f,
                    if (destination == page) LensColors.teal else LensColors.text,
                    true,
                )
            item.minimumHeight = ui.dp(56)
            item.gravity = Gravity.CENTER_VERTICAL
            item.setPadding(ui.dp(16), 0, ui.dp(16), 0)
            item.background =
                ui.glassBackground(
                    GlassRole.CHIP,
                    edgeColor = if (destination == page) LensColors.teal else null,
                )
            item.isFocusable = true
            item.isClickable = true
            item.setOnClickListener {
                page = destination
                detail = null
                closeDrawer()
                render()
            }
            ui.add(panel, item, 8)
        }
        panel.addView(Space(this), LinearLayout.LayoutParams(-1, 0, 1f))
        ui.add(
            panel,
            ui.text(
                "Read only · local dashboard\nCloud uploads and deletion off",
                12f,
                LensColors.muted,
            ),
        )
        panel.requestFocus()
    }

    private fun closeDrawer() {
        drawer?.let { frame.removeView(it) }
        drawer = null
        frame.getChildAt(0)?.let {
            it.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
            ui.blurBehind(it, false)
        }
    }
}
