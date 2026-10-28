package io.github.astrasler.whooplens

/**
 * Read-only evidence for WHOOP 4.0, WHOOP 5.0 and WHOOP MG.
 *
 * Layout facts are implemented here independently. No upstream decoder, schema,
 * captured packet or command frame is copied, and nothing in this file builds a
 * write. A passing unit test is not a physical strap.
 *
 * 4.0 service and envelope: whoop4-ble `docs/PROTOCOL.md` at `a76ad457` (MIT).
 * Shared `fd4b0001` family, characteristics through `fd4b0007`, and the 5.0/MG
 * envelope: muftiarfan/noop `docs/PROTOCOL.md` at `7be90e0`. Zë Stuart, "WHOOP 5
 * & MG — Same Handshake, New Data Format" (25 Jun 2026), reports that same
 * family on an owned MG and says Goose (5.0) and Maverick (MG) are not split by
 * GATT UUID. That report also says standard Heart Rate notifications were not
 * the data path, which disagrees with NOOP. This code does not pick a winner.
 */

internal const val WHOOP4_COMMAND_WRITE = "61080002-8d6d-82b8-614a-1c8cb0f8dcc6"
internal const val WHOOP4_COMMAND_NOTIFY = "61080003-8d6d-82b8-614a-1c8cb0f8dcc6"
internal const val WHOOP4_EVENT_NOTIFY = "61080004-8d6d-82b8-614a-1c8cb0f8dcc6"
internal const val WHOOP4_DATA_NOTIFY = "61080005-8d6d-82b8-614a-1c8cb0f8dcc6"
internal const val WHOOP5_COMMAND_WRITE = "fd4b0002-cce1-4033-93ce-002d5875f58a"
internal const val WHOOP5_NOTIFY_3 = "fd4b0003-cce1-4033-93ce-002d5875f58a"
internal const val WHOOP5_NOTIFY_4 = "fd4b0004-cce1-4033-93ce-002d5875f58a"
internal const val WHOOP5_NOTIFY_5 = "fd4b0005-cce1-4033-93ce-002d5875f58a"
internal const val WHOOP5_NOTIFY_7 = "fd4b0007-cce1-4033-93ce-002d5875f58a"
internal const val BATTERY_SERVICE = "0000180f-0000-1000-8000-00805f9b34fb"
internal const val BATTERY_LEVEL = "00002a19-0000-1000-8000-00805f9b34fb"
internal const val DEVICE_INFO_SERVICE = "0000180a-0000-1000-8000-00805f9b34fb"
internal const val LABEL_4_0 = "4.0 service 61080001. Model/firmware unverified."
internal const val LABEL_SHARED = "fd4b0001 shared by 5.0 and MG. Product unverified."
internal const val LABEL_AMBIGUOUS = "61080001 and fd4b0001 both seen. Ambiguous."
internal const val LABEL_NAME_ONLY = "Name only. No 4.0 or 5.0/MG service."
internal const val LABEL_NO_CUSTOM_SERVICE = "No 61080001 or fd4b0001 service in GATT."

internal val KNOWN_CUSTOM_CHARACTERISTICS =
    listOf(
        WHOOP4_COMMAND_WRITE,
        WHOOP4_COMMAND_NOTIFY,
        WHOOP4_EVENT_NOTIFY,
        WHOOP4_DATA_NOTIFY,
        WHOOP5_COMMAND_WRITE,
        WHOOP5_NOTIFY_3,
        WHOOP5_NOTIFY_4,
        WHOOP5_NOTIFY_5,
        WHOOP5_NOTIFY_7,
    )

internal enum class ProductCall {
    WHOOP_4_0,
    SHARED_5_0_OR_MG,
    AMBIGUOUS_SERVICES,
    NOT_A_CANDIDATE,
}

