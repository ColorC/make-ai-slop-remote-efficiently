# LOFA · Look Over From Afar

> 局域网内，从手机远看本机 omnicompany 的一切：审阅浏览、编辑笔记、和 AI 对话——全部在 App 内，支持应用内推送更新。连不到本机即无功能（不离线缓存）。
>
> `LOFA` 的发布门牌全句统一为 `Look Over From Afar`。本 repo 同时是**安卓相关工具的家**（设备工具 adb/scrcpy、构建/测试/日志工具）。

## 这是什么
本机（omnicompany 所在 PC，当前 Android 16/HyperOS3 的小米手机）局域网移动客户端。本质是 omnicompany 看板那套后端（FastAPI 8210 / ccdaemon 8201 / chatui 网关 7348）的 Android 客户端。

技术栈拍板：**Capacitor（原生 WebView 壳）+ 复用 omnicompany 看板 React 前端 + Capawesome 自托管热更（OTA）+ Timber 全量日志回传本机**。原生壳只管四件事：连接/权限、OTA、日志、空态。

## 权威计划
完整调研与计划在 omnicompany（保持 omnicompany 为规划中枢）：

- `omnicompany/docs/plans/remote-client/[2026-06-25]ANDROID-LAN-REMOTE/plan.md`
- 项目索引：`omnicompany/docs/projects/lofa/PROJECT_INDEX.md`

## 目录结构
```
lofa/
  app/      Capacitor Android 壳 + 配置（功能 UI 复用看板前端 build 产物）
  tools/    安卓相关工具的家
    device/   设备工具：adb(platform-tools) + scrcpy + 一键连接脚本
    build/    构建/打包脚本（OTA bundle 产出等）
    test/     真机 e2e（Maestro/Appium）、契约测试脚本
    log/      日志查看/导出辅助
  docs/     指向 omnicompany 权威计划的指针 + repo 内开发笔记
```

## 状态
规划完成（2026-06-25）。下一步：里程碑一——打通最薄端到端链路（小米真机 → 局域网 → 本机 → 显示一条真实审阅 material）+ 立起全量日志/测试地基。

## 铁律（从计划继承）
- 只局域网；连不上本机即无功能，不离线缓存。
- 全量日志、测试设施是一等公民，从第一天起。
- 真机验证不靠模拟器；每个里程碑产出真机录像/报告作为结果性产物。
- Android 16 本地网络权限是「局域网 only」的生死项，权限路径从里程碑一预埋。
