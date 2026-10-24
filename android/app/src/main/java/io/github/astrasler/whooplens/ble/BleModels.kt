package io.github.astrasler.whooplens

internal const val BLE_SOURCE = "WHOOP Direct BLE"
internal const val WHOOP4_SERVICE = "61080001-8d6d-82b8-614a-1c8cb0f8dcc6"
internal const val WHOOP5_SERVICE = "fd4b0001-cce1-4033-93ce-002d5875f58a"
internal const val HR_SERVICE = "0000180d-0000-1000-8000-00805f9b34fb"
internal const val HR_CHARACTERISTIC = "00002a37-0000-1000-8000-00805f9b34fb"
internal const val HR_CCCD = "00002902-0000-1000-8000-00805f9b34fb"

internal data class BleCandidate(val id: String, val name: String, val family: String) {
    companion object {
        fun identify(id: String, name: String?, services: Set<String>): BleCandidate? {
            val clean = name.orEmpty().filter { !it.isISOControl() }.take(40)
            val uuids = services.map { it.lowercase() }.toSet()
            val family =
                when {
                    WHOOP4_SERVICE in uuids -> "4.0 service family (model unverified)"
                    WHOOP5_SERVICE in uuids -> "5.0 / MG service family (model unverified)"
                    clean.uppercase().startsWith("WHOOP") -> "Unknown generation; name match only"
                    else -> return null
                }
            return BleCandidate(id, clean.ifBlank { "WHOOP candidate" }, family)
        }
    }
}

internal data class BleHeartRate(
    val bpm: Int,
    val contact: Boolean?,
    val energyKj: Int?,
    val rrTicks: List<Int>,
) {
    val rrMilliseconds: List<Double>
        get() = rrTicks.map { it * 1000.0 / 1024.0 }
}

/**
 * Adapted from Andy Guzman's whoop4-ble reader.py::parse_hr_measurement, MIT. Upstream
 * a76ad4576bda9ec76cc6347ff9ad18fbcad1cd88. Copyright (c) 2026 Andy Guzman. Kotlin adaptation:
 * strict bounds/flags, contact/energy, retain original R-R ticks, no I/O. Full notice:
 * assets/licenses/whoop4-ble-MIT.txt and THIRD_PARTY_NOTICES.md.
 */
internal object HeartRateMeasurement {
    fun decode(bytes: ByteArray): BleHeartRate? {
        if (bytes.size !in 2..512) return null
        var offset = 1
        fun u8() = bytes[offset++].toInt() and 255
        fun u16(): Int {
            val low = u8()
            return low or (u8() shl 8)
        }
        val flags = bytes[0].toInt() and 255
        if (flags and 0xe0 != 0 || (flags and 2 != 0 && flags and 4 == 0)) return null
        return try {
            val bpm = if (flags and 1 != 0) u16() else u8()
            val contact = if (flags and 4 != 0) flags and 2 != 0 else null
            val energy = if (flags and 8 != 0) u16() else null
            val rr = mutableListOf<Int>()
            if (flags and 16 != 0) {
                if (offset == bytes.size || (bytes.size - offset) % 2 != 0) return null
                while (offset < bytes.size) rr.add(u16())
            }
            if (offset != bytes.size || bpm == 0 || rr.any { it == 0 }) null
            else BleHeartRate(bpm, contact, energy, rr.toList())
        } catch (_: IndexOutOfBoundsException) {
            null
        }
    }
}

internal data class BleSample(
    val account: String,
    val deviceName: String,
    val family: String,
    val receivedAt: Long,
    val receivedElapsed: Long,
    val measurement: BleHeartRate,
    val source: String = BLE_SOURCE,
)

internal enum class BlePhase {
    IDLE,
    SCANNING,
    CONNECTING,
    LIVE,
    RETRYING,
    STOPPED,
    UNAVAILABLE,
    UNSUPPORTED,
    ERROR,
}

internal data class BleViewState(
    val phase: BlePhase = BlePhase.IDLE,
    val message: String = "Ready. Collection runs only while Direct BLE is open.",
    val candidates: List<BleCandidate> = emptyList(),
    val selected: BleCandidate? = null,
    val sample: BleSample? = null,
    val details: String = "",
)
