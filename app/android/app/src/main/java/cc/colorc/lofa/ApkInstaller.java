package cc.colorc.lofa;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * LOFA 自更新插件: app 自己从 PC 拉 APK 并触发系统安装器。
 * 飞连下手机→PC 通, 所以离开扁平网也能装 —— 不需要 adb / PC 主动连手机。
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstaller extends Plugin {

    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean ok = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ok = getContext().getPackageManager().canRequestPackageInstalls();
        }
        JSObject r = new JSObject();
        r.put("granted", ok);
        call.resolve(r);
    }

    @PluginMethod
    public void openInstallPermission(PluginCall call) {
        try {
            Intent i;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName()));
            } else {
                i = new Intent(Settings.ACTION_SECURITY_SETTINGS);
            }
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            call.reject(e.getMessage());
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void downloadAndInstall(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) { call.reject("missing url"); return; }
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    File apk = new File(getContext().getCacheDir(), "lofa-update.apk");
                    if (apk.exists()) apk.delete();
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(120000);
                    c.setInstanceFollowRedirects(true);
                    c.connect();
                    int code = c.getResponseCode();
                    if (code / 100 != 2) { call.reject("http " + code); return; }
                    InputStream in = c.getInputStream();
                    FileOutputStream out = new FileOutputStream(apk);
                    byte[] buf = new byte[65536];
                    int n;
                    long total = 0;
                    while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); total += n; }
                    out.flush(); out.close(); in.close(); c.disconnect();
                    if (total < 1000) { call.reject("apk too small: " + total); return; }
                    final File fapk = apk;
                    getActivity().runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                Uri uri = FileProvider.getUriForFile(getContext(),
                                        getContext().getPackageName() + ".fileprovider", fapk);
                                Intent i = new Intent(Intent.ACTION_VIEW);
                                i.setDataAndType(uri, "application/vnd.android.package-archive");
                                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                                getContext().startActivity(i);
                                JSObject r = new JSObject();
                                r.put("bytes", fapk.length());
                                call.resolve(r);
                            } catch (Exception e) {
                                call.reject("install: " + e.getMessage());
                            }
                        }
                    });
                } catch (Exception e) {
                    call.reject("download: " + e.getMessage());
                }
            }
        }).start();
    }
}
