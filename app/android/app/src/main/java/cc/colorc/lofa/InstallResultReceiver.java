package cc.colorc.lofa;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

/** Persists PackageInstaller results and opens the OEM confirmation only when Android requires it. */
public final class InstallResultReceiver extends BroadcastReceiver {
    static final String ACTION_INSTALL_RESULT = "cc.colorc.lofa.INSTALL_RESULT";

    @Override
    public void onReceive(Context context, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        int sessionId = intent.getIntExtra("session_id", -1);
        context.getSharedPreferences(ApkInstaller.INSTALL_PREFS, Context.MODE_PRIVATE).edit()
                .putInt("status", status)
                .putString("message", message == null ? "" : message)
                .putInt("session_id", sessionId)
                .putLong("updated_at", System.currentTimeMillis())
                .apply();
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmation;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                confirmation = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
            } else {
                //noinspection deprecation
                confirmation = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            }
            if (confirmation != null) {
                confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(confirmation);
            }
        }
    }
}
