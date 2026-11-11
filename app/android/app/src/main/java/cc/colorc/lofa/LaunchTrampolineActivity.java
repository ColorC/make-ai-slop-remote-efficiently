package cc.colorc.lofa;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

/**
 * Invisible hop used by launch_app when the target app is not running.
 *
 * Honor/Huawei iAware refuses a background caller starting a stopped app
 * ("prevent start activity by iaware", seen 11-11 on MagicPad3 Pro for
 * com.hypergryph.endfield). Starting lofa's own activity first and letting that
 * foreground activity start the target is treated as an ordinary user-visible launch.
 */
public final class LaunchTrampolineActivity extends Activity {
    static final String EXTRA_PACKAGE = "cc.colorc.lofa.extra.LAUNCH_PACKAGE";
    private static final String TAG = "LofaLaunchHop";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String target = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_PACKAGE);
        try {
            Intent launch = target == null ? null : getPackageManager().getLaunchIntentForPackage(target);
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(launch);
            }
        } catch (Throwable error) {
            Log.w(TAG, "launch " + target + " failed", error);
        }
        finish();
        overridePendingTransition(0, 0);
    }
}
