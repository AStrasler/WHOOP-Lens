package io.github.astrasler.whooplens

import android.text.util.Linkify
import android.widget.LinearLayout

internal fun renderOpenSourceCredits(ui: LensUi, root: LinearLayout) {
    ui.card(root) { card ->
        ui.heading(card, "Incorporated components")
        ui.add(
            card,
            ui.text(
                "WHOOP Lens adapts the standard heart-rate parser from whoop4-ble, developed by Andy Guzman and contributors, under the MIT License. Modified for Kotlin, strict validation, contact/energy fields and original R-R units. No upstream Bluetooth runtime or custom-protocol decoder is imported."
            ),
        )
        ui.add(
            card,
            ui.text(
                    "Original: https://github.com/andyguzmaneth/whoop4-ble\nRevision: a76ad4576bda9ec76cc6347ff9ad18fbcad1cd88\nSource: src/whoop4/reader.py::parse_hr_measurement"
                )
                .apply { Linkify.addLinks(this, Linkify.WEB_URLS) },
        )
    }
    ui.card(root) { card ->
        ui.heading(card, "Research references")
        ui.add(
            card,
            ui.text(
                "NOOP (muftiarfan / NoopApp), Wearable (Johnathan Middleton) and Goose (b-nnett / bennett) informed transport, framing and verification boundaries. No code from these three is incorporated. whoop4-ble also informed 4.0 evidence limits. Their maintainers do not endorse or maintain WHOOP Lens."
            ),
        )
        ui.add(
            card,
            ui.text(
                    "https://github.com/muftiarfan/noop\nhttps://github.com/johnmiddleton12/wearable\nhttps://github.com/b-nnett/goose\nhttps://github.com/andyguzmaneth/whoop4-ble"
                )
                .apply { Linkify.addLinks(this, Linkify.WEB_URLS) },
        )
    }
    fun showAsset(title: String, path: String) {
        val body = try { ui.context.assets.open(path).bufferedReader().use { it.readText() } }
            catch (_: Exception) { "License asset unavailable. See THIRD_PARTY_NOTICES.md in the repository." }
        val scroll = android.widget.ScrollView(ui.context)
        scroll.addView(ui.text(body, 12f, LensColors.muted).apply { setPadding(ui.dp(16),ui.dp(12),ui.dp(16),ui.dp(12)); setTextIsSelectable(true) })
        android.app.AlertDialog.Builder(ui.context).setTitle(title).setView(scroll).setPositiveButton("Done",null).show()
    }
    ui.card(root) { card ->
        ui.heading(card, "License texts")
        listOf(
            "whoop4-ble MIT" to "licenses/whoop4-ble-MIT.txt",
            "AndroidX / Kotlin · Apache" to "licenses/Apache-2.0.txt",
            "Checker Framework · MIT" to "licenses/checker-qual-MIT.txt",
            "Health Connect protobuf · BSD" to "licenses/health-connect-protobuf-BSD.txt",
            "Inter font" to "INTER-OFL.txt",
            "JetBrains Mono font" to "JETBRAINS-MONO-OFL.txt",
            "Covered By Your Grace font" to "COVERED-BY-YOUR-GRACE-OFL.txt",
            "Resolved dependency inventory" to "licenses/dependencies.json",
        ).forEach { (title,path) -> ui.button(card,title) { showAsset(title,path) } }
    }
}
