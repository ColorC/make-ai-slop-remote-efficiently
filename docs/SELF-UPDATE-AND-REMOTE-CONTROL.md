# LOFA 自更新 + 远程控制 · 完整软件设计

> 目标：**离开扁平网（用飞连／任何手机能摸到 PC 的网）也能安装／更新 LOFA，并尽可能多地远程操控手机**。
> 现状：远程操控共五层，均已落地。自更新（pull 式 OTA）、A 档 devview（adb 直连）、B 档 JS 级命令信道、B 档原生无障碍系统级执行器都已建成并经服务端／联调验证；adb 反向调试隧道（adb-over-WS）已建成并压测通过，只差真机经飞连实连（隧道步骤④）。
>
> 五层一览：
>
> | 层 | 能力边界 | 实现 |
> |---|---|---|
> | 1 自更新 OTA | app 自拉新 APK + 系统安装器，任何网可更 | `android.py` `/apk/*` + `ApkInstaller.java` |
> | 2 A 档 devview | 有 adb 通道时**完整控制**（截屏／输入／装包／底层调试） | `lofa/tools/devview/server.py`；仅本机够得着 adb 时 |
> | 3 B 档 JS 级命令 | WebView 进程内自助（切 tab／弹提示／回传状态／OTA），做不到系统级 | `android.py` `/commands/*` + `app/www/js/remote.js` |
> | 4 B 档原生无障碍 | **系统级点击／输入／截屏／驱动别的 app**，但走无障碍不走 adb（无 adb 级调试） | `android.py` `/automation/*` + `DeviceBridgeService.java` + `LofaAccessibilityService.java` |
> | 5 adb 反向隧道 | 手机连出建反向通道，PC 侧 `adb connect` 拿**完整 adb**（shell／logcat／install／文件） | `android_tunnel.py`（PC 中继）+ `DevTunnelService.java`（手机桥） |
>
> 第 3、4 层是两套并存的 B 档信道（端点／语义／设备身份都不同），信道梳理与合并建议见 `device-view-reverse-control-tablet.md` 第 5 节。

---

## 0. 根本约束：飞连是单向的（ZTNA）

飞连（零信任接入）实测：**手机 → PC 通，PC → 手机封**。
- 所以 **app 用**（手机拉 PC 的数据/审阅/对话/下载）在飞连下没问题。
- 而 **adb / scrcpy 投屏**这类需要 **PC 主动连手机**的操作，飞连下做不到。
- 推论：任何「PC 主动推给手机」的方案（adb install、adb shell）在飞连下都不行；必须改成**手机主动**——要么**手机自助执行**（第 3、4 层：命令入队→手机取走→进程内执行回传，含无障碍系统级点击/截屏），要么**手机先连出来建反向通道**（第 5 层隧道，把 adb 反向穿回）。

---

## 1. 自更新（已建成）—— 解决「离开扁平网也能装」

**思路**：不靠 adb。**app 自己从 PC 下载新 APK 并触发系统安装器**。下载是手机→PC（飞连通），安装是手机本地（不需要任何外部连接）。

### 1.1 组成
| 件 | 位置 | 作用 |
|---|---|---|
| 版本/下载/落地页端点 | `omnicompany .../controlplane/android.py` | `GET /api/android/apk/version`(manifest) · `/apk/latest`(下载APK) · `/install`(浏览器安装页) |
| 发布脚本 | `lofa/tools/build/publish-release.sh` | 版本+1 → 构建 → 复制 APK + 写 manifest 到 `omnicompany/data/android/releases/`。**不需要 adb/设备** |
| 原生自安装插件 | `lofa/app/.../ApkInstaller.java` | `downloadAndInstall({url})` 下载到 cacheDir + FileProvider + `ACTION_VIEW` 触发安装器；`canInstall`/`openInstallPermission` |
| 权限 | manifest `REQUEST_INSTALL_PACKAGES` | 允许 app 触发安装 |
| app 自更新 UI | `lofa/app/www/index.html` | 连上 PC 后 `checkUpdate()` 比对 `App.getInfo().build` 与 manifest.versionCode，新则弹**更新横幅**；点更新→`ApkInstaller.downloadAndInstall(/apk/latest)` |

