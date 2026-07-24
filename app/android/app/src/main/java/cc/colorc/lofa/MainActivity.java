package cc.colorc.lofa;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApkInstaller.class);
        registerPlugin(DeviceAutomation.class);
        super.onCreate(savedInstanceState);
        DeviceBridgeService.startIfConfigured(this);
        DevTunnelService.startIfConfigured(this);   // 配过一次后, 打开 app 自动连回中继(反向调试隧道)
        // 代码面板是跨源 iframe(http://localhost 应用里嵌 https://主机:12443/code),
        // WebView 默认拦第三方 cookie → serve-web 的令牌 cookie 回传不了 → "Forbidden"。这里放行。
        WebView wv = this.getBridge().getWebView();
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (wv != null) cm.setAcceptThirdPartyCookies(wv, true);
        handleDevTunnelIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDevTunnelIntent(intent);
    }

    /**
     * 从前台的 Activity 启动/停止反向 adb 隧道服务。经 Activity 触发可满足 Android 12+ 的
     * 前台服务后台启动限制(app 已在前台)，也便于外部经 `am start ... --ez start_devtunnel true` 唤起。
     */
    private void handleDevTunnelIntent(Intent intent) {
        if (intent == null) return;
        if (intent.getBooleanExtra("stop_devtunnel", false)) {
            DevTunnelService.stop(this);
            return;
        }
        if (intent.getBooleanExtra("start_devtunnel", false)) {
            String host = intent.getStringExtra(DevTunnelService.EXTRA_RELAY_HOST);
            int port = intent.getIntExtra(DevTunnelService.EXTRA_RELAY_PORT, 0);
            String scheme = intent.getStringExtra(DevTunnelService.EXTRA_RELAY_SCHEME);
            String token = intent.getStringExtra(DevTunnelService.EXTRA_TOKEN);
            DevTunnelService.start(this, host, port, scheme, token);
        }
    }
}