internal data class StrapObservation(
    val product: ProductCall,
    val label: String,
    val heartRateMeasurement: Boolean?,
    val batteryLevel: Boolean?,
    val extraPuffinNotify: Boolean?,
    val deviceInformationService: Boolean?,
    val servicePrefixes: List<String>,
    val customPrefixes: List<String>,
) {
    init {
        require(label.length <= 100)
        val lookedUp =
            listOf(heartRateMeasurement, batteryLevel, extraPuffinNotify, deviceInformationService)
        require(lookedUp.all { it == null } || lookedUp.all { it != null })
    }

    fun evidenceLine(): String {
        if (heartRateMeasurement == null) return label
        fun bit(name: String, value: Boolean?) = "$name=${if (value == true) "yes" else "no"}"
        val services =
            servicePrefixes.take(6).joinToString(",") +
                if (servicePrefixes.size > 6) "+${servicePrefixes.size - 6}" else ""
        return "$label ${bit("2A37", heartRateMeasurement)} ${bit("2A19", batteryLevel)} " +
            "${bit("fd4b0007", extraPuffinNotify)} ${bit("180A", deviceInformationService)} " +
            "services=$services custom=${customPrefixes.joinToString(",").ifEmpty { "none" }}."
    }

    companion object {
        fun fromAdvertisement(services: Set<String>): StrapObservation {
            val ids = norm(services)
            val product = productOf(ids)
            val label =
                when (product) {
                    ProductCall.WHOOP_4_0 -> LABEL_4_0
                    ProductCall.SHARED_5_0_OR_MG -> LABEL_SHARED
                    ProductCall.AMBIGUOUS_SERVICES -> LABEL_AMBIGUOUS
                    ProductCall.NOT_A_CANDIDATE -> ""
                }
            return StrapObservation(product, label, null, null, null, null, emptyList(), emptyList())
        }

        fun fromGatt(services: Set<String>, characteristics: Set<String>): StrapObservation {
            val ids = norm(services)
            val chars = norm(characteristics)
            val product = productOf(ids)
            val label =
                when (product) {
                    ProductCall.WHOOP_4_0 -> LABEL_4_0
                    ProductCall.SHARED_5_0_OR_MG -> LABEL_SHARED
                    ProductCall.AMBIGUOUS_SERVICES -> LABEL_AMBIGUOUS
                    ProductCall.NOT_A_CANDIDATE -> LABEL_NO_CUSTOM_SERVICE
                }
            return StrapObservation(
                product,
                label,
                HR_CHARACTERISTIC in chars,
                BATTERY_LEVEL in chars,
                WHOOP5_NOTIFY_7 in chars,
                DEVICE_INFO_SERVICE in ids,
                ids.map { it.take(8) }.distinct().sorted(),
                KNOWN_CUSTOM_CHARACTERISTICS.filter { it in chars }.map { it.take(8) },
            )
        }

        private fun norm(ids: Set<String>) = ids.map { it.lowercase() }.toSet()

        private fun productOf(services: Set<String>): ProductCall {
            val four = WHOOP4_SERVICE in services
            val shared = WHOOP5_SERVICE in services
            return when {
                four && shared -> ProductCall.AMBIGUOUS_SERVICES
                four -> ProductCall.WHOOP_4_0
                shared -> ProductCall.SHARED_5_0_OR_MG
                else -> ProductCall.NOT_A_CANDIDATE
            }
        }
    }
}

/** Printable Device Information bytes. They never select 5.0 or MG. */
internal object DeviceInformationText {
    fun printable(bytes: ByteArray): String? {
        if (bytes.isEmpty() || bytes.size > 40) return null
        if (bytes.any { (it.toInt() and 255) !in 0x20..0x7E }) return null
        return bytes.toString(Charsets.US_ASCII)
    }
}

/**
 * SIG Battery Level. One uint8, 0–100 percent. 0 is empty, not missing.
 * 101–255 are reserved and rejected. This does not read a strap.
 */
internal data class BatteryPercent(val percent: Int)

internal object BatteryLevelMeasurement {
    fun decode(bytes: ByteArray): BatteryPercent? {
        if (bytes.size != 1) return null
        val value = bytes[0].toInt() and 255
        if (value > 100) return null
        return BatteryPercent(value)
    }
}

internal object StrapChecksum {
    fun crc8(data: ByteArray): Int {
        var crc = 0
        for (byte in data) {
            crc = crc xor (byte.toInt() and 255)
            repeat(8) {
                crc =
                    if (crc and 0x80 != 0) ((crc shl 1) xor 0x07) and 0xff
                    else (crc shl 1) and 0xff
            }
        }
        return crc
    }

