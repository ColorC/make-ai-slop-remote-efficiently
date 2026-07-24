#!/usr/bin/env python3
"""tools/tunnel/verify_tunnel_stress.py — adb 反向隧道压测(步骤③，本机模拟器)。

在步骤②(verify_tunnel_native.py 已验证 echo/getprop 基线)之上，对隧道做大字节量 +
持续流 + 多路复用的健壮性压测，专门暴露背压/丢帧/截断问题。全程经隧道 serial
127.0.0.1:6555 跑真实 adb 命令，绝不用小数据/echo 冒充。

复用步骤②的链路搭建(起中继 + am start 唤起 DevTunnelService + adb connect)，见
verify_tunnel_native 的 setup 辅助函数。压测场景::

  1. push/pull 大文件 sha256 逐字节校验 —— 最能暴露背压 bug 的用例。
  2. install 大 APK —— PC→手机 大量字节透传。
  3. logcat dump + 短时 follow —— 持续流不卡死。
  4. 多路复用 —— 单隧道连接下并发 pull/shell 不串不卡(验 adb 自身 stream mux 经隧道透明)。
  5. 稳定性 —— 连续 N 轮 echo+中等 pull，无递增失败、无连接泄漏。

用 omnicompany venv python 跑::

    set PYTHONIOENCODING=utf-8
    omnicompany/venv/Scripts/python.exe lofa/tools/tunnel/verify_tunnel_stress.py

末尾自清理:删设备/本地测试文件 + disconnect + 杀中继。参数见 --help。
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# 复用步骤②已验证的链路辅助(起中继/唤起桥/连隧道/状态探测)。
import verify_tunnel_native as vt  # noqa: E402

DEVICE_TMP = "/data/local/tmp"
PUSH_NAME = "lofa_stress_push.bin"


# ── 底层工具 ──────────────────────────────────────────────────────────────────
def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _make_random_file(path: str, size_bytes: int) -> str:
    """写 size_bytes 随机字节，返回 sha256。分块写避免一次性占内存。"""
    h = hashlib.sha256()
    remaining = size_bytes
    with open(path, "wb") as f:
        while remaining > 0:
            n = min(remaining, 1 << 20)
            block = os.urandom(n)
            f.write(block)
            h.update(block)
            remaining -= n
    return h.hexdigest()


def _device_sha256(adb: str, serial: str, device_path: str, timeout: int = 120) -> str:
    """经隧道 serial 在设备上算 sha256(sha256sum 输出 '<hash>  <path>')。"""
    r = vt._adb(adb, "-s", serial, "shell", "sha256sum", device_path, timeout=timeout)
    out = (r.stdout or "").strip()
    return out.split()[0] if out else ""


class Result:
    def __init__(self) -> None:
        self.scenarios: list[tuple[str, bool, str]] = []  # (name, ok, detail)

    def add(self, name: str, ok: bool, detail: str = "") -> None:
        self.scenarios.append((name, ok, detail))
        flag = "PASS" if ok else "FAIL"
        print(f"[stress] [{flag}] {name}{(' — ' + detail) if detail else ''}", flush=True)

    @property
    def all_ok(self) -> bool:
        return all(ok for _, ok, _ in self.scenarios)


# ── 链路搭建(镜像 verify_tunnel_native.main 的 setup 段) ──────────────────────
def setup_tunnel(adb: str, serial: str, adb_port: int, ws_port: int, token: str,
                 relay_host: str, force_reverse: bool,
                 ws_impl: str = "wsproto", ws_ping_interval: float = 20.0):
    """起中继 + 唤起原生桥 + adb connect，返回 (relay_proc, tunnel_serial, reverse_added, used_path)。

    ws_impl/ws_ping_interval 透传给中继:压测时可选 legacy `websockets` + 短 ping 间隔以复现
    并发写崩连,或 wsproto 验证已修。失败抛 RuntimeError(附带已探到的 relay status)。
    """
    tunnel_serial = f"127.0.0.1:{adb_port}"
    if vt._port_open("127.0.0.1", adb_port) or vt._port_open("127.0.0.1", ws_port):
        raise RuntimeError(f"端口占用(adb {adb_port} / ws {ws_port})，先清残留")

    # 模拟器在线 + adbd tcp 5555 监听(桥的目标)。
    sanity = vt._adb(adb, "-s", serial, "shell", "echo", "EMU_OK")
    if "EMU_OK" not in (sanity.stdout or ""):
        raise RuntimeError(f"模拟器 {serial} shell 不通: {sanity.stdout!r} {sanity.stderr!r}")
    listen = vt._adb(
        adb, "-s", serial, "shell",
        "cat /proc/net/tcp6 /proc/net/tcp 2>/dev/null | grep -i ':15B3 ' | grep -i ' 0A '",
    )
    if ":15B3" not in (listen.stdout or "").upper():
        raise RuntimeError("模拟器内未见 adbd 监听 5555(先 adb tcpip 5555)")

    relay_log = open(os.path.join(HERE, ".relay-stress.log"), "w", encoding="utf-8")
    relay = subprocess.Popen(
        [
            sys.executable, "-m", "omnicompany.dashboard.controlplane.android_tunnel",
            "--adb-port", str(adb_port), "--ws-port", str(ws_port),
            "--adb-host", "127.0.0.1", "--ws-host", "0.0.0.0", "--token", token,
            "--ws-impl", ws_impl, "--ws-ping-interval", str(ws_ping_interval),
        ],
        stdout=relay_log, stderr=subprocess.STDOUT,
    )
    if not vt._wait(
        lambda: vt._port_open("127.0.0.1", ws_port) and vt._port_open("127.0.0.1", adb_port),
        timeout=20,
    ):
        raise RuntimeError("中继端口未就绪")
    print(f"[stress] relay up: adb 面 {tunnel_serial}, WS 0.0.0.0:{ws_port}", flush=True)

    used_path = ""
    reverse_added = False
    if not force_reverse:
        vt._launch_app(adb, serial, relay_host, ws_port, token)
        if vt._wait(lambda: vt._status(ws_port).get("bridge_connected"), timeout=20):
            used_path = f"10.0.2.2 (relay_host={relay_host})"
    if not used_path:
        print("[stress] 10.0.2.2 未连回，退化为 adb reverse …", flush=True)
        vt._adb(adb, "-s", serial, "reverse", f"tcp:{ws_port}", f"tcp:{ws_port}")
        reverse_added = True
        vt._adb(adb, "-s", serial, "shell", "am", "force-stop", vt.PACKAGE)
        vt._launch_app(adb, serial, "127.0.0.1", ws_port, token)
        if vt._wait(lambda: vt._status(ws_port).get("bridge_connected"), timeout=20):
            used_path = "adb reverse (relay_host=127.0.0.1)"
    if not used_path:
        raise RuntimeError(f"原生桥未注册到中继。relay status: {vt._status(ws_port)!r}")
    print(f"[stress] native bridge registered via {used_path}", flush=True)

    conn = vt._adb(adb, "connect", tunnel_serial)
    print(f"[stress] adb connect {tunnel_serial}: {conn.stdout.strip()}", flush=True)
    if not vt._wait(lambda: vt._status(ws_port).get("adb_connected"), timeout=10):
        raise RuntimeError("adb 未连上中继 adb 面")
    # 经隧道基线 echo(确认穿透到真 adbd)。
    echo = vt._adb(adb, "-s", tunnel_serial, "shell", "echo", "STRESS_READY")
    if "STRESS_READY" not in (echo.stdout or ""):
        raise RuntimeError(f"经隧道基线 echo 失败: {echo.stdout!r} {echo.stderr!r}")
    return relay, tunnel_serial, reverse_added, used_path, relay_log


def _est_conn_count(port: int) -> int:
    """统计到 127.0.0.1:<port> 的 ESTABLISHED 连接数(粗略探 socket 泄漏)。"""
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return -1
    n = 0
    needle = f"127.0.0.1:{port}"
    for line in out.splitlines():
        if needle in line and "ESTABLISHED" in line:
            n += 1
    return n


# ── 压测场景 ──────────────────────────────────────────────────────────────────
def scn_bigfile(adb: str, serial: str, workdir: str, size_mb: int, res: Result) -> None:
    src = os.path.join(workdir, PUSH_NAME)
    dst_device = f"{DEVICE_TMP}/{PUSH_NAME}"
    pulled = os.path.join(workdir, "lofa_stress_pulled.bin")
    size = size_mb * 1024 * 1024

    t0 = time.time()
    src_sha = _make_random_file(src, size)
    t_push0 = time.time()
    push = vt._adb(adb, "-s", serial, "push", src, dst_device, timeout=300)
    t_push = time.time() - t_push0
    push_ok = push.returncode == 0 and "error" not in (push.stderr or "").lower()

    dev_sha = _device_sha256(adb, serial, dst_device)
    dev_ok = dev_sha == src_sha

    t_pull0 = time.time()
    pull = vt._adb(adb, "-s", serial, "pull", dst_device, pulled, timeout=300)
    t_pull = time.time() - t_pull0
    pull_ok = pull.returncode == 0 and os.path.isfile(pulled)
    pulled_sha = _sha256_file(pulled) if pull_ok else ""
    sha_ok = pulled_sha == src_sha

    push_mbps = size / (1024 * 1024) / t_push if t_push > 0 else 0
    pull_mbps = size / (1024 * 1024) / t_pull if t_pull > 0 else 0
    detail = (
        f"{size_mb}MB push {t_push:.1f}s({push_mbps:.1f}MB/s) pull {t_pull:.1f}s({pull_mbps:.1f}MB/s); "
        f"src={src_sha[:12]} dev={dev_sha[:12]} pulled={pulled_sha[:12]}"
    )
    ok = push_ok and dev_ok and pull_ok and sha_ok
    if not ok:
        detail += (f" | push_ok={push_ok} dev_ok={dev_ok} pull_ok={pull_ok} sha_ok={sha_ok}"
                   f" push_err={push.stderr.strip()!r} pull_err={pull.stderr.strip()!r}")
    res.add(f"大文件 push/pull sha256({size_mb}MB)", ok, detail)
    # 留 dst_device 供并发/稳定性场景复用；本地临时文件保留到统一清理。


def scn_install(adb: str, serial: str, workdir: str, install_pkg: str, res: Result) -> None:
    """经隧道 install 大 APK。

    关键:装的必须是**别的**包，不能是 cc.colorc.lofa —— 重装隧道自身宿主 app 会杀掉
    DevTunnelService(桥)，把承载 install 流的隧道自己掐断，install 必失败(自毁)。这里
    取一个第三方单体 apk(默认 com.bilibili.nslg base.apk)经隧道 pull 到本机再经隧道
    install -r 装回:pm 会校验 apk 完整性/签名，Success 即证明这条大 apk 经隧道逐字节透传无误。
    """
    # 经隧道 pm path 解析目标 apk。
    pp = vt._adb(adb, "-s", serial, "shell", "pm", "path", install_pkg, timeout=30)
    apk_path = ""
    for ln in (pp.stdout or "").splitlines():
        ln = ln.strip()
        if ln.startswith("package:") and ln.endswith("base.apk"):
            apk_path = ln[len("package:"):]
            break
    if not apk_path:
        res.add("install 大 APK", False, f"未解析到 {install_pkg} 的 base.apk: {pp.stdout!r}")
        return

    local_apk = os.path.join(workdir, "foreign_install.apk")
    t_pull0 = time.time()
    pull = vt._adb(adb, "-s", serial, "pull", apk_path, local_apk, timeout=300)
    t_pull = time.time() - t_pull0
    if pull.returncode != 0 or not os.path.isfile(local_apk):
        res.add("install 大 APK", False,
                f"pull apk 失败: rc={pull.returncode} err={pull.stderr.strip()!r}")
        return
    sz = os.path.getsize(local_apk) / (1024 * 1024)

    t0 = time.time()
    r = vt._adb(adb, "-s", serial, "install", "-r", local_apk, timeout=300)
    dt = time.time() - t0
    out = (r.stdout or "") + (r.stderr or "")
    ok = "Success" in out
    last = out.strip().splitlines()[-1] if out.strip() else "(no output)"
    res.add("install 大 APK", ok,
            f"{install_pkg} {sz:.1f}MB (pull {t_pull:.1f}s) install {dt:.1f}s -> {last}")


def scn_logcat(adb: str, serial: str, res: Result) -> None:
    # dump。logcat 内含非 GBK 字节(中文/emoji)，Windows locale 解码会崩，强制 utf-8/replace。
    d = subprocess.run([adb, "-s", serial, "logcat", "-d", "-t", "500"],
                       capture_output=True, timeout=60)
    dump_text = (d.stdout or b"").decode("utf-8", "replace")
    lines = [ln for ln in dump_text.splitlines() if ln.strip()]
    dump_ok = len(lines) >= 20
    # 短时 follow：起 follow 进程，收几秒后杀，断言拿到多行且能干净停。
    follow_lines = 0
    follow_ok = False
    try:
        p = subprocess.Popen(
            [adb, "-s", serial, "logcat", "-v", "brief"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
        )
        # 制造日志流量(经隧道再触发 app 打点)。
        deadline = time.time() + 5
        buf: list[str] = []
        # 非阻塞读:用线程收集。
        collected: list[str] = []
        stop = threading.Event()

        def _reader():
            for ln in p.stdout:  # type: ignore[union-attr]
                collected.append(ln)
                if stop.is_set():
                    break

        th = threading.Thread(target=_reader, daemon=True)
        th.start()
        while time.time() < deadline:
            vt._adb(adb, "-s", serial, "shell", "log", "-t", "LofaStress", "follow-probe")
            time.sleep(0.5)
        stop.set()
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                p.terminate()
        except Exception:
            pass
        th.join(timeout=3)
        follow_lines = len(collected)
        follow_ok = follow_lines >= 5 and any("follow-probe" in ln for ln in collected)
    except Exception as e:  # noqa: BLE001
        follow_ok = False
        follow_lines = -1
        print(f"[stress]   logcat follow 异常: {e}", flush=True)
    ok = dump_ok and follow_ok
    res.add("logcat dump + 短时 follow", ok,
            f"dump {len(lines)} 行, follow 收 {follow_lines} 行(含探针={follow_ok})")


def scn_concurrency(adb: str, serial: str, workdir: str, res: Result) -> None:
    """并发 3 路 pull(各自独立文件+sha) + 1 路 shell，验多路复用不串不卡。"""
    files = {}
    for tag, mb in (("A", 3), ("B", 3), ("C", 3)):
        p = os.path.join(workdir, f"lofa_mux_{tag}.bin")
        sha = _make_random_file(p, mb * 1024 * 1024)
        dev = f"{DEVICE_TMP}/lofa_mux_{tag}.bin"
        push = vt._adb(adb, "-s", serial, "push", p, dev, timeout=120)
        files[tag] = {"local": p, "dev": dev, "src_sha": sha,
                      "pulled": os.path.join(workdir, f"lofa_mux_{tag}_pulled.bin"),
                      "push_ok": push.returncode == 0}

    results: dict[str, object] = {}
    lock = threading.Lock()

    def _pull(tag: str) -> None:
        info = files[tag]
        r = vt._adb(adb, "-s", serial, "pull", info["dev"], info["pulled"], timeout=180)
        sha = _sha256_file(info["pulled"]) if os.path.isfile(info["pulled"]) else ""
        with lock:
            results[tag] = (r.returncode == 0 and sha == info["src_sha"], sha[:12], info["src_sha"][:12])

    def _shell() -> None:
        r = vt._adb(adb, "-s", serial, "shell", "echo", "CONCURRENT_SHELL_OK", timeout=60)
        with lock:
            results["shell"] = "CONCURRENT_SHELL_OK" in (r.stdout or "")

    threads = [threading.Thread(target=_pull, args=(t,)) for t in files]
    threads.append(threading.Thread(target=_shell))
    t0 = time.time()
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    dt = time.time() - t0

    pull_ok = all(isinstance(results.get(t), tuple) and results[t][0] for t in files)
    shell_ok = bool(results.get("shell"))
    ok = pull_ok and shell_ok
    detail = f"3 路并发 pull + shell in {dt:.1f}s; " + \
             ", ".join(f"{t}:{'ok' if isinstance(results.get(t), tuple) and results[t][0] else 'BAD'}" for t in files) + \
             f", shell:{'ok' if shell_ok else 'BAD'}"
    if not ok:
        detail += f" | raw={results}"
    res.add("多路复用(并发 pull/shell 不串)", ok, detail)


def scn_stability(adb: str, serial: str, workdir: str, ws_port: int, rounds: int, res: Result) -> None:
    """N 轮 echo + 中等 pull，验无递增失败/连接泄漏。"""
    med = os.path.join(workdir, "lofa_med.bin")
    med_sha = _make_random_file(med, 2 * 1024 * 1024)
    dev = f"{DEVICE_TMP}/lofa_med.bin"
    vt._adb(adb, "-s", serial, "push", med, dev, timeout=60)

    conn_before = _est_conn_count(int(serial.split(":")[1]))
    fails = 0
    for i in range(rounds):
        e = vt._adb(adb, "-s", serial, "shell", "echo", f"ROUND_{i}", timeout=30)
        if f"ROUND_{i}" not in (e.stdout or ""):
            fails += 1
            continue
        out = os.path.join(workdir, "lofa_med_pulled.bin")
        p = vt._adb(adb, "-s", serial, "pull", dev, out, timeout=120)
        sha = _sha256_file(out) if os.path.isfile(out) else ""
        if p.returncode != 0 or sha != med_sha:
            fails += 1
    conn_after = _est_conn_count(int(serial.split(":")[1]))
    st = vt._status(ws_port)
    ok = fails == 0 and st.get("bridge_connected") and st.get("adb_connected")
    # 连接数应稳定(adb server 对每设备仅一条传输连接);允许 +/-1 抖动。
    leak = conn_after - conn_before if conn_before >= 0 and conn_after >= 0 else 0
    if leak > 2:
        ok = False
    res.add(f"稳定性({rounds} 轮 echo+2MB pull)", ok,
            f"失败 {fails}/{rounds}; 隧道连接数 {conn_before}->{conn_after}(泄漏判据<=2); "
            f"relay bridge={st.get('bridge_connected')} adb={st.get('adb_connected')}")


def scn_sustained(adb: str, serial: str, workdir: str, ws_port: int, duration: int, res: Result) -> None:
    """持续大流跨 keepalive-ping 边界:循环 push 48MB 直到 duration 秒。

    这是逼出「库的 ping/pong 写帧撞并发 send_bytes drain」竞态的确定性用例 —— 配合中继短
    ping 间隔(--relay-ping-interval),每次 push 期间必有 keepalive ping 落下。legacy websockets
    实现会崩连(中继 status 探不到/桥断);wsproto 实现应全程 sha 一致、中继存活。
    """
    src = os.path.join(workdir, "lofa_sustained.bin")
    src_sha = _make_random_file(src, 48 * 1024 * 1024)
    dev = f"{DEVICE_TMP}/lofa_sustained.bin"
    deadline = time.time() + duration
    iters = 0
    fails = 0
    crashed = False
    detail_err = ""
    while time.time() < deadline:
        p = vt._adb(adb, "-s", serial, "push", src, dev, timeout=120)
        if p.returncode != 0:
            fails += 1
            detail_err = f"push rc={p.returncode} err={p.stderr.strip()!r}"
        else:
            dsha = _device_sha256(adb, serial, dev)
            if dsha != src_sha:
                fails += 1
                detail_err = f"sha 不一致 dev={dsha[:12]} src={src_sha[:12]}"
        iters += 1
        try:
            st = vt._status(ws_port)
        except Exception as e:  # noqa: BLE001
            crashed = True
            detail_err = f"中继 status 探测失败: {e}"
            break
        if not (st.get("bridge_connected") and st.get("adb_connected")):
            crashed = True
            detail_err = f"桥/adb 掉线: {st!r}"
            break
    ok = (not crashed) and fails == 0 and iters > 0
    res.add(f"持续大流跨ping({duration}s,48MB×N)", ok,
            f"{iters} 次 push, 失败 {fails}, 中继崩={crashed}"
            + (f"; {detail_err}" if detail_err else ""))


# ── 清理 ──────────────────────────────────────────────────────────────────────
def cleanup(adb: str, serial: str, tunnel_serial: str, relay, reverse_added: bool,
            ws_port: int, workdir: str, relay_log) -> None:
    print("[stress] cleanup …", flush=True)
    # 删设备文件
    try:
        vt._adb(adb, "-s", tunnel_serial, "shell",
                "rm", "-f",
                f"{DEVICE_TMP}/{PUSH_NAME}", f"{DEVICE_TMP}/lofa_mux_A.bin",
                f"{DEVICE_TMP}/lofa_mux_B.bin", f"{DEVICE_TMP}/lofa_mux_C.bin",
                f"{DEVICE_TMP}/lofa_med.bin", f"{DEVICE_TMP}/lofa_sustained.bin", timeout=30)
    except Exception:
        pass
    try:
        vt._adb(adb, "disconnect", tunnel_serial, timeout=10)
    except Exception:
        pass
    try:
        vt._adb(adb, "-s", serial, "shell", "am", "force-stop", vt.PACKAGE, timeout=10)
    except Exception:
        pass
    if reverse_added:
        try:
            vt._adb(adb, "-s", serial, "reverse", "--remove", f"tcp:{ws_port}", timeout=10)
        except Exception:
            pass
    vt._kill(relay)
    try:
        relay_log.close()
    except Exception:
        pass
    # 删本地临时工作目录
    try:
        shutil.rmtree(workdir, ignore_errors=True)
    except Exception:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description="adb 反向隧道压测(步骤③)")
    parser.add_argument("--adb", default=vt.DEFAULT_ADB)
    parser.add_argument("--serial", default="emulator-5554")
    parser.add_argument("--adb-port", type=int, default=6555)
    parser.add_argument("--ws-port", type=int, default=8211)
    parser.add_argument("--token", default="verify-devtunnel-stress-7f2a")
    parser.add_argument("--relay-host", default="10.0.2.2")
    parser.add_argument("--force-reverse", action="store_true")
    parser.add_argument("--install-pkg", default="com.bilibili.nslg",
                        help="经隧道 install 测试用的第三方包(禁用 cc.colorc.lofa,会自毁隧道)")
    parser.add_argument("--big-mb", type=int, default=48, help="大文件 push/pull 大小(MB)")
    parser.add_argument("--rounds", type=int, default=20, help="稳定性轮数")
    parser.add_argument("--sustained-sec", type=int, default=14,
                        help="持续大流场景时长(秒)，需 > relay ping 间隔以跨边界")
    parser.add_argument("--relay-ws-impl", default="wsproto",
                        help="中继 uvicorn ws 实现(wsproto=已修 / websockets=复现崩连)")
    parser.add_argument("--relay-ping-interval", type=float, default=2.0,
                        help="中继 WS keepalive ping 间隔(秒)，调小以逼出并发写竞态")
    parser.add_argument("--only", default="",
                        help="只跑逗号分隔的场景子集(bigfile,logcat,concurrency,sustained,stability,install)")
    parser.add_argument("--keep", action="store_true", help="不清理(留隧道调试)")
    args = parser.parse_args()
    only = {s.strip() for s in args.only.split(",") if s.strip()}

    if not os.path.isfile(args.adb):
        print(f"[stress] FAIL: adb 不存在: {args.adb}")
        return 2

    workdir = tempfile.mkdtemp(prefix="lofa_tunnel_stress_")
    res = Result()
    relay = None
    tunnel_serial = f"127.0.0.1:{args.adb_port}"
    reverse_added = False
    relay_log = None

    try:
        relay, tunnel_serial, reverse_added, used_path, relay_log = setup_tunnel(
            args.adb, args.serial, args.adb_port, args.ws_port, args.token,
            args.relay_host, args.force_reverse,
            ws_impl=args.relay_ws_impl, ws_ping_interval=args.relay_ping_interval)
        print(f"[stress] tunnel ready via {used_path} (ws={args.relay_ws_impl}, "
              f"ping={args.relay_ping_interval}s). workdir={workdir}\n", flush=True)

        # install 放最后:即便用第三方 apk 不会掐桥,重装仍是最可能扰动的操作,末位最稳。
        def _run(key, fn):
            if not only or key in only:
                fn()
        _run("bigfile", lambda: scn_bigfile(args.adb, tunnel_serial, workdir, args.big_mb, res))
        _run("logcat", lambda: scn_logcat(args.adb, tunnel_serial, res))
        _run("concurrency", lambda: scn_concurrency(args.adb, tunnel_serial, workdir, res))
        _run("sustained", lambda: scn_sustained(args.adb, tunnel_serial, workdir, args.ws_port, args.sustained_sec, res))
        _run("stability", lambda: scn_stability(args.adb, tunnel_serial, workdir, args.ws_port, args.rounds, res))
        _run("install", lambda: scn_install(args.adb, tunnel_serial, workdir, args.install_pkg, res))

    except Exception as e:  # noqa: BLE001
        res.add("链路搭建/执行", False, f"{type(e).__name__}: {e}")
    finally:
        if not args.keep:
            cleanup(args.adb, args.serial, tunnel_serial, relay, reverse_added,
                    args.ws_port, workdir, relay_log)
        else:
            print(f"[stress] --keep: 隧道保留, workdir={workdir}", flush=True)

    print("\n[stress] ===== 汇总 =====", flush=True)
    for name, ok, detail in res.scenarios:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name} — {detail}", flush=True)
    verdict = "ALL PASS" if res.all_ok else "SOME FAIL"
    print(f"[stress] ==== {verdict} ====", flush=True)
    if not res.all_ok and relay_log is not None:
        p = os.path.join(HERE, ".relay-stress.log")
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                tail = f.read()[-2000:]
            print(f"\n----- .relay-stress.log (tail) -----\n{tail}", flush=True)
        except Exception:
            pass
    return 0 if res.all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
