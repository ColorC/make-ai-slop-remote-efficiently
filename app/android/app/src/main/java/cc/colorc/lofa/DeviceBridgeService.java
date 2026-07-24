package cc.colorc.lofa;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.provider.MediaStore;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/** Keeps the user-visible phone-to-PC control channel alive independently of accessibility. */
public final class DeviceBridgeService extends Service {
    private static final String TAG = "LofaDeviceBridge";
    static final int PROTOCOL_VERSION = 4;
    private static final String DEVICE_RUNTIME = "android-native";
    private static final String CHANNEL_ID = "lofa-device-bridge";
    private static final int NOTIFICATION_ID = 2201;
    private static volatile boolean running;
    private static volatile boolean paired;
    private static volatile long lastSuccessAt;
    private static volatile String lastError = "";
    private static volatile int consecutiveFailures;
    private static final Pattern SAFE_DEBUG_MEDIA_NAME = Pattern.compile(
            "(?:lofa-(?:xhs|debug)-[A-Za-z0-9._-]+\\.(?:png|jpe?g|webp)|xhs-insert-picker\\.png)",
            Pattern.CASE_INSENSITIVE
    );

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Map<String, JSONObject> completedReceipts = new LinkedHashMap<>();
    private volatile boolean stopping;

    static void startIfConfigured(Context context) {
        if (!DeviceBridgeConfig.isConfigured(context)) return;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, DeviceBridgeService.class));
        } catch (Throwable error) {
            lastError = "bridge_start: " + error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage());
        }
    }

    static JSONObject statusJson(Context context) {
        JSONObject out = new JSONObject();
        try {
            out.put("bridge_running", running);
            out.put("bridge_paired", paired);
            out.put("bridge_last_success_at", lastSuccessAt);
            out.put("bridge_last_error", lastError);
            out.put("bridge_consecutive_failures", consecutiveFailures);
            out.put("protocol_version", PROTOCOL_VERSION);
            out.put("app_version", appVersionName(context));
            out.put("app_version_code", appVersionCode(context));
            out.put("device_runtime", DEVICE_RUNTIME);
            out.put("device_local_ip", localIpv4Address());
            out.put("notification_permission", notificationPermission(context));
            out.put("accessibility_connected", LofaAccessibilityService.isRunning());
            out.put("capabilities", capabilities());
        } catch (Exception ignored) {
        }
        return out;
    }

    private static boolean notificationPermission(Context context) {
        return Build.VERSION.SDK_INT < 33
                || ContextCompat.checkSelfPermission(context, "android.permission.POST_NOTIFICATIONS")
                == PackageManager.PERMISSION_GRANTED;
    }

    private static JSONArray capabilities() {
        return new JSONArray()
                .put("status")
                .put("screenshot")
                .put("ui_tree")
                .put("tap")
                .put("click_text")
                .put("set_text")
                .put("global_action")
                .put("launch_app")
                .put("launch_label")
                .put("stage_media")
                .put("review_remote_probe")
                .put("cleanup_debug_media");
    }

    private static String appVersionName(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception ignored) {
            return "";
        }
    }

    private static long appVersionCode(Context context) {
        try {
            android.content.pm.PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
        } catch (Exception ignored) {
            return 0;
        }
    }

    private static String localIpv4Address() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface network = interfaces.nextElement();
                if (!network.isUp() || network.isLoopback()) continue;
                Enumeration<InetAddress> addresses = network.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    if (address instanceof Inet4Address
                            && !address.isLoopbackAddress()
                            && !address.isAnyLocalAddress()) {
                        return address.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return "";
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, notification("Connecting to the local control plane"));
        running = true;
        stopping = false;
        worker.execute(this::runLoop);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopping = true;
        running = false;
        worker.shutdownNow();
        super.onDestroy();
    }

    private void runLoop() {
        long backoffMillis = 1000;
        while (!stopping) {
            String base = DeviceBridgeConfig.baseUrl(this);
            String deviceId = DeviceBridgeConfig.deviceId(this);
            String token = DeviceBridgeConfig.deviceToken(this);
            if (base.isEmpty() || deviceId.isEmpty()) {
                lastError = "bridge is not configured";
                sleep(5000);
                continue;
            }
            try {
                if (!paired) pairAndRegister(base, deviceId, token);
                String encoded = URLEncoder.encode(deviceId, StandardCharsets.UTF_8.name());
                JSONObject payload = request(
                        "GET",
                        base + "/api/android/automation/poll?device_id=" + encoded + "&wait_seconds=25",
                        null,
                        token,
                        35000
                );
                JSONArray commands = payload.optJSONArray("commands");
                if (commands != null) {
                    for (int index = 0; index < commands.length() && !stopping; index++) {
                        JSONObject command = commands.optJSONObject(index);
                        if (command != null) executeAndReport(base, deviceId, token, command);
                    }
                }
                paired = true;
                lastSuccessAt = System.currentTimeMillis();
                lastError = "";
                consecutiveFailures = 0;
                backoffMillis = 1000;
                updateNotification("Connected; waiting for authorized UI tasks");
            } catch (Exception error) {
                paired = false;
                consecutiveFailures += 1;
                lastError = error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage());
                Log.w(TAG, "Device bridge reconnect failed", error);
                updateNotification("Reconnecting (" + consecutiveFailures + ")");
                sleep(backoffMillis);
                backoffMillis = Math.min(30000, backoffMillis * 2);
            }
        }
    }

    private void pairAndRegister(String base, String deviceId, String token) throws Exception {
        JSONObject identity = new JSONObject();
        identity.put("device_id", deviceId);
        identity.put("device_token", token);
        identity.put("protocol_version", PROTOCOL_VERSION);
        identity.put("capabilities", capabilities());
        identity.put("device_runtime", DEVICE_RUNTIME);
        identity.put("device_local_ip", localIpv4Address());
        request("POST", base + "/api/android/automation/pair", identity, token, 8000);

        JSONObject registration = new JSONObject();
        registration.put("device_id", deviceId);
        registration.put("protocol_version", PROTOCOL_VERSION);
        registration.put("capabilities", capabilities());
        registration.put("app_version", appVersionName(this));
        registration.put("app_version_code", appVersionCode(this));
        registration.put("device_runtime", DEVICE_RUNTIME);
        registration.put("device_local_ip", localIpv4Address());
        request("POST", base + "/api/android/automation/register", registration, token, 8000);
    }

    private void executeAndReport(String base, String deviceId, String token, JSONObject command) throws Exception {
        String commandId = command.optString("id");
        if (commandId.isEmpty()) return;
        JSONObject cached = completedReceipts.get(commandId);
        if (cached != null) {
            request("POST", base + "/api/android/automation/result", cached, token, 10000);
            return;
        }
        long expiresAtMillis = (long) (command.optDouble("expires_at", 0) * 1000L);
        JSONObject result;
        boolean ok;
        if (expiresAtMillis > 0 && System.currentTimeMillis() > expiresAtMillis) {
            result = error("command expired before device execution");
            ok = false;
        } else if ("stage_media".equals(command.optString("op"))) {
            result = stageMedia(base, token, command.optJSONObject("args"));
            ok = !result.has("error");
        } else if ("review_remote_probe".equals(command.optString("op"))) {
            result = probeReviewMaterial(command.optJSONObject("args"));
            ok = !result.has("error");
        } else if ("cleanup_debug_media".equals(command.optString("op"))) {
            result = cleanupDebugMedia(command.optJSONObject("args"));
            ok = !result.has("error");
        } else {
            LofaAccessibilityService executor = LofaAccessibilityService.getInstance();
            if ("status".equals(command.optString("op"))) {
                result = executor == null ? new JSONObject() : executor.status();
                merge(result, statusJson(this));
                ok = true;
            } else if (executor == null) {
                result = error("accessibility executor is not connected");
                ok = false;
            } else {
                result = executor.executeAutomationCommand(command.optString("op"), command.optJSONObject("args"));
                ok = !result.has("error");
            }
        }
        JSONObject receipt = new JSONObject();
        receipt.put("device_id", deviceId);
        receipt.put("command_id", commandId);
        receipt.put("sequence", command.optLong("sequence", 0));
        receipt.put("ok", ok);
        receipt.put("result", result);
        completedReceipts.put(commandId, receipt);
        if (completedReceipts.size() > 512) {
            String oldest = completedReceipts.keySet().iterator().next();
            completedReceipts.remove(oldest);
        }
        request("POST", base + "/api/android/automation/result", receipt, token, 10000);
    }

    private JSONObject stageMedia(String base, String token, JSONObject args) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return error("stage_media requires Android 10 or newer");
        }
        JSONArray assets = args == null ? null : args.optJSONArray("assets");
        if (assets == null || assets.length() == 0) return error("stage_media requires assets");
        JSONArray staged = new JSONArray();
        try {
            for (int index = 0; index < assets.length(); index++) {
                JSONObject asset = assets.optJSONObject(index);
                if (asset == null) throw new IllegalArgumentException("invalid asset at index " + index);
                String url = asset.optString("url");
                if (url.startsWith("/")) url = base + url;
                String expectedHash = asset.optString("sha256").toLowerCase(java.util.Locale.ROOT);
                String displayName = asset.optString("display_name", "lofa-" + index + ".jpg");
                String mime = asset.optString("mime", "image/jpeg");
                byte[] bytes = downloadBytes(url, token, 32 * 1024 * 1024);
                String actualHash = sha256(bytes);
                if (expectedHash.isEmpty() || !expectedHash.equals(actualHash)) {
                    throw new IllegalStateException("asset checksum mismatch: " + displayName);
                }
                ContentValues values = new ContentValues();
                values.put(MediaStore.Images.Media.DISPLAY_NAME, displayName);
                values.put(MediaStore.Images.Media.MIME_TYPE, mime);
                values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/LOFA");
                values.put(MediaStore.Images.Media.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IllegalStateException("MediaStore insert failed: " + displayName);
                try (OutputStream output = getContentResolver().openOutputStream(uri)) {
                    if (output == null) throw new IllegalStateException("MediaStore output unavailable: " + displayName);
                    output.write(bytes);
                }
                ContentValues complete = new ContentValues();
                complete.put(MediaStore.Images.Media.IS_PENDING, 0);
                getContentResolver().update(uri, complete, null, null);
                JSONObject item = new JSONObject();
                item.put("display_name", displayName);
                item.put("uri", uri.toString());
                item.put("sha256", actualHash);
                item.put("size", bytes.length);
                staged.put(item);
            }
            JSONObject out = new JSONObject();
            out.put("staged", staged);
            out.put("count", staged.length());
            return out;
        } catch (Exception exception) {
            return error(exception.getMessage());
        }
    }

    static boolean isSafeReviewRemoteUrl(String materialId, String value) {
        if (materialId == null || materialId.trim().isEmpty() || value == null) return false;
        try {
            URI uri = URI.create(value);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            String path = uri.getPath();
            if (!"https".equalsIgnoreCase(scheme) || host == null || host.trim().isEmpty()) return false;
            if (uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getRawUserInfo() != null) {
                return false;
            }
            String normalizedHost = host.trim().toLowerCase(java.util.Locale.ROOT);
            if ("localhost".equals(normalizedHost)
                    || "0.0.0.0".equals(normalizedHost)
                    || "::1".equals(normalizedHost)
                    || normalizedHost.startsWith("127.")) {
                return false;
            }
            return ("/api/boss-sight/reviewstage/" + materialId.trim() + "/file").equals(path);
        } catch (Exception ignored) {
            return false;
        }
    }

    static boolean isReviewMaterialIdentity(String kind, String contentType, byte[] sample) {
        if (sample == null || sample.length == 0) return false;
        String normalizedKind = kind == null ? "" : kind.trim().toLowerCase(java.util.Locale.ROOT);
        String normalizedType = contentType == null ? "" : contentType.toLowerCase(java.util.Locale.ROOT);
        String text = new String(sample, StandardCharsets.UTF_8).toLowerCase(java.util.Locale.ROOT);
        if ("html".equals(normalizedKind)
                || "static-report".equals(normalizedKind)
                || "demo".equals(normalizedKind)) {
            return normalizedType.contains("text/html")
                    || text.contains("<!doctype")
                    || text.contains("<html");
        }
        if ("image".equals(normalizedKind) || "aigc-image".equals(normalizedKind)) {
            return normalizedType.startsWith("image/")
                    || (sample.length >= 4
                    && (sample[0] & 0xff) == 0x89
                    && sample[1] == 'P'
                    && sample[2] == 'N'
                    && sample[3] == 'G')
                    || (sample.length >= 3
                    && (sample[0] & 0xff) == 0xff
                    && (sample[1] & 0xff) == 0xd8
                    && (sample[2] & 0xff) == 0xff);
        }
        if ("video".equals(normalizedKind)) {
            return normalizedType.startsWith("video/")
                    || (sample.length >= 8
                    && sample[4] == 'f'
                    && sample[5] == 't'
                    && sample[6] == 'y'
                    && sample[7] == 'p');
        }
        return true;
    }

    private JSONObject probeReviewMaterial(JSONObject args) {
        String materialId = args == null ? "" : args.optString("material_id", "").trim();
        String remoteUrl = args == null ? "" : args.optString("remote_url", "").trim();
        String kind = args == null ? "" : args.optString("kind", "").trim();
        if (!isSafeReviewRemoteUrl(materialId, remoteUrl)) {
            return error("review_remote_probe rejected unsafe or mismatched remote_url");
        }

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(remoteUrl).openConnection();
            connection.setRequestMethod("GET");
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(6000);
            connection.setReadTimeout(15000);
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("Range", "bytes=0-4095");
            connection.setRequestProperty("User-Agent", "lofa-physical-review-probe/1");
            int status = connection.getResponseCode();
            if (status != 200 && status != 206) {
                return error("review material HTTP " + status);
            }
            String contentType = String.valueOf(connection.getContentType());
            ByteArrayOutputStream sample = new ByteArrayOutputStream();
            try (InputStream stream = connection.getInputStream()) {
                byte[] chunk = new byte[1024];
                while (sample.size() < 4096) {
                    int read = stream.read(chunk, 0, Math.min(chunk.length, 4096 - sample.size()));
                    if (read < 0) break;
                    sample.write(chunk, 0, read);
                }
            }
            byte[] bytes = sample.toByteArray();
            boolean identityOk = isReviewMaterialIdentity(kind, contentType, bytes);
            if (!identityOk) return error("review material identity mismatch");

            JSONObject out = new JSONObject();
            out.put("material_id", materialId);
            out.put("remote_url", remoteUrl);
            out.put("kind", kind);
            out.put("http_status", status);
            out.put("content_type", contentType);
            out.put("content_range", String.valueOf(connection.getHeaderField("Content-Range")));
            out.put("sample_size", bytes.length);
            out.put("sample_sha256", sha256(bytes));
            out.put("identity_ok", true);
            // The URL is HTTPS-only and uses the platform's default trust manager and
            // hostname verifier. Reaching getResponseCode() therefore proves TLS validation.
            out.put("tls_verified", true);
            out.put("device_runtime", DEVICE_RUNTIME);
            out.put("device_local_ip", localIpv4Address());
            out.put("verified_at_device_ms", System.currentTimeMillis());
            return out;
        } catch (Exception exception) {
            return error(exception.getClass().getSimpleName() + ": " + exception.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    static boolean isSafeDebugMediaName(String value) {
        return value != null && SAFE_DEBUG_MEDIA_NAME.matcher(value).matches();
    }

    private JSONObject cleanupDebugMedia(JSONObject args) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return error("cleanup_debug_media requires Android 10 or newer");
        }
        JSONArray names = args == null ? null : args.optJSONArray("display_names");
        if (names == null || names.length() == 0 || names.length() > 64) {
            return error("cleanup_debug_media requires 1 to 64 exact display_names");
        }
        JSONArray requested = new JSONArray();
        int deleted = 0;
        try {
            for (int index = 0; index < names.length(); index++) {
                String name = names.optString(index, "").trim();
                if (!isSafeDebugMediaName(name)) {
                    return error("cleanup_debug_media rejected unsafe display name: " + name);
                }
                requested.put(name);
                String[] projection = {
                        MediaStore.Images.Media._ID,
                        MediaStore.Images.Media.RELATIVE_PATH
                };
                String selection = MediaStore.Images.Media.DISPLAY_NAME + "=? AND ("
                        + MediaStore.Images.Media.RELATIVE_PATH + " IS NULL OR "
                        + MediaStore.Images.Media.RELATIVE_PATH + " NOT LIKE ?)";
                String[] selectionArgs = {name, "Pictures/LOFA%"};
                try (Cursor cursor = getContentResolver().query(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                        projection,
                        selection,
                        selectionArgs,
                        null
                )) {
                    if (cursor == null) continue;
                    int idColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID);
                    while (cursor.moveToNext()) {
                        Uri uri = ContentUris.withAppendedId(
                                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                                cursor.getLong(idColumn)
                        );
                        deleted += getContentResolver().delete(uri, null, null);
                    }
                }
            }
            JSONObject out = new JSONObject();
            out.put("requested", requested);
            out.put("deleted", deleted);
            out.put("preserved_relative_path", "Pictures/LOFA");
            return out;
        } catch (Exception exception) {
            return error(exception.getMessage());
        }
    }

    private byte[] downloadBytes(String url, String token, int maximumBytes) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(30000);
        connection.setRequestProperty("X-LOFA-Device-Token", token);
        int code = connection.getResponseCode();
        if (code < 200 || code >= 300) {
            connection.disconnect();
            throw new IllegalStateException("asset download HTTP " + code);
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (InputStream stream = connection.getInputStream()) {
            byte[] chunk = new byte[8192];
            int read;
            while ((read = stream.read(chunk)) >= 0) {
                if (bytes.size() + read > maximumBytes) throw new IllegalStateException("asset exceeds size limit");
                bytes.write(chunk, 0, read);
            }
        } finally {
            connection.disconnect();
        }
        return bytes.toByteArray();
    }

    private static String sha256(byte[] value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
        StringBuilder out = new StringBuilder();
        for (byte item : digest) out.append(String.format(java.util.Locale.ROOT, "%02x", item));
        return out.toString();
    }

    private static void merge(JSONObject destination, JSONObject source) {
        java.util.Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            try {
                destination.put(key, source.opt(key));
            } catch (Exception ignored) {
            }
        }
    }

    private JSONObject request(
            String method,
            String url,
            JSONObject body,
            String token,
            int readTimeoutMillis
    ) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(readTimeoutMillis);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("X-LOFA-Device-Token", token);
        if (body != null) {
            byte[] data = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setFixedLengthStreamingMode(data.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(data);
            }
        }
        int code = connection.getResponseCode();
        InputStream stream = code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        if (stream != null) {
            byte[] chunk = new byte[8192];
            int read;
            while ((read = stream.read(chunk)) >= 0) bytes.write(chunk, 0, read);
            stream.close();
        }
        connection.disconnect();
        String text = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
        if (code < 200 || code >= 300) throw new IllegalStateException("HTTP " + code + ": " + text);
        return text.isEmpty() ? new JSONObject() : new JSONObject(text);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "LOFA device bridge",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps the user-authorized phone control channel online");
        channel.setSound(null, null);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private Notification notification(String message) {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentTitle("LOFA device bridge")
                .setContentText(message)
                .setOngoing(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void updateNotification(String message) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, notification(message));
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    private static JSONObject error(String message) {
        JSONObject out = new JSONObject();
        try {
            out.put("error", message == null ? "unknown error" : message);
        } catch (Exception ignored) {
        }
        return out;
    }
}
