package com.qwen.mobileshell

import org.junit.Assert.*
import org.junit.Test

class QwenRcDeepLinkTest {
    @Test fun parsesSessionAndPermissionDeepLinks() {
        val session = QwenRcDeepLink.parseSchemeUri("qwen-rc://session/abc_123?event=45&cwd=%2Fhome%2Fevan%2Fproj")
        assertEquals(QwenRcDeepLink.OpenSession("abc_123", "45", "/home/evan/proj"), session)
        val nav = (session as QwenRcDeepLink.OpenSession).toNavigation()
        assertEquals("https://gw.example/ui/?session=abc_123&event=45", nav.url("https://gw.example/"))

        val perm = QwenRcDeepLink.parseSchemeUri("qwen-rc://permission/perm-9")
        assertEquals(QwenRcDeepLink.OpenPermission("perm-9"), perm)
        assertEquals(
            "https://gw.example/ui/?permission=perm-9",
            (perm as QwenRcDeepLink.OpenPermission).toNavigation().url("https://gw.example/"),
        )
    }

    @Test fun failsClosedOnMalformedOrDaemonChangingDeepLinks() {
        for (bad in listOf(
            null,
            "",
            "https://gw.example/ui/",
            "qwen-rc://session/%00%ff",
            "qwen-rc://session/abc?url=https://evil.example/",
            "qwen-rc://permission/p1?url=https://evil.example/",
            "qwen-rc://session/a/b",
            "qwen-rc://pair?code=ABCD12345&url=http://cleartext.example/",
            "qwen-rc://pair?code=ABCD12345&url=https://evil.example/subpath",
        )) {
            assertTrue("expected Invalid for $bad", QwenRcDeepLink.parseSchemeUri(bad) is QwenRcDeepLink.Invalid)
        }
    }

    @Test fun parsesPairDeepLinkQrPayloadAndFormatsCertFingerprint() {
        val pair = QwenRcDeepLink.parseSchemeUri("qwen-rc://pair?code=ABCD-EFGHJ&url=https%3A%2F%2FRC.EXAMPLE%3A443")
        assertEquals(QwenRcDeepLink.PairDaemon("ABCD-EFGHJ", "https://rc.example/"), pair)

        val qr = QwenRcDeepLink.parseQrPayload("qwen-rc-pair:ABCD-EFGHJ;url=https://rc.example:4170")
        assertEquals(QwenRcDeepLink.PairDaemon("ABCD-EFGHJ", "https://rc.example:4170/"), qr)
        assertNull(QwenRcDeepLink.parseQrPayload("qwen-rc-pair:ABCD-EFGHJ;url=http://insecure.example:4170"))

        val fp = QwenRcDeepLink.formatCertSha256GroupedHex("test-cert-der".toByteArray(Charsets.UTF_8))
        assertTrue(fp.matches(Regex("([0-9A-F]{4} ){15}[0-9A-F]{4}")))
    }
}