    fun crc32(data: ByteArray): Long {
        var crc = 0xffffffffL
        for (byte in data) {
            crc = crc xor (byte.toLong() and 255)
            repeat(8) {
                crc = if (crc and 1L != 0L) (crc ushr 1) xor 0xedb88320L else crc ushr 1
            }
        }
        return crc xor 0xffffffffL
    }

    fun crc16Modbus(data: ByteArray): Int {
        var crc = 0xffff
        for (byte in data) {
            crc = crc xor (byte.toInt() and 255)
            repeat(8) {
                crc = if (crc and 1 != 0) (crc ushr 1) xor 0xa001 else crc ushr 1
            }
        }
        return crc and 0xffff
    }
}

internal enum class EnvelopeFamily {
    WHOOP_4_0,
    SHARED_5_0_OR_MG,
}

/**
 * A recognized notification envelope. [observedCommand] is never transmitted.
 *
 * 4.0 layout: `AA`, little-endian length at offset 1, CRC-8 (poly `0x07`, init 0)
 * of those two bytes at offset 3, inner bytes from offset 4 up to `length`,
 * CRC-32 (zlib) little-endian at `length`, total size `length + 4`, length at least 7.
 *
 * Shared 5.0/MG layout: `AA`, format `01`, little-endian declared length at offset 2,
 * CRC-16-Modbus (poly `0xA001`, init `0xFFFF`) of the first six bytes, little-endian
 * at offset 6, inner bytes from offset 8 up to `declared + 4`, CRC-32 little-endian
 * there, total size `declared + 8`, declared length at least 7. A match is
 * [EnvelopeFamily.SHARED_5_0_OR_MG]. It is not 5.0 alone and not MG alone.
 * These checks are not connected to a GATT callback.
 */
internal data class RecognizedEnvelope(
    val family: EnvelopeFamily,
    val observedType: Int,
    val observedCommand: Int,
)

internal object StrapEnvelope {
    fun recognize(bytes: ByteArray): RecognizedEnvelope? {
        if (bytes.size !in 11..512 || (bytes[0].toInt() and 255) != 0xaa) return null
        val four = recognize4(bytes)
        val shared = recognizeShared(bytes)
        return when {
            four != null && shared != null -> null
            else -> four ?: shared
        }
    }

    private fun recognize4(bytes: ByteArray): RecognizedEnvelope? {
        val length = u16(bytes, 1)
        if (length < 7 || length + 4 != bytes.size) return null
        if (StrapChecksum.crc8(byteArrayOf(bytes[1], bytes[2])) != (bytes[3].toInt() and 255))
            return null
        val inner = bytes.copyOfRange(4, length)
        if (inner.size < 3 || StrapChecksum.crc32(inner) != u32(bytes, length)) return null
        return RecognizedEnvelope(
            EnvelopeFamily.WHOOP_4_0,
            inner[0].toInt() and 255,
            inner[2].toInt() and 255,
        )
    }

    private fun recognizeShared(bytes: ByteArray): RecognizedEnvelope? {
        if ((bytes[1].toInt() and 255) != 0x01) return null
        val declared = u16(bytes, 2)
        if (declared < 7 || declared + 8 != bytes.size) return null
        val headerCrc = StrapChecksum.crc16Modbus(bytes.copyOfRange(0, 6))
        if (headerCrc != u16(bytes, 6)) return null
        val payloadEnd = declared + 4
        if (payloadEnd < 11 || payloadEnd > bytes.size - 4) return null
        val payload = bytes.copyOfRange(8, payloadEnd)
        if (payload.size < 3 || StrapChecksum.crc32(payload) != u32(bytes, payloadEnd)) return null
        return RecognizedEnvelope(
            EnvelopeFamily.SHARED_5_0_OR_MG,
            payload[0].toInt() and 255,
            payload[2].toInt() and 255,
        )
    }

    private fun u16(bytes: ByteArray, offset: Int) =
        (bytes[offset].toInt() and 255) or ((bytes[offset + 1].toInt() and 255) shl 8)

    private fun u32(bytes: ByteArray, offset: Int): Long {
        var value = 0L
        for (index in 0..3) value = value or ((bytes[offset + index].toLong() and 255) shl (8 * index))
        return value
    }
}

