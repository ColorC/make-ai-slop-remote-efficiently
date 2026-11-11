package cc.colorc.lofa;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Boot / package-update / Wi-Fi-available hook for {@link WirelessAdbKeeper}. Not exported: the
 * system delivers the boot broadcasts and our own Wi-Fi PendingIntent targets it explicitly.
 */
public class WirelessAdbReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null || intent.getAction() == null ? "?" : intent.getAction();
        boolean boot = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
        // Never from ACTION_WIFI_AVAILABLE itself: registering fires the callback again at once.
        if (boot || WirelessAdbKeeper.ACTION_ENSURE.equals(action)) WirelessAdbKeeper.registerWifiCallback(context);
        String reason = action.substring(action.lastIndexOf('.') + 1);
        PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                WirelessAdbKeeper.ensureWithRetries(context, reason);
            } finally {
                pending.finish();
            }
        }, "lofa-wireless-adb").start();
    }
}
