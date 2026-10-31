package io.github.astrasler.whooplens

import android.app.Activity
import android.app.Instrumentation
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.view.MotionEvent
import android.view.View
import android.widget.TextView
import androidx.core.graphics.ColorUtils
import java.io.File

/** Synthetic component renders only; never signs in or reads health data. */
class GlassyAcceptanceInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    private fun onUi(block: () -> Unit) {
        var failure: Throwable? = null
        runOnMainSync { try { block() } catch (error: Throwable) { failure=error } }
        failure?.let { throw it }
    }
    // Tile long detail/settings pages rather than allocating two full-page bitmaps.
    // Every scroll region is still captured and compared, with bounded memory use.
    private fun captureTiles(content: View, directory: File, name: String, compare: Boolean) {
        for (top in 0 until content.height step 3072) {
            val height=minOf(3072,content.height-top)
            fun image(): Bitmap {
                val bitmap=Bitmap.createBitmap(content.width,height,Bitmap.Config.ARGB_8888)
                val canvas=Canvas(bitmap);canvas.drawColor(LensColors.background);canvas.translate(0f,-top.toFloat());content.draw(canvas)
                return bitmap
            }
            val first=image()
            if (compare) { val second=image();check(first.sameAs(second)) { "$name has unstable repeated rendering at $top" };second.recycle() }
            File(directory,"$name-part${top/3072}.png").outputStream().use { first.compress(Bitmap.CompressFormat.PNG,100,it) }
            first.recycle()
        }
    }
    override fun onStart() {
        val result = Bundle()
        try {
            var renders = 0
            val directory = File(targetContext.getExternalFilesDir(null), "glassy-acceptance").apply { mkdirs() }
            for (width in listOf(360, 412, 480)) for (font in listOf(1f, 2f))
                for (choice in listOf(AppearanceChoice.GLASS, AppearanceChoice.REDUCED_TRANSPARENCY, AppearanceChoice.BATTERY_SAVER)) {
                    onUi {
                        val config = Configuration(targetContext.resources.configuration).apply {
                            fontScale = font; screenWidthDp = width
                        }
                        val context = targetContext.createConfigurationContext(config)
                        val ui = LensUi(context)
                        ui.appearance = resolveAppearance(AppearanceInputs(choice, false, true, 0f))
                        val root = ui.column(18)
                        var opened = 0
                        val button = ui.button(root, "Open recovery measurements", primary = true) { opened++ }
                        val tiles = mutableListOf<View>()
                        ui.pair(root, { parent ->
                            tiles += ui.statsCard(parent, "HRV", "64 ms", "♥", "↑ 10% vs baseline", DataSource.WHOOP) { opened++ }
                        }, { parent ->
                            tiles += ui.statsCard(parent, "Resting HR", "52 bpm", "◉", null, DataSource.WHOOP) { opened++ }
                        })
                        val pixels = ui.dp(width)
                        root.measure(View.MeasureSpec.makeMeasureSpec(pixels, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
                        root.layout(0, 0, pixels, root.measuredHeight)
                        check(button.height >= ui.dp(48))
                        button.performClick()
                        for (tile in tiles) {
                            check(tile.height >= ui.dp(48) && tile.isFocusable)
                            check(tile.createAccessibilityNodeInfo().className == "android.widget.Button")
                            tile.performClick()
                            val event = MotionEvent.obtain(0, 0, MotionEvent.ACTION_DOWN, 1f, 1f, 0)
                            tile.dispatchTouchEvent(event); event.recycle()
                            check(tile.translationY == 0f) // Remove animations is active in every render.
                        }
                        check(opened == 3)
                        fun checkText(view: View) {
                            if (view is TextView) {
                                val layout = view.layout
                                check(layout != null && layout.height <= view.height - view.paddingTop - view.paddingBottom)
                                for (line in 0 until layout.lineCount) check(layout.getLineWidth(line) <= layout.width + 1)
                            }
                            if (view is android.view.ViewGroup) for (i in 0 until view.childCount) checkText(view.getChildAt(i))
                        }
                        checkText(root)
                        // Worst primary gradient stop and secondary opaque backing.
                        check(ColorUtils.calculateContrast(LensColors.onTeal, android.graphics.Color.rgb(61,188,184)) >= 4.5)
                        check(ColorUtils.calculateContrast(LensColors.teal, android.graphics.Color.rgb(70,90,103)) >= 4.5)
                        val bitmap = Bitmap.createBitmap(pixels, root.height, Bitmap.Config.ARGB_8888)
                        val canvas = Canvas(bitmap); canvas.drawColor(LensColors.background); root.draw(canvas)
                        File(directory, "${width}dp-${(font*100).toInt()}-${choice.name}.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                        bitmap.recycle(); renders++
                    }
                }
            val activity = startActivitySync(android.content.Intent(targetContext, MainActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
            waitForIdleSync()
            Thread.sleep(600)
            waitForIdleSync()
            val original = Configuration(activity.resources.configuration)
            fun field(name: String) = activity.javaClass.getDeclaredField(name).apply { isAccessible = true }
            fun render() = activity.javaClass.getDeclaredMethod("render").apply { isAccessible = true }.invoke(activity)
            fun find(view: View, predicate: (View) -> Boolean): View? {
                if (predicate(view)) return view
                if (view is android.view.ViewGroup) for (i in 0 until view.childCount) {
                    val child = find(view.getChildAt(i), predicate)
                    if (child != null) return child
                }
                return null
            }
            for (font in listOf(1f, 2f)) {
                onUi {
                    activity.resources.updateConfiguration(Configuration(original).apply { fontScale = font }, activity.resources.displayMetrics)
                    field("account").set(activity, "visual-test")
                    field("snapshot").set(activity, null)
                    field("lifeSchedule").set(activity, LifeSchedulePreference("visual-test", LifeSchedule.FLEXIBLE, true))
                    field("page").set(activity, "Home")
                    field("detail").set(activity, null)
                    render()
                }
                waitForIdleSync()
                onUi {
                    val hrv = find(activity.window.decorView) { it.contentDescription?.startsWith("HRV,") == true }
                    check(hrv != null && hrv.performClick())
                    check(field("detail").get(activity) == "hrv")
                    field("detail").set(activity, null); render()
                }
                waitForIdleSync()
                onUi {
                    val recovery = find(activity.window.decorView) { it is TextView && it.text.toString() == "Open recovery measurements" }
                    check(recovery != null && recovery.performClick())
                    check(field("detail").get(activity) == "recovery")
                    field("detail").set(activity, null); render()
                    activity.javaClass.getDeclaredMethod("showDrawer").apply { isAccessible = true }.invoke(activity)
                }
                waitForIdleSync()
                onUi {
                    val navigation = find(activity.window.decorView) { it.contentDescription?.toString() == "Account & Settings, open page" }
                    check(navigation != null && navigation.performClick())
                    check(field("page").get(activity) == "Account & Settings")
                }
                waitForIdleSync()
                onUi {
                    val frame = field("frame").get(activity) as android.widget.FrameLayout
                    val scroll = frame.getChildAt(0) as android.widget.ScrollView
                    val content = scroll.getChildAt(0)
                    content.measure(View.MeasureSpec.makeMeasureSpec(frame.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
                    content.layout(0, 0, frame.width, content.measuredHeight)
                    captureTiles(content,directory,"Settings-${(font*100).toInt()}",false)

                }
            }
            // Application-wide fixture: deliberately clustered HR timestamps reproduce #112.
            val now = System.currentTimeMillis()
            val whoop = DataBatch(DataSource.WHOOP, now, listOf(
                Metric("recovery", "Recovery", 72.0, "%", DataSource.WHOOP, now),
                Metric("hrv", "HRV", 64.0, "ms", DataSource.WHOOP, now),
                Metric("rhr", "Resting HR", 52.0, "bpm", DataSource.WHOOP, now),
                Metric("sleep", "Sleep", 420.0, "min", DataSource.WHOOP, now),
                Metric("strain", "Strain", 11.0, "/21", DataSource.WHOOP, now)
            ), mapOf("sleep" to (0..29).map { Point(now-it*86400000L,420.0) }, "recovery" to (0..29).map { Point(now-it*86400000L,72.0) }),
                listOf(SleepDetail(now-8*3600000L,now,"WHOOP",emptyList(),420.0)))
            val heart = (0..20).map { Point(now-23*3600000L+it*1000,60.0+it,"com.example.synthetic") } + Point(now,80.0,"com.example.synthetic")
            val health = DataBatch(DataSource.HEALTH_CONNECT,now,listOf(Metric("steps","Steps",5000.0,"steps",DataSource.HEALTH_CONNECT,now)),
                mapOf("heart" to heart,"steps" to listOf(Point(now-3600000,5000.0))),
                listOf(SleepDetail(now-8*3600000L,now,"com.example.synthetic",listOf(SleepStage(now-7*3600000L,now-3600000L,"Light")),360.0)),
                listOf(ExerciseDetail(now-3600000L,now-1800000L,"Synthetic walk","com.example.synthetic")))
            var screenRenders = 0
            for (font in listOf(1f,2f)) {
                for ((screen, metric) in listOf("Home" to null,"Activity" to null,"Sleep" to null,"Vitals" to null,
                    "Health Connect" to null,"Account & Settings" to null,"Sources & freshness" to null,"Arrange Home" to null,
                    "Direct BLE" to null,"Open Source Licenses & Credits" to null,"Home" to "recovery","Vitals" to "heart","Sleep" to "sleep","Vitals" to "hrv")) {
                    onUi {
                        activity.resources.updateConfiguration(Configuration(original).apply { fontScale=font },activity.resources.displayMetrics)
                        field("account").set(activity,"visual-test")
                        field("snapshot").set(activity,DashboardSnapshot("visual-test",whoop,health))
                        field("granted").set(activity,healthCategories.map { it.permission }.toSet())
                        field("page").set(activity,screen)
                        field("detail").set(activity,metric)
                        field("detailSource").set(activity,if (metric=="heart") DataSource.HEALTH_CONNECT else DataSource.WHOOP)
                        field("cloudStatus").set(activity,CloudSyncStatus("visual-test",true,"ready",4,now,true))
                        field("lifeSchedule").set(activity,LifeSchedulePreference("visual-test",LifeSchedule.FLEXIBLE,true))
                        field("message").set(activity,"SYNTHETIC TEST DATA · NOT A PHYSICAL DEVICE")
                        render()
                    }
                    waitForIdleSync()
                    onUi {
                        val frame=field("frame").get(activity) as android.widget.FrameLayout
                        val content=(frame.getChildAt(0) as android.widget.ScrollView).getChildAt(0)
                        content.measure(View.MeasureSpec.makeMeasureSpec(frame.width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(0,View.MeasureSpec.UNSPECIFIED))
                        content.layout(0,0,frame.width,content.measuredHeight)
                        fun inspect(view: View) {
                            if (view is TextView && view.visibility==View.VISIBLE && view.width>0) {
                                val layout=view.layout
                                check(layout!=null && layout.height<=view.height-view.paddingTop-view.paddingBottom+1) { "$screen clipped height: ${view.text}" }
                                for (line in 0 until layout.lineCount) check(layout.getLineWidth(line)<=layout.width+1) { "$screen clipped width: ${view.text}" }
                            }
                            if (view is android.view.ViewGroup) for (i in 0 until view.childCount) inspect(view.getChildAt(i))
                        }
                        inspect(content)
                        val name=(screen+"-"+(metric?:"screen")).replace(" ","-").replace("&", "and")
                        captureTiles(content,directory,"App-$name-${(font*100).toInt()}",true)
                        fun charts(view: View) {
                            if (view is TrendChart) {
                                view.axisLabels.zipWithNext().forEach { (a,b) -> check(a.left+a.width < b.left) }
                                view.axisLabels.forEach { check(it.left>=0 && it.left+it.width<=view.width) }
                            }
                            if (view is android.view.ViewGroup) for (i in 0 until view.childCount) charts(view.getChildAt(i))
                        }
                        charts(content)
                        screenRenders++
                    }
                }
            }
            onUi { activity.resources.updateConfiguration(original, activity.resources.displayMetrics); activity.finish() }

            result.putString("result", "PASS: $renders synthetic width/font/appearance renders; independent clicks, text fit, contrast, touch targets, accessibility roles and remove-animations. $screenRenders application/detail renders with text bounds, chart label bounds and stable screenshot comparisons; actual Home HRV/recovery navigation and drawer-to-settings at both fonts on a 1440x3120 emulator. Not Samsung hardware approval.")
            finish(Activity.RESULT_OK, result)
        } catch (error: Throwable) {
            result.putString("failure", error.toString()); finish(Activity.RESULT_CANCELED, result)
        }
    }
}
