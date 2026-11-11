package cc.colorc.lofa;

import android.app.KeyguardManager;
import android.content.Context;
import android.graphics.Point;
import android.hardware.display.DisplayManager;
import android.os.PowerManager;
import android.view.Display;

import org.json.JSONObject;

/** Screen facts a remote controller needs before touching anything. Read-only. */
final class DeviceState {
    private DeviceState() {
    }

    private static Display display(Context context) {
        DisplayManager manager = context.getSystemService(DisplayManager.class);
        return manager == null ? null : manager.getDisplay(Display.DEFAULT_DISPLAY);
    }

    /** Full display size in the current rotation: {width, height}. Same frame as a screenshot. */
    @SuppressWarnings("deprecation")
    static int[] displaySize(Context context) {
        Display display = display(context);
        if (display == null) {
            android.util.DisplayMetrics metrics = context.getResources().getDisplayMetrics();
            return new int[]{metrics.widthPixels, metrics.heightPixels};
        }
        Point size = new Point();
        display.getRealSize(size);
        return new int[]{size.x, size.y};
    }

    static int rotation(Context context) {
        Display display = display(context);
        return display == null ? -1 : display.getRotation();
    }

    static void putStatus(Context context, JSONObject out) {
        try {
            int[] size = displaySize(context);
            out.put("display_width", size[0]);
            out.put("display_height", size[1]);
            out.put("display_rotation", rotation(context));
            out.put("orientation", size[0] >= size[1] ? "landscape" : "portrait");
            PowerManager power = context.getSystemService(PowerManager.class);
            if (power != null) out.put("interactive", power.isInteractive());
            KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
            if (keyguard != null) out.put("keyguard_locked", keyguard.isKeyguardLocked());
        } catch (Exception ignored) {
        }
        HumanTouchWatcher.putStatus(out);
    }
}
