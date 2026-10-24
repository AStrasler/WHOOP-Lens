package io.github.astrasler.whooplens

import android.widget.LinearLayout
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

internal fun renderBleScreen(
    ui: LensUi,
    root: LinearLayout,
    state: BleViewState,
    now: Long,
    scan: () -> Unit,
    select: (String) -> Unit,
    stop: () -> Unit,
) {
    ui.card(root) { card ->
        ui.heading(card, "WHOOP Direct BLE · experimental")
        ui.add(
            card,
            ui.text("Foreground only · local encrypted readings · no uploads", 12f, LensColors.teal),
        )
        ui.add(
            card,
            ui.text(
                "${state.phase.name.lowercase().replaceFirstChar { it.uppercase() }} · ${state.message}"
            ),
        )
        ui.add(
            card,
            ui.text(
                "Select your own strap. Detection does not establish model support or ownership. Standard heart-rate broadcast must be exposed by the strap.",
                12f,
                LensColors.muted,
            ),
        )
        ui.button(
            card,
            "Scan for WHOOP devices",
            true,
            state.phase !in
                setOf(BlePhase.SCANNING, BlePhase.CONNECTING, BlePhase.RETRYING, BlePhase.LIVE),
            scan,
        )
        ui.button(
            card,
            "Stop / disconnect",
            enabled =
                state.phase in
                    setOf(BlePhase.SCANNING, BlePhase.CONNECTING, BlePhase.RETRYING, BlePhase.LIVE),
            action = stop,
        )
    }
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
        state.candidates.forEachIndexed { index, candidate ->
            ui.card(root) { card ->
                ui.heading(card, "Candidate ${index + 1} · ${candidate.name}")
                ui.add(card, ui.text(candidate.family, 12f, LensColors.muted))
                ui.add(
                    card,
                    ui.text(
                        "Address ending ${candidate.id.takeLast(5)} · not proof of identity",
                        12f,
                        LensColors.muted,
                    ),
                )
                ui.button(card, "Connect to ${candidate.name}") { select(candidate.id) }
            }
        }
    ui.card(root) { card ->
        ui.heading(card, "Direct BLE heart rate")
        val sample = state.sample
        val fresh =
            state.phase == BlePhase.LIVE &&
                sample != null &&
                now >= sample.receivedElapsed &&
                sample.receivedElapsed > 0 &&
                now - sample.receivedElapsed <= 15000
        ui.add(
            card,
            ui.text(
                if (sample == null) "No measurement" else "${sample.measurement.bpm} bpm",
                32f,
                LensColors.teal,
                true,
                true,
            ),
        )
        ui.add(
            card,
            ui.text(
                if (fresh) "Live · received within 15 seconds"
                else "Saved / stale · not a current measurement",
                12f,
                if (fresh) LensColors.teal else LensColors.amber,
            ),
        )
        sample?.let {
            ui.add(
                card,
                ui.text("${it.source} · ${it.deviceName}\n${it.family}", 12f, LensColors.muted),
            )
            val time =
                DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss z")
                    .withZone(ZoneId.systemDefault())
                    .format(Instant.ofEpochMilli(it.receivedAt))
            ui.add(card, ui.text("Received on this phone: $time", 12f, LensColors.muted))
            ui.add(
                card,
                ui.text(
                    "Sensor contact: ${when (it.measurement.contact) { true -> "detected"
 false -> "not detected"
 null -> "not supplied" }}"
                ),
            )
            ui.add(
                card,
                ui.text(
                    if (it.measurement.rrTicks.isEmpty()) "R-R intervals: not supplied"
                    else
                        "R-R (1/1024 s ticks): ${it.measurement.rrTicks.joinToString()}\nR-R (ms): ${it.measurement.rrMilliseconds.joinToString { n -> java.text.DecimalFormat("0.0").format(n) }}",
                    12f,
                ),
            )
            ui.add(
                card,
                ui.text(
                    "Energy: ${it.measurement.energyKj?.let { n -> "$n kJ (device counter)" } ?: "not supplied"}",
                    12f,
                ),
            )
        }
        if (state.details.isNotBlank()) ui.add(card, ui.text(state.details, 12f, LensColors.muted))
        ui.add(
            card,
            ui.text(
                "Direct observations stay separate from official WHOOP and Health Connect. No recovery, HRV, strain, sleep-stage or medical claims. Leaving this section or locking/backgrounding the app stops BLE.",
                12f,
                LensColors.muted,
            ),
        )
    }
}
