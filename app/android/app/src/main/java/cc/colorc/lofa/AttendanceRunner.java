package cc.colorc.lofa;

import android.accessibilityservice.AccessibilityService;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.Arrays;
import java.util.List;

/** One bounded local attempt. No network, shell commands or attendance API calls. */
final class AttendanceRunner {
    static final String FEISHU = "com.ss.android.lark";
    private static volatile AttendanceRunner active;
    private final Context context;
    private final AttendanceStore store;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final KeyguardManager keyguard;
    private PowerManager.WakeLock wakeLock;
    private volatile boolean initiallyLocked;
    private boolean done;
    private boolean userInteracted;
    private boolean watchingInteraction;
    private volatile boolean openingFeishu;
    private char[] pin;
    private long deadline;

    private AttendanceRunner(Context context) {
        this.context = context.getApplicationContext();
        store = new AttendanceStore(context);
        keyguard = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
    }

    static void start(Context context, boolean test) {
        new Handler(Looper.getMainLooper()).post(() -> {
            if (active != null) {
                new AttendanceStore(context).record("上一次尚未结束，已跳过重复触发");
                return;
            }
            active = new AttendanceRunner(context);
            active.begin(test);
        });
    }

    static void interaction(int type) {
        if (active != null && active.watchingInteraction
                && (type == android.view.accessibility.AccessibilityEvent.TYPE_TOUCH_INTERACTION_START
                || type == android.view.accessibility.AccessibilityEvent.TYPE_VIEW_CLICKED
                || type == android.view.accessibility.AccessibilityEvent.TYPE_VIEW_SCROLLED)) {
            active.userInteracted = true;
        }
    }

    static void cancel() {
        if (active == null) return;
        active.store.record("已取消本次执行");
        AttendanceWakeActivity.close();
        if (Build.VERSION.SDK_INT >= 28 && active.initiallyLocked && !active.userInteracted && active.service() != null
                && (active.locked() || FEISHU.equals(active.foreground()))) {
            active.service().performGlobalAction(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN);
        }
        active.finish();
    }

    private LofaAccessibilityService service() { return LofaAccessibilityService.getInstance(); }
    private boolean locked() { return keyguard.isKeyguardLocked(); }
    static boolean isEnteringCredential() {
        AttendanceRunner run = active;
        return run != null && run.initiallyLocked && !run.openingFeishu;
    }

