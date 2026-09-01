package cc.colorc.lofa;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Message;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/**
 * Native page carrier for Dashboard web tabs.
 *
 * The child WebViews are real top-level Android views, so a site's
 * X-Frame-Options/CSP frame-ancestors policy does not apply. Dashboard still owns
 * tab chrome and sends only a stable id, URL, bounds and visibility.
 */
@CapacitorPlugin(name = "ExternalWebview")
public final class ExternalWebview extends Plugin {
    private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9_-]{1,80}");
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private boolean hostVisible = true;

    private static final class Entry {
        final WebView view;
        boolean requestedVisible;

        Entry(WebView view, boolean requestedVisible) {
            this.view = view;
            this.requestedVisible = requestedVisible;
        }
    }

    private static final class Bounds {
        final int x;
        final int y;
        final int width;
        final int height;

        Bounds(int x, int y, int width, int height) {
            this.x = x;
            this.y = y;
            this.width = width;
            this.height = height;
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        String id = validId(call);
        Uri uri = validHttpUrl(call.getString("url", ""));
        Bounds bounds = validBounds(call);
        String profile = call.getString("profile", "human");
        if (id == null || bounds == null) return;
        if (uri == null) {
            call.reject("invalid native webview URL");
            return;
        }
        if (!"human".equals(profile)) {
            call.reject("LOFA native web tabs currently support the human profile only");
            return;
        }
        boolean visible = call.getBoolean("visible", true);

        getActivity().runOnUiThread(() -> {
            try {
                Entry entry = entries.get(id);
                if (entry == null) {
                    WebView webView = createWebView();
                    entry = new Entry(webView, visible);
                    entries.put(id, entry);
                    root().addView(webView, layout(bounds));
                    webView.loadUrl(uri.toString());
                } else {
                    entry.requestedVisible = visible;
                    applyBounds(entry.view, bounds);
                    if (!uri.toString().equals(entry.view.getUrl())) entry.view.loadUrl(uri.toString());
                }
                entry.requestedVisible = visible;
                applyVisibility(entry);
                JSObject result = new JSObject();
                result.put("label", id);
                call.resolve(result);
            } catch (Exception exception) {
                call.reject(message(exception));
            }
        });
    }

    @PluginMethod
    public void update(PluginCall call) {
        String id = validId(call);
        Bounds bounds = validBounds(call);
        if (id == null || bounds == null) return;
        boolean visible = call.getBoolean("visible", true);
        boolean focus = call.getBoolean("focus", false);
        getActivity().runOnUiThread(() -> {
            Entry entry = entries.get(id);
            if (entry == null) {
                call.reject("native webview does not exist");
                return;
            }
            entry.requestedVisible = visible;
            applyBounds(entry.view, bounds);
            applyVisibility(entry);
            if (focus && visible && hostVisible) entry.view.requestFocus();
            call.resolve();
        });
    }

    @PluginMethod
    public void reload(PluginCall call) {
        String id = validId(call);
        if (id == null) return;
        getActivity().runOnUiThread(() -> {
            Entry entry = entries.get(id);
            if (entry == null) {
                call.reject("native webview does not exist");
                return;
            }
            entry.view.reload();
            call.resolve();
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        String id = validId(call);
        if (id == null) return;
        getActivity().runOnUiThread(() -> {
            Entry entry = entries.remove(id);
            if (entry != null) destroy(entry.view);
            call.resolve();
        });
    }

    @PluginMethod
    public void closeAll(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            for (Entry entry : entries.values()) destroy(entry.view);
            entries.clear();
            call.resolve();
        });
    }

    @PluginMethod
    public void setHostVisible(PluginCall call) {
        boolean visible = call.getBoolean("visible", true);
        getActivity().runOnUiThread(() -> {
            hostVisible = visible;
            for (Entry entry : entries.values()) applyVisibility(entry);
            call.resolve();
        });
    }

    private String validId(PluginCall call) {
        String id = call.getString("id", "").trim();
        if (!SAFE_ID.matcher(id).matches()) {
            call.reject("invalid native webview id");
            return null;
        }
        return id;
    }

    private Uri validHttpUrl(String raw) {
        try {
            Uri uri = Uri.parse(raw.trim());
            String scheme = uri.getScheme();
            if (scheme == null
                    || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))
                    || uri.getHost() == null
                    || uri.getUserInfo() != null) {
                throw new IllegalArgumentException("invalid URL");
            }
            return uri;
        } catch (Exception exception) {
            return null;
        }
    }

    private Bounds validBounds(PluginCall call) {
        JSObject value = call.getObject("bounds");
        double scale = number(call.getData(), "pixelRatio", 1);
        double x = number(value, "x", Double.NaN);
        double y = number(value, "y", Double.NaN);
        double width = number(value, "width", Double.NaN);
        double height = number(value, "height", Double.NaN);
        if (!Double.isFinite(scale) || scale < 0.25 || scale > 8
                || !Double.isFinite(x) || !Double.isFinite(y)
                || !Double.isFinite(width) || !Double.isFinite(height)
                || x < 0 || y < 0 || width < 1 || height < 1
                || x > 100000 || y > 100000 || width > 100000 || height > 100000) {
            call.reject("invalid native webview bounds");
            return null;
        }
        return new Bounds(
                (int) Math.round(x * scale),
                (int) Math.round(y * scale),
                Math.max(1, (int) Math.round(width * scale)),
                Math.max(1, (int) Math.round(height * scale))
        );
    }

    private static double number(JSObject object, String key, double fallback) {
        if (object == null) return fallback;
        Object value = object.opt(key);
        return value instanceof Number ? ((Number) value).doubleValue() : fallback;
    }

    private ViewGroup root() {
        View view = getActivity().findViewById(android.R.id.content);
        if (!(view instanceof ViewGroup)) throw new IllegalStateException("activity content root is unavailable");
        return (ViewGroup) view;
    }

    private static FrameLayout.LayoutParams layout(Bounds bounds) {
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(bounds.width, bounds.height);
        params.leftMargin = bounds.x;
        params.topMargin = bounds.y;
        return params;
    }

    private static void applyBounds(WebView view, Bounds bounds) {
        view.setLayoutParams(layout(bounds));
        view.requestLayout();
    }

    private void applyVisibility(Entry entry) {
        entry.view.setVisibility(hostVisible && entry.requestedVisible ? View.VISIBLE : View.GONE);
    }

    private static void destroy(WebView view) {
        view.stopLoading();
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
        view.removeAllViews();
        view.destroy();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView createWebView() {
        WebView webView = new WebView(getActivity());
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        webView.setWebViewClient(new PageClient());
        webView.setWebChromeClient(new PopupClient());
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        return webView;
    }

    private final class PageClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return request != null && handleNonHttp(request.getUrl());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleNonHttp(Uri.parse(url));
        }

        private boolean handleNonHttp(Uri uri) {
            String scheme = uri == null ? null : uri.getScheme();
            if (scheme != null && (scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) return false;
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                intent.addCategory(Intent.CATEGORY_BROWSABLE);
                getActivity().startActivity(intent);
            } catch (Exception ignored) {
                // Keep unsupported schemes from escaping into the Dashboard document.
            }
            return true;
        }
    }

    private final class PopupClient extends WebChromeClient {
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            if (resultMsg == null || !(resultMsg.obj instanceof WebView.WebViewTransport)) return false;
            AtomicBoolean delivered = new AtomicBoolean(false);
            WebView popup = new WebView(getActivity());
            popup.getSettings().setJavaScriptEnabled(true);
            popup.setWebViewClient(new WebViewClient() {
                private boolean deliver(String url) {
                    if (url == null || "about:blank".equals(url) || !delivered.compareAndSet(false, true)) return false;
                    ((MainActivity) getActivity()).dispatchNewBrowserTab(url);
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
                public void onPageStarted(WebView child, String url, Bitmap favicon) {
                    if (!deliver(url)) super.onPageStarted(child, url, favicon);
                }
            });
            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(popup);
            resultMsg.sendToTarget();
            return true;
        }
    }

    private static String message(Exception exception) {
        String message = exception.getMessage();
        return message == null || message.trim().isEmpty() ? exception.getClass().getSimpleName() : message;
    }
}
