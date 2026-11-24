package com.qwen.mobileshell

internal data class WatchedSessionPointer(
    val sessionId: String,
    val lastEventId: String? = null,
    val title: String? = null,
    val cwd: String? = null,
    val outbox: List<String> = emptyList(),
)

internal data class BridgeRpcRequest(
    val id: String,
    val method: String,
    val token: String? = null,
    val url: String? = null,
    val reason: String? = null,
    val sessionId: String? = null,
    val watched: WatchedSessionPointer? = null,
    val watchedCleared: Boolean = false,
    val filePath: String? = null,
    val workspace: String? = null,
    val filename: String? = null,
    val dataBase64: String? = null,
    val mimeType: String? = null,
)

internal object QwenBridgeInjector {
    const val JS_OBJECT_NAME = "qwenNativeBridge"
    const val BRIDGE_VERSION = 1

    fun originRule(canonicalOrigin: String): String = canonicalOrigin.removeSuffix("/")

    fun jsStringLiteral(value: String?): String {
        if (value == null) return "null"
        val sb = StringBuilder(value.length + 8)
        sb.append('"')
        for (ch in value) {
            when (ch) {
                '\\' -> sb.append("\\\\")
                '"' -> sb.append("\\\"")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\u2028' -> sb.append("\\u2028")
                '\u2029' -> sb.append("\\u2029")
                '<' -> sb.append("\\u003c")
                '>' -> sb.append("\\u003e")
                else -> if (ch.code < 0x20) {
                    sb.append(String.format("\\u%04x", ch.code))
                } else {
                    sb.append(ch)
                }
            }
        }
        sb.append('"')
        return sb.toString()
    }

    fun buildDocumentStartScript(
        shellVersion: String,
        pendingToken: String?,
        connectionName: String? = null,
    ): String {
        val shellLit = jsStringLiteral(shellVersion)
        val tokenLit = jsStringLiteral(pendingToken)
        val nameLit = jsStringLiteral(connectionName)
        return """
(function() {
  if (typeof window.qwen === 'object' && window.qwen !== null) return;
  var channel = typeof window.$JS_OBJECT_NAME === 'object' ? window.$JS_OBJECT_NAME : null;
  var seq = 0;
  var pending = Object.create(null);
  if (channel && typeof channel.addEventListener === 'function') {
    channel.addEventListener('message', function(ev) {
      try {
        var msg = JSON.parse(String(ev && ev.data || '{}'));
        var entry = msg && msg.id ? pending[msg.id] : null;
        if (!entry) return;
        delete pending[msg.id];
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(String(msg.error || 'bridge_error')));
      } catch (_e) {}
    });
  }
  function rpc(method, payload) {
    return new Promise(function(resolve, reject) {
      if (!channel || typeof channel.postMessage !== 'function') {
        reject(new Error('bridge_unavailable'));
        return;
      }
      var id = 'req-' + (++seq);
      pending[id] = { resolve: resolve, reject: reject };
      var body = Object.assign({ id: id, method: method }, payload || {});
      channel.postMessage(JSON.stringify(body));
    });
  }
  window.qwen = {
    platform: 'android-twa',
    version: { shell: $shellLit, bridge: $BRIDGE_VERSION },
    connectionName: $nameLit,
    __pendingToken: $tokenLit,
    getToken: function() { return rpc('getToken'); },
    setToken: function(t) { return rpc('setToken', { token: t === null || t === undefined ? null : String(t) }); },
    clearToken: function() { return rpc('clearToken'); },
    isBiometricAvailable: function() { return rpc('isBiometricAvailable'); },
    requireBiometric: function(reason) { return rpc('requireBiometric', { reason: String(reason || '') }); },
    openExternal: function(url) { return rpc('openExternal', { url: String(url || '') }); },
    showConnections: function() { return rpc('showConnections'); },
    setWatchedSession: function(ptr) {
      if (!ptr || !ptr.sessionId) return rpc('setWatchedSession', { cleared: true });
      var ob = Array.isArray(ptr.outbox)
        ? ptr.outbox.filter(function(x) { return typeof x === 'string' && x.trim().length > 0; }).slice(0, 32)
        : [];
      return rpc('setWatchedSession', {
        sessionId: String(ptr.sessionId),
        lastEventId: ptr.lastEventId === null || ptr.lastEventId === undefined ? null : String(ptr.lastEventId),
        title: ptr.title ? String(ptr.title) : null,
        cwd: ptr.cwd ? String(ptr.cwd) : null,
        outbox: ob
      });
    },
    consumeDispatchedOutbox: function(sessionId) {
      if (!sessionId) return Promise.resolve([]);
      return rpc('consumeDispatchedOutbox', { sessionId: String(sessionId) });
    },
    downloadWorkspaceFile: function(opts) {
      if (!opts || !opts.path) return Promise.reject(new Error('invalid_path'));
      return rpc('downloadWorkspaceFile', {
        filePath: String(opts.path),
        workspace: opts.workspace ? String(opts.workspace) : null,
        filename: opts.filename ? String(opts.filename) : null
      });
    },
    saveBase64File: function(opts) {
      if (!opts || typeof opts.dataBase64 !== 'string') return Promise.reject(new Error('invalid_data'));
      return rpc('saveBase64File', {
        dataBase64: opts.dataBase64,
        filename: opts.filename ? String(opts.filename) : null,
        mimeType: opts.mimeType ? String(opts.mimeType) : null
      });
    }
  };
})();
        """.trimIndent()
    }

