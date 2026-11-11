package io.github.astrasler.whooplens

import java.net.URI

internal fun trustedHttpsUrl(value: String, host: String): String {
    val uri = URI(value)
    require(uri.scheme == "https" && uri.host == host && (uri.port == -1 || uri.port == 443) &&
        uri.rawUserInfo == null && uri.rawFragment == null) { "Untrusted HTTPS endpoint" }
    return value
}
