package cc.colorc.lofa;

import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Opens an explicitly classified public HTTP(S) link in the user's browser. */
@CapacitorPlugin(name = "ExternalBrowser")
public final class ExternalBrowser extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String rawUrl = call.getString("url", "").trim();
        Uri uri;
        try {
            uri = Uri.parse(rawUrl);
        } catch (Exception exception) {
            call.reject("invalid url");
            return;
        }
        String scheme = uri.getScheme();
        if (scheme == null
                || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            call.reject("only http and https urls are allowed");
            return;
        }

        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (intent.resolveActivity(getContext().getPackageManager()) == null) {
            call.reject("no browser is installed");
            return;
        }
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception exception) {
            call.reject(exception.getMessage());
        }
    }
}
