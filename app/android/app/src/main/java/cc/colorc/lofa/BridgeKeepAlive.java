package cc.colorc.lofa;

import android.app.ActivityManager;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.WifiManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

/**
 * Keeps the device bridge reachable while the screen is off or the keyguard is up (1.0.67).
 *
 * <p>The owner: "if the tablet goes dark and nobody can reach it, it is useless". The bridge
 * service is already a foreground service; on its own that does not survive Doze, which stops
 * the CPU and suspends network for apps outside the battery-optimization allowlist. This class:
 * <ul>
 *   <li>holds a partial wake lock and a Wi-Fi lock while the bridge runs, so the long poll keeps
 *       going with the screen off (the allowlist entry itself is added over adb by the hosting
 *       watchdog: {@code cmd deviceidle whitelist +cc.colorc.lofa});</li>
 *   <li>lets go of the wake lock when the battery is low and not charging, so an unplugged tablet
 *       is not drained flat (the Wi-Fi lock alone costs little);</li>
 *   <li>arms an allow-while-idle alarm every {@link #WATCHDOG_MS} that restarts the bridge if the
 *       system killed it (START_STICKY alone is not honoured by every OEM).</li>
 * </ul>
 * Nothing here touches the screen, the keyguard or any user setting.
 */
final class BridgeKeepAlive {
    static final String TAG = "LofaKeepAlive";
    static final String WATCHDOG = "cc.colorc.lofa.BRIDGE_WATCHDOG";
    static final long WATCHDOG_MS = 15 * 60_000L;
    /** Below this battery percentage, unplugged, the CPU wake lock is released. */
    static final int LOW_BATTERY_PCT = 15;

    private static PowerManager.WakeLock wakeLock;
    private static WifiManager.WifiLock wifiLock;
    private static volatile long lastWatchdogAt;
    private static volatile String lastWatchdogResult = "";
    private static volatile String lastError = "";

    private BridgeKeepAlive() {
    }

    /** Pure policy: keep the CPU awake unless the battery is low and not charging. Unknown battery keeps it. */
    static boolean wantWakeLock(int batteryPct, boolean charging) {
        return charging || batteryPct < 0 || batteryPct > LOW_BATTERY_PCT;
    }

    /** Called from the bridge service when it starts and on every poll round (cheap when nothing changes). */
    static synchronized void hold(Context context) {
        Context app = context.getApplicationContext();
        try {
            if (wifiLock == null) {
                WifiManager wifi = app.getSystemService(WifiManager.class);
                if (wifi != null) {
                    @SuppressWarnings("deprecation")
                    int mode = WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                    wifiLock = wifi.createWifiLock(mode, "lofa:bridge");
                    wifiLock.setReferenceCounted(false);
                }
            }
            if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
        } catch (Throwable error) {
            lastError = "wifi_lock: " + error.getClass().getSimpleName() + ": " + error.getMessage();
        }
        try {
            if (wakeLock == null) {
                PowerManager power = app.getSystemService(PowerManager.class);
                if (power != null) {
                    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lofa:bridge");
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null) {
                int[] battery = battery(app);
                boolean want = wantWakeLock(battery[0], battery[1] == 1);
                if (want && !wakeLock.isHeld()) wakeLock.acquire();
                else if (!want && wakeLock.isHeld()) wakeLock.release();
            }
        } catch (Throwable error) {
            lastError = "wake_lock: " + error.getClass().getSimpleName() + ": " + error.getMessage();
        }
        armWatchdog(app);
    }

    private static volatile long lastRefreshAt;

    /** Poll-loop hook: re-applies {@link #hold} at most once a minute (battery policy, lost locks, alarm). */
    static void refresh(Context context) {
        long now = SystemClock.elapsedRealtime();
        if (now - lastRefreshAt < 60_000L) return;
        lastRefreshAt = now;
        hold(context);
    }

    static synchronized void release() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Throwable ignored) {
        }
    }

    /** {percent or -1, charging 1/0}. Sticky battery broadcast; no receiver is registered. */
    static int[] battery(Context context) {
        try {
            Intent intent = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (intent == null) return new int[]{-1, 0};
            int level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            int plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
            int pct = level >= 0 && scale > 0 ? Math.round(level * 100f / scale) : -1;
            return new int[]{pct, plugged != 0 ? 1 : 0};
        } catch (Throwable error) {
            return new int[]{-1, 0};
        }
    }

    private static PendingIntent watchdogIntent(Context context) {
        Intent intent = new Intent(context, BridgeWatchdogReceiver.class).setAction(WATCHDOG);
        return PendingIntent.getBroadcast(context, 7400, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** (Re)arms the restart alarm; exact allow-while-idle when permitted, inexact allow-while-idle otherwise. */
    static void armWatchdog(Context context) {
        try {
            AlarmManager alarms = context.getSystemService(AlarmManager.class);
            if (alarms == null) return;
            long due = SystemClock.elapsedRealtime() + WATCHDOG_MS;
            PendingIntent op = watchdogIntent(context);
            if (Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms()) {
                alarms.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, due, op);
            } else {
                alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, due, op);
            }
        } catch (Throwable error) {
            lastError = "watchdog_alarm: " + error.getClass().getSimpleName() + ": " + error.getMessage();
        }
    }

    /** Watchdog / boot entry: make sure the bridge runs, then re-arm. */
    static void onWatchdog(Context context, String why) {
        lastWatchdogAt = System.currentTimeMillis();
        boolean wasRunning = DeviceBridgeService.isRunning();
        DeviceBridgeService.startIfConfigured(context);
        lastWatchdogResult = why + (wasRunning ? ": running" : ": restarted");
        if (!wasRunning) Log.i(TAG, "bridge restarted by " + why);
        armWatchdog(context);
    }

    static void putStatus(Context context, JSONObject out) {
        try {
            out.put("keepalive_wake_lock_held", wakeLock != null && wakeLock.isHeld());
            out.put("keepalive_wifi_lock_held", wifiLock != null && wifiLock.isHeld());
            out.put("keepalive_last_watchdog_at", lastWatchdogAt);
            out.put("keepalive_last_watchdog", lastWatchdogResult);
            out.put("keepalive_last_error", lastError);
            int[] battery = battery(context);
            out.put("battery_pct", battery[0]);
            out.put("battery_charging", battery[1] == 1);
            PowerManager power = context.getSystemService(PowerManager.class);
            if (power != null) {
                out.put("ignoring_battery_optimizations", power.isIgnoringBatteryOptimizations(context.getPackageName()));
                out.put("device_idle_mode", power.isDeviceIdleMode());
                out.put("power_save_mode", power.isPowerSaveMode());
            }
            ActivityManager activity = context.getSystemService(ActivityManager.class);
            if (activity != null && Build.VERSION.SDK_INT >= 28) out.put("background_restricted", activity.isBackgroundRestricted());
            UsageStatsManager usage = context.getSystemService(UsageStatsManager.class);
            if (usage != null && Build.VERSION.SDK_INT >= 28) out.put("standby_bucket", usage.getAppStandbyBucket());
        } catch (Throwable ignored) {
        }
    }
}
