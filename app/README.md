# app · Capacitor Android 壳

> 状态说明：里程碑一（自建移动端审阅视图真机跑通）早已完成，本文为该里程碑前的待搭清单底稿，部分描述已过时，权威现状见 `omnicompany/docs/projects/lofa/PROJECT_INDEX.md`。

原生壳只做四件事：① 连接/权限　② OTA　③ 日志　④ 空态。功能 UI 是**自建移动端界面**，消费同一套后端接口（技术选型已否决复用桌面看板 React 前端的 build 产物，dockview 多面板塞竖屏适配差，详见 `omnicompany/docs/projects/lofa/PROJECT_INDEX.md`）。

## 待搭（里程碑一）
- Capacitor 脚手架 + Android 工程。
- `res/xml/network_security_config.xml`：精确放行 LAN 网段明文 HTTP（不要全局 usesCleartextTraffic）。
- 本地网络权限路径预埋（A16=NEARBY_WIFI_DEVICES，A17+=ACCESS_LOCAL_NETWORK），起步 targetSdk 34/35。
- 手填 IP:port 设置页 + 启动健康探测（GET /api/healthz）+ 连不上的统一空态。
- 日志：Timber + FileTree(JSONL) + CrashTree + OkHttp 拦截器 + WebView JS console 汇入。
- OTA：Capawesome Live Update 接线（里程碑五）。

详见权威计划 `omnicompany/docs/plans/remote-client/[2026-06-25]ANDROID-LAN-REMOTE/plan.md`。
