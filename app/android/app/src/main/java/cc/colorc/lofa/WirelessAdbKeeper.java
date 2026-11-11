package cc.colorc.lofa;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Keeps Android "wireless debugging" (adb over TLS) switched on so a LAN host can reconnect
 * after the device reboots or changes Wi-Fi, without a USB cable.
 *
 * Android turns {@code adb_wifi_enabled} off at boot and whenever Wi-Fi drops. With
 * WRITE_SECURE_SETTINGS (granted once over adb: {@code pm grant cc.colorc.lofa
 * android.permission.WRITE_SECURE_SETTINGS}) the app writes it back to 1, but only while USB
 * debugging itself ({@code adb_enabled}) is on. On a Wi-Fi network the user already trusted the
 * system starts adbd's TLS port silently; on a new network it asks the user as usual.
 *
 * Triggers: boot (locked and unlocked), package update, a Wi-Fi PendingIntent network callback
 * (survives process death), app/service start, and an adb-shell broadcast for testing.
 */
final class WirelessAdbKeeper {
    private static final String TAG = "LofaWirelessAdb";
    static final String ACTION_ENSURE = "cc.colorc.lofa.ENSURE_WIRELESS_ADB";
    static final String ACTION_WIFI_AVAILABLE = "cc.colorc.lofa.WIFI_AVAILABLE";
    private static final String ADB_WIFI_ENABLED = "adb_wifi_enabled";
    private static final String LOG_NAME = "wireless-adb.log";
    private static final long LOG_MAX_BYTES = 64 * 1024;

    private static volatile String lastResult = "";
    private static volatile long lastCheckedAt;

    private WirelessAdbKeeper() {}

    static boolean hasPermission(Context context) {
        return context.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS")
                == PackageManager.PERMISSION_GRANTED;
    }

    static int adbEnabled(Context context) {
        return Settings.Global.getInt(context.getContentResolver(), Settings.Global.ADB_ENABLED, -1);
    }

    static int adbWifiEnabled(Context context) {
        return Settings.Global.getInt(context.getContentResolver(), ADB_WIFI_ENABLED, -1);
    }

    /** Writes adb_wifi_enabled=1 when USB debugging is on and wireless debugging is off. Never throws. */
    static synchronized String ensure(Context context, String reason) {
        Context app = context.getApplicationContext() == null ? context : context.getApplicationContext();
        String result;
        try {
            int adb = adbEnabled(app);
            int wifi = adbWifiEnabled(app);
            if (adb != 1) {
                result = "skip: adb_enabled=" + adb;
            } else if (wifi == 1) {
                result = "ok: already on";
            } else if (!hasPermission(app)) {
                result = "fail: WRITE_SECURE_SETTINGS not granted (adb_wifi_enabled=" + wifi + ")";
            } else {
                boolean written = Settings.Global.putInt(app.getContentResolver(), ADB_WIFI_ENABLED, 1);
                result = (written ? "wrote 1" : "fail: putInt returned false") + " (was " + wifi + ")";
            }
        } catch (Throwable error) {
            result = "fail: " + error.getClass().getSimpleName() + ": " + error.getMessage();
        }
        lastResult = result;
        lastCheckedAt = System.currentTimeMillis();
        // Only log transitions and failures, not every routine "already on".
        if (!result.startsWith("ok:") && !result.startsWith("skip:")) log(app, reason + " -> " + result);
        else Log.i(TAG, reason + " -> " + result);
        return result;
    }

    /** Re-checks a few times: right after Wi-Fi comes up the system may still reset the flag. */
    static void ensureWithRetries(Context context, String reason) {
        ensure(context, reason);
        for (int attempt = 1; attempt <= 2; attempt++) {
            try {
                Thread.sleep(4000);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            }
            ensure(context, reason + " retry" + attempt);
        }
    }

    /**
     * Registers a Wi-Fi network callback delivered as a PendingIntent to {@link WirelessAdbReceiver},
     * so it fires even when the app process is not running. Re-registering the same PendingIntent
     * replaces the previous request. Lost on reboot; the boot receiver registers it again.
     */
    static void registerWifiCallback(Context context) {
        Context app = context.getApplicationContext() == null ? context : context.getApplicationContext();
        try {
            ConnectivityManager cm = app.getSystemService(ConnectivityManager.class);
            if (cm == null) return;
            Intent intent = new Intent(app, WirelessAdbReceiver.class).setAction(ACTION_WIFI_AVAILABLE);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            // ConnectivityService fills in the Network extra, so the PendingIntent must be mutable.
            if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
            PendingIntent pending = PendingIntent.getBroadcast(app, 0x7a1b, intent, flags);
            NetworkRequest request = new NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .build();
            cm.registerNetworkCallback(request, pending);
        } catch (Throwable error) {
            log(app, "register wifi callback failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    /** Called from long-lived components (app start, services). */
    static void onComponentStart(Context context, String reason) {
        registerWifiCallback(context);
        new Thread(() -> ensure(context, reason), "lofa-wireless-adb").start();
    }

    /** adbd's TLS port; usually unreadable for apps (SELinux), returns 0 then. */
    static int tlsPort() {
        try {
            Class<?> props = Class.forName("android.os.SystemProperties");
            String value = (String) props.getMethod("get", String.class).invoke(null, "service.adb.tls.port");
            return value == null || value.isEmpty() ? 0 : Integer.parseInt(value.trim());
        } catch (Throwable ignored) {
            return 0;
        }
    }

    static void putStatus(Context context, JSONObject out) {
        try {
            out.put("adb_enabled", adbEnabled(context));
            out.put("adb_wifi_enabled", adbWifiEnabled(context));
            out.put("write_secure_settings", hasPermission(context));
            out.put("wireless_adb_last_result", lastResult);
            out.put("wireless_adb_last_checked_at", lastCheckedAt);
            int port = tlsPort();
            if (port > 0) out.put("adb_tls_port", port);
        } catch (Throwable ignored) {
        }
    }

    private static void log(Context context, String message) {
        Log.i(TAG, message);
        try {
            // Device-protected storage: also writable before the first unlock after boot.
            Context storage = Build.VERSION.SDK_INT >= 24 ? context.createDeviceProtectedStorageContext() : context;
            File file = new File(storage.getFilesDir(), LOG_NAME);
            if (file.length() > LOG_MAX_BYTES) {
                File old = new File(storage.getFilesDir(), LOG_NAME + ".1");
                //noinspection ResultOfMethodCallIgnored
                old.delete();
                //noinspection ResultOfMethodCallIgnored
                file.renameTo(old);
            }
            String stamp = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(new Date());
            try (FileOutputStream output = new FileOutputStream(file, true)) {
                output.write((stamp + " " + message + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (Throwable ignored) {
        }
    }
}