    private void begin(boolean test) {
        initiallyLocked = locked();
        store.record((test ? "测试" : "定时") + "触发：" + (initiallyLocked ? "锁屏" : "已解锁"));
        if (service() == null) { fail("LOFA 无障碍服务未运行"); return; }
        if (initiallyLocked && (!store.hasPin() || store.blocked())) {
            fail("请在 LOFA 重新保存解锁 PIN"); return;
        }
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LOFA:attendance");
        wakeLock.acquire(60_000);
        handler.postDelayed(() -> { if (!done) fail("执行超时，请查看飞书考勤"); }, 45_000);
        if (!initiallyLocked) { launch(); return; }
        try {
            pin = store.loadPin();
            Intent wake = new Intent(context, AttendanceWakeActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
            service().startActivity(wake);
            deadline = SystemClock.elapsedRealtime() + 8_000;
            handler.postDelayed(this::waitForKeypad, 800);
        } catch (Exception error) { fail("无法读取解锁 PIN，请重新保存"); }
    }

    private AccessibilityNodeInfo find(String id) {
        LofaAccessibilityService access = service();
        if (access == null) return null;
        List<AccessibilityWindowInfo> windows = access.getWindows();
        for (AccessibilityWindowInfo window : windows) {
            AccessibilityNodeInfo root = window.getRoot();
            if (root == null) continue;
            try {
                if (!"com.android.systemui".contentEquals(root.getPackageName() == null ? "" : root.getPackageName())) continue;
                List<AccessibilityNodeInfo> nodes = root.findAccessibilityNodeInfosByViewId("com.android.systemui:id/" + id);
                AccessibilityNodeInfo match = null;
                for (AccessibilityNodeInfo node : nodes) {
                    if (match == null && node.isVisibleToUser() && node.isEnabled()) match = node;
                    else node.recycle();
                }
                if (match != null) return match;
            } finally { root.recycle(); }
        }
        return null;
    }

    private void waitForKeypad() {
        if (done) return;
        if (!locked()) { launch(); return; }
        boolean complete = true;
        for (int digit = 0; digit < 10; digit++) {
            AccessibilityNodeInfo node = find("key" + digit);
            if (node == null || !node.isClickable()) complete = false;
            if (node != null) node.recycle();
        }
        AccessibilityNodeInfo entry = find("pinEntry");
        if (entry == null) complete = false;
        else {
            // Never append to a credential already being entered by the owner.
            boolean occupied = entry.getText() != null && entry.getText().length() > 0;
            entry.recycle();
            if (occupied) { fail("锁屏输入框非空，已停止自动解锁"); return; }
        }
        if (complete) {
            // Persist BEFORE the first key: process death or a bad PIN cannot cause retries.
            store.prefs.edit().putBoolean("pin_blocked", true).commit();
            typeDigit(0);
        } else if (SystemClock.elapsedRealtime() < deadline) handler.postDelayed(this::waitForKeypad, 300);
        else fail("未找到完整数字键盘，已停止自动解锁");
    }

    private void typeDigit(int index) {
        if (done) return;
        if (!locked()) { unlocked(); return; }
        if (pin == null) { fail("解锁已中断"); return; }
        if (index >= pin.length) {
            erasePin();
            AccessibilityNodeInfo enter = find("key_enter");
            if (enter != null) { enter.performAction(AccessibilityNodeInfo.ACTION_CLICK); enter.recycle(); }
            deadline = SystemClock.elapsedRealtime() + 4_000;
            handler.postDelayed(this::waitForUnlock, 300);
            return;
        }
        AccessibilityNodeInfo node = find("key" + pin[index]);
        boolean clicked = node != null && node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        if (node != null) node.recycle();
        if (!clicked) { fail("数字键操作失败，请重新保存 PIN 后测试"); return; }
        handler.postDelayed(() -> typeDigit(index + 1), 220);
    }

    private void waitForUnlock() {
        if (done) return;
        if (!locked()) unlocked();
        else if (SystemClock.elapsedRealtime() < deadline) handler.postDelayed(this::waitForUnlock, 250);
        else fail("解锁未成功；后续 PIN 尝试已暂停");
    }

    private void unlocked() {
        store.prefs.edit().putBoolean("pin_blocked", false).commit();
        launch();
    }

    private void launch() {
        if (done) return;
        erasePin();
        if (locked()) { fail("手机仍处于锁屏状态"); return; }
        openingFeishu = true;
        AttendanceWakeActivity.close();
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(FEISHU);
        if (launch == null || service() == null) { fail("无法打开飞书，请检查安装与无障碍服务"); return; }
        try {
            service().startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            handler.postDelayed(() -> {
                if (!FEISHU.equals(foreground())) { fail("飞书未到前台，请手动检查考勤"); return; }
                store.record("已打开飞书；考勤结果请以飞书为准");
                if (!initiallyLocked) { finish(); return; }
                watchingInteraction = true;
                handler.postDelayed(this::relock, 20_000);
            }, 1500);
        } catch (Exception error) { fail("启动飞书失败，请手动检查考勤"); }
    }

    private String foreground() {
        if (service() == null) return "";
        AccessibilityNodeInfo root = service().getRootInActiveWindow();
        if (root == null) return "";
        try { return String.valueOf(root.getPackageName()); } finally { root.recycle(); }
    }

    private void relock() {
        if (done) return;
        if (locked()) store.record("已恢复锁屏");
        else if (userInteracted || !FEISHU.equals(foreground())) store.record("检测到手机操作，保留当前屏幕状态");
        else if (Build.VERSION.SDK_INT >= 28 && service() != null
                && service().performGlobalAction(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN)) {
            store.record("已恢复锁屏");
        } else { fail("自动回锁失败，请检查手机"); return; }
        finish();
    }

    private void fail(String message) {
        store.record(message);
        notifyFailure(context, message);
        AttendanceWakeActivity.close();
        // Do not leave the screen lit on a failed credential attempt.
        if (initiallyLocked && locked() && service() != null && Build.VERSION.SDK_INT >= 28) {
            service().performGlobalAction(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN);
        }
        finish();
    }

    private void erasePin() { if (pin != null) { Arrays.fill(pin, '\0'); pin = null; } }
    private void finish() {
        done = true;
        erasePin();
        handler.removeCallbacksAndMessages(null);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (active == this) active = null;
    }

    static void notifyFailure(Context context, String message) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        String channel = "attendance_result";
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(
                new NotificationChannel(channel, "飞书定时启动结果", NotificationManager.IMPORTANCE_DEFAULT));
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(context, channel) : new Notification.Builder(context);
        try {
            manager.notify(7300, builder.setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle("飞书定时启动需要检查").setContentText(message)
                    .setContentIntent(AttendanceScheduler.settings(context)).setAutoCancel(true).build());
        } catch (SecurityException ignored) { /* The same result remains in the native history. */ }
    }
}
