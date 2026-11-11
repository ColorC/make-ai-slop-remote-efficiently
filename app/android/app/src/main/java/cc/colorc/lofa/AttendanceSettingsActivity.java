package cc.colorc.lofa;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.KeyguardManager;
import android.app.TimePickerDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/** Local/offline settings. Credentials deliberately have no Capacitor or remote API. */
public final class AttendanceSettingsActivity extends Activity {
    private static volatile boolean privateInput;
    private AttendanceStore store;
    private LinearLayout body;
    private TextView status;
    private TextView history;
    static boolean isEnteringPin() { return privateInput; }

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        store = new AttendanceStore(this);
        getWindow().setStatusBarColor(Color.rgb(246, 247, 251));
        getWindow().setNavigationBarColor(Color.rgb(246, 247, 251));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(22), dp(32), dp(22), dp(36));
        body.setBackgroundColor(Color.rgb(246, 247, 251));
        scroll.addView(body);
        setContentView(scroll);
        if (Build.VERSION.SDK_INT >= 35) scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars());
            body.setPadding(dp(22), bars.top + dp(16), dp(22), bars.bottom + dp(24));
            return insets;
        });
        title("飞书定时启动", 26);
        title("到时自动打开飞书，由极速打卡核验位置与时间。无需电脑在线，无订阅费用。", 15);
        status = title("", 14);
        Switch enabled = new Switch(this);
        enabled.setText("启用定时启动");
        enabled.setTextSize(18);
        enabled.setPadding(0, dp(12), 0, dp(12));
        enabled.setChecked(store.enabled());
        body.addView(enabled);
        enabled.setOnCheckedChangeListener((button, checked) -> {
            if (checked && (!store.hasPin() || store.blocked() || !AttendanceScheduler.permitted(this)
                    || !LofaAccessibilityService.isRunning() || store.days() == 0)) {
                toast("请先保存 PIN，并开启无障碍与精确定时权限");
                button.setChecked(false);
                return;
            }
            store.prefs.edit().putBoolean("enabled", checked).commit();
            if (checked) AttendanceScheduler.refresh(this);
            else { AttendanceScheduler.cancel(this); AttendanceRunner.cancel(); }
            refreshStatus();
        });
        title("每周执行（不自动识别节假日或调休）", 16);
        LinearLayout days = new LinearLayout(this);
        String[] labels = {"一", "二", "三", "四", "五", "六", "日"};
        for (int day = 0; day < 7; day++) {
            final int mask = 1 << day;
            CheckBox check = new CheckBox(this);
            check.setText(labels[day]);
            check.setTextSize(13);
            check.setPadding(0, 0, 0, 0);
            check.setChecked((store.days() & mask) != 0);
            days.addView(check, new LinearLayout.LayoutParams(0, dp(52), 1));
            check.setOnCheckedChangeListener((view, checked) -> {
                int selected = checked ? store.days() | mask : store.days() & ~mask;
                if (selected == 0) { view.setChecked(true); toast("请至少保留一天；暂停请关闭启用开关"); return; }
                store.prefs.edit().putInt("days", selected).commit();
                AttendanceScheduler.refresh(this);
                refreshStatus();
            });
        }
        body.addView(days);
        for (int row = 0; row < 2; row++) {
            LinearLayout times = new LinearLayout(this);
            for (int col = 0; col < 2; col++) {
                final int slot = row * 2 + col;
                Button time = new Button(this);
                time.setText(timeLabel(store.time(slot)));
                time.setContentDescription("时间 " + (slot + 1) + " " + timeLabel(store.time(slot)));
                times.addView(time, new LinearLayout.LayoutParams(0, dp(54), 1));
                time.setOnClickListener(view -> new TimePickerDialog(this, (picker, hour, minute) -> {
                    store.prefs.edit().putInt("time_" + slot, hour * 60 + minute).commit();
                    time.setText(timeLabel(store.time(slot)));
                    time.setContentDescription("时间 " + (slot + 1) + " " + timeLabel(store.time(slot)));
                    AttendanceScheduler.refresh(this);
                    refreshStatus();
                }, store.time(slot) / 60, store.time(slot) % 60, true).show());
            }
            body.addView(times);
        }
        button("保存或更换解锁 PIN", this::enterPin);
        title("PIN 仅在本机加密保存。锁屏时尝试一次；解锁失败后暂停 PIN 尝试，需重新保存。重启后须先手动解锁一次。", 14);
        button("30秒后测试", () -> {
            if (!AttendanceScheduler.permitted(this) || !LofaAccessibilityService.isRunning()) {
                toast("请先开启无障碍与精确定时权限"); return;
            }
            AttendanceScheduler.test(this);
            store.record("已预约 30 秒后测试");
            toast("已预约；可锁屏测试，或保持解锁测试");
            refreshStatus();
        });
        button("取消测试", () -> {
            AttendanceRunner.cancel();
            AttendanceScheduler.cancel(this);
            AttendanceScheduler.refresh(this);
            refreshStatus();
            toast("已取消测试，正式时间保持有效");
        });
        title("原先锁屏：打开后约 20 秒回锁；检测到点击、滚动或切换应用则保留当前状态。原先已解锁：只打开飞书。", 14);
        button("精确定时权限", () -> {
            if (Build.VERSION.SDK_INT >= 31) startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                    Uri.parse("package:" + getPackageName())));
        });
        button("无障碍权限", () -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        button("通知权限", () -> {
            if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 73);
        });
        button("应用后台设置", () -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getPackageName()))));
        title("小米需允许自启动、后台弹出界面、锁屏显示，并将省电策略设为无限制。", 14);
        title("最近执行", 18);
        history = title("", 13);
        history.setTextIsSelectable(true);
        button("清除 PIN 并停用", () -> new AlertDialog.Builder(this).setTitle("清除本机 PIN？")
                .setMessage("将同时停用所有飞书定时启动和测试。")
                .setNegativeButton("取消", null).setPositiveButton("清除", (dialog, which) -> {
                    AttendanceRunner.cancel(); store.clearPin(); AttendanceScheduler.cancel(this); recreate();
                }).show());
        button("返回 LOFA", this::finish);
    }

    @Override public void onResume() { super.onResume(); AttendanceScheduler.refresh(this); refreshStatus(); }

    private int dp(int value) { return (int) (getResources().getDisplayMetrics().density * value + .5f); }
    private TextView title(String text, int size) {
        TextView view = new TextView(this);
        view.setText(text); view.setTextSize(size); view.setTextColor(Color.rgb(36, 43, 59));
        view.setPadding(0, dp(7), 0, dp(7)); body.addView(view); return view;
    }
    private void button(String text, Runnable action) {
        Button button = new Button(this); button.setText(text); button.setAllCaps(false);
        body.addView(button, new LinearLayout.LayoutParams(-1, dp(52)));
        button.setOnClickListener(view -> action.run());
    }
    private static String timeLabel(int minute) { return String.format(Locale.ROOT, "%02d:%02d", minute / 60, minute % 60); }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
    private void refreshStatus() {
        if (status == null) return;
        String message = (store.enabled() ? "已启用" : "未启用") + " · PIN "
                + (store.blocked() ? "需重新保存" : store.hasPin() ? "已加密保存" : "未设置")
                + "\n无障碍：" + (LofaAccessibilityService.isRunning() ? "正常" : "未运行")
                + "　精确定时：" + (AttendanceScheduler.permitted(this) ? "已允许" : "未允许");
        if (store.enabled() && store.days() != 0) {
            long next = Long.MAX_VALUE;
            for (int slot = 0; slot < 4; slot++) next = Math.min(next, AttendancePlan.next(System.currentTimeMillis(), store.time(slot), store.days(), TimeZone.getDefault()));
            message += "\n下次：" + new SimpleDateFormat("MM-dd E HH:mm", Locale.CHINA).format(new Date(next));
        }
        long test = store.prefs.getLong("test_due", 0);
        if (test > System.currentTimeMillis()) message += "\n测试：" + new SimpleDateFormat("HH:mm:ss", Locale.CHINA).format(new Date(test));
        status.setText(message);
        if (history != null) history.setText(store.prefs.getString("history", "暂无执行记录"));
    }

    private void enterPin() {
        if (((KeyguardManager) getSystemService(KEYGUARD_SERVICE)).isKeyguardLocked()) {
            toast("请先手动解锁手机"); return;
        }
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        input.setHint("手机锁屏数字 PIN");
        input.setSaveEnabled(false);
        input.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        if (Build.VERSION.SDK_INT >= 26) input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("保存解锁 PIN")
                .setMessage("请直接在手机输入。不会发送到聊天、网页或电脑。")
                .setView(input).setNegativeButton("取消", null).setPositiveButton("保存", null).create();
        privateInput = true;
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        dialog.setOnDismissListener(ignored -> {
            input.getText().clear(); privateInput = false;
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            refreshStatus();
        });
        dialog.setOnShowListener(ignored -> {
            dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
                char[] pin = new char[input.length()];
                input.getText().getChars(0, input.length(), pin, 0);
                try {
                    store.savePin(pin); input.getText().clear();
                    ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(input.getWindowToken(), 0);
                    dialog.dismiss(); toast("PIN 已在本机加密保存");
                } catch (IllegalArgumentException error) { toast(error.getMessage()); }
                catch (Exception error) { toast("保存失败，请稍后重试"); }
                finally { Arrays.fill(pin, '\0'); }
            });
            input.requestFocus();
            dialog.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
        });
        dialog.show();
    }
}
