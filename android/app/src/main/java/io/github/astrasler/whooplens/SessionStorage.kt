package io.github.astrasler.whooplens

import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal interface SessionStorage {
  fun read(): String?
  fun write(value: String)
  fun clear()
}

internal class MemorySessionStorage : SessionStorage {
  private var value: String? = null
  override fun read(): String? = value
  override fun write(value: String) { this.value = value }
  override fun clear() { value = null }
}

internal interface CredentialBlob {
  fun read(): ByteArray?
  fun writeAtomically(value: ByteArray)
  fun clear()
}

internal interface CredentialKeys {
  fun get(create: Boolean): SecretKey
  fun clear()
}

/** Only authenticated ciphertext reaches the filesystem; each write has a new IV. */
internal class EncryptedSessionStorage(
  private val blob: CredentialBlob,
  private val keys: CredentialKeys,
  private val binding: String = "io.github.astrasler.whooplens|https://auth.whooplens.tech|https://whooplens.tech/mcp|v1",
  private val maxPlaintextBytes: Int = 100000
) : SessionStorage {
  @Synchronized override fun read(): String? {
    val bytes = blob.read() ?: return null
    require(bytes.size in 30..(maxPlaintextBytes + 32) && bytes[0] == 1.toByte()) { "Invalid credential storage" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, keys.get(false), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
    cipher.updateAAD(binding.toByteArray(Charsets.UTF_8))
    return cipher.doFinal(bytes.copyOfRange(13, bytes.size)).toString(Charsets.UTF_8)
  }

  @Synchronized override fun write(value: String) {
    require(value.toByteArray(Charsets.UTF_8).size <= maxPlaintextBytes) { "Invalid credential storage" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, keys.get(true))
    cipher.updateAAD(binding.toByteArray(Charsets.UTF_8))
    require(cipher.iv.size == 12) { "Invalid credential cipher" }
    blob.writeAtomically(byteArrayOf(1) + cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)))
  }

  @Synchronized override fun clear() {
    // Erase the key as well as the file so a failed filesystem delete cannot restore a session.
    try { keys.clear() } finally { blob.clear() }
  }
}
