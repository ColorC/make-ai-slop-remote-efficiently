package cc.colorc.lofa;

import org.junit.Test;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.TimeZone;
import static org.junit.Assert.assertEquals;

public class AttendancePlanTest {
    private long parse(String time, String zone) throws Exception {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone(zone));
        return format.parse(time).getTime();
    }
    private void next(String now, int minute, int days, String expected, String zone) throws Exception {
        assertEquals(parse(expected, zone), AttendancePlan.next(parse(now, zone), minute, days, TimeZone.getTimeZone(zone)));
    }
    @Test public void skipsWeekendAndAnAlreadyDeliveredMinute() throws Exception {
        next("2026-11-06 19:05:00", 1145, 31, "2026-11-09 19:05:00", "Asia/Singapore");
        next("2026-11-09 09:55:00", 595, 31, "2026-11-10 09:55:00", "Asia/Singapore");
        next("2026-11-09 09:54:59", 595, 31, "2026-11-09 09:55:00", "Asia/Singapore");
    }
    @Test public void nearbySlotsRemainSeparateAndSundayWorks() throws Exception {
        next("2026-11-09 09:55:01", 599, 31, "2026-11-09 09:59:00", "Asia/Singapore");
        next("2026-11-09 19:00:00", 1141, 64, "2026-11-15 19:01:00", "Asia/Singapore");
    }
    @Test public void keepsLocalTimeAcrossDaylightSavingBoundary() throws Exception {
        next("2026-10-30 20:00:00", 595, 31, "2026-11-02 09:55:00", "America/New_York");
    }
    @Test(expected = IllegalArgumentException.class) public void rejectsEmptyDays() {
        AttendancePlan.next(0, 595, 0, TimeZone.getDefault());
    }
    @Test(expected = IllegalArgumentException.class) public void rejectsInvalidTime() {
        AttendancePlan.next(0, 1440, 31, TimeZone.getDefault());
    }
}
