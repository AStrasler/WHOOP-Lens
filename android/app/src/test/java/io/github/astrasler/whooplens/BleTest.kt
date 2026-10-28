package io.github.astrasler.whooplens

import java.io.File
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.*
import org.junit.Test

class BleTest {
    private fun bytes(vararg values: Int) = values.map { it.toByte() }.toByteArray()

    private val packet = bytes(0x16, 62, 0x00, 0x04) // contact detected, RR=1024 ticks
    private val device = BleCandidate("AA:BB:CC:DD:EE:FF", "WHOOP test", "4.0 service family")

    @Test
    fun standardEightBitAndOriginalRrUnits() {
        val m = HeartRateMeasurement.decode(packet)!!
        assertEquals(62, m.bpm)
        assertEquals(true, m.contact)
        assertEquals(listOf(1024), m.rrTicks)
        assertEquals(listOf(1000.0), m.rrMilliseconds)
        assertNull(m.energyKj)
    }

    @Test
    fun sixteenBitEnergyAndMultipleIntervals() {
        val m = HeartRateMeasurement.decode(bytes(0x19, 0x00, 0x01, 7, 0, 0, 4, 0, 2))!!
        assertEquals(256, m.bpm)
        assertEquals(7, m.energyKj)
        assertNull(m.contact)
        assertEquals(listOf(1024, 512), m.rrTicks)
        assertEquals(listOf(1000.0, 500.0), m.rrMilliseconds)
    }

    @Test
    fun absentOptionalValuesStayMissing() {
        val m = HeartRateMeasurement.decode(bytes(0, 70))!!
        assertNull(m.contact)
        assertNull(m.energyKj)
        assertTrue(m.rrTicks.isEmpty())
        assertEquals(false, HeartRateMeasurement.decode(bytes(4, 70))!!.contact)
    }

    @Test
    fun everyTruncationOfRequiredFieldsIsRejected() {
        val full = bytes(0x19, 72, 0, 5, 0, 0, 4)
        for (n in 0 until full.size) assertNull(
            "length $n",
            HeartRateMeasurement.decode(full.copyOf(n)),
        )
        assertNotNull(HeartRateMeasurement.decode(full))
    }

    @Test
    fun malformedReservedZeroAndOversizeAreRejected() {
        listOf(
                bytes(0, 0),
                bytes(0xe0, 70),
                bytes(2, 70),
                bytes(0, 70, 1),
                bytes(16, 70),
                bytes(16, 70, 1),
                bytes(16, 70, 0, 0),
                ByteArray(513),
            )
            .forEach { assertNull(HeartRateMeasurement.decode(it)) }
    }

    @Test
    fun discoveryDistinguishesGenerationEvidenceWithoutInferringMg() {
        assertNull(BleCandidate.identify("other", "Nearby watch", setOf(HR_SERVICE)))
        assertEquals(LABEL_4_0, BleCandidate.identify("a", null, setOf(WHOOP4_SERVICE.uppercase()))!!.family)
        val shared = BleCandidate.identify("b", "WHOOP MG", setOf(WHOOP5_SERVICE))!!
        assertEquals(LABEL_SHARED, shared.family)
        assertFalse(shared.family.contains("MG service"))
        val named = BleCandidate.identify("c", "WHOOP 5.0\nName", emptySet())!!
        assertEquals(LABEL_NAME_ONLY, named.family)
        assertEquals("WHOOP 5.0Name", named.name)
        assertEquals(
            LABEL_AMBIGUOUS,
            BleCandidate.identify("e", "WHOOP", setOf(WHOOP4_SERVICE, WHOOP5_SERVICE))!!.family,
        )
        assertTrue(LABEL_4_0.length <= 100 && LABEL_SHARED.length <= 100)
    }

    private class Transport : BleTransport {
        var issue: String? = null
        var events: BleTransport.Events? = null
        var connections = 0
        var scans = 0
        var stops = 0

        override fun availability() = issue

        override fun scan(events: BleTransport.Events) {
            scans++
            this.events = events
        }

        override fun connect(candidate: BleCandidate, events: BleTransport.Events) {
            connections++
            this.events = events
        }

        override fun stop() {
            stops++
        }
    }

    private class Timer : BleTimer {
        val tasks = mutableListOf<() -> Unit>()

        override fun after(delayMs: Long, action: () -> Unit): () -> Unit {
            tasks.add(action)
            return { tasks.remove(action) }
        }

