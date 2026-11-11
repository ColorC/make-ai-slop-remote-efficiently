package cc.colorc.lofa;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * Sets the extra control planes the device bridge polls (adb shell only: the receiver requires DUMP).
 *
 *   am broadcast -a cc.colorc.lofa.SET_BRIDGE_ENDPOINTS -n cc.colorc.lofa/.BridgeEndpointsShellReceiver \
 *       --es bases "http://192.168.1.8:8217"        (comma separated; "" clears)
 *
 * The running DeviceBridgeService picks the change up within ~10 seconds.
 */
public final class BridgeEndpointsShellReceiver extends BroadcastReceiver {
    private static final String TAG = "LofaBridgeEndpoints";

    @Override
    public void onReceive(Context context, Intent intent) {
        String raw = intent == null ? null : intent.getStringExtra("bases");
        List<String> accepted = new ArrayList<>();
        List<String> rejected = new ArrayList<>();
        if (raw != null) {
            for (String part : raw.split(",")) {
                String base = part.trim();
                if (base.isEmpty()) continue;
                if (DeviceBridgeConfig.isAcceptableExtraBase(base)) accepted.add(base);
                else rejected.add(base);
            }
        }
        if (raw != null) DeviceBridgeConfig.setExtraBases(context, accepted);
        String summary = "extra bases=" + DeviceBridgeConfig.extraBases(context) + " rejected=" + rejected;
        Log.i(TAG, summary);
        setResultData(summary);
        DeviceBridgeService.startIfConfigured(context);
    }
}
