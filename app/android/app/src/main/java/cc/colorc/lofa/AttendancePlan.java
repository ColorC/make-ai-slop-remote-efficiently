package cc.colorc.lofa;

import java.util.Calendar;
import java.util.TimeZone;

/** Local wall-clock schedule. Bit zero is Monday; no holiday assumptions. */
final class AttendancePlan {
    static final int[] DEFAULT_TIMES = {595, 599, 1141, 1145};
    static final int WEEKDAYS = 31;

    static long next(long now, int minute, int days, TimeZone zone) {
        if (minute < 0 || minute >= 1440 || (days & 127) == 0) {
            throw new IllegalArgumentException("Invalid attendance schedule");
        }
        Calendar date = Calendar.getInstance(zone);
        date.setTimeInMillis(now);
        for (int offset = 0; offset < 8; offset++) {
            Calendar candidate = (Calendar) date.clone();
            candidate.add(Calendar.DATE, offset);
            candidate.set(Calendar.HOUR_OF_DAY, minute / 60);
            candidate.set(Calendar.MINUTE, minute % 60);
            candidate.set(Calendar.SECOND, 0);
            candidate.set(Calendar.MILLISECOND, 0);
            int day = (candidate.get(Calendar.DAY_OF_WEEK) + 5) % 7;
            if ((days & (1 << day)) != 0 && candidate.getTimeInMillis() > now) {
                return candidate.getTimeInMillis();
            }
        }
        throw new IllegalStateException("No next attendance day");
    }
}