        fun fire() {
            tasks.removeAt(0).invoke()
        }
    }

    private inner class Fixture {
        val transport = Transport()
        val timer = Timer()
        val storage = MemorySessionStorage()
        val cache = BleCache(storage)
        var account: String? = "A"
        var allowed = true
        var time = 100000L
        val c =
            BleSessionController(
                transport,
                cache,
                { account },
                { allowed },
                timer,
                { time },
                { time },
                {},
            )

        init {
            c.selectAccount()
        }

        fun discover() {
            c.scan()
            transport.events!!.candidate(device)
        }

        fun live() {
            discover()
            c.connect(device.id)
            transport.events!!.subscribed("HR CCCD confirmed")
        }
    }

    @Test
    fun permissionsAndBluetoothAvailabilityGateTransport() {
        val f = Fixture()
        f.allowed = false
        f.c.scan()
        assertEquals(0, f.transport.scans)
        assertEquals(BlePhase.UNAVAILABLE, f.c.state.phase)
        f.allowed = true
        f.transport.issue = "Bluetooth off"
        f.c.scan()
        assertEquals(0, f.transport.scans)
    }

    @Test
    fun discoveryNeverConnectsWithoutExplicitKnownSelection() {
        val f = Fixture()
        f.discover()
        assertEquals(0, f.transport.connections)
        f.c.connect("arbitrary")
        assertEquals(0, f.transport.connections)
        f.c.connect(device.id)
        assertEquals(1, f.transport.connections)
    }

    @Test
    fun selectionFromPreviousAccountCannotStartNewOwnersSession() {
        val f = Fixture()
        f.discover()
        f.account = "B"
        f.c.connect(device.id)
        assertEquals(0, f.transport.connections)
        assertTrue(f.c.state.candidates.isEmpty())
        assertNull(f.c.state.selected)
        assertNull(f.c.state.sample)
    }

    @Test
    fun scanIsBoundedAndLateDiscoveriesAreIgnored() {
        val f = Fixture()
        f.c.scan()
        val old = f.transport.events!!
        f.timer.fire()
        old.candidate(device)
        assertTrue(f.c.state.candidates.isEmpty())
        assertEquals(BlePhase.IDLE, f.c.state.phase)
    }

    @Test
    fun candidatesAreBoundedAndDeduplicated() {
        val f = Fixture()
        f.c.scan()
        repeat(100) { f.transport.events!!.candidate(device.copy(id = "$it")) }
        f.transport.events!!.candidate(device.copy(id = "0"))
        assertEquals(30, f.c.state.candidates.size)
    }

    @Test
    fun connectionTimeoutRetriesOnlyTwiceAndThenStops() {
        val f = Fixture()
        f.discover()
        f.c.connect(device.id)
        repeat(2) {
            f.timer.fire()
            assertEquals(BlePhase.RETRYING, f.c.state.phase)
            f.timer.fire()
        }
        f.timer.fire()
        assertEquals(3, f.transport.connections)
        assertEquals(BlePhase.ERROR, f.c.state.phase)
        assertTrue(f.timer.tasks.isEmpty())
    }

    @Test
    fun missingGattOrCccdFailureIsUnsupportedWithoutRetry() {
        listOf("Missing HR characteristic", "Missing CCCD", "CCCD subscription rejected").forEach {
            val f = Fixture()
            f.discover()
            f.c.connect(device.id)
            f.transport.events!!.failed(it, false)
            assertEquals(BlePhase.UNSUPPORTED, f.c.state.phase)
            assertTrue(f.timer.tasks.isEmpty())
        }
    }

    @Test
    fun notificationBeforeSubscriptionIsRejected() {
        val f = Fixture()
        f.discover()
        f.c.connect(device.id)
        f.transport.events!!.packet(packet)
        assertNull(f.c.state.sample)
        assertNull(f.cache.read("A"))
    }

    @Test
    fun disconnectCancelsRetryAndRejectsOldCallbacks() {
        val f = Fixture()
        f.live()
        val old = f.transport.events!!
        old.failed("Dropped", true)
        f.c.stop()
        old.subscribed("late")
        old.packet(packet)
        assertEquals(BlePhase.STOPPED, f.c.state.phase)
        assertNull(f.c.state.sample)
        assertTrue(f.timer.tasks.isEmpty())
    }

