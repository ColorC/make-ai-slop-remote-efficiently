package cc.colorc.lofa;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Executes bounded UI operations after the user enables Android accessibility access. */
public final class LofaAccessibilityService extends AccessibilityService {
    private static final long UI_TREE_BUDGET_MILLIS = 800;
    private static volatile LofaAccessibilityService instance;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    public static LofaAccessibilityService getInstance() {
        return instance;
    }

    public static boolean isRunning() {
        return instance != null;
    }

    public static void configure(android.content.Context context, String baseUrl, String deviceId) {
        DeviceBridgeConfig.configure(context, baseUrl, deviceId);
        DeviceBridgeService.startIfConfigured(context);
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        DeviceBridgeService.startIfConfigured(this);
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // UI state is read only when an allowlisted command requests it.
    }

    @Override
    public void onInterrupt() {
        // Android owns this lifecycle and may reconnect the service.
    }

    public JSONObject executeAutomationCommand(String op, JSONObject args) throws Exception {
        JSONObject safeArgs = args == null ? new JSONObject() : args;
        switch (op) {
            case "status":
                return status();
            case "ui_tree":
                return onMain(() -> uiTree(Math.max(1, Math.min(500, safeArgs.optInt("max_nodes", 250)))));
            case "tap":
                return tap((float) safeArgs.optDouble("nx", -1), (float) safeArgs.optDouble("ny", -1));
            case "click_text":
                return onMain(() -> clickText(safeArgs.optString("text"), safeArgs.optBoolean("exact", true)));
            case "set_text":
                return onMain(() -> setText(safeArgs.optString("text"), safeArgs.optString("view_id")));
            case "global_action":
                return onMain(() -> globalAction(safeArgs.optString("action")));
            case "launch_app":
                return onMain(() -> launchApp(safeArgs.optString("package")));
            case "launch_label":
                return onMain(() -> launchLabel(safeArgs.optString("label")));
            case "screenshot":
                return screenshot();
            default:
                return error("unsupported automation op: " + op);
        }
    }

