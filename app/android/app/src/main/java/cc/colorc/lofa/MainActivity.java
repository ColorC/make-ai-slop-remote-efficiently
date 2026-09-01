package cc.colorc.lofa;

import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApkInstaller.class);
        registerPlugin(DeviceAutomation.class);
        registerPlugin(ExternalBrowser.class);
        registerPlugin(ExternalWebview.class);
        super.onCreate(savedInstanceState);
        DeviceBridgeService.startIfConfigured(this);
        DevTunnelService.startIfConfigured(this);   // Reconnect the reverse debug tunnel when configured.

        WebView webView = getBridge().getWebView();
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        if (webView != null) {
            // Dashboard itself remains the single remote shell. Pages opened inside
            // its web tabs use ExternalWebview, avoiding iframe-only CSP/XFO failures.
            // Keep popup interception here for the Dashboard document itself.
            cookieManager.setAcceptThirdPartyCookies(webView, true);
            WebSettings settings = webView.getSettings();
            settings.setSupportMultipleWindows(true);
            settings.setJavaScriptCanOpenWindowsAutomatically(true);
            webView.setWebChromeClient(new LofaWebChromeClient(getBridge()));
        }

        applyImmersiveMode();
        handleDevTunnelIntent(getIntent());
        handleFileShareIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDevTunnelIntent(intent);
        handleFileShareIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        applyImmersiveMode();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersiveMode();
    }

    /** Edge-to-edge immersive sticky mode; system bars no longer reserve WebView layout space. */
    private void applyImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }

        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(
            getWindow(), getWindow().getDecorView()
        );
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        );

        // Legacy Android fallback; WindowInsetsControllerCompat is authoritative on newer releases.
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }

    void dispatchNewBrowserTab(String rawUrl) {
        if (rawUrl == null) return;
        Uri uri = Uri.parse(rawUrl);
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) return;
        WebView mainWebView = getBridge().getWebView();
        if (mainWebView == null) return;
        String script = "window.dispatchEvent(new CustomEvent('lofa:new-window',{detail:{url:"
            + JSONObject.quote(rawUrl) + "}}));";
        runOnUiThread(() -> mainWebView.evaluateJavascript(script, null));
    }

    /**
     * ACTION_SEND is only an ingress signal here. The shell routes it to the
     * Dashboard-owned File Bridge entity; it does not grow a local file browser.
     * Keep the URI as opaque diagnostics data and never evaluate sender content.
     */
    private void handleFileShareIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        String mime = intent.getType();
        WebView webView = getBridge().getWebView();
        if (webView == null) return;
        String script = "window.dispatchEvent(new CustomEvent('lofa:file-share',{detail:{uri:"
            + JSONObject.quote(uri == null ? "" : uri.toString()) + ",mime:"
            + JSONObject.quote(mime == null ? "" : mime) + "}}));";
        runOnUiThread(() -> webView.post(() -> webView.evaluateJavascript(script, null)));
    }

    /**
     * Preserve all Capacitor WebChromeClient behavior and add only popup interception.
     * The temporary WebView only obtains the target URL. browserView owns the
     * internal-tab versus external-browser decision.
     */
    private final class LofaWebChromeClient extends BridgeWebChromeClient {
        LofaWebChromeClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            if (resultMsg == null || !(resultMsg.obj instanceof WebView.WebViewTransport)) return false;

            AtomicBoolean delivered = new AtomicBoolean(false);
            WebView popup = new WebView(MainActivity.this);
            popup.getSettings().setJavaScriptEnabled(true);
            popup.setWebViewClient(new WebViewClient() {
                private boolean deliver(String url) {
                    if (url == null || url.equals("about:blank") || !delivered.compareAndSet(false, true)) return false;
                    dispatchNewBrowserTab(url);
                    popup.stopLoading();
                    popup.destroy();
                    return true;
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView child, WebResourceRequest request) {
                    return request != null && deliver(request.getUrl().toString());
                }

                @Override
                @SuppressWarnings("deprecation")
                public boolean shouldOverrideUrlLoading(WebView child, String url) {
                    return deliver(url);
                }

                @Override
                public void onPageStarted(WebView child, String url, android.graphics.Bitmap favicon) {
                    if (!deliver(url)) super.onPageStarted(child, url, favicon);
                }
            });

            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(popup);
            resultMsg.sendToTarget();
            return true;
        }
    }

    /**
     * Start or stop the reverse adb tunnel from the foreground Activity. This satisfies Android 12+
     * foreground-service restrictions and supports external wakeup via the start_devtunnel intent extra.
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