    @Test
    fun accountSwitchRejectsDelayedPacketAndErasesOldCache() {
        val f = Fixture()
        f.live()
        val old = f.transport.events!!
        old.packet(packet)
        assertNotNull(f.cache.read("A"))
        f.account = "B"
        old.packet(packet)
        assertNull(f.c.state.sample)
        assertNull(f.cache.read("A"))
        assertNull(f.cache.read("B"))
    }

    @Test
    fun signOutRejectsOldCallbacksAndClearsCredentials() {
        val f = Fixture()
        f.live()
        val old = f.transport.events!!
        old.packet(packet)
        f.account = null
        f.c.forget()
        old.packet(packet)
        assertNull(f.storage.read())
        assertNull(f.c.state.sample)
    }

    @Test
    fun revokedPermissionStopsAndRejectsPackets() {
        val f = Fixture()
        f.live()
        val old = f.transport.events!!
        f.allowed = false
        old.packet(packet)
        assertNull(f.c.state.sample)
        assertEquals(BlePhase.UNAVAILABLE, f.c.state.phase)
    }

    @Test
    fun bluetoothInterruptionStopsSession() {
        val f = Fixture()
        f.live()
        f.transport.issue = "Bluetooth off"
        f.c.checkAccess()
        assertEquals(BlePhase.UNAVAILABLE, f.c.state.phase)
        assertTrue(f.timer.tasks.isEmpty())
    }

    @Test
    fun sourceReceiptTimesAndCacheSurviveRestartButNeverAsLive() {
        val f = Fixture()
        f.live()
        f.transport.events!!.packet(packet)
        val saved = BleCache(f.storage).read("A")!!
        assertEquals(BLE_SOURCE, saved.source)
        assertEquals(100000L, saved.receivedAt)
        assertEquals(0L, saved.receivedElapsed)
        assertEquals(listOf(1024), saved.measurement.rrTicks)
        val restored =
            BleSessionController(
                Transport(),
                BleCache(f.storage),
                { "A" },
                { true },
                Timer(),
                { 200000 },
                { 200000 },
                {},
            )
        restored.selectAccount()
        assertEquals(BlePhase.IDLE, restored.state.phase)
        assertEquals(saved, restored.state.sample)
    }

    @Test
    fun malformedPacketsDoNotReplaceLatestMeasurement() {
        val f = Fixture()
        f.live()
        f.transport.events!!.packet(packet)
        val previous = f.c.state.sample
        f.transport.events!!.packet(byteArrayOf())
        assertEquals(previous, f.c.state.sample)
    }

    @Test
    fun savedPriorConnectionIsNotFreshOnResubscribe() {
        val f = Fixture()
        f.live()
        f.transport.events!!.packet(packet)
        f.transport.events!!.failed("Lost", true)
        f.timer.fire()
        f.transport.events!!.subscribed("ready")
        assertEquals(0L, f.c.state.sample!!.receivedElapsed)
    }

    @Test
    fun encryptedCacheUsesAuthenticatedCiphertextAndRejectsCorruption() {
        var blob: ByteArray? = null
        val key = SecretKeySpec(ByteArray(32) { it.toByte() }, "AES")
        val storage =
            EncryptedSessionStorage(
                object : CredentialBlob {
                    override fun read() = blob

                    override fun writeAtomically(value: ByteArray) {
                        blob = value
                    }

                    override fun clear() {
                        blob = null
                    }
                },
                object : CredentialKeys {
                    override fun get(create: Boolean) = key

                    override fun clear() {}
                },
                binding = "ble-test",
                maxPlaintextBytes = 8192,
            )
        val cache = BleCache(storage)
        cache.write(
            BleSample(
                "A",
                device.name,
                device.family,
                100000,
                10,
                HeartRateMeasurement.decode(packet)!!,
            ),
            packet,
        )
        assertFalse(blob!!.toString(Charsets.UTF_8).contains(BLE_SOURCE))
        assertNotNull(BleCache(storage).read("A"))
        blob!![20] = (blob!![20].toInt() xor 1).toByte()
        assertNull(cache.read("A"))
        assertNull(blob)
    }

    @Test
    fun corruptAndWrongAccountStorageIsCleared() {
        val f = Fixture()
        f.storage.write("corrupt")
        assertNull(f.cache.read("A"))
        assertNull(f.storage.read())
        f.live()
        f.transport.events!!.packet(packet)
        assertNull(f.cache.read("B"))
        assertNull(f.storage.read())
    }

