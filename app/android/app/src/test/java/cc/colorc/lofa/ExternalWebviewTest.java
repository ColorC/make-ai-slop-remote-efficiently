package cc.colorc.lofa;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class ExternalWebviewTest {
    @Test
    public void gatewayHostAllowlistMatchesDashboardWorkspaceHosts() {
        assertTrue(ExternalWebview.isWorkspaceGatewayHost("10.3.43.246"));
        assertTrue(ExternalWebview.isWorkspaceGatewayHost("LAN.COLORC.CC"));
        assertTrue(ExternalWebview.isWorkspaceGatewayHost(" workshop.colorc.cc "));
        assertTrue(ExternalWebview.isWorkspaceGatewayHost("127.0.0.1"));
        assertTrue(ExternalWebview.isWorkspaceGatewayHost("::1"));

        assertFalse(ExternalWebview.isWorkspaceGatewayHost("10.3.43.247"));
        assertFalse(ExternalWebview.isWorkspaceGatewayHost("evil.colorc.cc"));
        assertFalse(ExternalWebview.isWorkspaceGatewayHost(""));
        assertFalse(ExternalWebview.isWorkspaceGatewayHost(null));
    }

    @Test
    public void gatewaySessionCookieNameFollowsScheme() {
        assertEquals("omni_desktop_session", ExternalWebview.gatewaySessionCookieName("https"));
        assertEquals("omni_desktop_session_http", ExternalWebview.gatewaySessionCookieName("http"));
        assertNull(ExternalWebview.gatewaySessionCookieName("ftp"));
        assertNull(ExternalWebview.gatewaySessionCookieName(null));
    }

    @Test
    public void webviewSessionTokenRequiresShapeAndFreshExpiry() {
        long now = 1_800_000_000L;
        assertEquals(
                "abc-DEF_123.sig-456_",
                ExternalWebview.validWebviewSessionToken("abc-DEF_123.sig-456_", now + 3600, now)
        );
        // Missing the signature segment, or vice versa.
        assertNull(ExternalWebview.validWebviewSessionToken("abcdef", now + 3600, now));
        assertNull(ExternalWebview.validWebviewSessionToken("abc.def.ghi", now + 3600, now));
        assertNull(ExternalWebview.validWebviewSessionToken("abc.de+f", now + 3600, now));
        assertNull(ExternalWebview.validWebviewSessionToken("", now + 3600, now));
        assertNull(ExternalWebview.validWebviewSessionToken(null, now + 3600, now));
        // Expired or expiring within the renewal margin.
        assertNull(ExternalWebview.validWebviewSessionToken("abc.def", now - 1, now));
        assertNull(ExternalWebview.validWebviewSessionToken("abc.def", now + 30, now));
        assertNull(ExternalWebview.validWebviewSessionToken("abc.def", 0, now));
    }
}
