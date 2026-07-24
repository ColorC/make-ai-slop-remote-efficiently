# LOFA 设备视图 · 反向控制 · 平板支持 — 通盘设计

> 2026-06-27。回应用户四点:① 模拟器里真跑 APP;② LOFA 单向连本机时本机仍能反向探测+尽量多操作(推装包/模拟点击/调试);③ 网页上操作模拟器里的真 APP 并作为审阅材料(验 APP 本体, 不是网页);④ 平板支持(平板手写笔记 + 平板审阅材料)。
> 三件事共用一组「设备原语」:**看屏 / 输入 / 装包+调试**。

## 0. 已落地(本轮)
- **设备视图 devview**(`lofa/tools/devview/server.py`):adb 直连设备 → `/dev/screen`(实时取屏)、`/dev/tap|text|key|swipe`(转发输入)、`/dev/install`(推装/更新 APK)、`/dev/restart_app`、`/dev/ui`(网页操作台)。
- **作为审阅材料**:审阅台里一条 `html` 材料,`live_url` 指向 `/dev/ui` → 在网页里**看到并操作模拟器内真实运行的 LOFA APK**(点图=在设备上点同处)。已实测:取屏出真画面、点「笔记」tab 真切换、四 tab 真数据。
- 这是「验 APP 本体」而非「验网页」:画面来自 `adb screencap` 抓的是 APK 在真 Android(模拟器)里的渲染,不是桌面浏览器加载 www。

## 1. 反向控制的两档(关键约束:飞连是单向的)
飞连让**手机→本机**可达,但本机**够不着手机的 adb**(无反向 adb)。所以分两档,共用同一组指令语义:

- **A 档 · 有 adb 通道**(模拟器 / USB 连本机 / 同网 `adb tcpip`):**完整控制**——任意截屏、任意点击/输入、装任意包、底层调试。devview 现在这套就是 A 档。**要完整调试就用 A 档(优先模拟器)。**
- **B 档 · 只有单向连接**(真手机经飞连):本机够不着手机 adb,靠「**app 自助执行 + 本机下指令**」。B 档现有**两条并存的信道**(端点/语义/设备身份都不同,梳理与合并建议见第 5 节):
  - **B 档 JS 级(旧)**:`/api/android/commands/*` + `app/www/js/remote.js`。app 每 3s 轮询取待办,在 **WebView 进程内**执行:切 tab/弹提示/回传 DOM 状态/触发 OTA。做不到系统级——只能碰 LOFA 自己的网页。
  - **B 档原生无障碍(新)**:`/api/android/automation/*` + `DeviceBridgeService.java`(前台服务长轮询) + `LofaAccessibilityService.java`(系统级执行器)。经 Android 无障碍服务(用户一次性授权)取得**系统级能力**:归一化坐标点击、读整棵 UI 树、按文本/view_id 点击填字、back/home/recents、启动任意 app、整屏截图(Android 11+),**能驱动别的 app**(如小红书草稿流程)。
  - **仍做不到的(无 adb)**:`adb shell`/`logcat`、装包到别的 app、底层调试、任意文件读写。这些由**第 5 层 adb 反向隧道**解决(手机连出建反向通道,PC 侧 `adb connect 127.0.0.1:6555` 拿完整 adb;架构与坑见 `SELF-UPDATE-AND-REMOTE-CONTROL.md` 第 3 节)。
  - **结论**:真手机日常走 B 档;系统级操控走原生无障碍信道,adb 级调试走反向隧道或切 A 档(模拟器/USB)。「B 档只能碰网页、系统级操控只能 A 档」的旧说法已被无障碍执行器推翻。

## 2. 平板支持
- 平板 = 更大屏的同一 LOFA www(Capacitor 同样能打平板包),**响应式按屏宽切布局**:审阅 tab 在平板上列表+详情并排,更适合审材料。
- **手写笔记**:加 ink 能力——canvas 捕获笔迹(strokes 向量 + 压感/倾斜),存成 `kind=ink` 内容;笔记编辑器支持 Apple Pencil / 触控笔。审阅材料也可在平板上**手写圈批**。
- 落地原则:平板与手机**共用一套 www**,不另造客户端;ink 作为又一种内容 kind,走 notes 的统一读写(authored / 后续 poof 桥),不为平板单搭一套存储。

## 3. 优先级建议
1. ✅ 设备视图(模拟器)+ 审阅材料 — 已落。
2. 升级设备视图画面:轮询截图(现~1.5fps)→ scrcpy/WebRTC 实时视频(更流畅) — 可选;scrcpy 也可经第 5 层隧道对真机投屏。
3. ✅ B 档命令信道 — 已落两条:JS 级(`/commands/*`)与原生无障碍(`/automation/*`,含系统级点击/截屏/启动 app + 状态回传)。下一步是收敛这两条(见第 5 节)。
4. 平板:响应式布局 + ink 手写笔记/批注。