### 1.2 版本流
- 安装的 app 知道自己的 versionCode（`@capacitor/app` `getInfo().build`）。
- PC 发布的 manifest 带 versionCode。app 端 `manifest.versionCode > 自身` → 弹横幅。
- `publish-release.sh` / `push-update.sh` 每次 versionCode +1，保证可检测。

### 1.3 引导（首次/旧版升级）——关键
**老 app（自更新加之前装的）没有自更新代码**，没法在 app 内更新。一次性引导：
> 手机浏览器打开 **`http://<PC>:8210/api/android/install`**（飞连下手机→PC 通）→ 点「下载并安装」→ 装上带自更新的版本。
之后 app 内点更新横幅即可自更新，不用再来这页。

PC 当前 IP：**`10.3.43.246`** → 引导 URL：`http://10.3.43.246:8210/api/android/install`。
（PC IP 变了就换；app 内连接地址也在「设置」页可改。）

### 1.4 两条更新通道
- **扁平网 + adb 在手边**：`bash lofa/tools/build/push-update.sh`（检测设备→构建→adb install -r→重启→校验）。整包替换，最快。
- **任何网（含飞连）**：`bash lofa/tools/build/publish-release.sh` 发布 → app 内自更新横幅 / 浏览器装。**这是离开扁平网的答案**。

### 1.5 安全/边界
- LAN/飞连内任何能到 8210 的人都能下 APK（同后端零鉴权问题）。后续可加 token。
- 自安装需用户给 LOFA 开「安装未知应用」（一次）。小米可能二次确认。
- 只换整包 APK；若只想热更 web 资产（秒级、免装），可后续接 Capawesome Live Update（见路线图）。

---

## 2. B 档原生无障碍系统级执行器（第 4 层，已建成）

飞连下本机够不着手机 adb，但手机能主动连出。这一层让手机**在自己进程内以系统级权限**执行本机下发的操控命令：本机（controller）入队命令 → 手机长轮询取走 → 无障碍服务执行 → 回传回执。不依赖 adb，靠 Android 无障碍服务（用户须一次性授权）取得系统级能力。

### 2.1 组成
| 件 | 位置 | 作用 |
|---|---|---|
| 命令信道端点 | `android.py` `/api/android/automation/*` | `pairing-window`／`pair`／`register`／`enqueue`／`poll`(长轮询)／`result`(POST 回执／GET 等回执)／`results`／`devices`／`assets/lease`＋`assets/{lease}/{asset}` |
| 前台服务（信道保活） | `DeviceBridgeService.java` | 常驻前台服务，长轮询 `/automation/poll?device_id=…&wait_seconds=25`；`device_token`／`X-LOFA-Device-Token` 鉴权；`completedReceipts` 幂等；掉线指数退避 |
| 系统级执行器 | `LofaAccessibilityService.java` | 无障碍服务真正执行：`ui_tree`／`tap`(归一化坐标手势)／`click_text`／`set_text`／`global_action`／`launch_app`／`launch_label`／`screenshot`(Android 11+ `takeScreenshot`)／`status` |
| Capacitor 插件 | `DeviceAutomation.java` | app 内 `configure`／`status`／`openAccessibilitySettings`，并挂起 `DevTunnelService`（见第 3 节） |

### 2.2 命令与回执（真实形态，契约锁在测试里）
- `enqueue` 生成命令包 `{id, sequence, op, args, created_at, expires_at, idempotency_key, status}`，`op` 限 `AUTOMATION_OPS` 白名单；带 `idempotency_key` 去重、`ttl_seconds` 过期、`next_sequence` 递增。
- `poll` 用服务端 `threading.Event` 长轮询（上限 25s），下发时把命令挂进 `inflight` 租约（60s，`delivery_count`），过期命令直接写失败回执。
- 手机执行后回传 `{device_id, command_id, sequence, ok, result}`；服务端按 `issued` 去重后落库为 `{command_id, ok, result, ts}`；controller 用 GET `/automation/result?command_id=…` 长等单条回执。
- `ui_tree`／`tap`／`click_text` 等每个 op 的 args 与 result 字段，见契约测试 `tools/test/web/contract/automation.contract.test.js`（+ `automation.schema.json`），以代码为真源逐字段锁定。
- 两套令牌：**controller 令牌** `X-LOFA-Control-Token`（本机操作者入队／读回执用）与**设备令牌** `X-LOFA-Device-Token`（手机轮询／回传用，服务端只存 `device_token_hash`）。配对握手：`pairing-window` 由 controller 开窗，绑定「最近登记的真机 device_id + 其源 IP」；`pair` 时设备须在窗口内、源 IP 与 device_id 双匹配才写入 token hash。

