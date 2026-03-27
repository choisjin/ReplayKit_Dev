"""ReplayKit — FastAPI Backend."""

from __future__ import annotations

import asyncio
import base64
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from .routers import device, results, scenario, settings
from .dependencies import adb_service, device_manager, playback_service, recording_service, scrcpy_manager, monitor_client
from .services.adb_service import resolve_sf_display_id
from .services.scrcpy_service import _find_scrcpy_server
from .models.scenario import ScenarioResult

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)


async def _reconnect_loop():
    """백그라운드: 끊어진 디바이스 주기적 재연결 시도 (5초 간격)."""
    while True:
        await asyncio.sleep(5)
        try:
            await device_manager.reconnect_disconnected()
        except Exception as e:
            logger.debug("Reconnect loop error: %s", e)


async def _get_monitor_status() -> dict:
    """관제 서버에 보낼 현재 상태를 수집."""
    # 활동 상태 판별
    activity = "idle"
    if playback_service.is_running:
        activity = "playing"
    elif recording_service.is_recording:
        activity = "recording"

    # 디바이스 목록
    devices = []
    for dev in device_manager.list_devices():
        devices.append({
            "device_id": dev.id,
            "name": dev.info.get("name", dev.id),
            "type": dev.type,
            "status": "connected" if dev.is_connected else "disconnected",
        })

    # 재생 진행 상태
    playback = None
    if playback_service.is_running and hasattr(playback_service, '_monitor_state'):
        ms = playback_service._monitor_state
        playback = {
            "scenario_name": ms.get("scenario_name", ""),
            "current_cycle": ms.get("current_cycle", 0),
            "total_cycles": ms.get("total_cycles", 0),
            "current_step": ms.get("current_step", 0),
            "total_steps": ms.get("total_steps", 0),
            "status": "paused" if playback_service.is_paused else "running",
            "passed": ms.get("passed", 0),
            "failed": ms.get("failed", 0),
            "warning": ms.get("warning", 0),
            "error": ms.get("error", 0),
        }

    # 시나리오 목록
    try:
        scenarios = await recording_service.list_scenarios()
    except Exception:
        scenarios = []

    return {
        "activity": activity,
        "devices": devices,
        "playback": playback,
        "scenarios": scenarios,
    }


async def _handle_monitor_command(cmd: dict) -> dict | None:
    """관제 서버에서 수신한 원격 명령 처리."""
    action = cmd.get("action", "")

    if action == "list_scenarios":
        scenarios = await recording_service.list_scenarios()
        return {"action": "list_scenarios", "scenarios": scenarios}

    elif action == "stop":
        if playback_service.is_running:
            await playback_service.stop()
            return {"action": "stop", "result": "ok"}
        return {"action": "stop", "result": "not_running"}

    elif action == "pause":
        if playback_service.is_running:
            await playback_service.pause()
            return {"action": "pause", "result": "ok"}
        return {"action": "pause", "result": "not_running"}

    elif action == "resume":
        if playback_service.is_running:
            await playback_service.resume()
            return {"action": "resume", "result": "ok"}
        return {"action": "resume", "result": "not_running"}

    elif action == "play":
        scenario_name = cmd.get("scenario", "")
        repeat = cmd.get("repeat", 1)
        verify = cmd.get("verify", True)
        if not scenario_name:
            return {"action": "play", "result": "error", "message": "scenario required"}
        if playback_service.is_running:
            return {"action": "play", "result": "error", "message": "already_running"}

        # 비동기로 재생 시작 (백그라운드)
        asyncio.create_task(_remote_play(scenario_name, repeat, verify))
        return {"action": "play", "result": "started", "scenario": scenario_name}

    return None