    fun formatSuccessReply(id: String, resultJsonLiteral: String): String =
        """{"id":${jsStringLiteral(id)},"ok":true,"result":$resultJsonLiteral}"""

    fun formatErrorReply(id: String, errorCode: String): String =
        """{"id":${jsStringLiteral(id)},"ok":false,"error":${jsStringLiteral(errorCode)}}"""

    private const val MAX_RPC_CHARS = 40 * 1024 * 1024

    fun parseRequest(raw: String?): BridgeRpcRequest? {
        if (raw.isNullOrBlank() || raw.length > MAX_RPC_CHARS) return null
        val fields = SimpleJson.parseFlatObject(raw) ?: return null
        val id = (fields["id"] as? String)?.takeIf { it.isNotBlank() && it.length <= 64 } ?: return null
        val method = (fields["method"] as? String)?.takeIf { it.isNotBlank() && it.length <= 64 } ?: return null
        if (method != "saveBase64File" && raw.length > 32768) return null
        val cleared = fields["cleared"] == true
        val sessionId = (fields["sessionId"] as? String)?.takeIf { it.isNotBlank() && it.length <= 128 }
        val watched = if (method == "setWatchedSession" && !cleared && sessionId != null) {
            WatchedSessionPointer(
                sessionId = sessionId,
                lastEventId = fields["lastEventId"] as? String,
                title = fields["title"] as? String,
                cwd = fields["cwd"] as? String,
                outbox = SimpleJson.parseStringArray(fields["outbox"] as? String),
            )
        } else null
        return BridgeRpcRequest(
            id = id,
            method = method,
            token = fields["token"] as? String,
            url = fields["url"] as? String,
            reason = fields["reason"] as? String,
            sessionId = sessionId,
            watched = watched,
            watchedCleared = cleared || (method == "setWatchedSession" && watched == null),
            filePath = (fields["filePath"] as? String)?.takeIf { it.isNotBlank() && it.length <= 2048 },
            workspace = (fields["workspace"] as? String)?.takeIf { it.isNotBlank() && it.length <= 2048 },
            filename = (fields["filename"] as? String)?.takeIf { it.isNotBlank() && it.length <= 256 },
            dataBase64 = (fields["dataBase64"] as? String)?.takeIf { it.isNotEmpty() },
            mimeType = (fields["mimeType"] as? String)?.takeIf { it.isNotBlank() && it.length <= 128 },
        )
    }
}

internal object SimpleJson {
    fun formatStringArray(items: List<String>): String =
        items.joinToString(",", "[", "]") { QwenBridgeInjector.jsStringLiteral(it) }

