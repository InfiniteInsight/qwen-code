package com.qwen.mobileshell

import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.util.Locale

internal sealed class QwenRcDeepLink {
    data class OpenSession(
        val sessionId: String,
        val eventId: String? = null,
        val cwd: String? = null,
    ) : QwenRcDeepLink() {
        fun toNavigation(): ConnectionNavigation =
            ConnectionNavigation(session = sessionId, ui = true, event = eventId)
    }

    data class OpenPermission(val permissionId: String) : QwenRcDeepLink() {
        fun toNavigation(): ConnectionNavigation =
            ConnectionNavigation(ui = true, permission = permissionId)
    }

    data class PairDaemon(val code: String, val daemonOrigin: String) : QwenRcDeepLink()

    data class Invalid(val reason: String) : QwenRcDeepLink()

    companion object {
        private val identifier = Regex("[A-Za-z0-9_-]{1,128}")
        private val eventNumeric = Regex("[0-9]{1,12}")
        private val pairCode = Regex("[A-Za-z0-9-]{4,64}")

        fun parseSchemeUri(raw: String?): QwenRcDeepLink {
            if (raw.isNullOrBlank() || raw.length > 4096) return Invalid("empty or oversized link")
            if (raw.contains("%00", ignoreCase = true) || raw.any { it.isISOControl() }) {
                return Invalid("invalid link")
            }
            val uri = try {
                URI(raw)
            } catch (_: Exception) {
                return Invalid("invalid link")
            }
            if (!uri.scheme.equals("qwen-rc", ignoreCase = true) || uri.rawUserInfo != null) {
                return Invalid("unsupported scheme")
            }
            val host = uri.host?.lowercase(Locale.ROOT) ?: return Invalid("missing route")
            val path = uri.rawPath.orEmpty()
            val params = parseQuery(uri.rawQuery) ?: return Invalid("malformed query")

            return when (host) {
                "session" -> {
                    if ("url" in params) return Invalid("daemon override forbidden on session link")
                    if (params.keys.any { it != "event" && it != "cwd" }) return Invalid("unsupported session parameter")
                    val sid = path.removePrefix("/")
                    if (!identifier.matches(sid)) return Invalid("invalid link")
                    val event = params["event"]
                    if (event != null && !eventNumeric.matches(event)) return Invalid("invalid event id")
                    val cwd = params["cwd"]?.takeIf { it.isNotBlank() && it.length <= 1024 }
                    OpenSession(sid, event, cwd)
                }
                "permission" -> {
                    if ("url" in params) return Invalid("daemon override forbidden on permission link")
                    if (params.isNotEmpty()) return Invalid("unsupported permission parameter")
                    val pid = path.removePrefix("/")
                    if (!identifier.matches(pid)) return Invalid("invalid link")
                    OpenPermission(pid)
                }
                "pair" -> {
                    if (path.isNotEmpty() && path != "/") return Invalid("invalid pair path")
                    if (params.keys.any { it != "code" && it != "url" }) return Invalid("unsupported pair parameter")
                    val code = params["code"]?.trim().orEmpty()
                    val urlRaw = params["url"]?.trim().orEmpty()
                    if (!pairCode.matches(code)) return Invalid("invalid pairing code")
                    val canonical = OriginPolicy.canonicalRoot(urlRaw)
                        ?: return Invalid("invalid daemon origin")
                    if (!canonical.startsWith("https://")) {
                        return Invalid("pairing deep link requires https://")
                    }
                    PairDaemon(code, canonical)
                }
                else -> Invalid("unknown route")
            }
        }

        fun parseQrPayload(raw: String?): PairDaemon? {
            if (raw.isNullOrBlank() || raw.length > 2048 || raw.any { it.isISOControl() }) return null
            if (!raw.startsWith("qwen-rc-pair:", ignoreCase = true)) return null
            val rest = raw.substring("qwen-rc-pair:".length)
            val parts = rest.split(';')
            if (parts.isEmpty()) return null
            val code = parts[0].trim()
            if (!pairCode.matches(code)) return null
            var urlValue: String? = null
            for (part in parts.drop(1)) {
                if (part.isBlank()) continue
                val kv = part.split('=', limit = 2)
                if (kv.size != 2 || !kv[0].equals("url", ignoreCase = true) || urlValue != null) return null
                urlValue = kv[1].trim()
            }
            val canonical = urlValue?.let { OriginPolicy.canonicalRoot(it) } ?: return null
            if (!canonical.startsWith("https://")) return null
            return PairDaemon(code, canonical)
        }

        fun formatCertSha256GroupedHex(derBytes: ByteArray): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(derBytes)
            val sb = StringBuilder(digest.size * 2 + 15)
            for (i in digest.indices) {
                if (i > 0 && i % 2 == 0) sb.append(' ')
                sb.append(String.format(Locale.US, "%02X", digest[i].toInt() and 0xFF))
            }
            return sb.toString()
        }

        private fun parseQuery(rawQuery: String?): Map<String, String>? {
            if (rawQuery.isNullOrEmpty()) return emptyMap()
            val out = mutableMapOf<String, String>()
            for (part in rawQuery.split('&')) {
                val kv = part.split('=', limit = 2)
                if (kv.size != 2 || kv[0].isEmpty() || out.containsKey(kv[0])) return null
                val decoded = try {
                    URLDecoder.decode(kv[1].replace("+", "%2B"), Charsets.UTF_8.name())
                } catch (_: Exception) {
                    return null
                }
                if (decoded.any { it.isISOControl() }) return null
                out[kv[0]] = decoded
            }
            return out
        }
    }
}
