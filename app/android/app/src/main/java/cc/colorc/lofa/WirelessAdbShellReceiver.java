package cc.colorc.lofa;

/**
 * Manual trigger from a trusted adb shell:
 *   am broadcast -a cc.colorc.lofa.ENSURE_WIRELESS_ADB -n cc.colorc.lofa/.WirelessAdbShellReceiver
 * Exported but guarded by android.permission.DUMP, which the shell holds and ordinary apps cannot.
 */
public final class WirelessAdbShellReceiver extends WirelessAdbReceiver {
}