    fun parseStringArray(raw: String?): List<String> {
        if (raw.isNullOrBlank()) return emptyList()
        var i = skipWs(raw, 0)
        if (i >= raw.length || raw[i] != '[') return emptyList()
        i = skipWs(raw, i + 1)
        if (i < raw.length && raw[i] == ']') {
            return if (skipWs(raw, i + 1) == raw.length) emptyList() else emptyList()
        }
        val out = ArrayList<String>()
        while (i < raw.length) {
            val strRes = readString(raw, i) ?: return emptyList()
            if (strRes.first.isNotBlank()) out.add(strRes.first)
            i = skipWs(raw, strRes.second)
            if (i >= raw.length) return emptyList()
            if (raw[i] == ']') {
                return if (skipWs(raw, i + 1) == raw.length) out else emptyList()
            }
            if (raw[i] != ',') return emptyList()
            i = skipWs(raw, i + 1)
        }
        return emptyList()
    }

    fun parseFlatObject(raw: String): Map<String, Any?>? {
        var i = skipWs(raw, 0)
        if (i >= raw.length || raw[i] != '{') return null
        i = skipWs(raw, i + 1)
        val out = LinkedHashMap<String, Any?>()
        if (i < raw.length && raw[i] == '}') {
            return if (skipWs(raw, i + 1) == raw.length) out else null
        }
        while (i < raw.length) {
            val keyRes = readString(raw, i) ?: return null
            val key = keyRes.first
            i = skipWs(raw, keyRes.second)
            if (i >= raw.length || raw[i] != ':') return null
            i = skipWs(raw, i + 1)
            val valRes = readValue(raw, i) ?: return null
            out[key] = valRes.first
            i = skipWs(raw, valRes.second)
            if (i >= raw.length) return null
            if (raw[i] == '}') {
                return if (skipWs(raw, i + 1) == raw.length) out else null
            }
            if (raw[i] != ',') return null
            i = skipWs(raw, i + 1)
        }
        return null
    }

    private fun skipWs(s: String, start: Int): Int {
        var i = start
        while (i < s.length && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) i++
        return i
    }

    private fun readValue(s: String, start: Int): Pair<Any?, Int>? {
        if (start >= s.length) return null
        return when (s[start]) {
            '"' -> readString(s, start)
            't' -> if (s.startsWith("true", start)) true to (start + 4) else null
            'f' -> if (s.startsWith("false", start)) false to (start + 5) else null
            'n' -> if (s.startsWith("null", start)) null to (start + 4) else null
            '{', '[' -> skipNested(s, start)
            else -> readNumber(s, start)
        }
    }

    private fun readNumber(s: String, start: Int): Pair<String, Int>? {
        var i = start
        if (s[i] == '-') i++
        val digitsStart = i
        while (i < s.length && (s[i].isDigit() || s[i] == '.' || s[i] == 'e' || s[i] == 'E' || s[i] == '+' || s[i] == '-')) i++
        if (i == digitsStart) return null
        return s.substring(start, i) to i
    }

    private fun skipNested(s: String, start: Int): Pair<String, Int>? {
        var depth = 0
        var i = start
        while (i < s.length) {
            when (s[i]) {
                '"' -> {
                    val str = readString(s, i) ?: return null
                    i = str.second
                    continue
                }
                '{', '[' -> depth++
                '}', ']' -> {
                    depth--
                    if (depth == 0) return s.substring(start, i + 1) to (i + 1)
                }
            }
            i++
        }
        return null
    }

    private fun readString(s: String, start: Int): Pair<String, Int>? {
        if (start >= s.length || s[start] != '"') return null
        val sb = StringBuilder()
        var i = start + 1
        while (i < s.length) {
            val ch = s[i++]
            if (ch == '"') return sb.toString() to i
            if (ch == '\\') {
                if (i >= s.length) return null
                when (val esc = s[i++]) {
                    '"', '\\', '/' -> sb.append(esc)
                    'b' -> sb.append('\b')
                    'f' -> sb.append('\u000C')
                    'n' -> sb.append('\n')
                    'r' -> sb.append('\r')
                    't' -> sb.append('\t')
                    'u' -> {
                        if (i + 4 > s.length) return null
                        val hex = s.substring(i, i + 4)
                        val code = hex.toIntOrNull(16) ?: return null
                        sb.append(code.toChar())
                        i += 4
                    }
                    else -> return null
                }
            } else {
                sb.append(ch)
            }
        }
        return null
    }
}
