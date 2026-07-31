package cc.colorc.lofa;

import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/** Downloads a verified self-update and submits it through PackageInstaller. */
@CapacitorPlugin(name = "ApkInstaller")
public final class ApkInstaller extends Plugin {
    static final String INSTALL_PREFS = "lofa.install.status";
    private final AtomicBoolean updateInProgress = new AtomicBoolean(false);

    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || getContext().getPackageManager().canRequestPackageInstalls();
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    @PluginMethod
    public void openInstallPermission(PluginCall call) {
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName())
                );
            } else {
                intent = new Intent(Settings.ACTION_SECURITY_SETTINGS);
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception exception) {
            call.reject(exception.getMessage());
        }
    }

    @PluginMethod
    public void installStatus(PluginCall call) {
        android.content.SharedPreferences preferences = getContext().getSharedPreferences(INSTALL_PREFS, android.content.Context.MODE_PRIVATE);
        JSObject result = new JSObject();
        result.put("status", preferences.getInt("status", Integer.MIN_VALUE));
        result.put("message", preferences.getString("message", ""));
        result.put("session_id", preferences.getInt("session_id", -1));
        result.put("updated_at", preferences.getLong("updated_at", 0));
        call.resolve(result);
    }

    @PluginMethod
    public void downloadAndInstall(final PluginCall call) {
        final String url = call.getString("url", "");
        final String expectedSha256 = call.getString("sha256", "").toLowerCase(Locale.ROOT);
        if (url.isEmpty() || expectedSha256.length() != 64) {
            call.reject("url and sha256 are required");
            return;
        }
        if (!updateInProgress.compareAndSet(false, true)) {
            call.reject("update already in progress");
            return;
        }
        new Thread(() -> {
            File apk = new File(getContext().getCacheDir(), "lofa-update.apk");
            try {
                if (apk.exists() && !apk.delete()) throw new IllegalStateException("stale update cannot be replaced");
                long bytes = download(url, apk);
                if (bytes < 1000) throw new IllegalStateException("APK is too small: " + bytes);
                String actualSha256 = sha256(apk);
                if (!expectedSha256.equals(actualSha256)) {
                    if (!apk.delete()) apk.deleteOnExit();
                    throw new IllegalStateException(
                            "APK checksum mismatch (expected " + expectedSha256
                                    + ", actual " + actualSha256 + ", bytes " + bytes + ")"
                    );
                }
                int sessionId = submitInstall(apk);
                JSObject result = new JSObject();
                result.put("bytes", bytes);
                result.put("sha256", actualSha256);
                result.put("session_id", sessionId);
                result.put("submitted", true);
                call.resolve(result);
            } catch (Exception exception) {
                call.reject("update: " + exception.getMessage());
            } finally {
                updateInProgress.set(false);
            }
        }, "lofa-apk-update").start();
    }

    private long download(String url, File destination) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(120000);
        connection.setInstanceFollowRedirects(true);
        int code = connection.getResponseCode();
        if (code < 200 || code >= 300) {
            connection.disconnect();
            throw new IllegalStateException("download HTTP " + code);
        }
        long total = 0;
        try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = input.read(buffer)) > 0) {
                output.write(buffer, 0, count);
                total += count;
            }
            output.getFD().sync();
        } finally {
            connection.disconnect();
        }
        return total;
    }

    private int submitInstall(File apk) throws Exception {
        PackageInstaller installer = getContext().getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams parameters = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        parameters.setAppPackageName(getContext().getPackageName());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            parameters.setInstallReason(android.content.pm.PackageManager.INSTALL_REASON_USER);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            parameters.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        }
        int sessionId = installer.createSession(parameters);
        try (PackageInstaller.Session session = installer.openSession(sessionId)) {
            // 写入流必须在 commit 之前关闭: PackageInstaller 不允许带着未关闭的 openWrite 流提交,
            // 否则 commit 失败并报 "file still open"。故 input/output 收进内层 try, 写完即关, 再 commit。
            try (FileInputStream input = new FileInputStream(apk);
                 OutputStream output = session.openWrite("lofa-update.apk", 0, apk.length())) {
                byte[] buffer = new byte[65536];
                int count;
                while ((count = input.read(buffer)) > 0) output.write(buffer, 0, count);
                session.fsync(output);
            }
            Intent result = new Intent(getContext(), InstallResultReceiver.class);
            result.setAction(InstallResultReceiver.ACTION_INSTALL_RESULT);
            result.putExtra("session_id", sessionId);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
            PendingIntent pending = PendingIntent.getBroadcast(getContext(), sessionId, result, flags);
            session.commit(pending.getIntentSender());
        }
        getContext().getSharedPreferences(INSTALL_PREFS, android.content.Context.MODE_PRIVATE).edit()
                .putInt("session_id", sessionId)
                .putInt("status", PackageInstaller.STATUS_PENDING_USER_ACTION)
                .putString("message", "submitted")
                .putLong("updated_at", System.currentTimeMillis())
                .apply();
        return sessionId;
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = input.read(buffer)) > 0) digest.update(buffer, 0, count);
        }
        StringBuilder value = new StringBuilder();
        for (byte item : digest.digest()) value.append(String.format(Locale.ROOT, "%02x", item));
        return value.toString();
    }
}
