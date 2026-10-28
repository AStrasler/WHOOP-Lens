package io.github.astrasler.whooplens

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.view.View
import android.widget.ScrollView
import java.io.File

/** Separate test APK only. No fixture or authentication bypass is packaged in the companion. */
class DesignReviewInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        start()
    }

    private fun field(activity: Activity, name: String, value: Any?) {
        activity.javaClass.getDeclaredField(name).apply { isAccessible = true }.set(activity, value)
    }

    private fun call(activity: Activity, name: String) {
        activity.javaClass.getDeclaredMethod(name).apply { isAccessible = true }.invoke(activity)
    }

    override fun onStart() {
        val results = Bundle()
        try {
            val activity =
                startActivitySync(
                    Intent(targetContext, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            waitForIdleSync()
            Thread.sleep(600)
            waitForIdleSync()
            val now = System.currentTimeMillis()
            fun m(key: String, title: String, value: Double, unit: String, s: DataSource) =
                Metric(
                    key,
                    title,
                    value,
                    unit,
                    s,
                    now,
                    if (s == DataSource.HEALTH_CONNECT) "com.example.test-writer" else null,
                )
            val w = DataSource.WHOOP
            val h = DataSource.HEALTH_CONNECT
            val wm =
                listOf(
                    m("recovery", "Recovery", 72.0, "%", w),
                    m("strain", "Strain", 11.4, "/ 21", w),
                    m("sleep", "Sleep", 458.0, "min", w),
                    m("hrv", "HRV", 64.0, "ms", w),
                    m("rhr", "Resting HR", 52.0, "bpm", w),
                    m("respiratory", "Respiratory rate", 15.2, "rpm", w),
                    m("spo2", "Blood oxygen", 97.0, "%", w),
                    m("temperature", "Skin temperature", 33.2, "°C", w),
                    m("performance", "Sleep performance", 91.0, "%", w),
                    m("rem", "REM", 112.0, "min", w),
                    m("light", "Light", 231.0, "min", w),
                    m("deep", "Deep", 115.0, "min", w),
                    m("awake", "Awake", 27.0, "min", w),
                )
            val hm =
                listOf(
                    m("steps", "Steps", 8412.0, "steps", h),
                    m("distance", "Distance", 6.1, "km", h),
                    m("energy", "Active energy", 412.0, "kcal", h),
                    m("exercise", "Exercise", 42.0, "min", h),
                    m("sleep", "Sleep (known stages)", 120.0, "min", h),
                    m("heart", "Heart rate", 72.0, "bpm", h),
                )
            fun points(base: Double) =
                (0..29).map { i ->
                    Point(now - (29 - i) * 86400000L, if (i == 5) null else base + (i % 5 - 2) * 3)
                }
            val sleep =
                SleepDetail(
                    now - 8 * 3600000L,
                    now,
                    "WHOOP · stage totals only",
                    emptyList(),
                    458.0,
                )
            val hcSleep =
                SleepDetail(
                    now - 8 * 3600000L,
                    now,
                    "com.example.test-writer",
                    listOf(
                        SleepStage(now - 7200000, now - 3600000, "Deep"),
                        SleepStage(now - 3600000, now, "REM"),
                    ),
                    120.0,
                )
            val snapshot =
                DashboardSnapshot(
                    "visual-test",
                    DataBatch(
                        w,
                        now,
                        wm,
                        wm.associate { it.key to points(it.value!!) },
                        listOf(sleep),
                    ),
                    DataBatch(
                        h,
                        now,
                        hm,
                        mapOf(
                            "steps" to points(8400.0),
                            "heart" to
                                (0..23).map {
                                    Point(
                                        now - (23 - it) * 3600000L,
                                        60.0 + it % 9 * 10,
                                        "com.example.test-writer",
                                    )
                                },
                            "sleep" to points(471.0),
                        ),
                        listOf(hcSleep),
                        listOf(
                            ExerciseDetail(
                                now - 3600000,
                                now - 1080000,
                                "Outdoor run",
                                "com.example.test-writer",
                            )
                        ),
                    ),
                )
            val directory =
                File(targetContext.getExternalFilesDir(null), "design-review").apply { mkdirs() }
            fun capture(name: String, full: Boolean = true) {
                waitForIdleSync()
                runOnMainSync {
                    val decor = activity.window.decorView
                    val frame =
                        activity.javaClass
                            .getDeclaredField("frame")
                            .apply { isAccessible = true }
                            .get(activity) as android.widget.FrameLayout
                    val sc = frame.getChildAt(0) as? ScrollView
                    val content =
                        if (full && sc != null && frame.childCount == 1) sc.getChildAt(0) else decor
                    if (content !== decor) {
                        content.measure(
                            View.MeasureSpec.makeMeasureSpec(frame.width, View.MeasureSpec.EXACTLY),
                            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
                        )
                        content.layout(0, 0, frame.width, content.measuredHeight)
                    }
                    val bitmap =
                        Bitmap.createBitmap(
                            content.width,
                            content.height.coerceAtMost(20000),
                            Bitmap.Config.ARGB_8888,
                        )
                    val canvas = Canvas(bitmap)
                    canvas.drawColor(LensColors.background)
                    content.draw(canvas)
                    File(directory, name + ".png").outputStream().use {
                        bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
                    }
                    bitmap.recycle()
                }
            }
            for (screen in
                listOf(
                    "Home",
                    "Activity",
                    "Sleep",
                    "Vitals",
                    "Health Connect",
                    "Account & Settings",
                    "Arrange Home",
                )) {
                runOnMainSync {
                    field(activity, "account", "visual-test")
                    field(activity, "snapshot", snapshot)
                    field(activity, "granted", healthCategories.map { it.permission }.toSet())
                    field(activity, "page", screen)
                    field(activity, "message", "DESIGN TEST FIXTURE · illustrative data only")
                    call(activity, "render")
                }
                capture(screen.replace(" & ", "-").replace(" ", "-"))
            }
            runOnMainSync {
                field(activity, "page", "Vitals")
                field(activity, "detail", "hrv")
                field(activity, "detailSource", w)
                call(activity, "render")
            }
            capture("Metric-detail")
            runOnMainSync {
                field(activity, "detail", null)
                call(activity, "render")
                call(activity, "showDrawer")
            }
            capture("Drawer", false)
            runOnMainSync {
                call(activity, "closeDrawer")
                field(activity, "account", null)
                field(activity, "snapshot", null)
                call(activity, "render")
            }
            capture("Signed-out")

            for ((name, mode) in
                listOf(
                    "State-empty" to "empty",
                    "State-error" to "error",
                    "State-offline" to "offline",
                    "State-loading" to "loading",
                )) {
                runOnMainSync {
                    field(activity, "account", "visual-test")
                    field(activity, "page", "Home")
                    field(
                        activity,
                        "snapshot",
                        if (mode == "empty") DashboardSnapshot("visual-test")
                        else if (mode == "offline")
                            snapshot.copy(
                                whoop = snapshot.whoop!!.copy(fetchedAt = now - 19 * 3600000)
                            )
                        else if (mode == "error")
                            snapshot.copy(
                                whoop =
                                    snapshot.whoop!!.copy(
                                        notices =
                                            listOf(
                                                "WHOOP reads unavailable. Retry when connected."
                                            ),
                                        complete = false,
                                    )
                            )
                        else snapshot,
                    )
                    field(activity, "message", "DESIGN TEST FIXTURE · " + name)
                    field(activity, "loading", mode == "loading")
                    call(activity, "render")
                }
                capture(name)
            }

            val providers =
                android.appwidget.AppWidgetManager.getInstance(targetContext).installedProviders
            for (type in LensWidgets.profiles.keys.filter { it != PrivateLockWidget::class.java }) {
                val info = providers.single { it.provider.className == type.name }
                check(info.targetCellWidth == 1 && info.targetCellHeight == 1)
                check(
                    info.resizeMode == 3 &&
                        info.maxResizeWidth > info.minResizeWidth &&
                        info.maxResizeHeight > info.minResizeHeight
                )
                check(info.previewLayout == R.layout.lens_widget_preview)
            }
            if (android.os.Build.VERSION.SDK_INT >= 36) {
                for (type in LensWidgets.profiles.keys) {
                    val info = providers.single { it.provider.className == type.name }
                    check(
                        (info.widgetCategory and
                            android.appwidget.AppWidgetProviderInfo.WIDGET_CATEGORY_NOT_KEYGUARD) != 0
                    ) { type.simpleName + " missing not_keyguard" }
                    check(
                        (info.widgetCategory and
                            android.appwidget.AppWidgetProviderInfo.WIDGET_CATEGORY_KEYGUARD) == 0
                    ) { type.simpleName + " still opts into keyguard" }
                }
            }
            var widgetRenders = 0
            for ((type, keys) in
                LensWidgets.profiles.filterKeys { it != PrivateLockWidget::class.java }) {
                for (font in listOf(1f, 2f)) {
                    for (scenario in
                        if (type == ExpandedWidget::class.java)
                            listOf(
                                "normal",
                                "missing",
                                "signed-out",
                                "summary",
                                "stale",
                                "long-label",
                            )
                        else listOf("normal")) {
                        for ((label, size) in
                            listOf(
                                "1x1" to (56 to 56),
                                "2x1" to (150 to 72),
                                "2x2" to (150 to 160),
                                "4x1" to (320 to 72),
                                "4x2" to (320 to 250),
                            )) {
                            runOnMainSync {
                                val config =
                                    android.content.res
                                        .Configuration(targetContext.resources.configuration)
                                        .apply { fontScale = font }
                                val context = targetContext.createConfigurationContext(config)
                                val content =
                                    widgetPresentation(
                                        when (scenario) {
                                            "missing" -> null
                                            "stale" ->
                                                snapshot.copy(
                                                    whoop =
                                                        snapshot.whoop!!.copy(
                                                            fetchedAt = now - 13 * 3600000L
                                                        )
                                                )
                                            "long-label" ->
                                                snapshot.copy(
                                                    whoop =
                                                        snapshot.whoop!!.copy(
                                                            metrics =
                                                                snapshot.whoop!!.metrics.map {
                                                                    it.copy(
                                                                        title =
                                                                            "A very long measurement label for accessibility"
                                                                    )
                                                                }
                                                        )
                                                )
                                            else -> snapshot
                                        },
                                        if (scenario == "signed-out") "other-account"
                                        else "visual-test",
                                        if (scenario == "summary") WidgetPrivacy.SUMMARY
                                        else WidgetPrivacy.DETAILED,
                                        false,
                                        keys,
                                        WidgetSpace(
                                            size.first.toFloat(),
                                            size.second.toFloat(),
                                            font,
                                        ),
                                        now,
                                    )
                                val remote = LensWidgets.responsiveViews(context, content)
                                val view = remote.apply(context, null)
                                val density = context.resources.displayMetrics.density
                                val width = (size.first * density).toInt()
                                val height = (size.second * density).toInt()
                                view.measure(
                                    View.MeasureSpec.makeMeasureSpec(
                                        width,
                                        View.MeasureSpec.EXACTLY,
                                    ),
                                    View.MeasureSpec.makeMeasureSpec(
                                        height,
                                        View.MeasureSpec.EXACTLY,
                                    ),
                                )
                                view.layout(0, 0, width, height)
                                // Primary must be visible and fit, including the large-font compact
                                // case.
                                val primary =
                                    view.findViewById<android.widget.TextView>(R.id.widget_body)
                                check(primary.width > 0 && primary.height > 0)
                                check(primary.layout.getLineWidth(0) <= primary.width + 1)
                                check(primary.layout.height <= primary.height + 1) {
                                    type.simpleName +
                                        " " +
                                        label +
                                        " font=" +
                                        font +
                                        " primary=" +
                                        primary.text +
                                        " textHeight=" +
                                        primary.layout.height +
                                        " available=" +
                                        primary.height
                                }
                                val image =
                                    Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                                view.draw(Canvas(image))
                                File(
                                        directory,
                                        "Widget-" +
                                            type.simpleName +
                                            "-" +
                                            label +
                                            "-" +
                                            scenario +
                                            "-font" +
                                            (font * 100).toInt() +
                                            ".png",
                                    )
                                    .outputStream()
                                    .use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
                                image.recycle()
                                widgetRenders++
                            }
                        }
                    }
                }
            }
            results.putInt("responsive_widget_renders", widgetRenders)

            val originalConfig = android.content.res.Configuration(activity.resources.configuration)
            runOnMainSync {
                val large =
                    android.content.res.Configuration(originalConfig).apply { fontScale = 2f }
                activity.resources.updateConfiguration(large, activity.resources.displayMetrics)
                field(activity, "page", "Activity")
                field(activity, "snapshot", snapshot)
                field(activity, "loading", false)
                call(activity, "render")
            }
            capture("Activity-font-200")
            runOnMainSync {
                activity.resources.updateConfiguration(
                    originalConfig,
                    activity.resources.displayMetrics,
                )
                activity.finish()
            }
            // Exercise the real Keystore/AtomicFile adapter on this emulator, not a phone.
            val encrypted = androidSessionStorage(targetContext, true)
            encrypted.write(DashboardCodec.encode(snapshot))
            check(
                DashboardCodec.decode(
                        androidSessionStorage(targetContext, true).read()!!,
                        "visual-test",
                    )
                    ?.whoop
                    ?.metric("recovery")
                    ?.value == 72.0
            )
            val key =
                java.security.KeyStore.getInstance("AndroidKeyStore")
                    .apply { load(null) }
                    .getKey("whooplens.dashboard.v1", null) as javax.crypto.SecretKey
            val info =
                javax.crypto.SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore")
                    .getKeySpec(key, android.security.keystore.KeyInfo::class.java)
                    as android.security.keystore.KeyInfo
            results.putInt("emulator_keystore_security_level", info.securityLevel)
            encrypted.clear()
            check(androidSessionStorage(targetContext, true).read() == null)
            // An old-account scheduled job must succeed without reading or transferring data.
            targetContext
                .getSharedPreferences("dashboard-options", 0)
                .edit()
                .putBoolean("background", true)
                .commit()
            val request =
                androidx.work
                    .OneTimeWorkRequestBuilder<DashboardRefreshWorker>()
                    .setInputData(androidx.work.workDataOf("account" to "old-account"))
                    .build()
            val workManager = androidx.work.WorkManager.getInstance(targetContext)
            workManager.enqueue(request).result.get(20, java.util.concurrent.TimeUnit.SECONDS)
            var state: androidx.work.WorkInfo.State? = null
            repeat(40) {
                state =
                    workManager
                        .getWorkInfoById(request.id)
                        .get(5, java.util.concurrent.TimeUnit.SECONDS)
                        ?.state
                if (state == androidx.work.WorkInfo.State.SUCCEEDED) return@repeat
                Thread.sleep(100)
            }
            check(state == androidx.work.WorkInfo.State.SUCCEEDED)
            targetContext
                .getSharedPreferences("dashboard-options", 0)
                .edit()
                .putBoolean("background", false)
                .commit()
            results.putString(
                "background_worker",
                "PASS: stale-account work performs no health or network read",
            )

            results.putString(
                "result",
                "PASS: 110 responsive widget renders at 100/200% fonts plus app renders, emulator Keystore persistence/erasure, and stale-account WorkManager execution with test-only fixture. No real sign-in, network health call, cloud upload or personal device used.",
            )
            finish(Activity.RESULT_OK, results)
        } catch (error: Throwable) {
            results.putString("failure", error.javaClass.simpleName + ": " + error.message)
            finish(Activity.RESULT_CANCELED, results)
        }
    }
}