    public JSONObject status() {
        JSONObject out = new JSONObject();
        try {
            AccessibilityNodeInfo root = activeRoot();
            out.put("enabled", true);
            out.put("service_connected", true);
            out.put("package", root == null || root.getPackageName() == null ? "" : String.valueOf(root.getPackageName()));
            out.put("window_title", root == null || root.getText() == null ? "" : clip(root.getText(), 160));
            out.put("android_api", Build.VERSION.SDK_INT);
            JSONObject bridge = DeviceBridgeService.statusJson(this);
            java.util.Iterator<String> keys = bridge.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                out.put(key, bridge.opt(key));
            }
        } catch (Exception exception) {
            return error(exception.getMessage());
        }
        return out;
    }

    private JSONObject uiTree(int maxNodes) {
        AccessibilityNodeInfo root = activeRoot();
        if (root == null) return error("no active accessibility window");
        JSONArray nodes = new JSONArray();
        boolean timedOut = appendNodesBounded(root, nodes, maxNodes);
        JSONObject out = new JSONObject();
        try {
            out.put("package", root.getPackageName() == null ? "" : String.valueOf(root.getPackageName()));
            out.put("nodes", nodes);
            out.put("timed_out", timedOut);
            out.put("truncated", timedOut || nodes.length() >= maxNodes);
        } catch (Exception exception) {
            return error(exception.getMessage());
        }
        return out;
    }

    private boolean appendNodesBounded(AccessibilityNodeInfo root, JSONArray rows, int maxNodes) {
        long deadline = SystemClock.elapsedRealtime() + UI_TREE_BUDGET_MILLIS;
        ArrayDeque<NodeFrame> pending = new ArrayDeque<>();
        Set<String> seen = new HashSet<>();
        pending.push(new NodeFrame(root, 0, false));
        boolean timedOut = false;
        while (!pending.isEmpty() && rows.length() < maxNodes) {
            if (SystemClock.elapsedRealtime() >= deadline) {
                timedOut = true;
                break;
            }
            NodeFrame frame = pending.pop();
            AccessibilityNodeInfo node = frame.node;
            try {
                Rect bounds = new Rect();
                node.getBoundsInScreen(bounds);
                String fingerprint = String.format(
                        Locale.ROOT,
                        "%d|%s|%s|%s|%d,%d,%d,%d|%d",
                        node.getWindowId(),
                        String.valueOf(node.getClassName()),
                        String.valueOf(node.getViewIdResourceName()),
                        clip(node.getText(), 160),
                        bounds.left, bounds.top, bounds.right, bounds.bottom,
                        frame.depth
                );
                if (!seen.add(fingerprint)) continue;
                JSONObject row = new JSONObject();
                boolean editable = node.isEditable();
                row.put("depth", frame.depth);
                row.put("class", node.getClassName() == null ? "" : String.valueOf(node.getClassName()));
                row.put("text", clip(node.getText(), editable ? 12000 : 1000));
                row.put("description", clip(node.getContentDescription(), 1000));
                row.put("view_id", node.getViewIdResourceName() == null ? "" : node.getViewIdResourceName());
                row.put("clickable", node.isClickable());
                row.put("editable", editable);
                row.put("enabled", node.isEnabled());
                row.put("focused", node.isFocused());
                row.put("checkable", node.isCheckable());
                row.put("checked", node.isChecked());
                row.put("selected", node.isSelected());
                row.put("bounds", String.format(Locale.ROOT, "%d,%d,%d,%d", bounds.left, bounds.top, bounds.right, bounds.bottom));
                rows.put(row);
                for (int index = node.getChildCount() - 1; index >= 0; index--) {
                    if (SystemClock.elapsedRealtime() >= deadline) {
                        timedOut = true;
                        break;
                    }
                    AccessibilityNodeInfo child = node.getChild(index);
                    if (child != null) pending.push(new NodeFrame(child, frame.depth + 1, true));
                }
            } catch (Exception ignored) {
                // One stale node must not prevent the rest of the bounded snapshot.
            } finally {
                if (frame.recycle) node.recycle();
            }
        }
        while (!pending.isEmpty()) {
            NodeFrame frame = pending.pop();
            if (frame.recycle) frame.node.recycle();
        }
        return timedOut;
    }

    private static final class NodeFrame {
        final AccessibilityNodeInfo node;
        final int depth;
        final boolean recycle;

        NodeFrame(AccessibilityNodeInfo node, int depth, boolean recycle) {
            this.node = node;
            this.depth = depth;
            this.recycle = recycle;
        }
    }

    @android.annotation.TargetApi(Build.VERSION_CODES.N)
    private JSONObject tap(float normalizedX, float normalizedY) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return error("tap requires Android 7 or newer");
        if (normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) {
            return error("tap requires normalized nx and ny in [0,1]");
        }
        android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
        float x = normalizedX * metrics.widthPixels;
        float y = normalizedY * metrics.heightPixels;
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<Boolean> success = new AtomicReference<>(false);
        mainHandler.post(() -> {
            Path path = new Path();
            path.moveTo(x, y);
            GestureDescription gesture = new GestureDescription.Builder()
                    .addStroke(new GestureDescription.StrokeDescription(path, 0, 80))
                    .build();
            dispatchGesture(gesture, new GestureResultCallback() {
                @Override
                public void onCompleted(GestureDescription gestureDescription) {
                    success.set(true);
                    latch.countDown();
                }

                @Override
                public void onCancelled(GestureDescription gestureDescription) {
                    latch.countDown();
                }
            }, null);
        });
        if (!latch.await(3, TimeUnit.SECONDS)) return error("tap timed out");
        JSONObject out = new JSONObject();
        out.put("dispatched", success.get());
        out.put("x", Math.round(x));
        out.put("y", Math.round(y));
        return out;
    }

    private JSONObject clickText(String text, boolean exact) {
        if (text == null || text.trim().isEmpty()) return error("click_text requires text");
        AccessibilityNodeInfo root = activeRoot();
        if (root == null) return error("no active accessibility window");
        List<AccessibilityNodeInfo> matches = root.findAccessibilityNodeInfosByText(text);
        for (AccessibilityNodeInfo candidate : matches) {
            String shown = candidate.getText() == null ? "" : String.valueOf(candidate.getText());
            String described = candidate.getContentDescription() == null ? "" : String.valueOf(candidate.getContentDescription());
            if (exact && !text.equals(shown) && !text.equals(described)) continue;
            AccessibilityNodeInfo clickable = candidate;
            while (clickable != null && !clickable.isClickable()) clickable = clickable.getParent();
            if (clickable != null && clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                JSONObject out = new JSONObject();
                try {
                    out.put("clicked", true);
                    out.put("text", text);
                } catch (Exception ignored) {
                }
                return out;
            }
        }
        return error("text target not found or not clickable: " + text);
    }

    private JSONObject setText(String text, String viewId) {
        AccessibilityNodeInfo root = activeRoot();
        if (root == null) return error("no active accessibility window");
        AccessibilityNodeInfo target = null;
        if (viewId != null && !viewId.trim().isEmpty()) {
            List<AccessibilityNodeInfo> found = root.findAccessibilityNodeInfosByViewId(viewId.trim());
            for (AccessibilityNodeInfo node : found) {
                if (node.isEditable()) {
                    target = node;
                    break;
                }
            }
        }
        if (target == null) target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (target == null || !target.isEditable()) target = firstEditable(root);
        if (target == null) return error("no editable field is available");
        Bundle values = new Bundle();
        values.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text == null ? "" : text);
        boolean changed = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, values);
        JSONObject out = new JSONObject();
        try {
            out.put("changed", changed);
            out.put("characters", text == null ? 0 : text.length());
            out.put("view_id", target.getViewIdResourceName() == null ? "" : target.getViewIdResourceName());
        } catch (Exception ignored) {
        }
        return changed ? out : error("ACTION_SET_TEXT was rejected by the target field");
    }

    private AccessibilityNodeInfo firstEditable(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isEditable() && node.isEnabled()) return node;
        for (int index = 0; index < node.getChildCount(); index++) {
            AccessibilityNodeInfo found = firstEditable(node.getChild(index));
            if (found != null) return found;
        }
        return null;
    }

    private JSONObject globalAction(String action) {
        int code;
        switch (action == null ? "" : action.trim().toLowerCase(Locale.ROOT)) {
            case "back": code = GLOBAL_ACTION_BACK; break;
            case "home": code = GLOBAL_ACTION_HOME; break;
            case "recents": code = GLOBAL_ACTION_RECENTS; break;
            case "notifications": code = GLOBAL_ACTION_NOTIFICATIONS; break;
            default: return error("unsupported global action: " + action);
        }
        JSONObject out = new JSONObject();
        try {
            out.put("performed", performGlobalAction(code));
            out.put("action", action);
        } catch (Exception ignored) {
        }
        return out;
    }

    private JSONObject launchApp(String packageName) {
        if (packageName == null || packageName.trim().isEmpty()) return error("launch_app requires package");
        Intent intent = getPackageManager().getLaunchIntentForPackage(packageName.trim());
        if (intent == null) return error("package is not installed: " + packageName);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
        JSONObject out = new JSONObject();
        try {
            out.put("launched", true);
            out.put("package", packageName.trim());
        } catch (Exception ignored) {
        }
        return out;
    }

    private JSONObject launchLabel(String label) {
        String wanted = label == null ? "" : label.trim();
        if (wanted.isEmpty()) return error("launch_label requires label");
        Intent query = new Intent(Intent.ACTION_MAIN);
        query.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> candidates = getPackageManager().queryIntentActivities(query, 0);
        for (ResolveInfo candidate : candidates) {
            CharSequence shown = candidate.loadLabel(getPackageManager());
            String value = shown == null ? "" : String.valueOf(shown).trim();
            if (!wanted.equals(value) && !value.contains(wanted)) continue;
            String packageName = candidate.activityInfo.packageName;
            JSONObject launched = launchApp(packageName);
            if (!launched.has("error")) {
                try {
                    launched.put("label", value);
                    launched.put("learned_package", packageName);
                } catch (Exception ignored) {
                }
            }
            return launched;
        }
        return error("launcher label is not available: " + wanted);
    }

    private JSONObject screenshot() throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return error("screenshot requires Android 11 or newer");
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<JSONObject> value = new AtomicReference<>();
        mainHandler.post(() -> takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
            @Override
            public void onSuccess(ScreenshotResult screenshotResult) {
                try {
                    HardwareBuffer buffer = screenshotResult.getHardwareBuffer();
                    Bitmap wrapped = Bitmap.wrapHardwareBuffer(buffer, screenshotResult.getColorSpace());
                    if (wrapped == null) throw new IllegalStateException("empty screenshot bitmap");
                    Bitmap bitmap = wrapped.copy(Bitmap.Config.ARGB_8888, false);
                    buffer.close();
                    int originalWidth = bitmap.getWidth();
                    int originalHeight = bitmap.getHeight();
                    int maxDimension = Math.max(originalWidth, originalHeight);
                    if (maxDimension > 1280) {
                        float scale = 1280f / maxDimension;
                        Bitmap scaled = Bitmap.createScaledBitmap(
                                bitmap,
                                Math.round(originalWidth * scale),
                                Math.round(originalHeight * scale),
                                true
                        );
                        bitmap.recycle();
                        bitmap = scaled;
                    }
                    int encodedWidth = bitmap.getWidth();
                    int encodedHeight = bitmap.getHeight();
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 75, bytes);
                    bitmap.recycle();
                    JSONObject out = new JSONObject();
                    out.put("mime", "image/jpeg");
                    out.put("width", originalWidth);
                    out.put("height", originalHeight);
                    out.put("encoded_width", encodedWidth);
                    out.put("encoded_height", encodedHeight);
                    out.put("base64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                    value.set(out);
                } catch (Exception exception) {
                    value.set(error(exception.getMessage()));
                } finally {
                    latch.countDown();
                }
            }

            @Override
            public void onFailure(int errorCode) {
                value.set(error("screenshot failed: " + errorCode));
                latch.countDown();
            }
        }));
        if (!latch.await(6, TimeUnit.SECONDS)) return error("screenshot timed out");
        return value.get() == null ? error("screenshot returned no result") : value.get();
    }

    private AccessibilityNodeInfo activeRoot() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root != null) return root;
        List<AccessibilityWindowInfo> windows = getWindows();
        if (windows != null) {
            for (AccessibilityWindowInfo window : windows) {
                if (window != null && window.getRoot() != null) return window.getRoot();
            }
        }
        return null;
    }

    private JSONObject onMain(java.util.concurrent.Callable<JSONObject> action) throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) return action.call();
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<JSONObject> value = new AtomicReference<>();
        AtomicReference<Exception> failure = new AtomicReference<>();
        mainHandler.post(() -> {
            try {
                value.set(action.call());
            } catch (Exception exception) {
                failure.set(exception);
            } finally {
                latch.countDown();
            }
        });
        if (!latch.await(4, TimeUnit.SECONDS)) throw new IllegalStateException("main-thread operation timed out");
        if (failure.get() != null) throw failure.get();
        return value.get();
    }

    private static String clip(CharSequence value, int max) {
        String text = value == null ? "" : String.valueOf(value);
        return text.length() <= max ? text : text.substring(0, max);
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