### 2.3 能力与边界
- **能做（系统级、跨 app）**：按归一化坐标点击、读整棵 UI 树、按文本／view_id 点击与填字、back／home／recents／通知栏、按包名或桌面标签启动任意 app、整屏截图，**能驱动别的 app**（如小红书草稿流程，来自 `_cross/[2026-07-15]LOFA-MINIMAL-INTERVENTION-XIAOHONGSHU-DRAFT`）。
- **附带**：`stage_media`（把本机资产经 `assets/lease` 起租、SHA-256 校验后落到手机相册 `Pictures/LOFA`）与 `cleanup_debug_media`（按精确白名单文件名清理调试图）——这两 op 由 `DeviceBridgeService` 本身处理，不经无障碍执行器。
- **做不到（无 adb／无系统调试权限）**：`adb shell`／`logcat`、把包装到别的 app、底层调试、任意文件读写。这些是第 5 层隧道解决的。
- 版本门槛：`tap` 要 Android 7+，`stage_media`／`cleanup_debug_media` 要 Android 10+，`screenshot` 要 Android 11+。

---

## 3. adb 反向调试隧道（第 5 层，已建成①②③，真机④待）

要「adb shell／logcat／install 任意包／文件读写／控制台自由操作」这套 **adb 级** 能力跑在飞连上，本质是让 adb 在飞连下可用。解法：**反向隧道**——手机主动连出到 PC，adb 顺隧道反向打回手机 adbd。

### 3.1 为什么自建，不用现成隧道工具
- chisel／frp／gost 等第三方隧道二进制被**公司 AV（卡巴）静默查杀**（`tools/tunnel/win.zip` 里的 chisel 实测被删，现已弃用删除）。
- 改为**全自建**：PC 中继与手机桥都是我们自己的 Python／原生代码（AV 不碰），字节走手机主动连出的 WS。

### 3.2 架构
```
宿主:  adb connect 127.0.0.1:6555
        │ (raw adb 协议字节)
     PC 中继 android_tunnel.py (adb 面 127.0.0.1:6555 + WS /api/devtunnel/ws)
        │  WS: {"op":"open"|"close"} 文本帧 + 透明二进制帧  (手机主动连出, 穿飞连)
     手机: LOFA 内置 DevTunnelService (前台服务, OkHttp WS)
        │  java.net.Socket → 127.0.0.1:5555
     手机本地 adbd (adb tcpip 5555)
```
- **单流 TCP-over-WS**：adb↔adbd 字节流封进 WS 二进制帧，中继对字节透明（不解析 adb 协议，adb 自己在这条连接上做 stream 复用）；控制用文本帧 `{"op":"open"|"close"}`。
- adb 面只绑 `127.0.0.1`（仅本机 adb 可连）；一条 adb 连接 ↔ 一个已注册手机桥，新接入顶替旧的（reconnect 友好）。
- 手机桥接入 WS 须带 device token（query `?token=` 或头 `X-LOFA-Device-Token`）。

### 3.3 PC 中继 `controlplane/android_tunnel.py`
- WS 端点 `/api/devtunnel/ws`（手机桥连入）＋ adb 面 TCP `127.0.0.1:6555`＋ `/api/devtunnel/status` 就绪探测（`bridge_connected`／`adb_connected`／`adb_face`）。
- 可 `run_standalone` 独立起（WS + adb 面共享同一事件循环），也可作 `devtunnel_router` 被 dashboard `include_router`。**当前只以 standalone 方式验证，尚未挂进 live dashboard(8210)。**

### 3.4 手机原生桥 `DevTunnelService`（前台服务）
- OkHttp WS 维持到中继（默认端口 8211，`pingInterval` 20s 保活，WS 长连不设读超时），从 `DeviceAutomation.startDevTunnel` 拉起；缺省从 `DeviceBridgeConfig` 的 base_url 推导主机／scheme、用 `device_token` 作 token。
- 收 `{"op":"open"}` → 开 `Socket(127.0.0.1,5555)` 双向泵；`{"op":"close"}`／EOF → 关。掉线指数退避重连。前置：一次性 `adb tcpip 5555` 让 adbd 监听本机 5555。

