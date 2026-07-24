"""LOFA 设备视图 / 远程控制 服务(devview)。

网页里看到并操作 Android 设备(模拟器/真机)里真实运行的 LOFA APP, 作为审阅材料嵌入 dashboard。
三原语: 看屏 / 输入 / 装包调试。模拟器走本地 adb 直连。

画面: H264 实时流(adb screenrecord → WebSocket → 浏览器 WebCodecs 解码)≈30fps, 不再轮询截图;
      WebCodecs 不可用时自动回退到截图轮询(/dev/screen)。
分辨率: /dev/size 可切手机/平板(adb wm size), 配合平板视图。
零窗口、纯 HTTP/WS, 不弹控制台。adb 用 lofa 项目自带 SDK。
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
from pathlib import Path

from fastapi import Body, FastAPI, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse

ADB = r"E:\WindowsWorkspace\lofa\tools\android-sdk\platform-tools\adb.exe"
if not Path(ADB).exists():
    ADB = shutil.which("adb") or "adb"

app = FastAPI(title="lofa-devview")
_size_cache: dict[str, tuple[int, int]] = {}

PRESETS = {  # 逻辑分辨率(配合 LOFA 响应式: >=600dp 宽 = 平板视图)
    "phone": (1080, 2340, 420),
    "tablet": (1600, 2560, 240),     # 竖平板
    "tablet_land": (2560, 1600, 240),
}


def _adb(serial: str, *args: str, binary: bool = False, timeout: int = 20):
    cmd = [ADB] + (["-s", serial] if serial else []) + list(args)
    p = subprocess.run(cmd, capture_output=True, timeout=timeout)
    return p.stdout if binary else p.stdout.decode("utf-8", "replace")


def _dev_size(serial: str) -> tuple[int, int]:
    out = _adb(serial, "shell", "wm", "size")
    w, h = 1080, 2340
    for line in out.splitlines():
        # 优先 Override size(被 wm size 改过的当前逻辑分辨率)
        if ("Override size:" in line or "Physical size:" in line) and "x" in line:
            try:
                wh = line.split(":")[-1].strip().split("x")
                w, h = int(wh[0]), int(wh[1])
            except Exception:
                pass
    _size_cache[serial] = (w, h)
    return w, h


@app.get("/dev/devices")
def devices():
    out = _adb("", "devices")
    rows = [{"serial": l.split("\t")[0].strip(), "state": l.split("\t")[1].strip()}
            for l in out.splitlines()[1:] if "\t" in l]
    return {"devices": rows}


@app.get("/dev/screen")
def screen(serial: str = "emulator-5554"):
    """截图(WebCodecs 回退路径用)。"""
    try:
        png = _adb(serial, "exec-out", "screencap", "-p", binary=True, timeout=15)
        if not png or png[:4] != b"\x89PNG":
            return Response(content=b"", media_type="image/png", status_code=503)
        return Response(content=png, media_type="image/png", headers={"Cache-Control": "no-store"})
    except Exception as e:  # noqa: BLE001
        return Response(content=str(e).encode(), status_code=500)


@app.websocket("/dev/h264")
async def h264(ws: WebSocket):
    """H264 实时流: adb screenrecord 连续 H264 → WS。screenrecord 有 180s 上限, 到点自动重起。"""
    await ws.accept()
    serial = ws.query_params.get("serial", "emulator-5554")
    dw, dh = _dev_size(serial)  # 按设备真实宽高比下采样, 切平板也不变形
    scale = 1.0 if max(dw, dh) <= 1280 else (1280.0 / max(dw, dh))
    sw, sh = int(dw * scale) // 2 * 2, int(dh * scale) // 2 * 2  # screenrecord 要偶数
    size = f"{sw}x{sh}"
    proc = None
    try:
        while True:
            proc = await asyncio.create_subprocess_exec(
                ADB, "-s", serial, "exec-out",
                "screenrecord", "--output-format=h264", f"--size={size}",
                "--bit-rate=6000000", "--time-limit=170", "-",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            while True:
                chunk = await proc.stdout.read(32768)
                if not chunk:
                    break  # screenrecord 到时/退出 → 外层重起
                await ws.send_bytes(chunk)
    except (WebSocketDisconnect, ConnectionError, RuntimeError):
        pass
    except Exception:  # noqa: BLE001
        pass
    finally:
        if proc and proc.returncode is None:
            try:
                proc.kill()
            except Exception:
                pass


@app.get("/dev/size")
def get_size(serial: str = "emulator-5554"):
    """当前逻辑分辨率(控制面板读数用)。density 取 wm density 当前 Override/Physical。"""
    w, h = _dev_size(serial)
    d = 0
    try:
        out = _adb(serial, "shell", "wm", "density")
        for line in out.splitlines():
            if ("Override density:" in line or "Physical density:" in line):
                try:
                    d = int(line.split(":")[-1].strip())
                except Exception:
                    pass
    except Exception:
        pass
    return {"ok": True, "w": w, "h": h, "density": d}


@app.post("/dev/size")
def set_size(body: dict = Body(...)):
    serial = body.get("serial", "emulator-5554")
    preset = body.get("preset")
    if preset == "reset":
        _adb(serial, "shell", "wm", "size", "reset")
        _adb(serial, "shell", "wm", "density", "reset")
        _size_cache.pop(serial, None)
        return {"ok": True, "preset": "reset"}
    if preset in PRESETS:
        w, h, d = PRESETS[preset]
    else:
        w, h, d = int(body.get("w", 1080)), int(body.get("h", 2340)), int(body.get("density", 420))
    _adb(serial, "shell", "wm", "size", f"{w}x{h}")
    _adb(serial, "shell", "wm", "density", str(d))
    _size_cache.pop(serial, None)
    return {"ok": True, "w": w, "h": h, "density": d, "preset": preset}


@app.post("/dev/tap")
def tap(body: dict = Body(...)):
    serial = body.get("serial", "emulator-5554")
    w, h = _dev_size(serial)
    x, y = int(float(body.get("nx", 0)) * w), int(float(body.get("ny", 0)) * h)
    _adb(serial, "shell", "input", "tap", str(x), str(y))
    return {"ok": True, "x": x, "y": y}


@app.post("/dev/swipe")
def swipe(body: dict = Body(...)):
    serial = body.get("serial", "emulator-5554")
    w, h = _dev_size(serial)
    _adb(serial, "shell", "input", "swipe",
         str(int(float(body["nx1"]) * w)), str(int(float(body["ny1"]) * h)),
         str(int(float(body["nx2"]) * w)), str(int(float(body["ny2"]) * h)),
         str(int(body.get("ms", 250))))
    return {"ok": True}


@app.post("/dev/text")
def text(body: dict = Body(...)):
    serial = body.get("serial", "emulator-5554")
    s = str(body.get("s", "")).replace(" ", "%s")
    if s:
        _adb(serial, "shell", "input", "text", s)
    return {"ok": True}


@app.post("/dev/key")
def key(body: dict = Body(...)):
    serial = body.get("serial", "emulator-5554")
    _adb(serial, "shell", "input", "keyevent", str(body.get("key", 4)))
    return {"ok": True}


@app.post("/dev/install")
def install(body: dict = Body(...)):
    serial = body.get("serial", "emulator-5554")
    apk = body.get("apk") or r"E:\WindowsWorkspace\lofa\app\android\app\build\outputs\apk\debug\app-debug.apk"
    out = _adb(serial, "install", "-r", apk, timeout=120)
    return JSONResponse({"ok": "Success" in out, "out": out[-400:]})


@app.post("/dev/restart_app")
def restart_app(body: dict = Body(...)):
    serial = body.get("serial", "emulator-5554")
    pkg = body.get("pkg", "cc.colorc.lofa")
    _adb(serial, "shell", "am", "force-stop", pkg)
    _adb(serial, "shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1")
    return {"ok": True}


_UI = (Path(__file__).parent / "ui.html").read_text(encoding="utf-8")
_CONSOLE = (Path(__file__).parent / "console.html").read_text(encoding="utf-8")


@app.get("/dev/ui", response_class=HTMLResponse)
def ui(serial: str = "emulator-5554"):
    return _UI


@app.get("/dev/console", response_class=HTMLResponse)
def console(serial: str = "emulator-5554"):
    """实机操作台(嵌审阅台单材料): ws-scrcpy 实时镜像(?stream= 注入) + 内置分辨率切换条。
    切换走同源 POST /dev/size, 切完重连镜像。"""
    return _CONSOLE


@app.get("/healthz")
def healthz():
    return {"ok": True, "service": "lofa-devview"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("DEVVIEW_PORT", "8770")), log_level="warning")
