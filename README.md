# LOFA — Look Over From Afar

> **Make AI Slop Remote Efficiently**

A LAN-based Android mobile client for the [omnicompany](https://github.com/ColorC/make-ai-slop-more-efficiently) AI software factory. Browse reviews, chat with AI agents, use a real terminal, manage projects — all from your phone on the same network.

局域网安卓客户端,把 omnicompany(AI 软件工厂)装进口袋:手机与电脑在同一局域网内,即可审阅材料、和 AI 对话、开真终端、管项目。离机无功能,不做离线缓存。

## ⚠️ Read This First · 先看这个

> This is a personal tool built for my own workflow. It requires omnicompany's dashboard backend running on a PC on the same LAN. It will NOT work standalone. I make no guarantees it will work on your machine, but I welcome bug fixes, feature PRs, or just filing issues telling me to fix something.
>
> 这是为我自己的工作流造的私人工具。必须配合局域网内一台运行 omnicompany 看板后端的电脑,单独装 app 没有任何功能。不保证在你的机器上能跑——但欢迎修 bug、提 feature PR,或者直接开 issue 命令我修(是的,你可以命令我)。

## Features · 功能

- **4-tab mobile UI** — Sessions (chat + terminal) / Review / Projects / Me(会话 · 审阅 · 项目 · 我的)
- **AI chat, multiple providers** — Claude / Codex / Kimi / OpenCode / Omni; streaming responses, tool-call cards, thinking blocks(多提供方对话,流式渲染 + 工具卡 + 推理块)
- **PTY terminal** — a real terminal over WebSocket, rendered by vendored **xterm.js 6.0** + WebGL, with accessory key bar (Esc/Tab/Ctrl/Alt) and pinch-to-zoom(真终端,附键盘工具条与缩放)
- **Review inbox with batch verdict** — browse, filter, accept/reject, comment, batch operations(审阅收件箱,批量裁定)
- **Projects board** — read-only view of projects, quests and plans(项目看板只读视图)
- **OTA self-update** — app downloads the new APK from your PC and triggers the system installer(应用内自更新)
- **5-layer remote-control architecture · 五层远控架构**:
  1. OTA self-update · OTA 自更新
  2. A-tier devview — full adb control, H264 ~30fps · A 档 devview(adb 全控 + H264 实时流)
  3. B-tier JS-level commands — WebView self-service · B 档 JS 级指令(WebView 自助)
  4. B-tier native accessibility automation — system-level tap/screenshot/launch · B 档原生辅助功能(系统级点按/截屏/拉起)
  5. Reverse adb tunnel — phone connects OUT to PC via WebSocket · 反向 adb 隧道(手机主动外连电脑)

## Tech Stack · 技术栈

- **App shell**: Capacitor 7 (Android WebView)
- **Frontend**: **vanilla ES modules, no build step** — ~6,800 lines JS + ~1,900 lines CSS; what you read is what ships(纯 vanilla,无构建步骤)
- **Terminal**: xterm.js 6.0 + WebGL renderer (vendored)
- **Native**: Java — Accessibility Service, APK installer, dev tunnel bridge(安卓原生 Java 层)
- **Server-side**: Python FastAPI (devview, tunnel relay)

## Quick Start · 上手

Prerequisites · 前提: Android Studio (JDK 21), Node.js, and a PC running the
[omnicompany](https://github.com/ColorC/make-ai-slop-more-efficiently) dashboard (`omni dashboard`) on your LAN.

1. Clone this repo. 克隆本仓库。
2. Open `app/android/` in Android Studio → build the APK → install it on your phone.
   用 Android Studio 打开 `app/android`,构建 APK 装到手机。
3. Make sure omnicompany's dashboard is running on your PC. 确保电脑上看板在跑。
4. Open LOFA on your phone (**same LAN**) — it auto-discovers the dashboard. 手机开 app(同一局域网),自动发现看板。

One-click dev stack launcher (Windows) · 一键起栈(Windows,幂等):

```powershell
.\lofa-up.ps1
```

Build + push a fresh APK to a device over adb · 构建并推送到设备:

```bash
bash tools/build/push-update.sh [ip:port]
```

## Project Structure · 目录结构

```
app/
├── www/            # Web frontend (vanilla JS, no build step)
│   ├── js/         # ES module views + state
│   ├── css/        # Design tokens + view-specific styles
│   ├── vendor/     # xterm.js 6.0 + addons
│   └── fonts/      # Cascadia Mono + LXGW WenKai
├── android/        # Capacitor Android native shell (Java)
tools/
├── device/         # adb + scrcpy + connect scripts
├── build/          # Release staging + OTA publishing
├── devview/        # Real-time screen mirror / control (FastAPI)
├── test/           # Vitest + Playwright + Maestro
└── tunnel/         # Reverse adb tunnel verification
docs/               # Design docs + API contracts
```

## Related · 相关

- [omnicompany](https://github.com/ColorC/make-ai-slop-more-efficiently) — the AI software factory this app connects to · 本 app 对接的 AI 软件工厂
- [summon-the-slop](https://github.com/ColorC/summon-the-slop) — desktop overlay shell, the other half of the remote work setup · 桌面悬浮壳,远程工作的另一半

## License · 许可证

[MIT](LICENSE)
