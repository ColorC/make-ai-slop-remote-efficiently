package cc.colorc.lofa;

import android.accessibilityservice.AccessibilityService;
import android.graphics.PixelFormat;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;

import org.json.JSONObject;

/**
 * Notices when a person touches the screen so remote automation can yield.
 *
 * A 1x1 transparent accessibility overlay with FLAG_WATCH_OUTSIDE_TOUCH receives one
 * ACTION_OUTSIDE for every touch-down anywhere else. The system zeroes the coordinates for
 * other apps' windows, and none are needed: only the time is kept. Touches from lofa's own
 * dispatched gestures (inside an injection window) and from virtual devices (adb input) are
 * not counted as human. Touch exploration mode is deliberately not used because it would
 * change how the whole device reacts to touch.
 */
final class HumanTouchWatcher {
    private static final String TAG = "LofaTouchWatch";
    /** Grace after an injected gesture ends; its ACTION_OUTSIDE can arrive slightly late. */
    private static final long INJECTION_TAIL_MILLIS = 400;

    private static volatile long lastHumanTouchAt;      // wall clock, ms
    private static volatile long lastSelfTouchAt;       // wall clock, ms
    private static volatile int humanTouches;
    private static volatile int selfTouches;
    private static volatile long injectingUntilUptime;
    private static volatile String state = "detached";
    private static volatile int lastDeviceId;
    /** Wall clock (ms) since which the overlay has been attached without a gap; 0 when not watching. */
    private static volatile long watchingSince;

    private View view;

    void attach(AccessibilityService service) {
        if (view != null) return;
        try {
            WindowManager manager = service.getSystemService(WindowManager.class);
            View probe = new View(service);
            probe.setOnTouchListener((ignored, event) -> {
                record(event);
                return false;
            });
            WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                    1,
                    1,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                            | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
                            | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.TRANSLUCENT
            );
            params.gravity = Gravity.TOP | Gravity.START;
            params.x = 0;
            params.y = 0;
            params.setTitle("lofa-touch-watch");
            manager.addView(probe, params);
            view = probe;
            state = "attached";
            watchingSince = System.currentTimeMillis();
        } catch (Throwable error) {
            state = "unavailable: " + error.getClass().getSimpleName();
            Log.w(TAG, "touch watcher overlay failed", error);
        }
    }

    void detach(AccessibilityService service) {
        if (view == null) return;
        try {
            service.getSystemService(WindowManager.class).removeViewImmediate(view);
        } catch (Throwable ignored) {
        }
        view = null;
        state = "detached";
        watchingSince = 0;
    }

    /** Call right before dispatching a gesture that lasts {@code durationMillis}. */
    static void markInjection(long durationMillis) {
        long until = SystemClock.uptimeMillis() + Math.max(0, durationMillis) + INJECTION_TAIL_MILLIS;
        if (until > injectingUntilUptime) injectingUntilUptime = until;
    }

    static long lastHumanTouchAt() {
        return lastHumanTouchAt;
    }

    private static void record(MotionEvent event) {
        int action = event.getActionMasked();
        if (action != MotionEvent.ACTION_OUTSIDE && action != MotionEvent.ACTION_DOWN) return;
        long now = System.currentTimeMillis();
        if (event.getEventTime() <= injectingUntilUptime || isVirtual(event)) {
            lastSelfTouchAt = now;
            selfTouches += 1;
            return;
        }
        lastHumanTouchAt = now;
        humanTouches += 1;
    }

    private static boolean isVirtual(MotionEvent event) {
        try {
            InputDevice device = InputDevice.getDevice(event.getDeviceId());
            lastDeviceId = event.getDeviceId();
            return device != null && device.isVirtual();
        } catch (Throwable ignored) {
            return false;
        }
    }

    static void putStatus(JSONObject out) {
        try {
            long now = System.currentTimeMillis();
            out.put("touch_watch", state);
            // Touches are only seen while attached: "no human touch in the last N minutes" is a claim
            // the controller may make only when human_touch_since is at least N minutes ago.
            out.put("human_touch_since", watchingSince);
            out.put("human_touch_since_s", watchingSince > 0 ? (now - watchingSince) / 1000.0 : JSONObject.NULL);
            out.put("last_touch_at", lastHumanTouchAt);
            out.put("last_touch_s", lastHumanTouchAt > 0 ? (now - lastHumanTouchAt) / 1000.0 : JSONObject.NULL);
            out.put("human_touches", humanTouches);
            out.put("self_touches", selfTouches);
            out.put("last_self_touch_at", lastSelfTouchAt);
            out.put("last_touch_device_id", lastDeviceId);
        } catch (Exception ignored) {
        }
    }
}
