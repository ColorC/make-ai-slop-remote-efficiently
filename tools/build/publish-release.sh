#!/usr/bin/env bash
# LOFA 发布一个可被 app「自更新」拉取的 APK —— 不需要 adb / 不需要连着设备。
#   版本号+1 → cap sync → 构建 → 复制 APK 到 omnicompany/data/android/releases → 写 manifest.json
# app 端连上 PC(含飞连)后 GET /api/android/apk/version 比对版本, 新则下载 /apk/latest 自安装。
set -uo pipefail
ROOT="/e/WindowsWorkspace/lofa"
APP="$ROOT/app"
GRADLE="$APP/android/app/build.gradle"
APK="$APP/android/app/build/outputs/apk/debug/app-debug.apk"
REL="/e/WindowsWorkspace/omnicompany/data/android/releases"
mkdir -p "$REL"

CUR=$(grep -oE "versionCode [0-9]+" "$GRADLE" | grep -oE "[0-9]+" | head -1)
NEW=$((CUR + 1))
sed -i "s/versionCode $CUR/versionCode $NEW/" "$GRADLE"
sed -i "s/versionName \"[^\"]*\"/versionName \"1.0.$NEW\"/" "$GRADLE"
echo "● 版本 $CUR → $NEW  (versionName 1.0.$NEW)"

echo "● 构建中…"
( cd "$APP" && npx cap sync android >/dev/null 2>&1 )
( cd "$APP/android" && ./gradlew assembleDebug --console=plain --no-daemon >/dev/null 2>&1 ) || { echo "✗ 构建失败 (单独跑 gradlew assembleDebug 看报错)"; exit 1; }

cp -f "$APK" "$REL/lofa-latest.apk"
SHA=$(sha256sum "$REL/lofa-latest.apk" | awk '{print $1}')
SIZE=$(stat -c %s "$REL/lofa-latest.apk")
cat > "$REL/manifest.json" <<EOF
{"versionCode": $NEW, "versionName": "1.0.$NEW", "sha256": "$SHA", "size": $SIZE, "filename": "lofa-latest.apk", "publishedAt": "$(date '+%Y-%m-%d %H:%M:%S')"}
EOF
echo "✓ 已发布 1.0.$NEW → $REL/lofa-latest.apk ($SIZE B)"
echo "  app 端在 设置→连接 后会自动检测; 或下次连上即弹更新横幅。"
