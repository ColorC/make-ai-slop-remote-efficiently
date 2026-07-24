package cc.colorc.lofa;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * 手机侧反向 adb 隧道桥(前台服务)。
 *
 * <p>飞连(ZTNA)只允许手机→PC 单向连出，adb 不能由 PC 主动连手机。本服务主动连出到 PC
 * 中继的 WebSocket(/api/devtunnel/ws)，把中继下发的控制/数据在 WS 与本机 adbd
 * (127.0.0.1:5555)之间做透明的原始字节双向转发，从而让 PC 侧照常 {@code adb connect}
 * 反向穿到本机 adbd。手机侧对应 android_tunnel.py 里描述的“手机桥”，与 mock 桥同协议。
 *
 * <p>桥协议(与中继一致)：
 * <ul>
 *   <li>收文本帧 {@code {"op":"open"}}  → 开一个到 adbd 的 socket（隐含 teardown 旧的）。</li>
 *   <li>收文本帧 {@code {"op":"close"}} → 关掉当前 adbd socket。</li>
 *   <li>收二进制帧 → 原样写入 adbd socket。</li>
 *   <li>adbd 读到字节 → 原样回二进制帧；adbd EOF → 发 {@code {"op":"close"}} 通知中继。</li>
 * </ul>
 *
 * <p>约束：对字节流保持透明，不解析 adb 协议；同一时刻只服务一条 adbd 连接(PC 的 adb
 * 传输连接对每台设备唯一)；对 WS 的写串行化避免帧交错；断线指数退避重连。
 */
public final class DevTunnelService extends Service {
    /** Intent 覆盖项：给中继 WS 指定主机/端口/scheme/token；缺省时从 DeviceBridgeConfig 推导。 */
    static final String EXTRA_RELAY_HOST = "dt_relay_host";
    static final String EXTRA_RELAY_PORT = "dt_relay_port";
    static final String EXTRA_RELAY_SCHEME = "dt_relay_scheme"; // ws | wss
    static final String EXTRA_TOKEN = "dt_token";

    private static final String TAG = "LofaDevTunnel";
    private static final String CHANNEL_ID = "lofa-devtunnel";
    private static final int NOTIFICATION_ID = 2202;
    private static final int DEFAULT_RELAY_PORT = 8211;
    private static final String WS_PATH = "/api/devtunnel/ws";
    // 手机桥固定连本机 adbd 的 tcp 面(需先 `adb tcpip 5555` 让 adbd 监听本机 5555)。
    private static final String ADBD_HOST = "127.0.0.1";
    private static final int ADBD_PORT = 5555;

    // 自证状态(供 devTunnelStatus 探测)。
    private static volatile boolean running;
    private static volatile boolean wsConnected;
    private static volatile boolean adbSocketOpen;
    private static volatile String lastError = "";
    private static volatile String relayTarget = "";
    private static volatile int reconnects;

    private final Object sendLock = new Object();    // 串行化对中继 WS 的写
    private final Object socketLock = new Object();   // 保护当前 adbd socket + 代际

    private volatile boolean stopping;
    private OkHttpClient client;
    private Thread worker;
    private volatile WebSocket webSocket;
    private volatile long backoffMillis = 1000;

    private String relayUrl;
    private String token;

    // 当前 adbd 连接(受 socketLock 保护)。adbdGen 每次开/拆递增，供 pump 识别是否仍为当前代，
    // 避免旧 pump 在新连接建立后重复发 op:close 或误清引用。
    private Socket adbdSocket;
    private int adbdGen;

    static void start(Context context, String relayHost, int relayPort, String scheme, String token) {
        Intent intent = new Intent(context, DevTunnelService.class);
        if (relayHost != null && !relayHost.isEmpty()) intent.putExtra(EXTRA_RELAY_HOST, relayHost);
        if (relayPort > 0) intent.putExtra(EXTRA_RELAY_PORT, relayPort);
        if (scheme != null && !scheme.isEmpty()) intent.putExtra(EXTRA_RELAY_SCHEME, scheme);
        if (token != null && !token.isEmpty()) intent.putExtra(EXTRA_TOKEN, token);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (Throwable error) {
            lastError = "devtunnel_start: " + error.getClass().getSimpleName() + ": "
                    + String.valueOf(error.getMessage());
        }
    }

    static void stop(Context context) {
        try {
            context.stopService(new Intent(context, DevTunnelService.class));
        } catch (Throwable ignored) {
        }
        clearConfig(context);
    }

    private static final String PREFS = "lofa_devtunnel";