    @Test
    fun gattInventoryDoesNotSplitTheSharedServiceFamily() {
        val observed =
            StrapObservation.fromGatt(
                setOf(WHOOP5_SERVICE, HR_SERVICE, BATTERY_SERVICE, DEVICE_INFO_SERVICE),
                setOf(WHOOP5_NOTIFY_7, WHOOP5_COMMAND_WRITE, HR_CHARACTERISTIC, BATTERY_LEVEL),
            )
        assertEquals(ProductCall.SHARED_5_0_OR_MG, observed.product)
        assertEquals(LABEL_SHARED, observed.label)
        assertEquals(true, observed.extraPuffinNotify)
        assertEquals(true, observed.heartRateMeasurement)
        assertTrue(observed.evidenceLine().contains("2A37=yes"))
        assertTrue(observed.evidenceLine().contains("fd4b0007=yes"))
        assertTrue(observed.evidenceLine().contains("custom=fd4b0002,fd4b0007"))
        assertEquals(9, KNOWN_CUSTOM_CHARACTERISTICS.distinct().size)
        assertFalse(observed.evidenceLine().contains("WHOOP 5.0"))
        assertFalse(observed.evidenceLine().contains("WHOOP MG"))
        assertTrue(LABEL_SHARED.contains("5.0") && LABEL_SHARED.contains("MG"))
        assertFalse(LABEL_SHARED.contains("WHOOP 5.0") || LABEL_SHARED.contains("WHOOP MG"))
    }

    @Test
    fun gattInventoryCoversFourEmptyAmbiguousAndAdvertisement() {
        val four =
            StrapObservation.fromGatt(
                setOf(WHOOP4_SERVICE),
                setOf(WHOOP4_COMMAND_WRITE, WHOOP4_DATA_NOTIFY),
            )
        assertEquals(ProductCall.WHOOP_4_0, four.product)
        assertEquals(LABEL_4_0, four.label)
        assertTrue(four.evidenceLine().contains("2A37=no"))
        assertTrue(four.evidenceLine().contains("custom=61080002,61080005"))
        val empty = StrapObservation.fromGatt(emptySet(), emptySet())
        assertEquals(LABEL_NO_CUSTOM_SERVICE, empty.label)
        assertTrue(empty.evidenceLine().contains("custom=none"))
        val both =
            StrapObservation.fromGatt(setOf(WHOOP4_SERVICE, WHOOP5_SERVICE), emptySet())
        assertEquals(LABEL_AMBIGUOUS, both.label)
        val advertised = StrapObservation.fromAdvertisement(setOf(WHOOP5_SERVICE))
        assertEquals(LABEL_SHARED, advertised.evidenceLine())
        assertNull(advertised.heartRateMeasurement)
    }

    @Test
    fun deviceInformationTextAndAdvertisedNamesDoNotSelectEitherProduct() {
        listOf("WHOOP 5.0", "WHOOP MG", "WHOOP AGT", "Maverick", "Goose").forEach { text ->
            val decoded = DeviceInformationText.printable(text.toByteArray(Charsets.US_ASCII))
            assertEquals(text, decoded)
            assertEquals(
                LABEL_SHARED,
                BleCandidate.identify("id", decoded, setOf(WHOOP5_SERVICE))!!.family,
            )
        }
        assertNull(DeviceInformationText.printable(byteArrayOf(0)))
        assertNull(DeviceInformationText.printable(ByteArray(41) { 'A'.code.toByte() }))
    }

    @Test
    fun batteryLevelRejectsReservedAndMissingBytes() {
        assertEquals(0, BatteryLevelMeasurement.decode(bytes(0))!!.percent)
        assertEquals(100, BatteryLevelMeasurement.decode(bytes(100))!!.percent)
        assertNull(BatteryLevelMeasurement.decode(bytes(101)))
        assertNull(BatteryLevelMeasurement.decode(bytes(255)))
        assertNull(BatteryLevelMeasurement.decode(byteArrayOf()))
        assertNull(BatteryLevelMeasurement.decode(bytes(50, 0)))
    }

    @Test
    fun checksumsMatchPublishedAlgorithmVectors() {
        val digits = "123456789".toByteArray(Charsets.US_ASCII)
        assertEquals(0xf4, StrapChecksum.crc8(digits))
        assertEquals(0xcbf43926L, StrapChecksum.crc32(digits))
        assertEquals(0x4b37, StrapChecksum.crc16Modbus(digits))
    }

