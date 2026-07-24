#!/usr/bin/env python3
"""tools/tunnel/verify_tunnel_native.py — adb 反向隧道端到端真实验证(步骤②，原生服务)。

与 verify_tunnel.py(步骤①)的区别：手机桥不再是 mock，而是安装在**本机 Android 模拟器**
里的原生 DevTunnelService(cc.colorc.lofa)。本脚本把整条链路固化、可重复跑：

    宿主 adb connect 127.0.0.1:6555
        │ (raw adb 字节)
    宿主中继 android_tunnel(adb 面 127.0.0.1:6555 / WS 面 0.0.0.0:8211)
        │  WS /api/devtunnel/ws  (模拟器经 10.0.2.2:8211 连回；失败自动退化为 adb reverse)
    模拟器内 DevTunnelService(原生前台服务)
        │  Socket(127.0.0.1, 5555)
    模拟器内 adbd

必须真实：`adb shell` 要经原生 DevTunnelService 穿到模拟器 adbd 才能回显；echo/getprop 的
回显来自真 adbd，非 mock/回环。

前置(脚本不代做，缺失会明确报错)：
- 模拟器内已开 adbd tcp 5555：`adb -s <serial> shell setprop service.adb.tcp.port 5555`
  且 `adb -s <serial> tcpip 5555`(确认 127.0.0.1:5555 有 adbd 监听)。
- 已安装带 DevTunnelService 的 debug APK。

用 omnicompany venv python 跑(依赖 fastapi/uvicorn)::

    set PYTHONIOENCODING=utf-8
    omnicompany/venv/Scripts/python.exe lofa/tools/tunnel/verify_tunnel_native.py

参数见 --help。
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LOFA_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DEFAULT_ADB = os.path.join(LOFA_ROOT, "tools", "device", "platform-tools", "adb.exe")
PACKAGE = "cc.colorc.lofa"
ACTIVITY = f"{PACKAGE}/.MainActivity"


def _port_open(host: str, port: int, timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _wait(pred, timeout: float, interval: float = 0.5) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if pred():
                return True
        except Exception:
            pass
        time.sleep(interval)
    return False


def _status(ws_port: int) -> dict:
    url = f"http://127.0.0.1:{ws_port}/api/devtunnel/status"
    with urllib.request.urlopen(url, timeout=2) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _kill(proc: "subprocess.Popen | None") -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            proc.terminate()
    except Exception:
        pass
    try:
        proc.wait(timeout=5)
    except Exception:
        pass


def _adb(adb: str, *args: str, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run([adb, *args], capture_output=True, text=True, timeout=timeout)


def _launch_app(adb: str, serial: str, relay_host: str, ws_port: int, token: str) -> None:
    """经前台 Activity 启动 DevTunnelService(满足 Android 12+ 前台服务后台启动限制)。"""
    _adb(
        adb, "-s", serial, "shell", "am", "start",
        "-n", ACTIVITY,
        "--ez", "start_devtunnel", "true",
        "--es", "dt_relay_host", relay_host,
        "--ei", "dt_relay_port", str(ws_port),
        "--es", "dt_relay_scheme", "ws",   # 中继是明文 uvicorn，强制 ws 避免继承设备 base_url 的 https
        "--es", "dt_token", token,
        timeout=30,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="adb 反向隧道端到端验证(步骤②，原生 DevTunnelService)")
    parser.add_argument("--adb", default=DEFAULT_ADB, help="adb.exe 全路径")
    parser.add_argument("--serial", default="emulator-5554", help="模拟器 serial")
    parser.add_argument("--adb-port", type=int, default=6555, help="隧道 adb 面端口(只绑本机)")
    parser.add_argument("--ws-port", type=int, default=8211, help="中继 WS 端口(绑 0.0.0.0)")
    parser.add_argument("--token", default="verify-devtunnel-native-9c1f", help="共享 device token")
    parser.add_argument("--relay-host", default="10.0.2.2", help="模拟器连宿主用的主机(默认 10.0.2.2)")
    parser.add_argument("--force-reverse", action="store_true", help="跳过 10.0.2.2，直接用 adb reverse")
    parser.add_argument("--keep", action="store_true", help="验证后不清理(留隧道调试)")
    args = parser.parse_args()

    tunnel_serial = f"127.0.0.1:{args.adb_port}"
    relay: "subprocess.Popen | None" = None
    relay_log = open(os.path.join(HERE, ".relay-native.log"), "w", encoding="utf-8")
    reverse_added = False
    used_path = ""
    ok = False
    echo_out = ""
    model_out = ""

    try:
        if not os.path.isfile(args.adb):
            print(f"[verify2] FAIL: adb 不存在: {args.adb}")
            return 2
        if _port_open("127.0.0.1", args.adb_port) or _port_open("127.0.0.1", args.ws_port):
            print(f"[verify2] FAIL: 端口占用(adb {args.adb_port} / ws {args.ws_port})，先清残留")
            return 2

        # sanity: 模拟器在线且 shell 可用(经原生 emulator transport，不走隧道)。
        sanity = _adb(args.adb, "-s", args.serial, "shell", "echo", "EMU_OK")
        if "EMU_OK" not in sanity.stdout:
            print(f"[verify2] FAIL: 模拟器 {args.serial} shell 不通。stdout={sanity.stdout!r} stderr={sanity.stderr!r}")
            return 2
        # sanity: 模拟器内 adbd tcp 5555 在监听(DevTunnelService 的目标)。管道须整段作单个 shell
        # 字符串传给 adb shell，否则 adb 会按空格拆散管道(经典 adb 引用坑)。5555=0x15B3，LISTEN=0A。
        listen = _adb(
            args.adb, "-s", args.serial, "shell",
            "cat /proc/net/tcp6 /proc/net/tcp 2>/dev/null | grep -i ':15B3 ' | grep -i ' 0A '",
        )
        if ":15B3" not in (listen.stdout or "").upper():
            print("[verify2] FAIL: 模拟器内未见 adbd 监听 5555。先 `adb tcpip 5555`。")
            print(f"[verify2]   /proc/net/tcp* grep: {listen.stdout!r}")
            return 2
        print(f"[verify2] sanity: 模拟器 {args.serial} 在线，adbd tcp 5555 监听中")

        # 起中继(独立进程，独立端口；WS 绑 0.0.0.0 让模拟器经 10.0.2.2 连到，adb 面只绑 127.0.0.1)。
        relay = subprocess.Popen(
            [
                sys.executable, "-m", "omnicompany.dashboard.controlplane.android_tunnel",
                "--adb-port", str(args.adb_port),
                "--ws-port", str(args.ws_port),
                "--adb-host", "127.0.0.1",
                "--ws-host", "0.0.0.0",
                "--token", args.token,
            ],
            stdout=relay_log,
            stderr=subprocess.STDOUT,
        )
        if not _wait(
            lambda: _port_open("127.0.0.1", args.ws_port) and _port_open("127.0.0.1", args.adb_port),
            timeout=20,
        ):
            print("[verify2] FAIL: 中继端口未就绪(WS/adb 面)")
            return 3
        print(f"[verify2] relay up: adb 面 {tunnel_serial}, WS 0.0.0.0:{args.ws_port}")

        # 路径①：模拟器经 10.0.2.2 连回宿主。
        if not args.force_reverse:
            _launch_app(args.adb, args.serial, args.relay_host, args.ws_port, args.token)
            if _wait(lambda: _status(args.ws_port).get("bridge_connected"), timeout=20):
                used_path = f"10.0.2.2 (relay_host={args.relay_host})"

        # 路径②(退化)：10.0.2.2 不通时，用 adb reverse 让模拟器 127.0.0.1:ws 转到宿主。
        if not used_path:
            print("[verify2] 10.0.2.2 未连回，退化为 adb reverse …")
            _adb(args.adb, "-s", args.serial, "reverse", f"tcp:{args.ws_port}", f"tcp:{args.ws_port}")
            reverse_added = True
            _adb(args.adb, "-s", args.serial, "shell", "am", "force-stop", PACKAGE)
            _launch_app(args.adb, args.serial, "127.0.0.1", args.ws_port, args.token)
            if _wait(lambda: _status(args.ws_port).get("bridge_connected"), timeout=20):
                used_path = "adb reverse (relay_host=127.0.0.1)"

        if not used_path:
            print("[verify2] FAIL: 原生 DevTunnelService 未注册到中继(两条路径都没连回)。")
            print(f"[verify2]   relay status: {_status(args.ws_port)!r}")
            return 4
        print(f"[verify2] native bridge registered via {used_path}")

        # 经隧道 adb connect + shell(真实穿透到模拟器 adbd)。
        conn = _adb(args.adb, "connect", tunnel_serial)
        print(f"[verify2] adb connect {tunnel_serial}: {conn.stdout.strip()}")
        _wait(lambda: _status(args.ws_port).get("adb_connected"), timeout=8)

        echo = _adb(args.adb, "-s", tunnel_serial, "shell", "echo", "TUNNEL2_OK")
        echo_out = (echo.stdout or "").strip()
        print(f"[verify2] adb -s {tunnel_serial} shell echo TUNNEL2_OK -> {echo_out!r}")
        if echo.stderr.strip():
            print(f"[verify2]   stderr: {echo.stderr.strip()!r}")

        model = _adb(args.adb, "-s", tunnel_serial, "shell", "getprop", "ro.product.model")
        model_out = (model.stdout or "").strip()
        print(f"[verify2] getprop ro.product.model (经隧道) -> {model_out!r}")

        ok = "TUNNEL2_OK" in echo_out and bool(model_out)
        return 0 if ok else 5

    finally:
        if not args.keep:
            try:
                _adb(args.adb, "disconnect", tunnel_serial, timeout=10)
            except Exception:
                pass
            try:
                _adb(args.adb, "-s", args.serial, "shell", "am", "force-stop", PACKAGE, timeout=10)
            except Exception:
                pass
            if reverse_added:
                try:
                    _adb(args.adb, "-s", args.serial, "reverse", "--remove", f"tcp:{args.ws_port}", timeout=10)
                except Exception:
                    pass
            _kill(relay)
        relay_log.close()
        verdict = "PASS" if ok else "FAIL"
        print(f"\n[verify2] ==== {verdict} ==== (echo={echo_out!r}, model={model_out!r}, path={used_path or 'none'})")
        if not ok:
            path = os.path.join(HERE, ".relay-native.log")
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    tail = f.read()[-1800:]
                print(f"\n----- .relay-native.log (tail) -----\n{tail}")
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
