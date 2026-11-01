package io.github.astrasler.whooplens

import android.graphics.Color
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Retained views keep the drawer, scroll, keyboard and accessibility focus stable on live ticks.
 */
internal class BleScreenBinding(
    private val ui: LensUi,
    root: LinearLayout,
    scan: () -> Unit,
    private val select: (String) -> Unit,
    stop: () -> Unit,
) {
    private lateinit var status: TextView
    private lateinit var scanButton: TextView
    private lateinit var stopButton: TextView
    private val candidates = ui.column()
    private var shownCandidates = emptyList<BleCandidate>()
    private lateinit var heartRate: TextView
    private lateinit var freshness: TextView
    private lateinit var source: TextView
    private lateinit var received: TextView
    private lateinit var contact: TextView
    private lateinit var rr: TextView
    private lateinit var energy: TextView
    private lateinit var details: TextView
    private var detailsExpanded = false
    private val timestamp =
        DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss z").withZone(ZoneId.systemDefault())

    init {
        ui.card(root, dashed = true, edgeColor = LensColors.error) { card ->
            ui.heading(card, "WHOOP Direct BLE · experimental")
            text(
                card,
                "Foreground only · local encrypted readings · no uploads",
                color = LensColors.teal,
            )
            status = text(card, "", size = 14f)
            text(
                card,
                "Select your own strap. Detection does not establish model support or ownership. Standard heart-rate broadcast must be exposed by the strap.",
            )
            scanButton =
                ui.button(card, "Scan for WHOOP devices", true, action = scan).apply {
                    tag = "ble-scan"
                }
            stopButton =
                ui.button(card, "Stop / disconnect", action = stop).apply { tag = "ble-stop" }
        }
        ui.add(root, candidates, 0)
        ui.card(root, dashed = true, edgeColor = LensColors.error) { card ->
            ui.heading(card, "Direct BLE heart rate")
            heartRate =
                ui.text("No measurement", 32f, LensColors.teal, true, true).also {
                    ui.add(card, it)
                }
            freshness = text(card, "")
            source = text(card, "")
            received = text(card, "")
            contact = text(card, "", size = 14f, color = LensColors.text)
            rr = text(card, "", color = LensColors.text)
            energy = text(card, "", color = LensColors.text)
            details = text(card, "").apply { visibility = View.GONE }
            ui.button(card, "Connection details") {
                detailsExpanded = !detailsExpanded
                details.visibility = if (detailsExpanded && details.text.isNotBlank()) View.VISIBLE else View.GONE
            }
            text(
                card,
                "Direct observations stay separate from official WHOOP and Health Connect. No recovery, HRV, strain, sleep-stage or medical claims. Leaving this section or locking/backgrounding the app stops BLE.",
            )
        }
    }

    private fun text(
        parent: LinearLayout,
        value: String,
        size: Float = 12f,
        color: Int = LensColors.muted,
    ) = ui.text(value, size, color).also { ui.add(parent, it) }

    private fun TextView.show(value: String, visible: Boolean = true) {
        if (text.toString() != value) text = value
        visibility = if (visible) View.VISIBLE else View.GONE
    }

    fun update(state: BleViewState, now: Long) {
        status.show(
            "${state.phase.name.lowercase().replaceFirstChar { it.uppercase() }} · ${state.message}"
        )
        val active =
            state.phase in
                setOf(BlePhase.SCANNING, BlePhase.CONNECTING, BlePhase.RETRYING, BlePhase.LIVE)
        scanButton.isEnabled = !active
        scanButton.setTextColor(if (active) LensColors.muted else Color.rgb(5, 32, 35))
        stopButton.isEnabled = active
        stopButton.setTextColor(if (active) LensColors.teal else LensColors.muted)
        val list =
            if (
                state.phase in
                    setOf(
                        BlePhase.SCANNING,
                        BlePhase.IDLE,
                        BlePhase.STOPPED,
                        BlePhase.UNSUPPORTED,
                        BlePhase.ERROR,
                    )
            )
                state.candidates
            else emptyList()
        // Candidate controls only change when discovery/selection actually changes, never per
        // packet.
        if (list != shownCandidates) {
            shownCandidates = list
            candidates.removeAllViews()
            list.forEachIndexed { index, candidate ->
                ui.card(candidates, dashed = true, edgeColor = LensColors.error) { card ->
                    ui.heading(card, "Candidate ${index + 1} · ${candidate.name}")
                    text(card, candidate.family)
                    text(card, "Address ending ${candidate.id.takeLast(5)} · not proof of identity")
                    ui.button(card, "Connect to ${candidate.name}") { select(candidate.id) }.tag =
                        "ble-device-${candidate.id}"
                }
            }
        }
        val sample = state.sample
        val fresh =
            state.phase == BlePhase.LIVE &&
                sample != null &&
                sample.receivedElapsed > 0 &&
                now >= sample.receivedElapsed &&
                now - sample.receivedElapsed <= 15000
        heartRate.show(if (sample == null) "No measurement" else "${sample.measurement.bpm} bpm")
        freshness.show(
            if (fresh) "Live · received within 15 seconds"
            else "Saved / stale · not a current measurement"
        )
        freshness.setTextColor(if (fresh) LensColors.teal else LensColors.amber)
        source.show(
            sample?.let { "${it.source} · ${it.deviceName}\n${it.family}" }.orEmpty(),
            sample != null,
        )
        received.show(
            sample
                ?.let {
                    "Received on this phone: ${timestamp.format(Instant.ofEpochMilli(it.receivedAt))}"
                }
                .orEmpty(),
            sample != null,
        )
        contact.show(
            "Sensor contact: ${when (sample?.measurement?.contact) { true -> "detected"
 false -> "not detected"
 null -> "not supplied" }}",
            sample != null,
        )
        rr.show(
            sample
                ?.measurement
                ?.let { m ->
                    if (m.rrTicks.isEmpty()) "R-R intervals: not supplied"
                    else
                        "R-R (ms): ${m.rrMilliseconds.joinToString { java.text.DecimalFormat("0.0").format(it) }}"
                }
                .orEmpty(),
            sample != null,
        )
        energy.show(
            "Energy: ${sample?.measurement?.energyKj?.let { "$it kJ (device counter)" } ?: "not supplied"}",
            sample != null,
        )
        details.show(state.details, detailsExpanded && state.details.isNotBlank())
    }
}

internal fun renderBleScreen(
    ui: LensUi,
    root: LinearLayout,
    state: BleViewState,
    now: Long,
    scan: () -> Unit,
    select: (String) -> Unit,
    stop: () -> Unit,
): BleScreenBinding = BleScreenBinding(ui, root, scan, select, stop).also { it.update(state, now) }
