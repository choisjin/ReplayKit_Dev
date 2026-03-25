"""Monitor Client — 관제 서버에 상태를 보고하고 원격 명령을 수신하는 클라이언트."""

from __future__ import annotations

import asyncio
import json
import logging
import platform
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable, Coroutine, Optional

logger = logging.getLogger(__name__)

# websockets 라이브러리가 없으면 aiohttp 또는 기본 라이브러리로 폴백
try:
    import websockets
    from websockets.client import connect as ws_connect
    HAS_WEBSOCKETS = True
except ImportError:
    HAS_WEBSOCKETS = False


class MonitorClient:
    """관제 서버에 WebSocket으로 연결하여 상태를 주기적으로 push하는 클라이언트.

    원격 명령 수신 시 콜백을 호출하여 시나리오 재생/중지 등을 처리.
    """

    def __init__(self):
        self._server_url: str = ""
        self._client_id: str = str(uuid.uuid4())[:8]
        self._client_name: str = platform.node()  # 호스트명
        self._ws: Any = None
        self._task: Optional[asyncio.Task] = None
        self._status_interval: float = 2.0  # 상태 전송 간격 (초)
        self._running = False

        # 상태 수집 콜백
        self._get_status_fn: Optional[Callable[[], Coroutine[Any, Any, dict]]] = None
        # 원격 명령 수신 콜백
        self._on_command_fn: Optional[Callable[[dict], Coroutine[Any, Any, dict | None]]] = None

    @property
    def is_connected(self) -> bool:
        return self._ws is not None and self._running

    @property
    def server_url(self) -> str:
        return self._server_url

    def set_status_callback(self, fn: Callable[[], Coroutine[Any, Any, dict]]):
        """상태 수집 콜백 등록. 주기적으로 호출되어 현재 상태를 반환해야 함."""
        self._get_status_fn = fn

    def set_command_callback(self, fn: Callable[[dict], Coroutine[Any, Any, dict | None]]):
        """원격 명령 수신 콜백 등록. 명령을 처리하고 결과를 반환."""
        self._on_command_fn = fn

    async def start(self, server_url: str):
        """관제 서버에 연결 시작."""
        if not HAS_WEBSOCKETS:
            logger.warning("websockets 패키지 미설치 — 관제 서버 연결 불가 (pip install websockets)")
            return

        if not server_url:
            logger.debug("관제 서버 URL 미설정 — 연결하지 않음")
            return

        # 기존 연결 정리
        await self.stop()

        self._server_url = server_url.rstrip("/")
        self._running = True
        self._task = asyncio.create_task(self._connection_loop())
        logger.info("Monitor client 시작: %s", self._server_url)

    async def stop(self):
        """연결 종료."""
        self._running = False
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        logger.info("Monitor client 중지")

    async def _connection_loop(self):
        """자동 재연결 루프."""
        ws_url = self._server_url.replace("http://", "ws://").replace("https://", "wss://")
        if not ws_url.endswith("/ws/client"):
            ws_url = ws_url.rstrip("/") + "/ws/client"

        while self._running:
            try:
                async with ws_connect(ws_url, ping_interval=20, ping_timeout=10) as ws:
                    self._ws = ws
                    logger.info("관제 서버 연결 성공: %s", ws_url)

                    # 등록 메시지 전송
                    await ws.send(json.dumps({
                        "type": "register",
                        "client_id": self._client_id,
                        "name": self._client_name,
                        "version": "0.1.0",
                    }))

                    # 등록 확인 대기
                    resp = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    resp_data = json.loads(resp)
                    if resp_data.get("type") == "registered":
                        logger.info("관제 서버 등록 완료: client_id=%s", self._client_id)

                    # 수신 태스크 + 상태 전송 태스크 병렬 실행
                    recv_task = asyncio.create_task(self._receive_loop(ws))
                    send_task = asyncio.create_task(self._send_status_loop(ws))

                    # 하나가 끝나면 나머지도 종료
                    done, pending = await asyncio.wait(
                        [recv_task, send_task],
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    for t in pending:
                        t.cancel()
                        try:
                            await t
                        except (asyncio.CancelledError, Exception):
                            pass

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.debug("관제 서버 연결 실패: %s — 5초 후 재시도", e)
            finally:
                self._ws = None

            if self._running:
                await asyncio.sleep(5)

    async def _receive_loop(self, ws):
        """서버에서 수신한 메시지 처리 (원격 명령)."""
        try:
            async for raw in ws:
                try:
                    data = json.loads(raw)
                except Exception:
                    continue

                msg_type = data.get("type")
                if msg_type == "command" and self._on_command_fn:
                    action = data.get("action", "")
                    logger.info("원격 명령 수신: %s", action)
                    try:
                        result = await self._on_command_fn(data)
                        if result is not None:
                            await ws.send(json.dumps({
                                "type": "command_result",
                                "result": result,
                            }))
                    except Exception as e:
                        logger.error("원격 명령 처리 오류: %s", e)
                        await ws.send(json.dumps({
                            "type": "command_result",
                            "result": {"error": str(e)},
                        }))
        except Exception:
            pass  # 연결 종료 시 루프 탈출

    async def _send_status_loop(self, ws):
        """주기적으로 상태를 관제 서버에 전송."""
        try:
            while self._running:
                if self._get_status_fn:
                    try:
                        status = await self._get_status_fn()
                        status["type"] = "status_update"
                        status["client_id"] = self._client_id
                        status["name"] = self._client_name
                        status["version"] = "0.1.0"
                        status["timestamp"] = datetime.now(timezone.utc).isoformat()
                        await ws.send(json.dumps(status, default=str))
                    except Exception as e:
                        logger.debug("상태 전송 오류: %s", e)
                await asyncio.sleep(self._status_interval)
        except Exception:
            pass

    async def update_server_url(self, new_url: str):
        """관제 서버 URL 변경 시 재연결."""
        if new_url == self._server_url:
            return
        if new_url:
            await self.start(new_url)
        else:
            await self.stop()
