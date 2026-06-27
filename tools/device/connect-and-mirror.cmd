@echo off
REM ============================================================
REM  无线连接小米手机并启动 scrcpy 投屏操控
REM  用法:  双击运行,或  connect-and-mirror.cmd 10.3.101.120:39847
REM  - 默认连接端口 39847(无线调试主界面那个,关掉无线调试会变)
REM  - 若提示连不上 -> 手机重开"无线调试",看新端口,改这里或传参
REM  - 若提示需要重新配对 -> 用 platform-tools\adb.exe pair <ip>:<配对端口> <配对码>
REM ============================================================
setlocal
set HERE=%~dp0
set ADB=%HERE%platform-tools\adb.exe
set SCRCPY=%HERE%scrcpy-win64-v4.0\scrcpy.exe

set TARGET=%1
if "%TARGET%"=="" set TARGET=10.3.101.120:39847

echo [1/3] 启动 adb 服务...
"%ADB%" start-server

echo [2/3] 连接 %TARGET% ...
"%ADB%" connect %TARGET%
"%ADB%" -s %TARGET% wait-for-device

echo [3/3] 启动 scrcpy 投屏(无音频,最大边1600)...
"%SCRCPY%" -s %TARGET% -m 1600 --no-audio --window-title "Xiaomi popsicle (wireless)"

endlocal
