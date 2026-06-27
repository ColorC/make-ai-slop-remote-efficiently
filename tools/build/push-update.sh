#!/usr/bin/env bash
# LOFA 一键「从电脑端主动更新手机上的 app」
#   检测设备(自动) -> 版本号+1 -> 构建 APK -> adb 推送安装 -> 重启 -> 校验新版本
# 用法: bash push-update.sh [ip:port]    不传则自动找设备(后端记的手机IP / 上次成功)
# 前提: 手机在与 PC 互通的扁平网(飞连/ZTNA 单向连不上); 已 adb tcpip 5555。
set -uo pipefail
ROOT="/e/WindowsWorkspace/lofa"
ADB="$ROOT/tools/device/platform-tools/adb.exe"
APP="$ROOT/app"
GRADLE="$APP/android/app/build.gradle"
APK="$APP/android/app/build/outputs/apk/debug/app-debug.apk"
PKG="cc.colorc.lofa"
DASH="${OMNI_DASH:-http://127.0.0.1:8210}"

# 1) 检测设备: 后端记的手机IP -> .device.conf -> 传参
bip(){ curl -s --max-time 4 "$DASH/api/android/device" 2>/dev/null | grep -oE '"ip"[^,}]*' | grep -oE "[0-9]+(\.[0-9]+){3}" | head -1; }
TARGET="${1:-}"
if [ -z "$TARGET" ]; then ip="$(bip)"; [ -n "$ip" ] && TARGET="$ip:5555"; fi
[ -z "$TARGET" ] && [ -f "$ROOT/tools/device/.device.conf" ] && TARGET="$(cat "$ROOT/tools/device/.device.conf")"
[ -z "$TARGET" ] && { echo "✗ 找不到设备: 在手机上开一下 app(登记IP)或传 ip:5555"; exit 1; }
"$ADB" connect "$TARGET" >/dev/null 2>&1; sleep 1
[ "$("$ADB" -s "$TARGET" get-state 2>/dev/null)" = "device" ] || { echo "✗ 连不上 $TARGET (需扁平网, 飞连连不上)"; exit 1; }
echo "● 设备: $TARGET"
OLD=$("$ADB" -s "$TARGET" shell dumpsys package "$PKG" 2>/dev/null | grep -oE "versionName=[^ ]+" | head -1)
echo "● 当前手机已装: ${OLD:-未安装}"

# 2) 版本号 +1 (让更新可检测)
CUR=$(grep -oE "versionCode [0-9]+" "$GRADLE" | grep -oE "[0-9]+" | head -1)
NEW=$((CUR + 1))
sed -i "s/versionCode $CUR/versionCode $NEW/" "$GRADLE"
sed -i "s/versionName \"[^\"]*\"/versionName \"1.0.$NEW\"/" "$GRADLE"
echo "● 版本: versionCode $CUR → $NEW  (versionName 1.0.$NEW)"

# 3) 构建
echo "● 构建中 (cap sync + assembleDebug)…"
( cd "$APP" && npx cap sync android >/dev/null 2>&1 )
( cd "$APP/android" && ./gradlew assembleDebug --console=plain --no-daemon >/dev/null 2>&1 ) || { echo "✗ 构建失败"; exit 1; }

# 4) 推送安装 (屏幕需亮, 自动唤醒)
"$ADB" -s "$TARGET" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
"$ADB" -s "$TARGET" shell wm dismiss-keyguard >/dev/null 2>&1
echo "● 推送安装 (adb install -r)…"
"$ADB" -s "$TARGET" install -r "$APK" 2>&1 | tail -1

# 5) 重启 app
"$ADB" -s "$TARGET" shell am force-stop "$PKG" >/dev/null 2>&1
"$ADB" -s "$TARGET" shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1

# 6) 校验
sleep 2
AFT=$("$ADB" -s "$TARGET" shell dumpsys package "$PKG" 2>/dev/null | grep -oE "versionName=[^ ]+" | head -1)
echo "✓ 完成: 手机现装 ${AFT}  (lastUpdate $(date '+%H:%M:%S'))"
