package io.github.astrasler.whooplens

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import java.util.UUID

internal fun blePermissions(context: Context): Boolean =
    listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT).all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }

/** Foreground transport. Only the standard HR CCCD is written. No proprietary commands. */
@SuppressLint(
    "MissingPermission"
) // Every entry/callback checks runtime permission; revocation is caught.
internal class AndroidBleTransport(private val context: Context) : BleTransport {
    private val main = Handler(Looper.getMainLooper())
    private val adapter
        get() = context.getSystemService(BluetoothManager::class.java)?.adapter

    private var scanner: BluetoothLeScanner? = null
    private var scanCallback: ScanCallback? = null
    private var gatt: BluetoothGatt? = null
    private var receiver: BleTransport.Events? = null

    override fun availability(): String? =
        try {
            when {
                !context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) ||
                    adapter == null -> "Bluetooth LE is unavailable on this device."
                !blePermissions(context) -> "Nearby Devices permission required."
                adapter?.isEnabled != true -> "Bluetooth is off. Enable it in Android settings."
                else -> null
            }
        } catch (_: SecurityException) {
            "Nearby Devices permission unavailable."
        }

    override fun scan(events: BleTransport.Events) {
        stop()
        availability()?.let {
            events.failed(it, false)
            return
        }
        receiver = events
        val callback =
            object : ScanCallback() {
                override fun onScanResult(callbackType: Int, result: ScanResult) {
                    main.post {
                        if (scanCallback !== this || !blePermissions(context)) return@post
                        try {
                            val services =
                                result.scanRecord
                                    ?.serviceUuids
                                    .orEmpty()
                                    .map { it.uuid.toString() }
                                    .toSet()
                            val candidate =
                                BleCandidate.identify(
                                    result.device.address,
                                    result.scanRecord?.deviceName ?: result.device.name,
                                    services,
                                )
                            candidate?.let { events.candidate(it) }
                        } catch (_: SecurityException) {
                            events.failed("Nearby Devices permission revoked.", false)
                        }
                    }
                }

                override fun onScanFailed(errorCode: Int) {
                    main.post {
                        if (scanCallback === this)
                            events.failed("Android could not scan. Wait, then retry.", false)
                    }
                }
            }
        scanCallback = callback
        scanner = adapter?.bluetoothLeScanner
        try {
            val scan = scanner ?: error("Unavailable")
            // Bounded user scan includes name-only candidates; other advertisements are discarded.
            scan.startScan(
                null,
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
                callback,
            )
        } catch (_: Exception) {
            events.failed(
                "Bluetooth scan unavailable. Check Nearby Devices permission and Bluetooth.",
                false,
            )
        }
    }

    override fun connect(candidate: BleCandidate, events: BleTransport.Events) {
        stop()
        availability()?.let {
            events.failed(it, false)
            return
        }
        receiver = events
        val callback =
            object : BluetoothGattCallback() {
                private fun dispatch(g: BluetoothGatt, block: () -> Unit) {
                    main.post {
                        if (g !== gatt || receiver !== events) return@post
                        if (!blePermissions(context)) {
                            events.failed("Nearby Devices permission revoked.", false)
                            return@post
                        }
                        try {
                            block()
                        } catch (_: SecurityException) {
                            events.failed("Nearby Devices permission revoked.", false)
                        } catch (_: Exception) {
                            events.failed("Bluetooth operation failed.", true)
                        }
                    }
                }

                override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) =
                    dispatch(g) {
                        if (
                            status != BluetoothGatt.GATT_SUCCESS ||
                                newState == BluetoothProfile.STATE_DISCONNECTED
                        )
                            events.failed("Device disconnected or connection failed.", true)
                        else if (
                            newState == BluetoothProfile.STATE_CONNECTED && !g.discoverServices()
                        )
                            events.failed("GATT discovery could not start.", true)
                    }

                override fun onServicesDiscovered(g: BluetoothGatt, status: Int) =
                    dispatch(g) {
                        if (status != BluetoothGatt.GATT_SUCCESS) {
                            events.failed("GATT discovery failed.", true)
                            return@dispatch
                        }
                        val evidence = gattEvidence(g)
                        val service = g.getService(UUID.fromString(HR_SERVICE))
                        val characteristic =
                            service?.getCharacteristic(UUID.fromString(HR_CHARACTERISTIC))
                        val descriptor = characteristic?.getDescriptor(UUID.fromString(HR_CCCD))
                        if (
                            characteristic == null ||
                                descriptor == null ||
                                characteristic.properties and
                                    BluetoothGattCharacteristic.PROPERTY_NOTIFY == 0
                        ) {
                            events.failed(
                                "Standard HR notifications are not exposed. Enable supported HR broadcast on your strap if available. No unlock commands were sent. $evidence",
                                false,
                            )
                            return@dispatch
                        }
                        if (
                            !g.setCharacteristicNotification(characteristic, true) ||
                                g.writeDescriptor(
                                    descriptor,
                                    BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE,
                                ) != BluetoothStatusCodes.SUCCESS
                        )
                            events.failed("HR notification subscription could not start.", false)
                    }

                override fun onDescriptorWrite(
                    g: BluetoothGatt,
                    descriptor: BluetoothGattDescriptor,
                    status: Int,
                ) =
                    dispatch(g) {
                        if (
                            descriptor.uuid != UUID.fromString(HR_CCCD) ||
                                descriptor.characteristic.uuid != UUID.fromString(HR_CHARACTERISTIC)
                        )
                            return@dispatch
                        if (status == BluetoothGatt.GATT_SUCCESS)
                            events.subscribed(
                                "Standard HR 180D / 2A37 · notify + CCCD confirmed · ${g.services.size} GATT services · ${gattEvidence(g)}"
                            )
                        else
                            events.failed(
                                "Android rejected HR notification subscription. OS pairing may be required; no proprietary setup was attempted.",
                                false,
                            )
                    }

                override fun onCharacteristicChanged(
                    g: BluetoothGatt,
                    characteristic: BluetoothGattCharacteristic,
                    value: ByteArray,
                ) {
                    val copy = value.copyOf()
                    dispatch(g) {
                        if (characteristic.uuid == UUID.fromString(HR_CHARACTERISTIC))
                            events.packet(copy)
                    }
                }
            }
        try {
            gatt =
                adapter
                    ?.getRemoteDevice(candidate.id)
                    ?.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
            if (gatt == null) events.failed("Bluetooth connection unavailable.", true)
        } catch (_: Exception) {
            events.failed("Bluetooth connection unavailable.", true)
        }
    }

    private fun gattEvidence(g: BluetoothGatt): String {
        val services = g.services.orEmpty()
        return StrapObservation.fromGatt(
                services.map { it.uuid.toString() }.toSet(),
                services.flatMap { it.characteristics.orEmpty() }.map { it.uuid.toString() }.toSet(),
            )
            .evidenceLine()
    }

    override fun stop() {
        receiver = null
        val callback = scanCallback
        scanCallback = null
        try {
            if (callback != null) scanner?.stopScan(callback)
        } catch (_: Exception) {}
        scanner = null
        val previous = gatt
        gatt = null
        try {
            previous?.disconnect()
        } catch (_: Exception) {}
        try {
            previous?.close()
        } catch (_: Exception) {}
    }
}
