package cc.colorc.lofa;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The alarm receiver is private; public system events can only restore the schedule. */
public final class AttendanceReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        AttendanceStore store = new AttendanceStore(context);
        if (!AttendanceScheduler.FIRE.equals(intent.getAction())) {
            AttendanceScheduler.refresh(context);
            return;
        }
        int slot = intent.getIntExtra("slot", -1);
        long due = intent.getLongExtra("due", 0);
        if (slot < 0 || slot > AttendanceScheduler.TEST || due == 0) return;
        boolean test = slot == AttendanceScheduler.TEST;
        if (test) {
            if (store.prefs.getLong("test_due", 0) != due) return;
            store.prefs.edit().remove("test_due").commit();
        } else {
            AttendanceScheduler.refresh(context);
            if (!store.enabled()) return;
        }
        if (Math.abs(System.currentTimeMillis() - due) > 90_000) {
            store.record("错过触发时间，已跳过本次");
            AttendanceRunner.notifyFailure(context, "错过触发时间，请查看飞书考勤");
            return;
        }
        // Persist before execution; an alarm must never type a PIN twice after redelivery.
        String id = "last_" + slot;
        if (store.prefs.getLong(id, 0) >= due) return;
        store.prefs.edit().putLong(id, due).commit();
        AttendanceRunner.start(context, test);
    }
}
