package com.qwen.mobileshell

import org.junit.Assert.*
import org.junit.Test

class SseEventParserTest {
    @Test fun tracksCursorAcrossPingsAndEmitsActionableAlerts() {
        val parser = SseEventParser()
        assertNull(parser.feedLine(": ping"))
        assertNull(parser.feedLine(""))

        assertNull(parser.feedLine("id: 12"))
        assertNull(parser.feedLine("""data: {"id":"12","type":"session_update","data":{"sessionUpdate":"agent_message_chunk"}}"""))
        assertNull(parser.feedLine(""))
        assertEquals("12", parser.lastEventId)

        assertNull(parser.feedLine("id: 13"))
        assertNull(parser.feedLine("""data: {"id":"13","type":"permission_request","data":{"title":"Run pytest"}}"""))
        val permAlert = parser.feedLine("")
        assertEquals(SseAlert("13", "permission", "Action required", "Run pytest"), permAlert)
        assertEquals("13", parser.lastEventId)

        assertNull(parser.feedLine("id: 14"))
        assertNull(parser.feedLine("""data: {"id":"14","type":"turn_complete","data":{"stopReason":"max_tokens"}}"""))
        val turnAlert = parser.feedLine("")
        assertEquals(
            SseAlert("14", "turn_complete", "Turn finished", "Stopped (max_tokens) - tap to continue.", stopReason = "max_tokens"),
            turnAlert,
        )

        assertNull(parser.feedLine("id: 15"))
        assertNull(parser.feedLine("""data: {"id":"15","type":"stream_error","data":{"code":"prompt_timeout"}}"""))
        val errAlert = parser.feedLine("")
        assertEquals(
            SseAlert("15", "error", "Session interrupted", "Stream reported prompt_timeout."),
            errAlert,
        )

        assertNull(parser.feedLine("id: 16"))
        assertNull(parser.feedLine("""data: {"id":"16","type":"turn_error","data":{"message":"Model stream ended without a finish reason."}}"""))
        val turnErrAlert = parser.feedLine("")
        assertEquals(
            SseAlert("16", "error", "Turn interrupted", "Model stream ended without a finish reason."),
            turnErrAlert,
        )

        assertNull(parser.feedLine("id: 17"))
        assertNull(parser.feedLine("""data: {"id":"17","type":"turn_complete","data":{"stopReason":"end_turn"}}"""))
        val doneAlert = parser.feedLine("")
        assertEquals("end_turn", doneAlert?.stopReason)
    }
}