### 3.5 关键坑：中继必须用 `ws=wsproto`
- uvicorn 的 legacy `websockets` 实现把 keepalive ping／自动 pong 的写帧走 asyncio `drain()`，会与本中继在同一连接上的并发 `send_bytes` drain 撞上 legacy `_drain_helper` 的 `assert waiter is None`——大流量下（如 install 大 APK 的持续发送遇上 20s keepalive ping）必崩连、传输中断。
- `wsproto` 实现所有帧走 `transport.write()`，用 `pause_writing`／`resume_writing` 做真正的发送背压，既不撞该断言又保留 keepalive 与背压。`run_standalone` 默认 `ws="wsproto"`，未装时退化 `websockets-sansio`（同样不撞断言，但无发送背压）。
- **边界**：将来把 `devtunnel_router` 挂进 live dashboard 8210，dashboard 的 uvicorn 也须设 `ws=wsproto`，否则同一竞态会中断 install。

### 3.6 用上之后（全在飞连）
`adb connect 127.0.0.1:6555` 即获得**完整 adb**：`adb install` 装任意包、`adb shell input`、`adb shell getprop/dumpsys`、`adb push/pull`、`adb shell`、`logcat`。

### 3.7 落地进度（架构里程碑，非流水）
- ① PC 中继 + mock 桥端到端验证中继逻辑：已过（`tools/tunnel/verify_tunnel.py` + `mock_devtunnel_bridge.py`）。
- ② 手机原生 `DevTunnelService`（本机模拟器）联调 echo／getprop 基线：已过（`tools/tunnel/verify_tunnel_native.py`）。
- ③ 压测：大文件 push/pull SHA-256 逐字节透明、install 大 APK、logcat dump+follow、多路复用、连续多轮稳定性——全绿（`tools/tunnel/verify_tunnel_stress.py`）。
- ④ 真机经飞连实连：**待手机就位**。
- ⑤（可选，未做）把 scrcpy 指向 `127.0.0.1:6555` 实现飞连投屏——scrcpy 走 adb，隧道通了自动经隧道。

---

## 4. 能力矩阵（飞连下）
| 能力 | 状态 | 靠哪层 |
|---|---|---|
| 看审阅／网页材料／AI 对话 | ✅ | app 本体 |
| 自更新 app | ✅ | 第 1 层 OTA（横幅／浏览器装） |
| WebView 内自助（切 tab／弹提示／回传状态／触发 OTA） | ✅ | 第 3 层 B 档 JS 级 |
| 系统级点击／输入／填字／启动别的 app | ✅ | 第 4 层无障碍（需用户开无障碍权限） |
| 系统级整屏截图 | ✅ | 第 4 层无障碍 `takeScreenshot`（Android 11+） |
| 装任意包到别的 app | ✅ 已建，真机④待 | 第 5 层隧道 `adb install`（无障碍做不到） |
| adb shell／logcat／文件／控制台自由操作 | ✅ 已建，真机④待 | 第 5 层隧道 `adb shell` |
| 投屏 scrcpy | ⭕ 未做（步骤⑤可选） | 隧道通后 scrcpy 指 `127.0.0.1:6555` |

---

## 5. 运维速查
- 发布新版（任何网可更）：`bash lofa/tools/build/publish-release.sh`
- 扁平网整包推：`bash lofa/tools/build/push-update.sh`
- 扁平网自动连设备：`bash lofa/tools/device/auto-adb.sh`（固定端口 5555 + 后端记的手机 IP）
- 引导装／升级 URL（手机浏览器）：`http://10.3.43.246:8210/api/android/install`
- 发布物：`omnicompany/data/android/releases/{lofa-latest.apk,manifest.json}`
- 隧道独立起中继：`python omnicompany/.../controlplane/android_tunnel.py --adb-port 6555 --ws-port 8211 --token <device_token>`（默认 `ws=wsproto`）
- 隧道验证脚本：`tools/tunnel/verify_tunnel{,_native,_stress}.py`（步骤①②③）
- 无障碍信道契约：`tools/test/web/contract/automation.contract.test.js`（`npx vitest run` 即跑）