internal enum class StrapGeneration(val label: String) {
    WHOOP_4_0("WHOOP 4.0"),
    WHOOP_5_0("WHOOP 5.0"),
    WHOOP_MG("WHOOP MG"),
}

internal enum class EvidenceMark(val phrase: String) {
    COMPLETED_CODE("completed code"),
    SIMULATED_OR_UNIT_TESTED("simulated or unit-tested"),
    PENDING_PHYSICAL("pending physical verification"),
}

internal data class MatrixCell(
    val generation: StrapGeneration,
    val topic: String,
    val marks: Set<EvidenceMark>,
    val finding: String,
) {
    fun evidencePhrase(): String =
        EvidenceMark.entries.filter { it in marks }.joinToString("; ") { it.phrase }

    init {
        require(marks.isNotEmpty())
        require("|" !in topic && "|" !in finding && "\n" !in finding)
    }
}

internal object GenerationMatrix {
    private val codeTest = setOf(EvidenceMark.COMPLETED_CODE, EvidenceMark.SIMULATED_OR_UNIT_TESTED)
    private val codeTestPhysical = codeTest + EvidenceMark.PENDING_PHYSICAL
    private val physical = setOf(EvidenceMark.PENDING_PHYSICAL)

    val cells: List<MatrixCell> =
        buildList {
            addAll(
                row(
                "advertised custom service",
                codeTestPhysical,
                "Classifier maps 61080001-8d6d-82b8-614a-1c8cb0f8dcc6 to the 4.0 family. No strap has been scanned.",
                "Classifier maps fd4b0001-cce1-4033-93ce-002d5875f58a to the shared family, not to 5.0 alone. No strap has been scanned.",
                "Classifier maps fd4b0001-cce1-4033-93ce-002d5875f58a to the shared family, not to MG alone. No strap has been scanned.",
                ),
            )
            addAll(
                row(
                "custom characteristics",
                codeTestPhysical,
                "GATT inventory can record 61080002 through 61080005. None of them is written.",
                "GATT inventory can record fd4b0002 through fd4b0005 and fd4b0007. fd4b0007 does not select 5.0. None is written.",
                "GATT inventory can record fd4b0002 through fd4b0005 and fd4b0007. fd4b0007 does not select MG. None is written.",
                ),
            )
            addAll(
                row(
                "standard heart-rate parser",
                codeTest,
                "Bluetooth Heart Rate Measurement parser, synthetic packets only. Not evidence that a 4.0 strap notifies.",
                "Same parser. Not evidence that a 5.0 strap notifies.",
                "Same parser. Not evidence that an MG strap notifies.",
                ),
            )
            addAll(
                row(
                "standard heart-rate notifications on a strap",
                physical,
                "whoop4-ble reports live 180D/2A37 on that author's 4.0. WHOOP Lens has not confirmed it.",
                "NOOP claims unbonded 180D/2A37. Vestigator part 7 saw that fail on an MG, not on a cited 5.0. Unresolved for 5.0.",
                "Same public conflict. Vestigator's session was an MG. Unresolved for MG until that strap is tested.",
                ),
            )
            addAll(
                row(
                "optional R-R intervals",
                codeTestPhysical,
                "Parser keeps 1/1024 s ticks when the standard flag is set. Whether a 4.0 strap sets it is unverified.",
                "No 5.0 capture in this repo shows 2A37 R-R. Absence must stay absent.",
                "No MG capture in this repo shows 2A37 R-R. Absence must stay absent.",
                ),
            )
            addAll(
                row(
                "standard battery parser",
                codeTest,
                "SIG Battery Level parser: one byte, 0 through 100. No live read is wired.",
                "Same parser. No live read is wired, and a 5.0 battery value has not been read.",
                "Same parser. No live read is wired, and an MG battery value has not been read.",
                ),
            )
            addAll(
                row(
                "battery level on a strap",
                physical,
                "NOOP claims 180F/2A19 on 4.0. This app does not read it. Confirm without writing.",
                "NOOP claims 2A19 on the shared family. Confirm on a 5.0 strap without writing.",
                "NOOP claims 2A19 on the shared family. Confirm on an MG strap without writing.",
                ),
            )
            addAll(
                row(
                "frame envelope recognizer",
                codeTest,
                "Independent check of the published 4.0 envelope on a synthetic frame. Not a captured strap frame.",
                "Independent check of the published 8-byte envelope. A match is not identified as 5.0 rather than MG.",
                "Same recognizer. A match is the shared envelope, not an MG identification.",
                ),
            )
            addAll(
                row(
                "service UUID identifies this product alone",
                codeTestPhysical,
                "61080001 selects the 4.0 family label only. That is not a physical identification.",
                "fd4b0001 does not identify WHOOP 5.0 alone. The label stays shared.",
                "fd4b0001 does not identify WHOOP MG alone. The label stays shared.",
                ),
            )
            addAll(
                row(
                "device-information text selects this product",
                codeTestPhysical,
                "Printable device-information bytes are not mapped to 4.0, 5.0 or MG.",
                "A model string containing 5.0 does not select WHOOP 5.0.",
                "A model string containing MG does not select WHOOP MG.",
                ),
            )
            addAll(
                row(
                "proprietary command write",
                physical,
                "Command characteristics are inventory-only. Not implemented. The physical procedure must not send this.",
                "Command characteristics are inventory-only. Not implemented. The physical procedure must not send this.",
                "Command characteristics are inventory-only. Not implemented. The physical procedure must not send this.",
                ),
            )
            addAll(
                row(
                "history ack or trim",
                physical,
                "History read, ack and trim are not implemented. The physical procedure must not send this.",
                "History read, ack and trim are not implemented. The physical procedure must not send this.",
                "History read, ack and trim are not implemented. The physical procedure must not send this.",
                ),
            )
            addAll(
                row(
                "clock write",
                physical,
                "Clock writes are not implemented. The physical procedure must not send this.",
                "Clock writes are not implemented. The physical procedure must not send this.",
                "Clock writes are not implemented. The physical procedure must not send this.",
                ),
            )
            addAll(
                row(
                "firmware operation",
                physical,
                "Firmware operations are not implemented. The physical procedure must not send this.",
                "Firmware operations are not implemented. The physical procedure must not send this.",
                "Firmware operations are not implemented. The physical procedure must not send this.",
                ),
            )
            addAll(
                row(
                "ECG",
                physical,
                "Cited sources do not assign ECG to 4.0. Not implemented. The physical procedure must not probe it.",
                "Vestigator describes ECG as an MG path. Not implemented. The physical procedure must not probe it.",
                "Described only through device-config commands. Not implemented. The physical procedure must not probe it.",
                ),
            )
            addAll(
                row(
                "skin temperature",
                physical,
                "whoop4-ble describes temperature inside historical records. Not implemented. The physical procedure must not send this.",
                "Vestigator describes skin temperature as an MG path. Not implemented. The physical procedure must not probe it.",
                "Described as an MG sensor path. Not implemented. The physical procedure must not probe it.",
                ),
            )
            addAll(
                row(
                "subscription required",
                physical,
                "Not determined. There is no WHOOP Lens strap session, subscribed or otherwise.",
                "Not determined for 5.0. A subscribed session would not prove a subscription is required.",
                "Not determined for MG. A subscribed session would not prove a subscription is required.",
                ),
            )
            addAll(
                row(
                "app write surface",
                codeTestPhysical,
                "Foreground transport still writes only the standard Heart Rate CCCD after 2A37 exposes notify. No new write was added. Acceptance on a 4.0 strap is unverified here.",
                "Same write surface. Whether a 5.0 strap accepts that CCCD is unverified.",
                "Same write surface. Whether an MG strap accepts that CCCD is unverified.",
                ),
            )
        }

    fun markdownTable(): String {
        val header = "| Generation | Topic | Evidence | Finding |\n|---|---|---|---|\n"
        val body =
            cells.joinToString("\n") {
                "| ${it.generation.label} | ${it.topic} | ${it.evidencePhrase()} | ${it.finding} |"
            }
        return header + body + "\n"
    }

    private fun row(
        topic: String,
        marks: Set<EvidenceMark>,
        four: String,
        five: String,
        mg: String,
    ) =
        listOf(
            MatrixCell(StrapGeneration.WHOOP_4_0, topic, marks, four),
            MatrixCell(StrapGeneration.WHOOP_5_0, topic, marks, five),
            MatrixCell(StrapGeneration.WHOOP_MG, topic, marks, mg),
        )
}