    @Test
    fun syntheticEnvelopesStayInsideTheirPublicFamilies() {
        val four = hex("aa07006b300000823c2adb")
        val shared = hex("aa01070001002535300100c30d31c2")
        val harvard = StrapEnvelope.recognize(four)!!
        assertEquals(EnvelopeFamily.WHOOP_4_0, harvard.family)
        assertEquals(0x30, harvard.observedType)
        assertEquals(0x00, harvard.observedCommand)
        val puffin = StrapEnvelope.recognize(shared)!!
        assertEquals(EnvelopeFamily.SHARED_5_0_OR_MG, puffin.family)
        assertEquals(0x30, puffin.observedType)
        assertEquals(0x00, puffin.observedCommand)
        four[8] = (four[8].toInt() xor 1).toByte()
        shared[10] = (shared[10].toInt() xor 1).toByte()
        assertNull(StrapEnvelope.recognize(four))
        assertNull(StrapEnvelope.recognize(shared))
        assertNull(StrapEnvelope.recognize(byteArrayOf(0xaa.toByte())))
        assertNull(StrapEnvelope.recognize(ByteArray(513) { 0xaa.toByte() }))
        val intactFour = hex("aa07006b300000823c2adb")
        val intactShared = hex("aa01070001002535300100c30d31c2")
        val badCrc8 = intactFour.copyOf()
        badCrc8[3] = (badCrc8[3].toInt() xor 1).toByte()
        val badCrc16 = intactShared.copyOf()
        badCrc16[6] = (badCrc16[6].toInt() xor 1).toByte()
        assertNull(StrapEnvelope.recognize(badCrc8))
        assertNull(StrapEnvelope.recognize(badCrc16))
        assertNull(StrapEnvelope.recognize(intactFour + byteArrayOf(0.toByte())))
        assertNull(StrapEnvelope.recognize(intactShared + byteArrayOf(0.toByte())))
        assertNull(StrapEnvelope.recognize(intactShared.copyOf(14)))
        val wrongFormat = intactShared.copyOf()
        wrongFormat[1] = 0x02
        val headerCrc = StrapChecksum.crc16Modbus(wrongFormat.copyOfRange(0, 6))
        wrongFormat[6] = (headerCrc and 0xff).toByte()
        wrongFormat[7] = (headerCrc shr 8 and 0xff).toByte()
        assertNull(StrapEnvelope.recognize(wrongFormat))
        assertNull(StrapEnvelope.recognize(shortHarvard(6)))
        assertNull(StrapEnvelope.recognize(shortShared(6)))
    }

    @Test
    fun matrixKeepsFiveAndMgSeparateAndDoesNotClaimHardware() {
        val topics = { generation: StrapGeneration ->
            GenerationMatrix.cells.filter { it.generation == generation }.map { it.topic }
        }
        assertEquals(topics(StrapGeneration.WHOOP_5_0), topics(StrapGeneration.WHOOP_MG))
        assertEquals(topics(StrapGeneration.WHOOP_4_0), topics(StrapGeneration.WHOOP_5_0))
        assertEquals(3, StrapGeneration.entries.size)
        val blocked =
            setOf(
                "proprietary command write",
                "history ack or trim",
                "clock write",
                "firmware operation",
            )
        GenerationMatrix.cells.forEach { cell ->
            assertFalse(cell.evidencePhrase().contains("hardware"))
            if (cell.topic in blocked || cell.topic == "ECG" || cell.topic == "skin temperature") {
                assertFalse(cell.marks.contains(EvidenceMark.COMPLETED_CODE))
                assertTrue(
                    cell.finding.contains("must not send") || cell.finding.contains("must not probe"),
                )
            }
        }
        val five =
            GenerationMatrix.cells.first {
                it.generation == StrapGeneration.WHOOP_5_0 &&
                    it.topic == "service UUID identifies this product alone"
            }
        val mg =
            GenerationMatrix.cells.first {
                it.generation == StrapGeneration.WHOOP_MG &&
                    it.topic == "service UUID identifies this product alone"
            }
        assertTrue(five.finding.contains("does not identify WHOOP 5.0"))
        assertTrue(mg.finding.contains("does not identify WHOOP MG"))
        val fiveHeartRate =
            GenerationMatrix.cells.first {
                it.generation == StrapGeneration.WHOOP_5_0 &&
                    it.topic == "standard heart-rate notifications on a strap"
            }
        assertFalse(fiveHeartRate.finding.contains("5.0/MG"))
        assertTrue(fiveHeartRate.finding.contains("on an MG"))
        assertTrue(fiveHeartRate.finding.contains("was not the data path"))
        assertTrue(fiveHeartRate.finding.contains("no 5.0 is cited"))
        val doc = repoFile("docs/ble/GENERATION_MATRIX.md")
        val start = doc.indexOf("<!-- matrix-start -->")
        val end = doc.indexOf("<!-- matrix-end -->")
        assertTrue(start >= 0 && end > start)
        assertEquals(
            GenerationMatrix.markdownTable().trim(),
            doc.substring(start, end).substringAfter("-->").trim(),
        )
        val procedure = repoFile("docs/ble/PHYSICAL_STRAP_TEST.md")
        assertTrue(procedure.contains("## Sheet A — WHOOP 5.0"))
        assertTrue(procedure.contains("## Sheet B — WHOOP MG"))
        assertTrue(procedure.contains("This procedure has not been run"))
        assertFalse(procedure.contains("hardware-tested: yes"))
    }

