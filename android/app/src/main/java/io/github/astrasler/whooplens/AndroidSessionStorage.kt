package io.github.astrasler.whooplens

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** App-private, credential-encrypted storage excluded from backup and device transfer. */
internal fun androidSessionStorage(context: Context): SessionStorage {
  val atomic = AtomicFile(File(context.noBackupFilesDir, "oauth-session.bin"))
  val blob = object : CredentialBlob {
    override fun read(): ByteArray? {
      if (!atomic.baseFile.exists() && !File(atomic.baseFile.path + ".bak").exists()) return null
      return atomic.openRead().use {
        val bytes = it.readNBytes(131073)
        require(bytes.size <= 131072) { "Invalid credential storage" }
        bytes
      }
    }
    override fun writeAtomically(value: ByteArray) {
      val stream = atomic.startWrite()
      try {
        stream.write(value)
        atomic.finishWrite(stream)
      } catch (_: Exception) {
        atomic.failWrite(stream)
        error("Credential storage unavailable")
      }
    }
    override fun clear() { atomic.delete() }
  }
  val keys = object : CredentialKeys {
    private val alias = "whooplens.oauth.v1"
    private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    override fun get(create: Boolean): SecretKey {
      val existing = store().getKey(alias, null) as? SecretKey
      if (existing != null) return existing
      check(create) { "Credential key unavailable" }
      return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
        init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setKeySize(256)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setRandomizedEncryptionRequired(true)
          .build())
      }.generateKey()
    }
    override fun clear() { store().deleteEntry(alias) }
  }
  return EncryptedSessionStorage(blob, keys)
}

/** One session owner prevents concurrent Activity instances from racing token rotation. */
internal object AndroidSessions {
  private var session: PrivateSession? = null
  @Synchronized fun get(context: Context): PrivateSession = session ?: PrivateSession(
    storage = androidSessionStorage(context.applicationContext)
  ).also { session = it }
}
