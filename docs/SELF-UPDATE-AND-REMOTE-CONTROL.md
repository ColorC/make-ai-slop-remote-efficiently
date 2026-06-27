# LOFA 自更新 + 远程控制 · 完整软件设计

> 2026-06-26。目标：**离开扁平网（用飞连/任何手机能摸到 PC 的网）也能安装/更新 LOFA，并尽可能多地远程操控手机**。
> 现状：**自更新（pull 式 OTA）已建成并服务端验证**；**全套远程控制（adb-over-飞连 反向隧道）已设计，待实现**。

---

## 0. 根本约束：飞连是单向的（ZTNA）

飞连（零信任接入）实测：**手机 → PC 通，PC → 手机封**。
- 所以 **app 用**（手机拉 PC 的数据/审阅/对话/下载）在飞连下没问题。
- 而 **adb / scrcpy / 截图**都需要 **PC 主动连手机**，飞连下做不到。
- 推论：任何「PC 主动推给手机」的方案（adb install、adb shell）在飞连下都不行；必须改成**手机主动**（拉取）或**手机先连出来建反向通道**。

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

## 2. 全套远程控制（设计，待实现）—— adb 级能力跑在飞连上

要「点击操控 / 系统信息 / 文件读写 / 控制台自由操作 / 投屏」全套，本质是要 **adb 在飞连下可用**。唯一解法：**反向隧道**——手机主动连出到 PC，adb 顺隧道反向打回手机 adbd。

### 2.1 为什么不用现成隧道工具
- chisel / frp / gost 等都被**公司 AV（卡巴）静默查杀**（实测 chisel.exe + arm64 都被删）。第三方隧道二进制在这台机器上不可用。
- 必须**自建**（全是我们自己的 Python/原生代码，AV 不碰），且隧道**走 8210 的 WS**（8210 是唯一证明过能穿飞连的端口）。

### 2.2 架构
```
PC:  adb connect 127.0.0.1:6555
        │ (raw adb 协议字节)
     dashboard 中继 (FastAPI, 8210)
        │  WS /api/devtunnel/ws   (手机主动连出, 穿飞连)
     手机: LOFA 内置原生「隧道前台服务」(Kotlin/Java)
        │  java.net.Socket → 127.0.0.1:5555
     手机本地 adbd (adb tcpip 5555)
```
- **单流 TCP-over-WS**：adb↔adbd 的字节流封进 WS 二进制帧。控制用文本帧 `{"op":"open"|"close"}`。
- 一次一个 adb 连接即可（adb 内部多路复用 stream）。

### 2.3 PC 中继（新增 `controlplane/android_tunnel.py`）
- WS 端点 `/api/devtunnel/ws`：手机桥连入，token 鉴权，登记为当前 bridge。
- 本机 TCP 监听 `127.0.0.1:6555`：adb 连入时 → 给 bridge 发 `{"op":"open"}` → 双向泵 adb_tcp ↔ WS(binary) ↔ bridge。adb 断 → `{"op":"close"}`。

### 2.4 手机原生桥（LOFA 内 `DevTunnelService`，前台服务）
- 前台服务（带常驻通知，保活）维持到 `ws://<PC>:8210/api/devtunnel/ws` 的 WS（OkHttp）。
- 收 `{"op":"open"}` → 开 `Socket(127.0.0.1,5555)`，双向泵 socket ↔ WS(binary)；`{"op":"close"}`/EOF → 关。
- 掉线指数退避重连。一次性 `adb tcpip 5555`（已做，见 auto-adb.sh）让 adbd 在 5555。

### 2.5 用上之后（全在飞连）
`adb connect 127.0.0.1:6555` 即获得**完整 adb**：
- 主动替换 app：`adb install`
- 点击操控：`adb shell input` / `scrcpy`（scrcpy 走 adb，自动经隧道）
- 系统信息：`adb shell getprop/dumpsys`
- 文件读写：`adb push/pull` / `adb shell`
- 控制台自由操作：`adb shell`

### 2.6 实现顺序（下一阶段）
1. PC 中继 `android_tunnel.py`（WS + 6555 监听 + 单流泵）。用 **PC 端 mock 桥**（连中继 WS + 桥到扁平网手机 adbd）端到端验证中继逻辑，不依赖原生。
2. 手机原生 `DevTunnelService`（OkHttp WS + adbd socket 泵 + 前台服务保活），从 app 启动。
3. 扁平网验证 `adb connect 127.0.0.1:6555` 全通；再让用户切飞连验证跨网。
4. （可选）把 scrcpy 指向 `127.0.0.1:6555` 实现飞连投屏。

### 2.7 备选/降级
- 若隧道保活在飞连下不稳：app 内做**有限远程控制 agent**（无障碍服务点击 + 应用 UID shell 取系统信息/文件 + 截图 MediaProjection），不如全 adb 强但无需隧道。
- Termux + ssh 反向隧道：AV 安全但需装 Termux + PC 开 sshd + 飞连放行端口（不如自建 WS-over-8210 稳过飞连）。

---

## 3. 能力矩阵（飞连下）
| 能力 | 现在 | 加隧道后 |
|---|---|---|
| 看审阅/网页材料/AI对话 | ✅ app 已有 | ✅ |
| 自更新 app | ✅ 已建（横幅/浏览器） | ✅ |
| 替换 app（PC 主动整包） | ❌（要扁平网 adb） | ✅ adb install |
| 点击操控/投屏 | ❌ | ✅ input/scrcpy |
| 系统信息/文件/控制台 | ❌ | ✅ adb shell |

---

## 4. 运维速查
- 发布新版（任何网可更）：`bash lofa/tools/build/publish-release.sh`
- 扁平网整包推：`bash lofa/tools/build/push-update.sh`
- 扁平网自动连设备：`bash lofa/tools/device/auto-adb.sh`（固定端口 5555 + 后端记的手机 IP）
- 引导装/升级 URL（手机浏览器）：`http://10.3.43.246:8210/api/android/install`
- 发布物：`omnicompany/data/android/releases/{lofa-latest.apk,manifest.json}`
