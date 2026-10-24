package io.github.astrasler.whooplens

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
        assertTrue(
            BleCandidate.identify("a", null, setOf(WHOOP4_SERVICE))!!.family.startsWith("4.0")
        )
        assertTrue(
            BleCandidate.identify("b", "WHOOP", setOf(WHOOP5_SERVICE))!!
                .family
                .contains("unverified")
        )
        assertTrue(
            BleCandidate.identify("c", "WHOOP\nName", emptySet())!!.family.contains("Unknown")
        )
        assertFalse(BleCandidate.identify("c", "WHOOP\nName", emptySet())!!.name.contains('\n'))
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
}