    // 持久化 relay 配置, 供 app 启动时 startIfConfigured 自动拉起(实现"打开 app 就自动连回中继",
    // 不必每次手动 intent 启动)。
    static void saveConfig(Context context, String host, int port, String scheme, String token) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("relay_host", host)
                .putInt("relay_port", port)
                .putString("relay_scheme", scheme)
                .putString("token", token)
                .apply();
    }

    // 显式 stop 时清掉配置, 避免下次 app 启动又自动连上已不想要的中继。
    static void clearConfig(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    // app 启动时调用: 若之前配过 relay(host+token 非空)则自动启动隧道, 无需再手动 intent。
    static void startIfConfigured(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String host = prefs.getString("relay_host", "");
        String token = prefs.getString("token", "");
        if (host == null || host.isEmpty() || token == null || token.isEmpty()) return;
        int port = prefs.getInt("relay_port", DEFAULT_RELAY_PORT);
        String scheme = prefs.getString("relay_scheme", "ws");
        start(context, host, port, scheme, token);
    }

    static JSONObject statusJson() {
        JSONObject out = new JSONObject();
        try {
            out.put("devtunnel_running", running);
            out.put("devtunnel_ws_connected", wsConnected);
            out.put("devtunnel_adb_socket_open", adbSocketOpen);
            out.put("devtunnel_relay", relayTarget);
            out.put("devtunnel_reconnects", reconnects);
            out.put("devtunnel_last_error", lastError);
        } catch (Exception ignored) {
        }
        return out;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, notification("Starting reverse adb tunnel"));
        client = new OkHttpClient.Builder()
                .pingInterval(20, TimeUnit.SECONDS)      // 心跳保活/探测半开连接
                .readTimeout(0, TimeUnit.MILLISECONDS)   // WS 长连不设读超时
                .retryOnConnectionFailure(true)
                .build();
        running = true;
        stopping = false;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        resolveConfig(intent);
        Log.i(TAG, "onStartCommand relay=" + relayTarget + " url="
                + (relayUrl == null ? "<none>" : relayUrl.replaceAll("token=[^&]*", "token=***")));
        if (worker == null || !worker.isAlive()) {
            worker = new Thread(this::runLoop, "lofa-devtunnel");
            worker.setDaemon(true);
            worker.start();
        }
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopping = true;
        running = false;
        wsConnected = false;
        WebSocket ws = webSocket;
        if (ws != null) {
            try {
                ws.close(1000, "service stopping");
            } catch (Exception ignored) {
            }
        }
        teardownAdbd();
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    /** extras 优先，否则从 DeviceBridgeConfig 的 base_url 推导主机/scheme、deviceToken 作 token。 */
    private void resolveConfig(Intent intent) {
        String host = intent == null ? null : intent.getStringExtra(EXTRA_RELAY_HOST);
        int port = intent == null ? -1 : intent.getIntExtra(EXTRA_RELAY_PORT, -1);
        String scheme = intent == null ? null : intent.getStringExtra(EXTRA_RELAY_SCHEME);
        String tok = intent == null ? null : intent.getStringExtra(EXTRA_TOKEN);

        // 仅当主机也来自 base_url 时才让 scheme 跟随 base_url；显式传入的中继主机默认明文 ws
        // (局域网中继本身是明文 uvicorn，若继承 base_url 的 https 会对明文口发 TLS 握手而失败)。
        String base = DeviceBridgeConfig.baseUrl(this);
        if ((host == null || host.isEmpty()) && !base.isEmpty()) {
            try {
                URI parsed = URI.create(base);
                host = parsed.getHost();
                if (scheme == null || scheme.isEmpty()) {
                    scheme = "https".equalsIgnoreCase(parsed.getScheme()) ? "wss" : "ws";
                }
            } catch (Exception ignored) {
            }
        }
        if (scheme == null || scheme.isEmpty()) scheme = "ws";
        if (port <= 0) port = DEFAULT_RELAY_PORT;
        if (tok == null || tok.isEmpty()) tok = DeviceBridgeConfig.deviceToken(this);

        this.token = tok;
        if (host != null && !host.isEmpty()) {
            relayTarget = host + ":" + port;
            // OkHttp 的 HttpUrl 只认 http/https；WS 升级走 http(s) URL。
            String httpScheme = "wss".equalsIgnoreCase(scheme) ? "https" : "http";
            this.relayUrl = httpScheme + "://" + host + ":" + port + WS_PATH
                    + "?token=" + Uri.encode(tok == null ? "" : tok);
            saveConfig(this, host, port, scheme, tok);   // 记住配置, 下次 app 启动自动连回
        } else {
            this.relayUrl = null;
        }
    }

    private void runLoop() {
        while (!stopping) {
            if (relayUrl == null || relayUrl.isEmpty() || token == null || token.isEmpty()) {
                lastError = "devtunnel is not configured";
                updateNotification("Not configured");
                sleep(5000);
                continue;
            }
            final CountDownLatch done = new CountDownLatch(1);
            WebSocket ws = client.newWebSocket(
                    new Request.Builder().url(relayUrl).build(),
                    new RelayListener(done)
            );
            this.webSocket = ws;
            try {
                done.await();
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
            this.webSocket = null;
            wsConnected = false;
            teardownAdbd();
            if (stopping) break;
            reconnects++;
            long wait = backoffMillis;
            updateNotification("Reconnecting in " + (wait / 1000) + "s (" + reconnects + ")");
            sleep(wait);
            backoffMillis = Math.min(30000, backoffMillis * 2);
        }
        running = false;
    }

    /** 中继 WS 监听器：控制帧→开关 adbd socket，二进制帧→写 adbd。 */
    private final class RelayListener extends WebSocketListener {
        private final CountDownLatch done;

        RelayListener(CountDownLatch done) {
            this.done = done;
        }

        @Override
        public void onOpen(WebSocket ws, Response response) {
            wsConnected = true;
            lastError = "";
            backoffMillis = 1000;
            Log.i(TAG, "ws onOpen: " + relayTarget);
            updateNotification("Tunnel online: " + relayTarget);
        }

        @Override
        public void onMessage(WebSocket ws, String text) {
            String op = parseOp(text);
            if ("open".equals(op)) {
                openAdbd(ws);
            } else if ("close".equals(op)) {
                teardownAdbd();
            }
        }

        @Override
        public void onMessage(WebSocket ws, ByteString bytes) {
            writeToAdbd(bytes.toByteArray());
        }

        @Override
        public void onClosing(WebSocket ws, int code, String reason) {
            try {
                ws.close(1000, null);
            } catch (Exception ignored) {
            }
        }

        @Override
        public void onClosed(WebSocket ws, int code, String reason) {
            done.countDown();
        }

        @Override
        public void onFailure(WebSocket ws, Throwable error, @Nullable Response response) {
            lastError = error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage());
            Log.w(TAG, "ws onFailure (resp=" + (response == null ? "null" : response.code()) + ")", error);
            done.countDown();
        }
    }

    private static String parseOp(String text) {
        try {
            return new JSONObject(text).optString("op", "");
        } catch (Exception error) {
            return "";
        }
    }

    /** 为新的 adb 连接开一个到 adbd 的 socket，顶替旧的，并起读取泵回传字节。 */
    private void openAdbd(WebSocket ws) {
        synchronized (socketLock) {
            closeAdbdLocked();
            final int gen = ++adbdGen;
            try {
                Socket socket = new Socket();
                socket.connect(new InetSocketAddress(ADBD_HOST, ADBD_PORT), 4000);
                socket.setTcpNoDelay(true);
                adbdSocket = socket;
                adbSocketOpen = true;
                Log.i(TAG, "adbd socket opened -> " + ADBD_HOST + ":" + ADBD_PORT);
                Thread pump = new Thread(() -> pumpAdbdToWs(ws, socket, gen), "lofa-devtunnel-adbd");
                pump.setDaemon(true);
                pump.start();
            } catch (IOException error) {
                adbSocketOpen = false;
                lastError = "adbd_connect: " + error.getMessage();
                Log.w(TAG, "adbd connect failed", error);
                // 连不上本机 adbd → 通知中继关闭对端 adb 连接。
                sendText(ws, "{\"op\":\"close\"}");
            }
        }
    }

    /** adbd → WS：读 adbd 字节回传为二进制帧；EOF/错误若仍是当前代则发 op:close 通知中继。 */
    private void pumpAdbdToWs(WebSocket ws, Socket socket, int gen) {
        byte[] buffer = new byte[32768];
        try {
            InputStream input = socket.getInputStream();
            while (true) {
                int read = input.read(buffer);
                if (read < 0) break;       // adbd EOF
                if (read == 0) continue;
                synchronized (sendLock) {
                    ws.send(ByteString.of(buffer, 0, read));
                }
            }
        } catch (IOException error) {
            // socket 被 teardown 关闭或读错误 → 退出泵。
        }
        boolean current;
        synchronized (socketLock) {
            current = gen == adbdGen;
            if (current) {
                adbSocketOpen = false;
                closeQuiet(adbdSocket);
                adbdSocket = null;
            }
        }
        if (current) sendText(ws, "{\"op\":\"close\"}");
    }

    /** 中继→adbd：把二进制帧写入当前 adbd socket。 */
    private void writeToAdbd(byte[] data) {
        Socket socket;
        synchronized (socketLock) {
            socket = adbdSocket;
        }
        if (socket == null) return;
        try {
            OutputStream output = socket.getOutputStream();
            output.write(data);
            output.flush();
        } catch (IOException error) {
            synchronized (socketLock) {
                if (socket == adbdSocket) closeAdbdLocked();
            }
        }
    }

    private void teardownAdbd() {
        synchronized (socketLock) {
            closeAdbdLocked();
        }
    }

    /** 关闭当前 adbd socket 并递增代际(令 pump 失效，避免重复 op:close)。须持 socketLock。 */
    private void closeAdbdLocked() {
        if (adbdSocket != null) {
            closeQuiet(adbdSocket);
            adbdSocket = null;
        }
        adbSocketOpen = false;
        adbdGen++;
    }

    private boolean sendText(WebSocket ws, String text) {
        if (ws == null) return false;
        synchronized (sendLock) {
            try {
                return ws.send(text);
            } catch (Exception error) {
                return false;
            }
        }
    }

    private static void closeQuiet(Socket socket) {
        if (socket != null) {
            try {
                socket.close();
            } catch (Exception ignored) {
            }
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "LOFA reverse adb tunnel",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps the reverse adb debug tunnel to the PC relay online");
        channel.setSound(null, null);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private Notification notification(String message) {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentTitle("LOFA reverse adb tunnel")
                .setContentText(message)
                .setOngoing(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void updateNotification(String message) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, notification(message));
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }
}
