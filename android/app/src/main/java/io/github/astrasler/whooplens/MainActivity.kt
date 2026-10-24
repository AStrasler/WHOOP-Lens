package io.github.astrasler.whooplens

import android.app.AlertDialog
import android.app.KeyguardManager
import android.content.*
import android.os.*
import android.view.*
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
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
    private var detail: String? = null
    private var detailSource = DataSource.WHOOP
    private var rangeDays = 7
    private var activityDays = 7
    private var message = ""
    private var drawer: View? = null
    private lateinit var frame: FrameLayout
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
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        page = savedInstanceState?.getString("page") ?: "Home"
        frame = FrameLayout(this).apply { setBackgroundColor(LensColors.background) }
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

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("page", page)
        super.onSaveInstanceState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleOAuthCallback(intent)
    }

    override fun onResume() {
        super.onResume()
        foreground = true
        resumeAccount()
        handler.postDelayed(periodic, 300000)
    }

    override fun onPause() {
        foreground = false
        handler.removeCallbacks(periodic)
        handler.removeCallbacks(sessionTick)
        super.onPause()
    }

    override fun onDestroy() {
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
                }
                val old = prefs.getStringSet("last-permissions", emptySet()).orEmpty()
                granted = permissions
                if (current == null) {
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
            "Sign out of WHOOP Lens?",
            "Erases encrypted sign-in and cached previews on this phone. Asks the server to revoke this phone's grant when online. Health Connect permissions stay in Android settings.",
            "Sign out",
        ) {
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
        AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(body)
            .setNegativeButton("Cancel", null)
            .setPositiveButton(positive) { _, _ -> action() }
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
            .setTitle("Choose what WHOOP Lens can read")
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

    private fun render() {
        if (!::frame.isInitialized) return
        drawer = null
        frame.removeAllViews()
        val scroll = ScrollView(this)
        val root = ui.column(16)
        scroll.addView(root)
        frame.addView(scroll)
        val bar = ui.row()
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
        val title =
            ui.text(
                if (account == null) "WHOOP Lens"
                else
                    detail?.let { metric(it, detailSource)?.title ?: it }
                        ?: if (page == "Home") "Today" else page,
                21f,
                bold = true,
            )
        ViewCompat.setAccessibilityHeading(title, true)
        bar.addView(title, LinearLayout.LayoutParams(0, -2, 1f))
        ui.add(root, bar)
        if (locked()) {
            ui.card(root) { ui.add(it, ui.text("Unlock to view your private dashboard")) }
            return
        }
        if (loading) {
            ui.add(
                root,
                ui.text("Reading permitted sources…", 12f, LensColors.teal).apply {
                    accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
                },
            )
            root.addView(
                ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
                    isIndeterminate = true
                },
                LinearLayout.LayoutParams(-1, ui.dp(4)),
            )
        }
        if (message.isNotEmpty())
            ui.add(
                root,
                ui.text(message, 12f, if (!online(this)) LensColors.amber else LensColors.muted)
                    .apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE },
            )
        if (account == null) {
            signedOut(root)
            return
        }
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
            else -> settings(root)
        }
    }

    private fun signedOut(root: LinearLayout) {
        ui.card(root) { c ->
            ui.add(c, ui.text("WHOOP Lens", 30f, bold = true))
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
                    "Opens your browser. WHOOP Lens never sees your password. Credentials use Keystore encryption.",
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

    private fun metricCard(root: LinearLayout, key: String, title: String, source: DataSource) =
        ui.metric(root, metric(key, source), title, source) {
            detail = key
            detailSource = source
            rangeDays = 7
            render()
        }

    private fun freshness(root: LinearLayout, b: DataBatch?) {
        if (b == null) return
        val stale = b.stale(System.currentTimeMillis()) || !online(this)
        ui.add(
            root,
            ui.text(
                b.source.label +
                    " · " +
                    (if (stale) "Saved" else "Read") +
                    " " +
                    dateTime(b.fetchedAt) +
                    (if (!b.complete) " · partial" else ""),
                12f,
                if (stale) LensColors.amber else LensColors.muted,
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

    private fun home(root: LinearLayout) {
        ui.add(
            root,
            ui.text(
                LocalDate.now().format(java.time.format.DateTimeFormatter.ofPattern("EEE · MMM d")),
                12f,
                LensColors.muted,
            ),
        )
        freshness(root, snapshot?.whoop)
        freshness(root, snapshot?.health)
        val hidden = prefs.getStringSet("home-hidden", emptySet()).orEmpty()
        val visible = cardOrder().filterNot { it in hidden }
        visible.forEachIndexed { index, key ->
            if (key == "Sleep" && visible.getOrNull(index - 1) == "Strain") return@forEachIndexed
            when (key) {
                "Recovery" ->
                    ui.card(root) { c ->
                        ui.chip(c, DataSource.WHOOP)
                        val m = metric("recovery", DataSource.WHOOP)
                        val row =
                            if (resources.configuration.fontScale > 1.3f) ui.column() else ui.row()
                        val ring = RecoveryRing(this, m?.value)
                        ring.alpha =
                            if (snapshot?.whoop?.stale(System.currentTimeMillis()) == true) .6f
                            else 1f
                        row.addView(ring, LinearLayout.LayoutParams(ui.dp(112), ui.dp(112)))
                        val info = ui.column(8)
                        ui.add(
                            info,
                            ui.text(
                                if (m?.value == null) "No WHOOP recovery yet" else "Recovery",
                                17f,
                                bold = true,
                            ),
                        )
                        ui.add(
                            info,
                            ui.text(
                                "HRV " + (metric("hrv", DataSource.WHOOP)?.display() ?: "—"),
                                12f,
                                LensColors.muted,
                            ),
                        )
                        ui.add(
                            info,
                            ui.text(
                                "Resting HR " + (metric("rhr", DataSource.WHOOP)?.display() ?: "—"),
                                12f,
                                LensColors.muted,
                            ),
                        )
                        ui.add(
                            info,
                            ui.text(
                                m?.measuredAt?.let(::dateTime) ?: "Waiting for a WHOOP score",
                                11f,
                                LensColors.muted,
                            ),
                        )
                        row.addView(
                            info,
                            LinearLayout.LayoutParams(
                                if (row.orientation == LinearLayout.HORIZONTAL) 0 else -1,
                                -2,
                                1f,
                            ),
                        )
                        ui.add(c, row, 0)
                        c.isClickable = true
                        c.isFocusable = true
                        c.contentDescription = "WHOOP recovery details"
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
                            { metricCard(it, "strain", "Strain", DataSource.WHOOP) },
                            { metricCard(it, "sleep", "Sleep", DataSource.WHOOP) },
                        )
                    else metricCard(root, "strain", "Strain", DataSource.WHOOP)
                "Sleep" -> metricCard(root, "sleep", "Sleep", DataSource.WHOOP)
                "Activity" ->
                    ui.card(root) { c ->
                        ui.chip(c, DataSource.HEALTH_CONNECT)
                        ui.heading(c, "Activity · today")
                        ui.add(
                            c,
                            ui.text(
                                metric("steps", DataSource.HEALTH_CONNECT)?.display()
                                    ?: "Allow Steps or record activity",
                                28f,
                                bold = true,
                                numbers = true,
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
            ui.text(source.label + " · gaps mean not shared · tap a point", 11f, LensColors.muted),
        )
    }

    private fun activity(root: LinearLayout) {
        tabs(root, listOf("Day", "Week", "Month"), listOf(1, 7, 30).indexOf(activityDays)) {
            activityDays = listOf(1, 7, 30)[it]
            render()
        }
        ui.card(root) { c ->
            ui.chip(c, DataSource.HEALTH_CONNECT)
            ui.heading(c, "Steps · " + activityDays + " days")
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

    private fun sleep(root: LinearLayout) {
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
            ui.heading(c, "14-night history")
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
        ui.card(root) { c ->
            ui.chip(c, DataSource.HEALTH_CONNECT)
            ui.heading(c, "Heart rate · today")
            val p =
                snapshot?.health?.series?.get("heart").orEmpty().filter {
                    it.time > System.currentTimeMillis() - 86400000
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
            ui.card(root) { c ->
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
            val baseline = personalBaseline(b?.series?.get(k).orEmpty(), System.currentTimeMillis())
            chart(c, p, detailSource, baseline = baseline)
            ui.add(
                c,
                ui.text(
                    if (baseline == null)
                        "Baseline unavailable: at least 14 recorded days are needed."
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
        ui.card(root) { c ->
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
        ui.card(root) { c ->
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
        ui.card(root) { c ->
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
        ui.card(root) { c ->
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
            ui.add(c, ui.text("Theme · Premium dark"))
            toggle(c, "Reduced motion", prefs.getBoolean("reduced-motion", false)) {
                prefs.edit().putBoolean("reduced-motion", it).apply()
            }
            ui.add(
                c,
                ui.text("Static charts and rings avoid sweeps and pulses.", 12f, LensColors.muted),
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
                        "Widget contents are copied to your launcher. Anyone seeing that surface can read them, including host copies. Lock-screen provider never receives numbers. Choose Summary for privacy.",
                        "Use detailed home widgets",
                        save,
                    )
                else save()
            }
            ui.add(
                c,
                ui.text(
                    "Six resizable home widgets. Lock-screen host support varies by Android and One UI. No Now Bar or watch companion. Lock-screen provider is non-numeric.",
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
                "WHOOP Lens help",
                "Missing data means a source did not share it, permission is missing, or a read failed. Check source notices, Health Connect sharing and connection. WHOOP remains authoritative. Not medical advice.",
            )
        }
        ui.button(root, "Sign out") { signOut() }
        ui.add(
            root,
            ui.text("WHOOP Lens Companion · not affiliated with WHOOP", 12f, LensColors.muted),
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
                "Drag a card, or use arrows. Hidden cards stay one tap away.",
                14f,
                LensColors.muted,
            ),
        )
        val order = cardOrder().toMutableList()
        val hidden = prefs.getStringSet("home-hidden", emptySet()).orEmpty().toMutableSet()
        fun save() {
            prefs
                .edit()
                .putString("home-order", order.joinToString(","))
                .putStringSet("home-hidden", hidden)
                .apply()
            render()
        }
        order.forEachIndexed { i, name ->
            val card =
                ui.card(root) { c ->
                    ui.add(c, ui.text(name, 17f, bold = true))
                    toggle(c, "Show " + name, name !in hidden) {
                        if (it) hidden.remove(name) else hidden.add(name)
                        save()
                    }
                    tabs(c, listOf("↑ Move up", "↓ Move down"), -1) { n ->
                        val j = if (n == 0) i - 1 else i + 1
                        if (j in order.indices) {
                            java.util.Collections.swap(order, i, j)
                            save()
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
                            save()
                        }
                        true
                    }
                    else -> true
                }
            }
        }
        ui.button(root, "Done", true) {
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
        frame.getChildAt(0).importantForAccessibility =
            View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        val scroll = ScrollView(this).apply { isFillViewport = true }
        val panel =
            ui.column(24).apply {
                background = ui.shape(LensColors.top, 28)
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
                contentDescription = "WHOOP Lens pulse-ring logo"
            },
            LinearLayout.LayoutParams(ui.dp(64), ui.dp(64)).apply { bottomMargin = ui.dp(12) },
        )
        ui.add(panel, ui.text("WHOOP Lens", 25f, LensColors.text, true))
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
                ui.shape(
                    if (destination == page) android.graphics.Color.rgb(25, 58, 62)
                    else LensColors.top,
                    14,
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
        frame.getChildAt(0)?.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
    }
}
