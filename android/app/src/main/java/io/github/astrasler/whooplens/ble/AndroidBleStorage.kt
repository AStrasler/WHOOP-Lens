package io.github.astrasler.whooplens

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * Separate filename, key alias and authenticated binding; never shares the OAuth/dashboard blob.
 */
internal fun androidBleStorage(context: Context): SessionStorage {
    val file = AtomicFile(File(context.noBackupFilesDir, "direct-ble.bin"))
    val blob =
        object : CredentialBlob {
            override fun read(): ByteArray? {
                if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists())
                    return null
                return file.openRead().use {
                    val bytes = it.readNBytes(8225)
                    require(bytes.size <= 8224)
                    bytes
                }
            }

            override fun writeAtomically(value: ByteArray) {
                val stream = file.startWrite()
                try {
                    stream.write(value)
                    file.finishWrite(stream)
                } catch (e: Exception) {
                    file.failWrite(stream)
                    throw e
                }
            }

            override fun clear() = file.delete()
        }
    val keys =
        object : CredentialKeys {
            private val alias = "whooplens.direct-ble.v1"

            private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

            override fun get(create: Boolean): SecretKey {
                val existing = store().getKey(alias, null) as? SecretKey
                if (existing != null) return existing
                check(create)
                return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
                    .apply {
                        init(
                            KeyGenParameterSpec.Builder(
                                    alias,
                                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                                )
                                .setKeySize(256)
                                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                                .setRandomizedEncryptionRequired(true)
                                .build()
                        )
                    }
                    .generateKey()
            }

            override fun clear() = store().deleteEntry(alias)
        }
    return EncryptedSessionStorage(
        blob,
        keys,
        binding = "io.github.astrasler.whooplens|direct-ble|v1",
        maxPlaintextBytes = 8192,
    )
}
