package cc.colorc.lofa;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import java.util.TimeZone;

final class AttendanceScheduler {
    static final String FIRE = "cc.colorc.lofa.ATTENDANCE_ALARM";
    static final int TEST = 4;

    static boolean permitted(Context context) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        return Build.VERSION.SDK_INT < 31 || manager.canScheduleExactAlarms();
    }

    private static PendingIntent operation(Context context, int slot, long due) {
        Intent intent = new Intent(context, AttendanceReceiver.class).setAction(FIRE)
                .putExtra("slot", slot).putExtra("due", due);
        return PendingIntent.getBroadcast(context, 7300 + slot, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static PendingIntent settings(Context context) {
        return PendingIntent.getActivity(context, 7300, new Intent(context, AttendanceSettingsActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void cancel(Context context) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        for (int slot = 0; slot <= TEST; slot++) manager.cancel(operation(context, slot, 0));
        new AttendanceStore(context).prefs.edit().remove("test_due").commit();
    }

    static void refresh(Context context) {
        AttendanceStore store = new AttendanceStore(context);
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        for (int slot = 0; slot < 4; slot++) {
            manager.cancel(operation(context, slot, 0));
            if (store.enabled() && store.days() != 0 && permitted(context)) {
                long due = AttendancePlan.next(System.currentTimeMillis(), store.time(slot), store.days(), TimeZone.getDefault());
                set(context, slot, due);
            }
        }
    }

    private static void set(Context context, int slot, long due) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        // Alarm-clock API avoids idle throttling between the user's 09:55/09:59 slots.
        manager.setAlarmClock(new AlarmManager.AlarmClockInfo(due, settings(context)), operation(context, slot, due));
    }

    static void test(Context context) {
        long due = System.currentTimeMillis() + 30_000;
        new AttendanceStore(context).prefs.edit().putLong("test_due", due).commit();
        set(context, TEST, due);
    }
}