    @Test
    fun safeguardsStayForegroundReadOnlyAndLocationFree() {
        val manifest = repoFile("android/app/src/main/AndroidManifest.xml")
        assertTrue(manifest.contains("android.permission.BLUETOOTH_SCAN"))
        assertTrue(manifest.contains("android.permission.BLUETOOTH_CONNECT"))
        assertTrue(manifest.contains("neverForLocation"))
        listOf(
                "ACCESS_FINE_LOCATION",
                "ACCESS_COARSE_LOCATION",
                "BLUETOOTH_ADVERTISE",
                "BLUETOOTH_ADMIN",
                "ACCESS_BACKGROUND_LOCATION",
            )
            .forEach { assertFalse(manifest.contains(it)) }
        val sources =
            File(repoRoot(), "android/app/src/main")
                .walk()
                .filter { it.extension == "kt" }
                .map { it.readText() }
                .joinToString("\n")
        assertEquals(1, Regex("""writeDescriptor\(""").findAll(sources).count())
        assertFalse(sources.contains("writeCharacteristic"))
        assertFalse(sources.contains("ENABLE_INDICATION_VALUE"))
        assertTrue(sources.contains("ENABLE_NOTIFICATION_VALUE"))
        assertTrue(sources.contains("getDescriptor(UUID.fromString(HR_CCCD))"))
        assertTrue(sources.contains("getCharacteristic(UUID.fromString(HR_CHARACTERISTIC))"))
        val lower = sources.lowercase()
        assertFalse(lower.contains("e671230191"))
        assertFalse(Regex("""0xe6(\.tobyte\(\))?\s*,\s*0x71""").containsMatchIn(lower))
        assertFalse(Regex("""-26\s*,\s*113""").containsMatchIn(lower))
        assertFalse(Regex("""-0x1a\s*,\s*0x71""").containsMatchIn(lower))
    }

    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    private fun le32(value: Long) =
        ByteArray(4) { index -> ((value shr (8 * index)) and 0xff).toByte() }

    private fun shortHarvard(length: Int): ByteArray {
        val inner = ByteArray(length - 4)
        val prefix = byteArrayOf(0xaa.toByte(), (length and 0xff).toByte(), 0)
        val crc8 = StrapChecksum.crc8(prefix.copyOfRange(1, 3))
        return prefix + crc8.toByte() + inner + le32(StrapChecksum.crc32(inner))
    }

    private fun shortShared(declared: Int): ByteArray {
        val payload = ByteArray(declared - 4)
        val header =
            byteArrayOf(0xaa.toByte(), 0x01, (declared and 0xff).toByte(), 0, 0x01, 0)
        val crc16 = StrapChecksum.crc16Modbus(header)
        return header +
            (crc16 and 0xff).toByte() +
            (crc16 shr 8 and 0xff).toByte() +
            payload +
            le32(StrapChecksum.crc32(payload))
    }

    private fun repoRoot(): File =
        generateSequence(File("").absoluteFile) { it.parentFile }
            .first { File(it, "android/app/src/main/AndroidManifest.xml").isFile }

    private fun repoFile(relative: String) = File(repoRoot(), relative).readText().replace("\r\n", "\n")
}
