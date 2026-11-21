package cc.colorc.lofa;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class BridgeKeepAliveTest {
    @Test
    public void wakeLockKeptUnlessLowAndUnplugged() {
        assertTrue(BridgeKeepAlive.wantWakeLock(80, false));
        assertTrue(BridgeKeepAlive.wantWakeLock(16, false));
        assertFalse(BridgeKeepAlive.wantWakeLock(15, false));
        assertFalse(BridgeKeepAlive.wantWakeLock(3, false));
        assertTrue(BridgeKeepAlive.wantWakeLock(3, true));    // charging: always keep
        assertTrue(BridgeKeepAlive.wantWakeLock(-1, false));  // unknown battery: keep
    }
}
