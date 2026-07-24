#!/usr/bin/env python3
"""tools/tunnel/verify_tunnel.py — adb 反向隧道端到端真实验证(步骤①)。

编排：起 PC 中继(android_tunnel.run_standalone) → 起 mock 桥(指向模拟器真 adbd)
→ `adb connect 127.0.0.1:6555` → `adb -s 127.0.0.1:6555 shell echo TUNNEL_OK`
→ 断言回显含 TUNNEL_OK → 清理(adb disconnect + 杀子进程)。

必须真实：adb shell 需要真 adbd，字节要透过隧道穿到模拟器真 adbd 才能回显，
不能用 echo server/mock 断言冒充。

用 omnicompany 的 python 跑(依赖 fastapi/uvicorn/websockets)::

    omnicompany/venv/Scripts/python.exe lofa/tools/tunnel/verify_tunnel.py

可选参数见 --help(adbd 目标、端口、token、adb 路径均可覆盖)。
"""

from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LOFA_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DEFAULT_ADB = os.path.join(LOFA_ROOT, "tools", "device", "platform-tools", "adb.exe")
MOCK_BRIDGE = os.path.join(HERE, "mock_devtunnel_bridge.py")


def _port_open(host: str, port: int, timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _wait(pred, timeout: float, interval: float = 0.25) -> bool:
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
        import json

        return json.loads(resp.read().decode("utf-8"))


def _kill(proc: subprocess.Popen | None) -> None:
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
    return subprocess.run(
        [adb, *args], capture_output=True, text=True, timeout=timeout
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="adb 反向隧道端到端验证(步骤①)")
    parser.add_argument("--adb", default=DEFAULT_ADB, help="adb.exe 全路径")
    parser.add_argument("--adbd", default="127.0.0.1:5555", help="目标真 adbd host:port")
    parser.add_argument("--adb-port", type=int, default=6555, help="隧道 adb 面端口")
    parser.add_argument("--ws-port", type=int, default=8211, help="中继 WS 端口")
    parser.add_argument("--token", default="verify-devtunnel-token", help="共享 device token")
    parser.add_argument("--keep", action="store_true", help="验证后不清理(留隧道调试)")
    args = parser.parse_args()

    tunnel_serial = f"127.0.0.1:{args.adb_port}"
    relay: subprocess.Popen | None = None
    bridge: subprocess.Popen | None = None
    relay_log = open(os.path.join(HERE, ".relay.log"), "w", encoding="utf-8")
    bridge_log = open(os.path.join(HERE, ".bridge.log"), "w", encoding="utf-8")
    ok = False
    echo_out = ""
    props_out = ""

    try:
        if not os.path.isfile(args.adb):
            print(f"[verify] FAIL: adb 不存在: {args.adb}")
            return 2
        if _port_open("127.0.0.1", args.adb_port) or _port_open("127.0.0.1", args.ws_port):
            print(
                f"[verify] FAIL: 端口占用(adb {args.adb_port} / ws {args.ws_port})，"
                "先清理残留进程"
            )
            return 2

        # 直连 sanity check：目标 adbd 真能连、能 shell。
        ah, _, ap = args.adbd.rpartition(":")
        _adb(args.adb, "connect", args.adbd)
        sanity = _adb(args.adb, "-s", args.adbd, "shell", "echo", "ADBD_DIRECT_OK")
        if "ADBD_DIRECT_OK" not in sanity.stdout:
            print(
                f"[verify] FAIL: 目标 adbd {args.adbd} 直连 shell 不通，"
                f"隧道无从谈起。stdout={sanity.stdout!r} stderr={sanity.stderr!r}"
            )
            return 2
        print(f"[verify] sanity: 直连 {args.adbd} shell OK")

        # 起中继(独立进程，独立测试端口，不碰 live dashboard)。
        relay = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "omnicompany.dashboard.controlplane.android_tunnel",
                "--adb-port", str(args.adb_port),
                "--ws-port", str(args.ws_port),
                "--adb-host", "127.0.0.1",
                "--ws-host", "127.0.0.1",
                "--token", args.token,
            ],
            stdout=relay_log,
            stderr=subprocess.STDOUT,
        )
        if not _wait(
            lambda: _port_open("127.0.0.1", args.ws_port)
            and _port_open("127.0.0.1", args.adb_port),
            timeout=15,
        ):
            print("[verify] FAIL: 中继端口未就绪(WS/adb 面)")
            return 3
        print(f"[verify] relay up: adb 面 {tunnel_serial}, WS :{args.ws_port}")

        # 起 mock 桥(指向真 adbd)。
        bridge = subprocess.Popen(
            [
                sys.executable,
                MOCK_BRIDGE,
                "--relay", f"ws://127.0.0.1:{args.ws_port}/api/devtunnel/ws",
                "--token", args.token,
                "--adbd", args.adbd,
            ],
            stdout=bridge_log,
            stderr=subprocess.STDOUT,
        )
        if not _wait(lambda: _status(args.ws_port).get("bridge_connected"), timeout=15):
            print("[verify] FAIL: mock 桥未注册到中继")
            return 4
        print("[verify] mock bridge registered")

        # 经隧道 adb connect + shell echo(真实穿透)。
        conn = _adb(args.adb, "connect", tunnel_serial)
        print(f"[verify] adb connect {tunnel_serial}: {conn.stdout.strip()}")
        # 给传输连接的 CNXN 握手一点时间。
        _wait(lambda: _status(args.ws_port).get("adb_connected"), timeout=5)

        echo = _adb(args.adb, "-s", tunnel_serial, "shell", "echo", "TUNNEL_OK")
        echo_out = (echo.stdout or "").strip()
        print(f"[verify] adb -s {tunnel_serial} shell echo TUNNEL_OK")
        print(f"[verify]   stdout: {echo_out!r}")
        if echo.stderr.strip():
            print(f"[verify]   stderr: {echo.stderr.strip()!r}")

        # 额外取证：经隧道读设备属性，证明是真 adbd 而非回环。
        props = _adb(
            args.adb, "-s", tunnel_serial, "shell",
            "getprop", "ro.product.model",
        )
        props_out = (props.stdout or "").strip()
        if props_out:
            print(f"[verify] getprop ro.product.model (经隧道): {props_out!r}")

        ok = "TUNNEL_OK" in echo_out
        return 0 if ok else 5

    finally:
        if not args.keep:
            try:
                _adb(args.adb, "disconnect", tunnel_serial, timeout=10)
            except Exception:
                pass
            _kill(bridge)
            _kill(relay)
        relay_log.close()
        bridge_log.close()
        verdict = "PASS" if ok else "FAIL"
        print(f"\n[verify] ==== {verdict} ==== (echo={echo_out!r})")
        if not ok:
            for name in (".relay.log", ".bridge.log"):
                path = os.path.join(HERE, name)
                try:
                    with open(path, encoding="utf-8", errors="replace") as f:
                        tail = f.read()[-1500:]
                    print(f"\n----- {name} (tail) -----\n{tail}")
                except Exception:
                    pass


if __name__ == "__main__":
    sys.exit(main())
