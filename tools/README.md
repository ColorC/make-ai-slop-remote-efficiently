# tools · 安卓相关工具的家

本 repo 收编所有安卓开发相关工具，避免散落。

## device/ — 设备工具（adb + scrcpy）
无线连接小米手机 + 投屏操控用。**已迁入（2026-06-25）**，adb 从新位置起服验证可用：
- `device/platform-tools/` — 谷歌官方 adb（无线配对/连接/调试）
- `device/scrcpy-win64-v4.0/` — 投屏操控（注意：本机无音频设备，启动须 `--no-audio`）
- `device/connect-and-mirror.cmd` — 一键连接 + 投屏（参数为 `IP:连接端口`，相对路径，迁移后无需改）

已知设备坑（来自实测）：
- 无线配对端口 ≠ 连接端口；配对码每次重开弹窗都变。
- 小米默认不给输入注入权限，必须开「USB调试（安全设置）」点击才生效。
- scrcpy 默认转发音频，本机无音频设备会崩，须 `--no-audio`。

## build/ — 构建/打包
Capacitor 构建、OTA bundle 产出（web 资产打 ZIP + 算 SHA-256 + 写 manifest）等脚本。

## test/ — 测试
真机 e2e（Maestro/Appium，驱动真实 UI 路径）、对新建后端端点的契约测试脚本。

## log/ — 日志辅助
日志查看/导出辅助。App 端日志按 JSONL 落盘 + 批量回传本机 `POST /api/android/log`，本机在看板里查看。
