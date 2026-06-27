#!/usr/bin/env bash
# LOFA 自动连设备守护脚本 —— 干掉"反复开关无线调试 + 反复报 IP/端口"的麻烦。
#
# 前提(一次性): 设备已切到固定端口模式 `adb tcpip 5555`(见 setup 下方)。之后端口恒为 5555。
# 逻辑: 只要本脚本在跑, 检测到设备掉线就自动用 上次成功IP / mDNS发现 / 传入IP 重连; 连上就保持。
#
# 用法:
#   auto-adb.sh [ip]        # 后台守护, 默认连 <ip>:5555; 不传则用上次成功的 IP / mDNS
#   auto-adb.sh setup <ip:无线调试端口>   # 一次性: 连上后切固定端口 5555, 之后就稳定了
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ADB="$HERE/platform-tools/adb.exe"
CONF="$HERE/.device.conf"
PORT=5555

load(){ [ -f "$CONF" ] && cat "$CONF" 2>/dev/null; }
save(){ echo "$1" > "$CONF"; }
norm(){ case "$1" in *:*) echo "$1";; *) echo "$1:$PORT";; esac; }
connected(){ "$ADB" devices 2>/dev/null | grep -qE "\sdevice$"; }
discover(){ "$ADB" mdns services 2>/dev/null | grep -oE "[0-9]+(\.[0-9]+){3}:[0-9]+" | head -1; }
# 核心: 从本机 dashboard 拉"最近连上的手机 IP"(app 一连上 PC 就被后端记下了) —— 用户开下 app 即可自动反向调试
DASH="${OMNI_DASH:-http://127.0.0.1:8210}"
backend_ip(){ curl -s --max-time 3 "$DASH/api/android/device" 2>/dev/null | grep -oE '"ip"[^,}]*' | grep -oE "[0-9]+(\.[0-9]+){3}" | head -1; }

try(){ local t; t="$(norm "$1")"; [ -z "$1" ] && return 1
  "$ADB" connect "$t" >/dev/null 2>&1; sleep 1
  if [ "$("$ADB" -s "$t" get-state 2>/dev/null)" = "device" ]; then save "$t"; echo "[auto-adb] connected $t"; return 0; fi
  return 1; }

if [ "${1:-}" = "setup" ]; then
  # 一次性: 用当前无线调试端点连上 -> 切固定端口 5555 -> 验证
  ep="${2:?用法: auto-adb.sh setup <ip:无线调试端口>}"
  "$ADB" connect "$ep" >/dev/null 2>&1; sleep 1
  [ "$("$ADB" -s "$ep" get-state 2>/dev/null)" = "device" ] || { echo "[auto-adb] 连不上 $ep, 先确认网络互通"; exit 1; }
  ip="${ep%%:*}"
  echo "[auto-adb] 切固定端口 5555 ..."; "$ADB" -s "$ep" tcpip 5555; sleep 2
  try "$ip" && echo "[auto-adb] 固定端口已就绪: $ip:5555 (重启手机前一直有效)" || echo "[auto-adb] 切端口后重连失败, 重试 auto-adb.sh $ip"
  exit 0
fi

ARG="${1:-}"
echo "[auto-adb] 守护启动 (端口 $PORT). 连不上就自动重连; Ctrl-C 退出。"
while true; do
  if connected; then sleep 5; continue; fi
  # 候选顺序: 传入IP -> 后端记的手机IP(app连上即得) -> 上次成功 -> mDNS
  for c in "$ARG" "$(backend_ip)" "$(load)" "$(discover)"; do [ -n "$c" ] && try "$c" && break; done
  sleep 5
done
