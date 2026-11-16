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
import androidx.core.app.NotificationCompat
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal data class SseAlert(
    val eventId: String?,
    val kind: String,
    val title: String,
    val body: String,
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
                )
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
    )

    private val running = AtomicBoolean(false)
    private val activeTarget = AtomicReference<Target?>(null)
    @Volatile private var activeConnection: HttpURLConnection? = null
    private var workerThread: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannels()
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
        val next = Target(profileId, sessionId, title, cursor)

        val fg = buildForegroundNotification(title ?: sessionId)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(FG_NOTIFICATION_ID, fg, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(FG_NOTIFICATION_ID, fg)
        }

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
                    if (code == 401 || code == 403 || code == 404) {
                        conn.disconnect()
                        stopSelf()
                        break
                    }
                    if (code in 200..299) {
                        connectedOnce = true
                        backoffMs = 1_000L
                        BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { reader ->
                            while (running.get() && activeTarget.get()?.sessionId == target.sessionId) {
                                val line = reader.readLine() ?: break
                                val alert = parser.feedLine(line)
                                if (parser.lastEventId != null) {
                                    cursor = parser.lastEventId
                                }
                                if (alert != null && !ForegroundVisibility.isForeground) {
                                    postAlertNotification(target.sessionId, target.sessionTitle, alert)
                                }
                            }
                        }
                    }
                    conn.disconnect()
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

    private fun postAlertNotification(sessionId: String, sessionTitle: String?, alert: SseAlert) {
        val mgr = getSystemService(NotificationManager::class.java) ?: return
        val deepUri = buildString {
            append("qwen-rc://session/")
            append(Uri.encode(sessionId))
            if (!alert.eventId.isNullOrBlank() && alert.eventId.all { it.isDigit() }) {
                append("?event=")
                append(alert.eventId)
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

    companion object {
        const val ACTION_START = "com.qwen.mobileshell.BG_SSE_START"
        const val ACTION_STOP = "com.qwen.mobileshell.BG_SSE_STOP"
        const val EXTRA_PROFILE_ID = "profile_id"
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_SESSION_TITLE = "session_title"
        const val EXTRA_LAST_EVENT_ID = "last_event_id"

        private const val CHANNEL_STREAM = "qwen_rc_bg_stream"
        private const val CHANNEL_ALERTS = "qwen_rc_alerts"
        private const val FG_NOTIFICATION_ID = 4170
        private const val ALERT_NOTIFICATION_BASE = 5000

        internal fun startOrUpdate(context: Context, profileId: String, pointer: WatchedSessionPointer) {
            val intent = Intent(context, BackgroundSseService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_PROFILE_ID, profileId)
                putExtra(EXTRA_SESSION_ID, pointer.sessionId)
                putExtra(EXTRA_SESSION_TITLE, pointer.title)
                putExtra(EXTRA_LAST_EVENT_ID, pointer.lastEventId)
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