## 4. 边界
- B 档「无 adb」是物理约束(飞连单向):**系统级操控**已由原生无障碍执行器拿到,不再受此限;仍受限的只有 **adb 级底层调试**(shell/logcat/装别的 app/文件),那要 A 档或第 5 层反向隧道。
- ink/平板与「内容层」是同一套内容读写,别再起第二套(吸取上次内容层大门面被回退的教训)。

## 5. 两套 B 档信道梳理与合并建议

B 档现在**并存两套命令信道**,由同一个运行中的 app 同时消费:`remote.js` 在 WebView 里每 3s 轮询 `/commands/*`,同时它的 `startRemote()` 又调 `DeviceAutomation.configure()` 拉起原生 `DeviceBridgeService` 去长轮询 `/automation/*`。两者存储、语义、设备身份、健壮性都不同。

| 维度 | JS 级(旧) `/commands/*` + `remote.js` | 原生无障碍(新) `/automation/*` + `DeviceBridgeService` |
|---|---|---|
| 执行环境 | WebView 进程内 JS,只能碰 LOFA 自己的网页 | Android 无障碍服务,系统级、可跨 app |
| op 集 | `ping`/`toast`/`navigate`/`state`/`screenshot`/`ota_check`/`ota_install`(`LEGACY_COMMAND_OPS`) | `status`/`screenshot`/`ui_tree`/`tap`/`click_text`/`set_text`/`global_action`/`launch_app`/`launch_label`/`stage_media`/`cleanup_debug_media`(`AUTOMATION_OPS`) |
| 设备身份 | 前端 `localStorage` 自造 `lofa.deviceId`,**无令牌** | 配对握手(`pairing-window`→`pair`,绑真机 device_id + 源 IP),存 `device_token_hash` |
| 鉴权 | `enqueue` 要 controller 令牌;**`poll`/`result` 无任何鉴权**(任何人可读/写任意 device_id 队列) | controller 令牌 `X-LOFA-Control-Token` 入队/读回执;设备令牌 `X-LOFA-Device-Token` 轮询/回传 |
| 取指令 | `poll` 一次取空整个队列,无重发保障 | 长轮询(`threading.Event`,25s);`inflight` 租约 + `delivery_count` 重投 |
| 可靠性 | 无幂等/无序号/无过期 | `idempotency_key` 去重、`sequence` 递增、`ttl` 过期、`issued` 去重回执 |
| 存储 | `data/runtime/lofa_commands.json` | `data/runtime/lofa_automation.json` |

**两处易踩的坑(以代码为准)**:
- **`screenshot` 撞名不同物**:JS 级 `screenshot` 只回 WebView 的可见文本(`{kind:'webview-state', bodyText}`),根本不是截图;无障碍 `screenshot` 才是真整屏 JPEG。同名不同义,极易误用。
- **`eval` 是幽灵 op**:`cmd_enqueue` 的 docstring 和 `remote.js` 注释都写了 `eval`,但 `LEGACY_COMMAND_OPS` 白名单没有它、`remote.js` 也无 `eval` 分支——入队会被拒。属误导文字。

**建议:统一到 `/automation/*`,弃用 JS 级 `/commands/*`。**
- 原生无障碍信道在能力(系统级、跨 app)、鉴权(双令牌 + 配对)、可靠性(幂等/租约/过期)上全面优于 JS 级,应作为 B 档**唯一主信道**。
- JS 级里仍有独立价值的只有**对 LOFA 自身**的操作:`ota_check`/`ota_install`(触发自更新)、`toast`/`navigate`/`state`(app 内提示/切页/回传状态)。这些无障碍信道也能近似做(`launch_app`/`click_text`),但不如 WebView 内 JS 精确。收敛路径二选一:
  1. 把这几个「LOFA-self」op 作为新 op 并进 `/automation/*`,由 WebView 桥执行,彻底下线 `/commands/*`;或
  2. 暂留一个**极小**的 app 自操作入口,但立即砍掉与 automation 重复或更弱的部分——尤其撞名的 `screenshot` 和**无鉴权的 `poll`/`result`**。
- 无论选哪条,**立即**该做的三件小事:① 删掉 docstring/注释里的 `eval` 误导文字;② 给 legacy `poll`/`result` 补设备鉴权或直接下线(当前无鉴权是真实安全缺口);③ 全项目文档统一指认 `/automation/*` 为 B 档主信道。
- 以上为文字分析与建议,本轮不改远控业务代码。
