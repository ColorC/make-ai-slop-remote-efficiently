package cc.colorc.lofa;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

final class DeviceBridgeConfig {
    static final String PREFS = "lofa.device.automation";
    private static final String PREF_BASE = "base_url";
    private static final String PREF_DEVICE = "device_id";
    private static final String PREF_TOKEN = "device_token";

    private DeviceBridgeConfig() {
    }

    static void configure(Context context, String baseUrl, String deviceId) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(PREF_BASE, trimBase(baseUrl))
                .putString(PREF_DEVICE, deviceId == null ? "" : deviceId.trim())
                .apply();
    }

    static String baseUrl(Context context) {
        return preferences(context).getString(PREF_BASE, "");
    }

    static String deviceId(Context context) {
        return preferences(context).getString(PREF_DEVICE, "");
    }

    static boolean isConfigured(Context context) {
        return !baseUrl(context).isEmpty() && !deviceId(context).isEmpty();
    }

    static String deviceToken(Context context) {
        SharedPreferences preferences = preferences(context);
        String existing = preferences.getString(PREF_TOKEN, "");
        if (existing != null && !existing.isEmpty()) return existing;
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        String token = Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        preferences.edit().putString(PREF_TOKEN, token).commit();
        return token;
    }

    static String webSessionCookieValue(Context context, String deviceId) {
        return webSessionCookieValue(deviceId, deviceToken(context));
    }

    static String webSessionCookieValue(String deviceId, String token) {
        try {
            String encodedDevice = URLEncoder.encode(
                    deviceId == null ? "" : deviceId.trim(),
                    StandardCharsets.UTF_8.name()
            ).replace("+", "%20");
            return encodedDevice + "." + (token == null ? "" : token);
        } catch (Exception impossible) {
            throw new IllegalStateException("UTF-8 is unavailable", impossible);
        }
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String trimBase(String value) {
        String out = value == null ? "" : value.trim();
        while (out.endsWith("/")) out = out.substring(0, out.length() - 1);
        return out;
    }
}