async def _remote_play(scenario_name: str, repeat: int, verify: bool):
    """원격 재생 명령 실행 (백그라운드)."""
    try:
        logger.info("원격 재생 시작: %s (repeat=%d, verify=%s)", scenario_name, repeat, verify)
        scen = await recording_service.load_scenario(scenario_name)

        # Preflight device check
        preflight_errors = await playback_service.preflight_check(scen)
        if preflight_errors:
            logger.error("원격 재생 preflight 실패: %s", preflight_errors)
            # 에러를 monitor_state에 기록하여 대시보드에서 확인 가능
            playback_service._monitor_state = {
                "scenario_name": scenario_name,
                "total_cycles": repeat, "current_cycle": 0,
                "current_step": 0, "total_steps": len(scen.steps),
                "status": "error",
                "passed": 0, "failed": 0, "warning": 0, "error": 0,
                "error_message": "; ".join(preflight_errors),
            }
            return

        playback_service._should_stop = False
        playback_service._pause_event.set()
        playback_service._monitor_state = {
            "scenario_name": scenario_name,
            "total_cycles": repeat,
            "current_cycle": 0,
            "current_step": 0,
            "total_steps": len(scen.steps),
            "passed": 0, "failed": 0, "warning": 0, "error": 0,
        }

        result = ScenarioResult(
            scenario_name=scenario_name,
            device_serial="multi-device",
            status="pass",
            total_steps=len(scen.steps),
            total_repeat=repeat,
            started_at=datetime.now(timezone.utc).isoformat(),
        )

        for iteration in range(1, repeat + 1):
            playback_service._monitor_state["current_cycle"] = iteration
            step_idx = 0
            async for item in playback_service.execute_scenario_stream(scen, verify=verify, repeat_index=iteration):
                if isinstance(item, dict) and item.get("_type") == "step_start":
                    step_idx += 1
                    playback_service._monitor_state["current_step"] = step_idx
                else:
                    step_result = item
                    result.step_results.append(step_result)
                    if step_result.status == "pass":
                        result.passed_steps += 1
                        playback_service._monitor_state["passed"] += 1
                    elif step_result.status == "fail":
                        result.failed_steps += 1
                        playback_service._monitor_state["failed"] += 1
                    elif step_result.status == "warning":
                        result.warning_steps += 1
                        playback_service._monitor_state["warning"] += 1
                    else:
                        result.error_steps += 1
                        playback_service._monitor_state["error"] += 1

            if playback_service._should_stop:
                break

        result.finished_at = datetime.now(timezone.utc).isoformat()
        if result.failed_steps > 0 or result.error_steps > 0:
            result.status = "fail"
        elif result.warning_steps > 0:
            result.status = "warning"
        else:
            result.status = "pass"
        await playback_service._save_result(result)
        logger.info("원격 재생 완료: %s → %s", scenario_name, result.status)
    except Exception as e:
        logger.error("원격 재생 오류: %s", e, exc_info=True)
        if hasattr(playback_service, '_monitor_state'):
            playback_service._monitor_state["error_message"] = str(e)
    finally:
        if hasattr(playback_service, '_monitor_state'):
            playback_service._monitor_state["status"] = "idle"


@asynccontextmanager
async def _auto_connect_all():
    """서버 시작 후 등록된 모든 디바이스를 백그라운드에서 자동 연결."""
    await asyncio.sleep(2)  # 서버 안정화 대기
    all_devices = device_manager.list_all()
    if not all_devices:
        return
    logger.info("백그라운드 자동 연결 시작: %d개 디바이스", len(all_devices))
    for dev in all_devices:
        try:
            msg = await device_manager.connect_device_by_id(dev.id)
            logger.info("자동 연결: %s", msg)
        except Exception as e:
            logger.debug("자동 연결 실패 %s: %s", dev.id, e)


async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    # --- Startup ---
    reconnect_task = asyncio.create_task(_reconnect_loop())
    auto_connect_task = asyncio.create_task(_auto_connect_all())

    # 관제 클라이언트 콜백 항상 등록 (URL은 나중에 Settings에서 설정 가능)
    monitor_client.set_status_callback(_get_monitor_status)
    monitor_client.set_command_callback(_handle_monitor_command)
    try:
        from .routers.settings import _load as _load_settings
        cfg = _load_settings()
        monitor_url = cfg.get("monitor_server_url", "")
        if monitor_url:
            await monitor_client.start(monitor_url)
    except Exception as e:
        logger.debug("Monitor client startup: %s", e)

    yield
    # --- Shutdown ---
    await monitor_client.stop()
    reconnect_task.cancel()
    auto_connect_task.cancel()
    scrcpy_manager.stop_all()
    logger.info("Closing all serial connections...")
    device_manager.close_all_serial_connections()
    logger.info("Killing ADB server...")
    try:
        await adb_service._run("kill-server")
    except Exception as e:
        logger.debug("ADB kill-server: %s", e)


