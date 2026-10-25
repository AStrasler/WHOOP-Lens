package io.github.astrasler.whooplens

import org.json.JSONArray
import org.json.JSONObject

internal class BleCache(private val storage: SessionStorage) {
    fun read(account: String): BleSample? {
        return try {
            val j = JSONObject(storage.read() ?: return null)
            require(j.getInt("v") == 1 && j.getString("source") == BLE_SOURCE)
            if (j.getString("account") != account) {
                clear()
                null
            } else {
                val bytes = j.getJSONArray("packet")
                require(bytes.length() in 2..512)
                val measurement =
                    HeartRateMeasurement.decode(
                        ByteArray(bytes.length()) {
                            val value = bytes.getInt(it)
                            require(value in 0..255)
                            value.toByte()
                        }
                    ) ?: error("Invalid measurement")
                val name = j.getString("device")
                val family = j.getString("family")
                require(name.length <= 40 && family.length <= 100 && j.getLong("received") > 0)
                BleSample(account, name, family, j.getLong("received"), 0, measurement)
            }
        } catch (_: Exception) {
            clear()
            null
        }
    }

    fun write(sample: BleSample, packet: ByteArray) {
        require(
            sample.source == BLE_SOURCE && sample.measurement == HeartRateMeasurement.decode(packet)
        )
        storage.write(
            JSONObject()
                .put("v", 1)
                .put("account", sample.account)
                .put("source", BLE_SOURCE)
                .put("device", sample.deviceName)
                .put("family", sample.family)
                .put("received", sample.receivedAt)
                .put("packet", JSONArray(packet.map { it.toInt() and 255 }))
                .toString()
        )
    }

    fun clear() {
        try {
            storage.clear()
        } catch (_: Exception) {
            /* key/file erasure attempted */
        }
    }
}

/** All calls and callbacks are serialized by the host (main looper on Android). */
internal interface BleTransport {
    interface Events {
        fun candidate(candidate: BleCandidate)

        fun subscribed(details: String)

        fun packet(bytes: ByteArray)

        fun failed(message: String, retryable: Boolean)
    }

    fun availability(): String?

    fun scan(events: Events)

    fun connect(candidate: BleCandidate, events: Events)

    fun stop()
}

internal fun interface BleTimer {
    fun after(delayMs: Long, action: () -> Unit): () -> Unit
}

