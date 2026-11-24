package com.qwen.mobileshell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal data class SseAlert(
    val eventId: String?,
    val kind: String,
    val title: String,
    val body: String,
    val stopReason: String? = null,
)

/**
 * Pure line-by-line SSE parser for `/session/:id/events` frames.
 * Extracts actionable turn lifecycle alerts (approval needed, turn complete,
 * stream error) while tracking the latest `Last-Event-ID` cursor.
 */
internal class SseEventParser {
    var lastEventId: String? = null
        private set

    private var curId: String? = null
    private var curEvent: String? = null
    private val dataLines = mutableListOf<String>()

    fun feedLine(rawLine: String): SseAlert? {
        val line = rawLine.trimEnd('\r')
        if (line.isEmpty()) {
            val alert = dispatchFrame()
            curId = null
            curEvent = null
            dataLines.clear()
            return alert
        }
        if (line.startsWith(":")) return null
        val colon = line.indexOf(':')
        val field: String
        val value: String
        if (colon < 0) {
            field = line
            value = ""
        } else {
            field = line.substring(0, colon)
            val after = line.substring(colon + 1)
            value = if (after.startsWith(" ")) after.substring(1) else after
        }
        when (field) {
            "id" -> if (value.isNotEmpty() && !value.contains('\u0000')) {
                curId = value
                lastEventId = value
            }
            "event" -> curEvent = value
            "data" -> dataLines.add(value)
        }
        return null
    }

    private fun dispatchFrame(): SseAlert? {
        if (dataLines.isEmpty()) return null
        val payload = dataLines.joinToString("\n")
        val envelope = SimpleJson.parseFlatObject(payload) ?: return null
        val frameType = (envelope["type"] as? String) ?: curEvent ?: return null
        val frameId = curId ?: (envelope["id"] as? String)
        if (frameId != null) lastEventId = frameId
        val dataObj = (envelope["data"] as? String)?.let { SimpleJson.parseFlatObject(it) }

        return when (frameType) {
            "permission_request", "interaction_request" -> {
                val tool = (dataObj?.get("title") as? String)
                    ?: (dataObj?.get("toolName") as? String)
                    ?: "Approval requested"
                SseAlert(frameId, "permission", "Action required", tool)
            }
            "turn_complete" -> {
                val stop = (dataObj?.get("stopReason") as? String) ?: "end_turn"
                if (stop == "cancelled") null
                else SseAlert(
                    frameId,
                    "turn_complete",
                    "Turn finished",
                    if (stop == "end_turn") "Agent finished replying." else "Stopped ($stop) - tap to continue.",
                    stopReason = stop,
                )
            }
            "turn_error" -> {
                val detail = (dataObj?.get("message") as? String)
                    ?: (dataObj?.get("code") as? String)
                    ?: (dataObj?.get("error") as? String)
                    ?: "turn_error"
                SseAlert(frameId, "error", "Turn interrupted", detail)
            }
            "stream_error" -> {
                val code = (dataObj?.get("code") as? String)
                    ?: (dataObj?.get("error") as? String)
                    ?: "stream_error"
                SseAlert(frameId, "error", "Session interrupted", "Stream reported $code.")
            }
            else -> null
        }
    }
}

class BackgroundSseService : Service() {
    private data class Target(
        val profileId: String,
        val sessionId: String,
        val sessionTitle: String?,
        val lastEventId: String?,
        val cwd: String? = null,
    )

