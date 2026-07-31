package cc.colorc.lofa;

import org.junit.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class DeviceBridgeServiceTest {
    @Test
    public void webSessionCookieKeepsDeviceTokenOutOfJavascriptAndEncodesDeviceId() {
        assertEquals(
                "phone%20with%20space.native-token",
                DeviceBridgeConfig.webSessionCookieValue("phone with space", "native-token")
        );
    }

    @Test
    public void cleanupDebugMediaOnlyAcceptsKnownDebugNames() {
        assertTrue(DeviceBridgeService.isSafeDebugMediaName("lofa-xhs-gallery.png"));
        assertTrue(DeviceBridgeService.isSafeDebugMediaName("lofa-debug-picker-01.jpg"));
        assertTrue(DeviceBridgeService.isSafeDebugMediaName("xhs-insert-picker.png"));

        assertFalse(DeviceBridgeService.isSafeDebugMediaName("post-01-card-01.png"));
        assertFalse(DeviceBridgeService.isSafeDebugMediaName("../lofa-xhs-gallery.png"));
        assertFalse(DeviceBridgeService.isSafeDebugMediaName("lofa-xhs-gallery.mp4"));
    }

    @Test
    public void reviewProbeOnlyAcceptsExactHttpsMaterialRoute() {
        String id = "mat_abc123";
        assertTrue(DeviceBridgeService.isSafeReviewRemoteUrl(
                id,
                "https://10.3.43.246:12443/api/boss-sight/reviewstage/mat_abc123/file"
        ));
        assertFalse(DeviceBridgeService.isSafeReviewRemoteUrl(
                id,
                "http://10.3.43.246:8210/api/boss-sight/reviewstage/mat_abc123/file"
        ));
        assertFalse(DeviceBridgeService.isSafeReviewRemoteUrl(
                id,
                "https://127.0.0.1:12443/api/boss-sight/reviewstage/mat_abc123/file"
        ));
        assertFalse(DeviceBridgeService.isSafeReviewRemoteUrl(
                id,
                "https://10.3.43.246:12443/api/boss-sight/reviewstage/mat_other/file"
        ));
    }

    @Test
    public void reviewProbeChecksCarrierIdentity() {
        byte[] html = "<!doctype html><html><body>ok</body></html>".getBytes(StandardCharsets.UTF_8);
        byte[] markdown = "# report".getBytes(StandardCharsets.UTF_8);
        byte[] png = new byte[]{(byte) 0x89, 'P', 'N', 'G', 0};

        assertTrue(DeviceBridgeService.isReviewMaterialIdentity("static-report", "text/html", html));
        assertFalse(DeviceBridgeService.isReviewMaterialIdentity("static-report", "text/plain", markdown));
        assertTrue(DeviceBridgeService.isReviewMaterialIdentity("aigc-image", "image/png", png));
    }
}
