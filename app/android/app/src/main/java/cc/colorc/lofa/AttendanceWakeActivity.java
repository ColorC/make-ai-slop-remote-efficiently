package cc.colorc.lofa;

import android.app.Activity;
import android.app.KeyguardManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.TextView;

/** Private, short-lived window used only to wake and request the real system PIN UI. */
public final class AttendanceWakeActivity extends Activity {
    private static AttendanceWakeActivity current;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        current = this;
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true); }
        TextView text = new TextView(this);
        text.setText("飞书定时启动\n正在请求解锁…");
        text.setGravity(android.view.Gravity.CENTER);
        text.setTextSize(22);
        setContentView(text);
        if (Build.VERSION.SDK_INT >= 26) text.postDelayed(() -> {
            if (!isFinishing()) ((KeyguardManager) getSystemService(KEYGUARD_SERVICE)).requestDismissKeyguard(this, null);
        }, 250);
        text.postDelayed(this::finish, 12_000);
    }
    static void close() { if (current != null) current.finish(); }
    @Override public void onDestroy() { if (current == this) current = null; super.onDestroy(); }
}