    private val running = AtomicBoolean(false)
    private val activeTarget = AtomicReference<Target?>(null)
    @Volatile private var activeConnection: HttpURLConnection? = null
    private var workerThread: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannels()
    }

    private fun acquireOrRefreshWakeLock() {
        try {
            val pm = getSystemService(PowerManager::class.java) ?: return
            val wl = wakeLock ?: pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "QwenMobileShell:BgSse",
            ).apply { setReferenceCounted(false) }.also { wakeLock = it }
            wl.acquire(WAKE_LOCK_TIMEOUT_MS)
        } catch (_: Exception) {
            // Best-effort CPU wake lock during background session monitoring.
        }
    }

    private fun releaseWakeLock() {
        try {
            val wl = wakeLock
            if (wl != null && wl.isHeld) {
                wl.release()
            }
        } catch (_: Exception) {
            // Ignore already-released wake lock.
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopStreaming()
            stopSelf()
            return START_NOT_STICKY
        }
        val profileId = intent?.getStringExtra(EXTRA_PROFILE_ID)?.takeIf { it.isNotBlank() }
        val sessionId = intent?.getStringExtra(EXTRA_SESSION_ID)?.takeIf { it.isNotBlank() }
        if (profileId == null || sessionId == null) {
            stopStreaming()
            stopSelf()
            return START_NOT_STICKY
        }
        val title = intent.getStringExtra(EXTRA_SESSION_TITLE)
        val cursor = intent.getStringExtra(EXTRA_LAST_EVENT_ID)
        val cwd = intent.getStringExtra(EXTRA_SESSION_CWD)
        val outboxRaw = intent.getStringExtra(EXTRA_OUTBOX_JSON)
        if (outboxRaw != null) {
            syncOutbox(sessionId, SimpleJson.parseStringArray(outboxRaw))
        }
        val next = Target(profileId, sessionId, title, cursor, cwd)

        val fg = buildForegroundNotification(title ?: sessionId)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(FG_NOTIFICATION_ID, fg, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(FG_NOTIFICATION_ID, fg)
        }
        acquireOrRefreshWakeLock()

        val prev = activeTarget.getAndSet(next)
        if (prev?.profileId != next.profileId || prev.sessionId != next.sessionId) {
            activeConnection?.disconnect()
        }
        ensureWorker()
        return START_STICKY
    }

    override fun onDestroy() {
        stopStreaming()
        super.onDestroy()
    }

    private fun stopStreaming() {
        running.set(false)
        activeTarget.set(null)
        activeConnection?.disconnect()
        activeConnection = null
        workerThread?.interrupt()
        workerThread = null
        releaseWakeLock()
    }

    private fun ensureWorker() {
        if (!running.compareAndSet(false, true)) return
        workerThread = Thread({
            var backoffMs = 1_000L
            var cursor: String? = activeTarget.get()?.lastEventId
            var trackedSession: String? = activeTarget.get()?.sessionId
            while (running.get() && !Thread.currentThread().isInterrupted) {
                val target = activeTarget.get() ?: break
                if (target.sessionId != trackedSession) {
                    trackedSession = target.sessionId
                    cursor = target.lastEventId
                    backoffMs = 1_000L
                }
                val profile = try {
                    AndroidProfileStore(applicationContext).vault.load().profiles.find { it.id == target.profileId }
                } catch (_: Exception) {
                    null
                }
                val token = profile?.token
                if (profile == null || token.isNullOrEmpty()) {
                    stopSelf()
                    break
                }
                val parser = SseEventParser()
                var connectedOnce = false
                try {
                    val streamUrl = URL("${profile.origin}session/${Uri.encode(target.sessionId)}/events")
                    val conn = (streamUrl.openConnection() as HttpURLConnection).apply {
                        requestMethod = "GET"
                        connectTimeout = 15_000
                        readTimeout = 80_000 // > 3x gateway 25s heartbeat
                        useCaches = false
                        setRequestProperty("Accept", "text/event-stream")
                        setRequestProperty("Authorization", "Bearer $token")
                        if (!cursor.isNullOrBlank()) {
                            setRequestProperty("Last-Event-ID", cursor)
                        }
                    }
                    activeConnection = conn
                    val code = conn.responseCode
                    if (code == 401 || code == 403) {
                        conn.disconnect()
                        stopSelf()
                        break
                    }
                    if (code == 412) {
                        // Cursor fell behind WAL horizon: drop the stale cursor and
                        // immediately attach to the live tail so the stream stays open.
                        cursor = null
                        conn.disconnect()
                        connectedOnce = true
                        backoffMs = 250L
                    } else if (code == 404 || code == 409) {
                        conn.disconnect()
                        if (!target.cwd.isNullOrBlank() && tryResumeSession(profile.origin, token, target.sessionId, target.cwd)) {
                            cursor = null
                            connectedOnce = true
                            backoffMs = 250L
                        } else if (code == 404 && target.cwd.isNullOrBlank()) {
                            stopSelf()
                            break
                        }
                    } else if (code in 200..299) {
                        connectedOnce = true
                        backoffMs = 1_000L
                        acquireOrRefreshWakeLock()
                        BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { reader ->
                            while (running.get() && activeTarget.get()?.sessionId == target.sessionId) {
                                val line = reader.readLine() ?: break
                                val alert = parser.feedLine(line)
                                if (parser.lastEventId != null) {
                                    cursor = parser.lastEventId
                                }
                                if (alert != null && !ForegroundVisibility.isForeground) {
                                    if (alert.kind == "turn_complete" && alert.stopReason == "end_turn") {
                                        val nextQueued = popNextOutboxPrompt(target.sessionId)
                                        if (nextQueued != null) {
                                            dispatchQueuedPromptInBackground(
                                                profile.origin,
                                                token,
                                                target.sessionId,
                                                target.cwd,
                                                nextQueued,
                                            )
                                            continue
                                        }
                                    }
                                    postAlertNotification(target.sessionId, target.sessionTitle, target.cwd, alert)
                                }
                            }
                        }
                        conn.disconnect()
                    } else {
                        conn.disconnect()
                    }
                } catch (_: Exception) {
                    // Reconnect after bounded backoff while service remains active.
                } finally {
                    activeConnection = null
                }
                if (!running.get()) break
                if (!connectedOnce) {
                    backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
                }
                try {
                    Thread.sleep(backoffMs)
                } catch (_: InterruptedException) {
                    break
                }
            }
            running.set(false)
        }, "qwen-rc-bg-sse").also { it.isDaemon = true; it.start() }
    }

    private fun tryResumeSession(origin: String, token: String, sessionId: String, cwd: String): Boolean {
        return try {
            val resumeUrl = URL("${origin}session/${Uri.encode(sessionId)}/resume")
            val bodyBytes = """{"cwd":${QwenBridgeInjector.jsStringLiteral(cwd)}}""".toByteArray(Charsets.UTF_8)
            val conn = (resumeUrl.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 30_000
                useCaches = false
                doOutput = true
                setFixedLengthStreamingMode(bodyBytes.size)
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer $token")
            }
            try {
                conn.outputStream.use { it.write(bodyBytes) }
                conn.responseCode in 200..299
            } finally {
                conn.disconnect()
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun ensureChannels() {
        val mgr = getSystemService(NotificationManager::class.java) ?: return
        val streamChannel = NotificationChannel(
            CHANNEL_STREAM,
            getString(R.string.bg_sse_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.bg_sse_channel_desc)
            setShowBadge(false)
        }
        val alertChannel = NotificationChannel(
            CHANNEL_ALERTS,
            getString(R.string.bg_alert_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = getString(R.string.bg_alert_channel_desc)
        }
        mgr.createNotificationChannel(streamChannel)
        mgr.createNotificationChannel(alertChannel)
    }

    private fun buildForegroundNotification(label: String): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingOpen = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = Intent(this, BackgroundSseService::class.java).apply { action = ACTION_STOP }
        val pendingStop = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_STREAM)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(getString(R.string.bg_sse_notification_title))
            .setContentText(label)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(pendingOpen)
            .addAction(0, getString(R.string.bg_sse_disconnect), pendingStop)
            .build()
    }

    private fun postAlertNotification(sessionId: String, sessionTitle: String?, cwd: String?, alert: SseAlert) {
        val mgr = getSystemService(NotificationManager::class.java) ?: return
        val queryParts = mutableListOf<String>()
        if (!alert.eventId.isNullOrBlank() && alert.eventId.all { it.isDigit() }) {
            queryParts.add("event=${alert.eventId}")
        }
        if (!cwd.isNullOrBlank()) {
            queryParts.add("cwd=${Uri.encode(cwd)}")
        }
        val deepUri = buildString {
            append("qwen-rc://session/")
            append(Uri.encode(sessionId))
            if (queryParts.isNotEmpty()) {
                append('?')
                append(queryParts.joinToString("&"))
            }
        }
        val openIntent = Intent(Intent.ACTION_VIEW, Uri.parse(deepUri), this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            this,
            sessionId.hashCode(),
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val subtitle = if (!sessionTitle.isNullOrBlank()) "$sessionTitle: ${alert.body}" else alert.body
        val n = NotificationCompat.Builder(this, CHANNEL_ALERTS)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(alert.title)
            .setContentText(subtitle)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pending)
            .build()
        mgr.notify(ALERT_NOTIFICATION_BASE + (sessionId.hashCode() and 0x7FFF), n)
    }

    private fun dispatchQueuedPromptInBackground(
        origin: String,
        token: String,
        sessionId: String,
        cwd: String?,
        promptText: String,
    ) {
        acquireOrRefreshWakeLock()
        recordDispatchedOutbox(sessionId, promptText)
        Thread({
            var refused = false
            try {
                var code = postPromptOnce(origin, token, sessionId, promptText)
                if (code == 409 && !cwd.isNullOrBlank() && tryResumeSession(origin, token, sessionId, cwd)) {
                    code = postPromptOnce(origin, token, sessionId, promptText)
                }
                if (code in 400..599) {
                    refused = true
                }
            } catch (_: SocketTimeoutException) {
                // Gateway holds POST /session/:id/prompt open across the full turn (#38);
                // a read timeout after enqueue means the daemon is still running the turn.
            } catch (_: Exception) {
                // Connection drop mid-turn leaves the daemon turn running (#38).
            }
            if (refused) {
                rollbackDispatchedOutbox(sessionId, promptText)
            }
        }, "qwen-rc-bg-outbox").start()
    }

    private fun postPromptOnce(
        origin: String,
        token: String,
        sessionId: String,
        promptText: String,
    ): Int {
        val promptUrl = URL("${origin}session/${Uri.encode(sessionId)}/prompt")
        val bodyBytes = """{"prompt":${QwenBridgeInjector.jsStringLiteral(promptText)}}""".toByteArray(Charsets.UTF_8)
        val conn = (promptUrl.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 180_000
            useCaches = false
            doOutput = true
            setFixedLengthStreamingMode(bodyBytes.size)
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Authorization", "Bearer $token")
        }
        return try {
            conn.outputStream.use { it.write(bodyBytes) }
            conn.responseCode
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        const val ACTION_START = "com.qwen.mobileshell.BG_SSE_START"
        const val ACTION_STOP = "com.qwen.mobileshell.BG_SSE_STOP"
        const val EXTRA_PROFILE_ID = "profile_id"
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_SESSION_TITLE = "session_title"
        const val EXTRA_LAST_EVENT_ID = "last_event_id"
        const val EXTRA_SESSION_CWD = "session_cwd"
        const val EXTRA_OUTBOX_JSON = "session_outbox_json"

        private const val CHANNEL_STREAM = "qwen_rc_bg_stream"
        private const val CHANNEL_ALERTS = "qwen_rc_alerts"
        private const val FG_NOTIFICATION_ID = 4170
        private const val ALERT_NOTIFICATION_BASE = 5000
        private const val WAKE_LOCK_TIMEOUT_MS = 4L * 60L * 60L * 1000L

        private val outboxLock = Any()
        private val pendingOutboxBySession = ConcurrentHashMap<String, MutableList<String>>()
        private val dispatchedOutboxBySession = ConcurrentHashMap<String, MutableList<String>>()

        internal fun syncOutbox(sessionId: String, items: List<String>) {
            synchronized(outboxLock) {
                val alreadyDispatched = dispatchedOutboxBySession[sessionId].orEmpty().toMutableList()
                val filtered = ArrayList<String>(items.size)
                for (item in items) {
                    val idx = alreadyDispatched.indexOf(item)
                    if (idx >= 0) {
                        alreadyDispatched.removeAt(idx)
                    } else if (item.isNotBlank()) {
                        filtered.add(item)
                    }
                }
                if (filtered.isEmpty()) {
                    pendingOutboxBySession.remove(sessionId)
                } else {
                    pendingOutboxBySession[sessionId] = filtered
                }
            }
        }

        internal fun popNextOutboxPrompt(sessionId: String): String? {
            synchronized(outboxLock) {
                val list = pendingOutboxBySession[sessionId] ?: return null
                if (list.isEmpty()) {
                    pendingOutboxBySession.remove(sessionId)
                    return null
                }
                val next = list.removeAt(0)
                if (list.isEmpty()) {
                    pendingOutboxBySession.remove(sessionId)
                }
                return next
            }
        }

        private fun recordDispatchedOutbox(sessionId: String, promptText: String) {
            synchronized(outboxLock) {
                val list = dispatchedOutboxBySession.getOrPut(sessionId) { ArrayList() }
                list.add(promptText)
            }
        }

        private fun rollbackDispatchedOutbox(sessionId: String, promptText: String) {
            synchronized(outboxLock) {
                dispatchedOutboxBySession[sessionId]?.let { list ->
                    val idx = list.lastIndexOf(promptText)
                    if (idx >= 0) list.removeAt(idx)
                    if (list.isEmpty()) dispatchedOutboxBySession.remove(sessionId)
                }
                val pending = pendingOutboxBySession.getOrPut(sessionId) { ArrayList() }
                pending.add(0, promptText)
            }
        }

        internal fun consumeDispatchedOutbox(sessionId: String?): List<String> {
            if (sessionId.isNullOrBlank()) return emptyList()
            synchronized(outboxLock) {
                val list = dispatchedOutboxBySession.remove(sessionId) ?: return emptyList()
                return list.toList()
            }
        }

        internal fun clearOutboxStateForTests() {
            synchronized(outboxLock) {
                pendingOutboxBySession.clear()
                dispatchedOutboxBySession.clear()
            }
        }

        internal fun startOrUpdate(context: Context, profileId: String, pointer: WatchedSessionPointer) {
            syncOutbox(pointer.sessionId, pointer.outbox)
            val intent = Intent(context, BackgroundSseService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_PROFILE_ID, profileId)
                putExtra(EXTRA_SESSION_ID, pointer.sessionId)
                putExtra(EXTRA_SESSION_TITLE, pointer.title)
                putExtra(EXTRA_LAST_EVENT_ID, pointer.lastEventId)
                putExtra(EXTRA_SESSION_CWD, pointer.cwd)
                putExtra(EXTRA_OUTBOX_JSON, SimpleJson.formatStringArray(pointer.outbox))
            }
            ContextCompatStart.startForeground(context, intent)
        }

        internal fun stop(context: Context) {
            context.stopService(Intent(context, BackgroundSseService::class.java))
        }
    }
}

internal object ForegroundVisibility {
    @Volatile var isForeground: Boolean = false
}

private object ContextCompatStart {
    fun startForeground(context: Context, intent: Intent) {
        try {
            androidx.core.content.ContextCompat.startForegroundService(context, intent)
        } catch (_: Exception) {
            // Android 12+ background start restriction fallback when invoked late.
        }
    }
}
