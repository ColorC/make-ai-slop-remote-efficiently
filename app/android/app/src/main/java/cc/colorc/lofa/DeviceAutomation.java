package cc.colorc.lofa;

import android.content.Intent;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DeviceAutomation")
public final class DeviceAutomation extends Plugin {
    @PluginMethod
    public void configure(PluginCall call) {
        String baseUrl = call.getString("baseUrl", "");
        String deviceId = call.getString("deviceId", "");
        if (baseUrl.trim().isEmpty() || deviceId.trim().isEmpty()) {
            call.reject("baseUrl and deviceId are required");
            return;
        }
        LofaAccessibilityService.configure(getContext(), baseUrl, deviceId);
        JSObject result = new JSObject();
        result.put("configured", true);
        result.put("accessibility_enabled", LofaAccessibilityService.isRunning());
        result.put("device_id", deviceId);
        call.resolve(result);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("accessibility_enabled", LofaAccessibilityService.isRunning());
        try {
            org.json.JSONObject bridge = DeviceBridgeService.statusJson(getContext());
            java.util.Iterator<String> bridgeKeys = bridge.keys();
            while (bridgeKeys.hasNext()) {
                String key = bridgeKeys.next();
                result.put(key, bridge.opt(key));
            }
        } catch (Exception ignored) {
        }
        try {
            org.json.JSONObject tunnel = DevTunnelService.statusJson();
            java.util.Iterator<String> tunnelKeys = tunnel.keys();
            while (tunnelKeys.hasNext()) {
                String key = tunnelKeys.next();
                result.put(key, tunnel.opt(key));
            }
        } catch (Exception ignored) {
        }
        LofaAccessibilityService service = LofaAccessibilityService.getInstance();
        if (service != null) {
            try {
                org.json.JSONObject status = service.status();
                java.util.Iterator<String> keys = status.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    result.put(key, status.opt(key));
                }
            } catch (Exception ignored) {
            }
        }
        call.resolve(result);
    }

    @PluginMethod
    public void startDevTunnel(PluginCall call) {
        // 覆盖项可选；缺省时 DevTunnelService 从 DeviceBridgeConfig 推导(base_url 主机 + 8211 + device_token)。
        String relayHost = call.getString("relayHost", "");
        int relayPort = call.getInt("relayPort", 0);
        String scheme = call.getString("scheme", "");
        String token = call.getString("token", "");
        DevTunnelService.start(getContext(), relayHost, relayPort, scheme, token);
        JSObject result = new JSObject();
        result.put("started", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stopDevTunnel(PluginCall call) {
        DevTunnelService.stop(getContext());
        JSObject result = new JSObject();
        result.put("stopped", true);
        call.resolve(result);
    }

    @PluginMethod
    public void devTunnelStatus(PluginCall call) {
        JSObject result = new JSObject();
        try {
            org.json.JSONObject status = DevTunnelService.statusJson();
            java.util.Iterator<String> keys = status.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                result.put(key, status.opt(key));
            }
        } catch (Exception ignored) {
        }
        call.resolve(result);
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }
}
