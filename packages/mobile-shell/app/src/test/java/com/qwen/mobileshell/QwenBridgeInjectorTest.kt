package com.qwen.mobileshell

import org.junit.Assert.*
import org.junit.Test

class QwenBridgeInjectorTest {
    @Test fun escapesTokensSafelyInDocumentStartScript() {
        val tricky = """tok"</script>\n"""
        val script = QwenBridgeInjector.buildDocumentStartScript("0.23.3", tricky)
        assertTrue(script.contains("platform: 'android-twa'"))
        assertTrue(script.contains("bridge: 1"))
        assertFalse("raw closing script tag must never appear", script.contains("</script>"))
        assertEquals("https://gw.example:4170", QwenBridgeInjector.originRule("https://gw.example:4170/"))
    }

    @Test fun parsesRpcRequestsAndFormatsReplies() {
        val setReq = QwenBridgeInjector.parseRequest("""{"id":"req-1","method":"setToken","token":"rc-secret-1"}""")
        assertNotNull(setReq)
        assertEquals("req-1", setReq!!.id)
        assertEquals("setToken", setReq.method)
        assertEquals("rc-secret-1", setReq.token)

        val watchReq = QwenBridgeInjector.parseRequest(
            """{"id":"req-2","method":"setWatchedSession","sessionId":"sess-9","lastEventId":"42","title":"Bugfix","cwd":"/proj","outbox":["run tests","ship it"]}""",
        )
        assertNotNull(watchReq)
        assertFalse(watchReq!!.watchedCleared)
        assertEquals(
            WatchedSessionPointer("sess-9", "42", "Bugfix", "/proj", listOf("run tests", "ship it")),
            watchReq.watched,
        )

        val consumeReq = QwenBridgeInjector.parseRequest(
            """{"id":"req-2b","method":"consumeDispatchedOutbox","sessionId":"sess-9"}""",
        )
        assertNotNull(consumeReq)
        assertEquals("consumeDispatchedOutbox", consumeReq!!.method)
        assertEquals("sess-9", consumeReq.sessionId)
        assertNull(consumeReq.watched)

        BackgroundSseService.clearOutboxStateForTests()
        BackgroundSseService.syncOutbox("sess-9", listOf("first prompt", "second prompt"))
        assertEquals("first prompt", BackgroundSseService.popNextOutboxPrompt("sess-9"))
        assertEquals("second prompt", BackgroundSseService.popNextOutboxPrompt("sess-9"))
        assertNull(BackgroundSseService.popNextOutboxPrompt("sess-9"))
        assertEquals("""["a","b\"c"]""", SimpleJson.formatStringArray(listOf("a", "b\"c")))

        val clearWatch = QwenBridgeInjector.parseRequest("""{"id":"req-3","method":"setWatchedSession","cleared":true}""")
        assertNotNull(clearWatch)
        assertTrue(clearWatch!!.watchedCleared)
        assertNull(clearWatch.watched)

        val saveReq = QwenBridgeInjector.parseRequest(
            """{"id":"req-4","method":"saveBase64File","dataBase64":"aGVsbG8=","filename":"note.txt","mimeType":"text/plain"}""",
        )
        assertNotNull(saveReq)
        assertEquals("saveBase64File", saveReq!!.method)
        assertEquals("aGVsbG8=", saveReq.dataBase64)
        assertEquals("note.txt", saveReq.filename)
        assertEquals("text/plain", saveReq.mimeType)

        assertEquals(
            """{"id":"req-1","ok":true,"result":"tok-9"}""",
            QwenBridgeInjector.formatSuccessReply("req-1", QwenBridgeInjector.jsStringLiteral("tok-9")),
        )
        assertEquals(
            """{"id":"req-1","ok":false,"error":"storage_error"}""",
            QwenBridgeInjector.formatErrorReply("req-1", "storage_error"),
        )
    }
}