internal class BleSessionController(
    private val transport: BleTransport,
    private val cache: BleCache,
    private val account: () -> String?,
    private val permission: () -> Boolean,
    private val timer: BleTimer,
    private val wallTime: () -> Long,
    private val elapsed: () -> Long,
    private val changed: (BleViewState) -> Unit,
) {
    var state = BleViewState()
        private set

    private var owner: String? = null
    private var generation = 0L
    private var active = false
    private var cancelTimer: (() -> Unit)? = null
    private var retries = 0
    private var lastWrite = Long.MIN_VALUE

    private fun publish(next: BleViewState) {
        state = next
        changed(next)
    }

    private fun invalidate() {
        ++generation
        active = false
        cancelTimer?.invoke()
        cancelTimer = null
        transport.stop()
    }

    fun selectAccount() {
        val current = account()
        if (owner == current) return
        val previous = owner
        invalidate()
        owner = current
        if (previous != null || current == null) cache.clear()
        publish(BleViewState(sample = current?.let { cache.read(it) }))
    }

    fun forget() {
        invalidate()
        owner = null
        cache.clear()
        publish(BleViewState())
    }

    fun stop() {
        invalidate()
        publish(
            state.copy(phase = BlePhase.STOPPED, message = "Stopped. Saved readings are not live.")
        )
    }

    private fun ready(): Boolean {
        selectAccount()
        if (owner == null) {
            publish(BleViewState(message = "Sign in before starting Direct BLE."))
            return false
        }
        val issue =
            if (!permission()) "Nearby Devices permission required." else transport.availability()
        if (issue != null) {
            invalidate()
            publish(state.copy(phase = BlePhase.UNAVAILABLE, message = issue))
            return false
        }
        return true
    }

    fun checkAccess() {
        selectAccount()
        if (active && (!permission() || transport.availability() != null)) {
            invalidate()
            publish(
                state.copy(
                    phase = BlePhase.UNAVAILABLE,
                    message =
                        "Bluetooth or Nearby Devices access unavailable. Start again when available.",
                )
            )
        }
    }

    fun scan() {
        if (!ready()) return
        invalidate()
        active = true
        retries = 0
        publish(
            state.copy(
                phase = BlePhase.SCANNING,
                message = "Scanning for 12 seconds. Select your own strap.",
                candidates = emptyList(),
                selected = null,
                details = "",
            )
        )
        val ticket = generation
        try {
            transport.scan(events(ticket))
        } catch (_: Exception) {
            failure(ticket, "Scan could not start.", false)
            return
        }
        cancelTimer =
            timer.after(12000) {
                if (valid(ticket)) {
                    invalidate()
                    publish(
                        state.copy(
                            phase = BlePhase.IDLE,
                            message = "Scan finished. Select a candidate or scan again.",
                        )
                    )
                }
            }
    }

    fun connect(id: String) {
        if (!ready()) return
        val selected = state.candidates.find { it.id == id } ?: return
        retries = 0
        beginConnect(selected)
    }

    private fun beginConnect(selected: BleCandidate) {
        invalidate()
        active = true
        lastWrite = Long.MIN_VALUE
        publish(
            state.copy(
                phase = BlePhase.CONNECTING,
                selected = selected,
                sample = state.sample?.copy(receivedElapsed = 0),
                details = "",
                message = "Connecting and checking standard HR notifications…",
            )
        )
        val ticket = generation
        try {
            transport.connect(selected, events(ticket))
        } catch (_: Exception) {
            failure(ticket, "Connection failed.", true)
            return
        }
        cancelTimer =
            timer.after(15000) { failure(ticket, "Connection or subscription timed out.", true) }
    }

    private fun valid(ticket: Long): Boolean {
        if (account() != owner) {
            selectAccount()
            return false
        }
        if (!permission()) {
            invalidate()
            publish(
                state.copy(
                    phase = BlePhase.UNAVAILABLE,
                    message = "Nearby Devices permission revoked.",
                )
            )
            return false
        }
        return active && ticket == generation && owner != null
    }

    private fun events(ticket: Long) =
        object : BleTransport.Events {
            override fun candidate(candidate: BleCandidate) {
                if (!valid(ticket) || state.phase != BlePhase.SCANNING) return
                if (state.candidates.none { it.id == candidate.id } && state.candidates.size < 30)
                    publish(state.copy(candidates = state.candidates + candidate))
            }

            override fun subscribed(details: String) {
                if (!valid(ticket) || state.phase != BlePhase.CONNECTING) return
                cancelTimer?.invoke()
                cancelTimer = null
                publish(
                    state.copy(
                        phase = BlePhase.LIVE,
                        message = "Subscribed. Waiting for a valid HR measurement.",
                        details = details.take(300),
                    )
                )
            }

            override fun packet(bytes: ByteArray) {
                if (!valid(ticket) || state.phase != BlePhase.LIVE) return
                val decoded = HeartRateMeasurement.decode(bytes)
                if (decoded == null) {
                    publish(
                        state.copy(
                            message =
                                "Malformed or unavailable HR packet ignored; waiting for valid data."
                        )
                    )
                    return
                }
                val device = state.selected ?: return
                val sample =
                    BleSample(owner!!, device.name, device.family, wallTime(), elapsed(), decoded)
                // Keep a single bounded encrypted snapshot. No raw stream, network or account ID on
                // BLE.
                if (lastWrite == Long.MIN_VALUE || elapsed() - lastWrite >= 5000) {
                    try {
                        cache.write(sample, bytes)
                        lastWrite = elapsed()
                    } catch (_: Exception) {
                        failure(ticket, "Encrypted BLE storage unavailable.", false)
                        return
                    }
                }
                if (!valid(ticket)) return
                publish(
                    state.copy(
                        sample = sample,
                        message = "Standard HR received. Receipt time, not a sensor clock.",
                    )
                )
            }

            override fun failed(message: String, retryable: Boolean) =
                failure(ticket, message, retryable)
        }

    private fun failure(ticket: Long, message: String, retryable: Boolean) {
        if (!valid(ticket)) return
        val selected = state.selected
        invalidate()
        if (
            retryable &&
                selected != null &&
                retries < 2 &&
                permission() &&
                transport.availability() == null
        ) {
            retries++
            active = true
            val retryTicket = generation
            publish(
                state.copy(phase = BlePhase.RETRYING, message = "$message Retry $retries of 2.")
            )
            cancelTimer =
                timer.after(retries * 2000L) { if (valid(retryTicket)) beginConnect(selected) }
        } else
            publish(
                state.copy(
                    phase = if (retryable) BlePhase.ERROR else BlePhase.UNSUPPORTED,
                    message = message,
                )
            )
    }
}
