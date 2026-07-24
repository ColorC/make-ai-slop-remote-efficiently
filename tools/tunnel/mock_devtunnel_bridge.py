#!/usr/bin/env python3
"""tools/tunnel/mock_devtunnel_bridge.py — 冒充手机 DevTunnelService 的本机 mock 桥。

步骤① 用它代替尚未实现的原生 DevTunnelService，端到端验证 PC 中继逻辑：
用 websockets 客户端连中继 /api/devtunnel/ws(带 device token)，对中继在该 WS 上
下发的 {"op":"open"} 打开一个到目标 adbd 的原始 socket，之后做原始字节双向转发
(WS binary ↔ adbd socket)；收 {"op":"close"} 或 adbd EOF 则关闭并通知对端。

原生 DevTunnelService(步骤②)行为与此一致，差异仅在：socket 目标固定
127.0.0.1:5555、用 OkHttp WS + 前台服务保活、掉线指数退避重连。

约束：对字节流保持透明，不解析 adb 协议。目标 adbd host:port 可配。
"""

from __future__ import annotations

import argparse
import asyncio
import json

from websockets.asyncio.client import connect

_CHUNK = 65536


class MockBridge:
    def __init__(self, relay_url: str, token: str, adbd_host: str, adbd_port: int) -> None:
        self._url = relay_url
        self._token = token
        self._adbd_host = adbd_host
        self._adbd_port = adbd_port
        self._ws = None
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._pump: asyncio.Task | None = None
        self._send_lock = asyncio.Lock()  # 新 websockets asyncio 客户端并发 send 会报错

    async def run(self) -> None:
        uri = self._url
        if self._token:
            sep = "&" if "?" in uri else "?"
            uri = f"{uri}{sep}token={self._token}"
        async with connect(uri, max_size=None) as ws:
            self._ws = ws
            print(
                f"[mock-bridge] connected to relay {self._url}; "
                f"target adbd {self._adbd_host}:{self._adbd_port}",
                flush=True,
            )
            try:
                async for message in ws:
                    if isinstance(message, (bytes, bytearray)):
                        await self._on_data(bytes(message))
                    else:
                        await self._on_control(message)
            finally:
                await self._teardown(notify=False)

    async def _on_control(self, text: str) -> None:
        try:
            op = json.loads(text).get("op")
        except Exception:
            op = None
        if op == "open":
            await self._open_adbd()
        elif op == "close":
            await self._teardown(notify=False)

    async def _open_adbd(self) -> None:
        await self._teardown(notify=False)  # 顶替旧 socket
        reader, writer = await asyncio.open_connection(self._adbd_host, self._adbd_port)
        self._reader, self._writer = reader, writer
        self._pump = asyncio.create_task(self._pump_adbd_to_ws())
        print("[mock-bridge] opened adbd socket", flush=True)

    async def _pump_adbd_to_ws(self) -> None:
        try:
            while True:
                data = await self._reader.read(_CHUNK)
                if not data:
                    break  # adbd EOF
                await self._ws_send(data)
        except asyncio.CancelledError:
            return  # 外部 teardown 取消，不回发 close
        except Exception:
            pass
        # EOF/错误 → 通知中继关闭对端 adb 连接。
        await self._teardown(notify=True)

    async def _on_data(self, data: bytes) -> None:
        w = self._writer
        if w is not None and not w.is_closing():
            try:
                w.write(data)
                await w.drain()
            except (ConnectionError, OSError):
                pass

    async def _teardown(self, notify: bool) -> None:
        pump = self._pump
        self._pump = None
        if pump is not None and pump is not asyncio.current_task():
            pump.cancel()
        w = self._writer
        self._reader = None
        self._writer = None
        if w is not None:
            try:
                w.close()
            except Exception:
                pass
        if notify:
            await self._ws_send_text(json.dumps({"op": "close"}))

    async def _ws_send(self, data: bytes) -> None:
        async with self._send_lock:
            try:
                await self._ws.send(data)
            except Exception:
                pass

    async def _ws_send_text(self, text: str) -> None:
        async with self._send_lock:
            try:
                await self._ws.send(text)
            except Exception:
                pass


async def _amain() -> None:
    parser = argparse.ArgumentParser(description="LOFA adb 反向隧道 mock 手机桥")
    parser.add_argument(
        "--relay",
        required=True,
        help="中继 WS URL，如 ws://127.0.0.1:8211/api/devtunnel/ws",
    )
    parser.add_argument("--token", default="", help="device token")
    parser.add_argument(
        "--adbd",
        default="127.0.0.1:5555",
        help="目标 adbd host:port(默认 127.0.0.1:5555)",
    )
    args = parser.parse_args()
    host, _, port = args.adbd.rpartition(":")
    bridge = MockBridge(args.relay, args.token, host, int(port))
    await bridge.run()


if __name__ == "__main__":
    try:
        asyncio.run(_amain())
    except KeyboardInterrupt:
        pass
