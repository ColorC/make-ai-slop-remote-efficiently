package cc.colorc.lofa;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Restarts the device bridge after it was killed (1.0.67): fires from the allow-while-idle alarm
 * armed by {@link BridgeKeepAlive}, after boot / unlock and after an app update. Starting a
 * foreground service from here is allowed: exact-alarm holders and battery-allowlisted apps are
 * exempt from the background-start restriction.
 */
public final class BridgeWatchdogReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null || intent.getAction() == null ? "unknown" : intent.getAction();
        BridgeKeepAlive.onWatchdog(context, action.substring(action.lastIndexOf('.') + 1));
    }
}