app = FastAPI(
    title="ReplayKit",
    description="녹화(Record) → 재생(Playback) → 검증(Verify) 웹 기반 자동화 도구",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — allow React dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(device.router)
app.include_router(scenario.router)
app.include_router(results.router)
app.include_router(settings.router)

# Serve screenshots statically
screenshots_dir = Path(__file__).resolve().parent.parent / "screenshots"
screenshots_dir.mkdir(parents=True, exist_ok=True)
app.mount("/screenshots", StaticFiles(directory=str(screenshots_dir)), name="screenshots")

recordings_dir = Path(__file__).resolve().parent.parent.parent / "Results" / "Video"
recordings_dir.mkdir(parents=True, exist_ok=True)
app.mount("/recordings", StaticFiles(directory=str(recordings_dir)), name="recordings")

# Serve docs (user guide)
_docs_dir = Path(__file__).resolve().parent.parent.parent / "docs"
if _docs_dir.is_dir():
    app.mount("/docs", StaticFiles(directory=str(_docs_dir), html=True), name="docs")

@app.get("/api/health")
async def health_check():
    return {"status": "ok"}


# 프로덕션: frontend/dist 정적 파일 서빙 (Vite 빌드 결과)
# 반드시 모든 API 라우트 등록 후 마지막에 추가 (catch-all)
_frontend_dist = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if _frontend_dist.is_dir():
    from starlette.responses import FileResponse as _FR

    @app.get("/{path:path}")
    async def _serve_frontend(path: str):
        file = _frontend_dist / path
        if file.is_file():
            return _FR(str(file))
        # SPA fallback: index.html
        return _FR(str(_frontend_dist / "index.html"))


@app.get("/")
async def root():
    return {
        "app": "ReplayKit",
        "version": "0.1.0",
        "docs": "/docs",
    }


@app.websocket("/ws/screen")
async def websocket_screen_mirror(websocket: WebSocket):
    """WebSocket endpoint for real-time screen mirroring.

    클라이언트가 첫 메시지로 {"device_id": "...", "screen_type": "front_center"} 전송.
    H.264 모드: scrcpy → binary H.264 NAL 전송 + 양방향 컨트롤 (터치/키)
    JPEG 모드: JPEG 프레임 전송 (HKMC, VisionCamera, screencap 폴백)
    """
    await websocket.accept()
    logger.debug("Screen mirror WebSocket connected")

    # 클라이언트로부터 device_id 수신 (선택)
    target_device_id = ""
    screen_type = "front_center"
    force_h264 = False
    try:
        init_msg = await asyncio.wait_for(websocket.receive_json(), timeout=2.0)
        target_device_id = init_msg.get("device_id", "")
        screen_type = init_msg.get("screen_type", "front_center")
        force_h264 = init_msg.get("force_h264", False)
    except (asyncio.TimeoutError, Exception):
        pass  # 타임아웃이면 ADB 폴백

    # 디바이스 타입 판별
    dev = device_manager.get_device(target_device_id) if target_device_id else None
    is_hkmc = dev and dev.type == "hkmc6th"
    is_vision_camera = dev and dev.type == "vision_camera"

    dev_type_label = "hkmc" if is_hkmc else ("vision_camera" if is_vision_camera else "adb")
    logger.debug("Screen mirror: device=%s type=%s", target_device_id, dev_type_label)

    # ADB scrcpy 스트림 참조 (정리용)
    scrcpy_stream = None
    scrcpy_serial = ""
    scrcpy_display = 0
    h264_mode = False
    recv_task = None  # finally에서 참조하므로 try 밖에서 초기화

    try:
        # ADB 디바이스: scrcpy 스트림 획득 시도
        if not is_hkmc and not is_vision_camera and dev:
            adb_display_id = 0
            try:
                adb_display_id = int(screen_type)
            except (ValueError, TypeError):
                pass
            scrcpy_serial = dev.address or target_device_id
            scrcpy_display = adb_display_id
            # force_h264: scrcpy-server만 있으면 PyAV 없이도 H.264 raw 스트리밍
            if force_h264 and _find_scrcpy_server() is not None:
                from .services.scrcpy_service import ScrcpyStream
                stream = ScrcpyStream(serial=scrcpy_serial, display_id=scrcpy_display)
                stream.start(asyncio.get_event_loop())
                # 첫 데이터 대기
                for _ in range(50):
                    if stream.is_running and (stream._h264_queue and not stream._h264_queue.empty()):
                        break
                    if not stream.is_running:
                        break
                    await asyncio.sleep(0.1)
                if stream.is_running:
                    scrcpy_stream = stream
                    logger.info("scrcpy H.264 raw stream forced for %s", scrcpy_serial)
                else:
                    logger.warning("scrcpy force_h264 failed for %s", scrcpy_serial)
            else:
                scrcpy_stream = await scrcpy_manager.acquire_stream(
                    serial=scrcpy_serial, display_id=scrcpy_display
                )
            if scrcpy_stream:
                logger.info("scrcpy stream acquired for %s (display=%d)", scrcpy_serial, scrcpy_display)
            else:
                logger.debug("scrcpy unavailable for %s, falling back to screencap", scrcpy_serial)

        # 모드 협상: force_h264일 때만 H.264 raw, 기본은 JPEG
        if force_h264 and scrcpy_stream and scrcpy_stream.is_running:
            h264_mode = True
            await websocket.send_json({
                "mode": "h264",
                "width": scrcpy_stream._video_width or 1080,
                "height": scrcpy_stream._video_height or 1920,
            })
        else:
            await websocket.send_json({"mode": "jpeg"})

        # H.264 모드: 컨트롤 수신 태스크 + 프레임 송신
        async def _receive_control():
            """클라이언트로부터 컨트롤 메시지 수신 (터치/키)."""
            try:
                while True:
                    raw = await websocket.receive_text()
                    try:
                        import json
                        msg = json.loads(raw)
                    except Exception:
                        continue
                    msg_type = msg.get("type")
                    if msg_type == "touch" and scrcpy_stream:
                        scrcpy_stream.inject_touch(
                            action=msg.get("action", 0),
                            x=msg.get("x", 0),
                            y=msg.get("y", 0),
                            width=msg.get("w", 1080),
                            height=msg.get("h", 1920),
                        )
                    elif msg_type == "key" and scrcpy_stream:
                        scrcpy_stream.inject_keycode(
                            keycode=msg.get("keycode", 0),
                            action=msg.get("action", 0),
                        )
            except WebSocketDisconnect:
                pass
            except Exception:
                pass

        if h264_mode:
            recv_task = asyncio.create_task(_receive_control())

        while True:
            try:
                # 매 프레임마다 최신 서비스 인스턴스 조회 (재연결 대응)
                hkmc = device_manager.get_hkmc_service(target_device_id) if is_hkmc else None
                if hkmc and hkmc.is_connected:
                    jpeg_bytes = await hkmc.async_screencap_bytes(
                        screen_type=screen_type, fmt="jpeg", timeout=3.0
                    )
                    await websocket.send_bytes(jpeg_bytes)
                elif is_hkmc:
                    # HKMC 재연결 대기 중 — 빈 프레임 대신 잠시 대기
                    await asyncio.sleep(0.3)
                    continue
                elif is_vision_camera:
                    cam = device_manager.get_vision_camera(target_device_id)
                    if cam and cam.IsConnected():
                        try:
                            loop = asyncio.get_event_loop()
                            jpeg_bytes = await loop.run_in_executor(
                                None, cam.CaptureBytes, "jpeg"
                            )
                            logger.debug("VisionCam frame: %d bytes", len(jpeg_bytes))
                            await websocket.send_bytes(jpeg_bytes)
                        except RuntimeError as ve:
                            if "No frame available" in str(ve):
                                logger.debug("VisionCamera: waiting for first frame...")
                            else:
                                logger.error("VisionCamera capture error: %s", ve)
                            await asyncio.sleep(0.3)
                            continue
                    else:
                        logger.warning("VisionCam not ready: cam=%s connected=%s",
                                       cam is not None, cam.IsConnected() if cam else "no_cam")
                        await asyncio.sleep(0.3)
                        continue
                elif h264_mode and scrcpy_stream and scrcpy_stream.is_running:
                    # scrcpy H.264 raw NAL 전송 (브라우저 MSE 디코딩)
                    h264_data = await scrcpy_stream.async_get_h264_frame(timeout=0.5)
                    if h264_data:
                        await websocket.send_bytes(h264_data)
                    continue  # async_get_h264_frame이 블로킹, sleep 불필요
                elif scrcpy_stream and scrcpy_stream.is_running:
                    # scrcpy JPEG 폴백 — async_wait_frame이 새 프레임까지 블로킹
                    jpeg_bytes = await scrcpy_stream.async_wait_frame(timeout=2.0)
                    if jpeg_bytes:
                        await websocket.send_bytes(jpeg_bytes)
                    continue
                else:
                    # ADB screencap 폴백 — binary JPEG로 전송
                    adb_display_id = None
                    try:
                        adb_display_id = int(screen_type)
                    except (ValueError, TypeError):
                        pass
                    sf_did = resolve_sf_display_id(
                        dev.info if dev else None, adb_display_id
                    )
                    adb_serial = dev.address if dev else target_device_id
                    png_bytes = await adb_service.screencap_bytes(
                        serial=adb_serial or None, sf_display_id=sf_did
                    )
                    # PNG → JPEG 변환하여 binary 전송 (프론트엔드 Blob 핸들러 통합)
                    try:
                        from PIL import Image as _PILImage
                        import io as _io
                        img = _PILImage.open(_io.BytesIO(png_bytes))
                        if img.mode == "RGBA":
                            img = img.convert("RGB")
                        buf = _io.BytesIO()
                        img.save(buf, format="JPEG", quality=85)
                        await websocket.send_bytes(buf.getvalue())
                    except Exception:
                        # PIL 없으면 기존 JSON base64 방식 폴백
                        b64 = base64.b64encode(png_bytes).decode("ascii")
                        await websocket.send_json({
                            "type": "frame",
                            "image": b64,
                            "format": "png",
                        })
            except WebSocketDisconnect:
                raise
            except Exception as e:
                try:
                    await websocket.send_json({
                        "type": "error",
                        "message": str(e),
                    })
                except Exception:
                    # 클라이언트 이미 끊김 — 루프 탈출
                    break
                await asyncio.sleep(0.3)
                continue
            await asyncio.sleep(0)  # 이벤트 루프 양보 (각 소스가 자체 속도로 전송)
    except (WebSocketDisconnect, Exception) as exc:
        if isinstance(exc, WebSocketDisconnect):
            logger.info("Screen mirror WebSocket disconnected")
        else:
            logger.warning("Screen mirror WebSocket error: %s", exc)
    finally:
        # 컨트롤 수신 태스크 정리
        if recv_task and not recv_task.done():
            recv_task.cancel()
        # scrcpy 스트림 해제
        if scrcpy_stream:
            scrcpy_manager.release_stream(scrcpy_serial, scrcpy_display)


@app.websocket("/ws/playback")
async def websocket_playback(websocket: WebSocket):
    """WebSocket endpoint for streaming playback results step by step."""
    await websocket.accept()
    logger.info("Playback WebSocket connected")

    # 재생 중 stop 메시지를 수신하기 위한 리스너 태스크
    stop_listener_task: asyncio.Task | None = None

    async def _listen_for_stop():
        """재생 중 WebSocket에서 stop/pause/resume 명령을 대기."""
        try:
            while True:
                msg = await websocket.receive_json()
                cmd = msg.get("action")
                if cmd == "stop":
                    await playback_service.stop()
                    logger.info("Stop command received during playback")
                    return
                elif cmd == "pause":
                    await playback_service.pause()
                    await websocket.send_json({"type": "playback_paused"})
                    logger.info("Playback paused")
                elif cmd == "resume":
                    await playback_service.resume()
                    await websocket.send_json({"type": "playback_resumed"})
                    logger.info("Playback resumed")
        except Exception:
            pass

    try:
        while True:
            data = await websocket.receive_json()
            action = data.get("action")

            if action == "play":
                scenario_name = data.get("scenario")
                verify = data.get("verify", True)
                repeat = data.get("repeat", 1)
                device_map_override = data.get("device_map")  # optional override from frontend
                skip_steps: set[int] = set(data.get("skip_steps", []))
                try:
                    if playback_service.is_running:
                        await websocket.send_json({"type": "error", "message": "이미 재생 중입니다"})
                        continue
                    playback_service._should_stop = False
                    playback_service._pause_event.set()
                    stop_listener_task = asyncio.create_task(_listen_for_stop())

                    scen = await recording_service.load_scenario(scenario_name)

                    # 스킵할 스텝 제거
                    if skip_steps:
                        scen.steps = [s for s in scen.steps if s.id not in skip_steps]

                    # Preflight device check
                    preflight_errors = await playback_service.preflight_check(scen, device_map_override)
                    if preflight_errors:
                        await websocket.send_json({
                            "type": "preflight_error",
                            "errors": preflight_errors,
                        })
                        continue

                    # 관제 모니터링 상태 초기화
                    playback_service._monitor_state = {
                        "scenario_name": scenario_name,
                        "total_cycles": repeat,
                        "current_cycle": 0,
                        "current_step": 0,
                        "total_steps": len(scen.steps),
                        "passed": 0, "failed": 0, "warning": 0, "error": 0,
                    }

                    # Single result for ALL cycles
                    result = ScenarioResult(
                        scenario_name=scenario_name,
                        device_serial="multi-device",
                        status="pass",
                        total_steps=len(scen.steps),
                        total_repeat=repeat,
                        started_at=datetime.now(timezone.utc).isoformat(),
                    )

                    for iteration in range(1, repeat + 1):
                        playback_service._monitor_state["current_cycle"] = iteration
                        if repeat > 1:
                            await websocket.send_json({
                                "type": "iteration_start",
                                "iteration": iteration,
                                "total": repeat,
                            })

                        _step_idx = 0
                        async for item in playback_service.execute_scenario_stream(scen, verify=verify, repeat_index=iteration, device_map_override=device_map_override):
                            if isinstance(item, dict) and item.get("_type") == "step_start":
                                _step_idx += 1
                                playback_service._monitor_state["current_step"] = _step_idx
                                await websocket.send_json({
                                    "type": "step_start",
                                    "data": {k: v for k, v in item.items() if k != "_type"},
                                    "iteration": iteration,
                                })
                            else:
                                step_result = item
                                result.step_results.append(step_result)
                                if step_result.status == "pass":
                                    result.passed_steps += 1
                                    playback_service._monitor_state["passed"] += 1
                                elif step_result.status == "fail":
                                    result.failed_steps += 1
                                    playback_service._monitor_state["failed"] += 1
                                elif step_result.status == "warning":
                                    result.warning_steps += 1
                                    playback_service._monitor_state["warning"] += 1
                                else:
                                    result.error_steps += 1
                                    playback_service._monitor_state["error"] += 1
                                await websocket.send_json({
                                    "type": "step_result",
                                    "data": step_result.model_dump(),
                                    "iteration": iteration,
                                })

                        if playback_service._should_stop:
                            break

                    # Determine overall status and save once
                    result.finished_at = datetime.now(timezone.utc).isoformat()
                    if result.failed_steps > 0 or result.error_steps > 0:
                        result.status = "fail"
                    elif result.warning_steps > 0:
                        result.status = "warning"
                    else:
                        result.status = "pass"
                    result_path = await playback_service._save_result(result)

                    if playback_service._should_stop:
                        await websocket.send_json({"type": "playback_stopped", "result_filename": Path(result_path).name})
                    else:
                        await websocket.send_json({"type": "playback_complete", "result_filename": Path(result_path).name})
                except Exception as e:
                    await websocket.send_json({"type": "error", "message": str(e)})
                finally:
                    if stop_listener_task and not stop_listener_task.done():
                        stop_listener_task.cancel()
                        try:
                            await stop_listener_task
                        except (asyncio.CancelledError, Exception):
                            pass
                        stop_listener_task = None

            elif action == "play_group":
                # Play scenarios in a group with conditional jump support
                group_members = data.get("scenarios", [])  # list[str] or list[dict]
                verify = data.get("verify", True)
                repeat = data.get("repeat", 1)
                device_map_override = data.get("device_map")

                # Normalize to list[dict] for jump support
                entries: list[dict] = []
                for m in group_members:
                    if isinstance(m, str):
                        entries.append({"name": m, "on_pass_goto": None, "on_fail_goto": None})
                    else:
                        entries.append(m)

                try:
                    if playback_service.is_running:
                        await websocket.send_json({"type": "error", "message": "이미 재생 중입니다"})
                        continue
                    playback_service._should_stop = False
                    playback_service._pause_event.set()
                    stop_listener_task = asyncio.create_task(_listen_for_stop())

                    # Preflight: check all scenarios in the group
                    all_preflight_errors: list[str] = []
                    for entry in entries:
                        try:
                            scen = await recording_service.load_scenario(entry["name"])
                            errs = await playback_service.preflight_check(scen)
                            for e in errs:
                                msg = f"[{entry['name']}] {e}"
                                if msg not in all_preflight_errors:
                                    all_preflight_errors.append(msg)
                        except FileNotFoundError:
                            all_preflight_errors.append(f"시나리오 '{entry['name']}'을(를) 찾을 수 없습니다")
                    if all_preflight_errors:
                        await websocket.send_json({
                            "type": "preflight_error",
                            "errors": all_preflight_errors,
                        })
                        continue

                    saved_result_filenames: list[str] = []
                    sc_idx = 0
                    start_step = 0  # step index to start from within current scenario
                    while sc_idx < len(entries):
                        if playback_service._should_stop:
                            break
                        entry = entries[sc_idx]
                        sc_name = entry["name"]
                        scen = await recording_service.load_scenario(sc_name)
                        await websocket.send_json({
                            "type": "group_scenario_start",
                            "scenario_name": sc_name,
                            "scenario_index": sc_idx + 1,
                            "total_scenarios": len(entries),
                            "start_step": start_step,
                        })

                        result = ScenarioResult(
                            scenario_name=sc_name,
                            device_serial="multi-device",
                            status="pass",
                            total_steps=len(scen.steps),
                            total_repeat=repeat,
                            started_at=datetime.now(timezone.utc).isoformat(),
                        )

                        step_jumps = entry.get("step_jumps", {})
                        step_jump_target = None  # set if a step-level jump fires

                        for iteration in range(1, repeat + 1):
                            if repeat > 1:
                                await websocket.send_json({
                                    "type": "iteration_start",
                                    "iteration": iteration,
                                    "total": repeat,
                                })
                            async for step_result in playback_service.execute_scenario_stream(scen, verify=verify, repeat_index=iteration, start_step=start_step, device_map_override=device_map_override):
                                result.step_results.append(step_result)
                                if step_result.status == "pass":
                                    result.passed_steps += 1
                                elif step_result.status == "fail":
                                    result.failed_steps += 1
                                elif step_result.status == "warning":
                                    result.warning_steps += 1
                                else:
                                    result.error_steps += 1
                                await websocket.send_json({
                                    "type": "step_result",
                                    "data": step_result.model_dump(),
                                    "iteration": iteration,
                                    "scenario_name": sc_name,
                                })

                                # Check step-level jumps (keyed by step_id)
                                sj = step_jumps.get(str(step_result.step_id))
                                if sj:
                                    if step_result.status in ("pass", "warning"):
                                        sj_jump = sj.get("on_pass_goto")
                                    else:
                                        sj_jump = sj.get("on_fail_goto")
                                    if sj_jump is not None:
                                        step_jump_target = sj_jump
                                        break  # break out of step stream

                            if step_jump_target or playback_service._should_stop:
                                break

                        result.finished_at = datetime.now(timezone.utc).isoformat()
                        if result.failed_steps > 0 or result.error_steps > 0:
                            result.status = "fail"
                        elif result.warning_steps > 0:
                            result.status = "warning"
                        else:
                            result.status = "pass"
                        result_path = await playback_service._save_result(result)
                        saved_result_filenames.append(Path(result_path).name)

                        if playback_service._should_stop:
                            break

                        # Determine jump target: step-level takes priority over scenario-level
                        next_idx = sc_idx + 1
                        start_step = 0  # reset for next scenario
                        jump = None

                        if step_jump_target is not None:
                            jump = step_jump_target
                        else:
                            # Scenario-level conditional jump
                            if result.status in ("pass", "warning"):
                                jump = entry.get("on_pass_goto")
                            else:
                                jump = entry.get("on_fail_goto")

                        if jump is not None:
                            if isinstance(jump, dict):
                                target_sc = jump.get("scenario", -1)
                                target_step = jump.get("step", 0)
                            else:
                                target_sc = jump
                                target_step = 0
                            if target_sc == -1:
                                break  # END
                            next_idx = target_sc
                            start_step = target_step

                        sc_idx = next_idx

                    rf = saved_result_filenames[-1] if saved_result_filenames else ""
                    if playback_service._should_stop:
                        await websocket.send_json({"type": "playback_stopped", "result_filename": rf})
                    else:
                        await websocket.send_json({"type": "playback_complete", "result_filename": rf})
                except Exception as e:
                    await websocket.send_json({"type": "error", "message": str(e)})
                finally:
                    if stop_listener_task and not stop_listener_task.done():
                        stop_listener_task.cancel()
                        try:
                            await stop_listener_task
                        except (asyncio.CancelledError, Exception):
                            pass
                        stop_listener_task = None

            elif action == "stop":
                # 재생 시작 전 stop이 올 경우 (리스너 태스크 없을 때)
                await playback_service.stop()
                await websocket.send_json({"type": "playback_stopped"})

    except WebSocketDisconnect:
        logger.info("Playback WebSocket disconnected")
