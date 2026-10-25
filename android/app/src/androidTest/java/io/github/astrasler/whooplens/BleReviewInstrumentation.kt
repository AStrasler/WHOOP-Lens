package io.github.astrasler.whooplens

import android.app.Instrumentation
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File

/** Synthetic/native-render and Keystore checks in the separate test APK, never the companion. */
class BleReviewInstrumentation : Instrumentation() {
    private var phase: String? = null

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        phase = arguments?.getString("phase")
        start()
    }

    override fun onStart() {
        val result = Bundle()
        try {
            val storage = androidBleStorage(targetContext)
            val cache = BleCache(storage)
            if (phase == "read") {
                check(cache.read("instrumentation-A")?.measurement?.bpm == 64)
                check(File(targetContext.filesDir, "ble-upgrade-sentinel").exists())
                cache.clear()
                result.putString(
                    "result",
                    "PASS: encrypted BLE snapshot survived a real instrumentation process restart; existing in-place-update file retained.",
                )
                finish(android.app.Activity.RESULT_OK, result)
                return
            }
            cache.clear()
            val packet = byteArrayOf(0x16, 64, 0, 4)
            val sample =
                BleSample(
                    "instrumentation-A",
                    "WHOOP synthetic",
                    "Unverified fixture",
                    1800000000000,
                    1000,
                    HeartRateMeasurement.decode(packet)!!,
                )
            cache.write(sample, packet)
            if (phase == "write") {
                result.putString(
                    "result",
                    "PASS: encrypted BLE snapshot persisted for next process.",
                )
                finish(android.app.Activity.RESULT_OK, result)
                return
            }
            check(
                BleCache(androidBleStorage(targetContext))
                    .read("instrumentation-A")!!
                    .measurement
                    .bpm == 64
            )
            val disk =
                File(targetContext.noBackupFilesDir, "direct-ble.bin")
                    .readBytes()
                    .toString(Charsets.UTF_8)
            check(!disk.contains("instrumentation-A") && !disk.contains(BLE_SOURCE))
            check(cache.read("instrumentation-B") == null)
            check(!File(targetContext.noBackupFilesDir, "direct-ble.bin").exists())
            val dir = File(targetContext.cacheDir, "ble-review").apply { mkdirs() }
            var count = 0
            var uiFailure: Throwable? = null
            runOnMainSync {
                try {
                    listOf(1f, 2f).forEach { scale ->
                        val config =
                            android.content.res
                                .Configuration(targetContext.resources.configuration)
                                .apply { fontScale = scale }
                        val ui = LensUi(targetContext.createConfigurationContext(config))
                        listOf(
                                BlePhase.IDLE,
                                BlePhase.SCANNING,
                                BlePhase.LIVE,
                                BlePhase.UNSUPPORTED,
                                BlePhase.STOPPED,
                            )
                            .forEach { phase ->
                                val root =
                                    ui.column(16).apply {
                                        setBackgroundColor(LensColors.background)
                                    }
                                var scanned = false
                                var stopped = false
                                var selected = ""
                                val candidate =
                                    BleCandidate(
                                        "test-device",
                                        "WHOOP synthetic",
                                        "4.0 family, unverified",
                                    )
                                renderBleScreen(
                                    ui,
                                    root,
                                    BleViewState(
                                        phase,
                                        "Synthetic fixture · not physical WHOOP evidence",
                                        listOf(candidate),
                                        candidate,
                                        if (phase == BlePhase.LIVE || phase == BlePhase.STOPPED)
                                            sample
                                        else null,
                                    ),
                                    1100,
                                    { scanned = true },
                                    { selected = it },
                                    { stopped = true },
                                )
                                fun texts(v: View): List<TextView> =
                                    if (v is TextView) listOf(v)
                                    else if (v is LinearLayout)
                                        (0 until v.childCount).flatMap { texts(v.getChildAt(it)) }
                                    else emptyList()
                                val buttons = texts(root)
                                check(
                                    buttons.any {
                                        it.text.toString().contains(BLE_SOURCE, ignoreCase = true)
                                    }
                                )
                                if (phase == BlePhase.IDLE) {
                                    buttons
                                        .first { it.text == "Scan for WHOOP devices" }
                                        .performClick()
                                    check(scanned)
                                    buttons
                                        .first { it.text.toString().startsWith("Connect to") }
                                        .performClick()
                                    check(selected == candidate.id)
                                }
                                if (phase == BlePhase.LIVE) {
                                    buttons.first { it.text == "Stop / disconnect" }.performClick()
                                    check(stopped)
                                }
                                root.measure(
                                    View.MeasureSpec.makeMeasureSpec(
                                        1080,
                                        View.MeasureSpec.EXACTLY,
                                    ),
                                    View.MeasureSpec.makeMeasureSpec(
                                        0,
                                        View.MeasureSpec.UNSPECIFIED,
                                    ),
                                )
                                root.layout(0, 0, 1080, root.measuredHeight)
                                val bitmap =
                                    Bitmap.createBitmap(
                                        1080,
                                        root.measuredHeight,
                                        Bitmap.Config.ARGB_8888,
                                    )
                                root.draw(Canvas(bitmap))
                                File(dir, "${phase.name}-${scale}.png").outputStream().use {
                                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
                                }
                                bitmap.recycle()
                                count++
                            }
                        val root = ui.column()
                        renderOpenSourceCredits(ui, root)
                        check(root.childCount >= 6)
                        val host = android.widget.FrameLayout(ui.context)
                        val viewport = android.widget.ScrollView(ui.context)
                        val content = ui.column(16)
                        viewport.addView(content)
                        host.addView(viewport, android.widget.FrameLayout.LayoutParams(-1, -1))
                        val live = BleViewState(phase = BlePhase.LIVE, sample = sample)
                        val binding = renderBleScreen(ui, content, live, 1100, {}, {}, {})
                        host.measure(
                            View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
                            View.MeasureSpec.makeMeasureSpec(900, View.MeasureSpec.EXACTLY),
                        )
                        host.layout(0, 0, 1080, 900)
                        val stop = content.findViewWithTag<View>("ble-stop")
                        stop.isFocusableInTouchMode = true
                        check(stop.requestFocus())
                        viewport.scrollTo(0, 300)
                        val position = viewport.scrollY
                        check(position > 0)
                        val drawer = ui.text("Navigation drawer overlay")
                        host.addView(drawer)
                        binding.update(
                            live.copy(
                                sample =
                                    sample.copy(measurement = sample.measurement.copy(bpm = 65))
                            ),
                            1500,
                        )
                        binding.update(live, 20000) // freshness tick without a packet
                        host.measure(
                            View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
                            View.MeasureSpec.makeMeasureSpec(900, View.MeasureSpec.EXACTLY),
                        )
                        host.layout(0, 0, 1080, 900)
                        check(host.childCount == 2 && drawer.parent === host)
                        check(content.findViewWithTag<View>("ble-stop") === stop && stop.isFocused)
                        check(viewport.scrollY == position)
                    }
                } catch (e: Throwable) {
                    uiFailure = e
                }
            }
            uiFailure?.let { throw it }
            check(count == 10)
            cache.clear()
            result.putString(
                "result",
                "PASS: 10 native BLE fixtures, 100%/200% fonts, UI controls, retained drawer/scroll/focus during packet/freshness updates, offline credits, real Android Keystore ciphertext/restart/isolation/erasure. No RF or physical WHOOP validation.",
            )
            finish(android.app.Activity.RESULT_OK, result)
        } catch (e: Throwable) {
            result.putString("failure", e.javaClass.simpleName + ": " + e.message)
            finish(android.app.Activity.RESULT_CANCELED, result)
        }
    }
}
