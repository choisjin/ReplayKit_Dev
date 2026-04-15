"""ReplayKit — FastAPI Backend."""

from __future__ import annotations

import asyncio
import base64
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from .routers import device, results, scenario, settings, webcam
from .dependencies import adb_service, device_manager, playback_service, recording_service, monitor_client
from .services.adb_service import resolve_sf_display_id
from .models.scenario import ScenarioResult
from .services.playback_service import RESULTS_DIR as _RESULTS_DIR


def _result_filename(result_path: str) -> str:
    """결과 파일 절대경로 → RESULTS_DIR 기준 상대경로 (예: '20260401_091200_scen/result.json' 또는 'scen_20260401.json')."""
    try:
        return str(Path(result_path).relative_to(_RESULTS_DIR)).replace("\\", "/")
    except ValueError:
        return Path(result_path).name

import os as _os
from logging.handlers import TimedRotatingFileHandler as _TRFH

_log_fmt = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_log_dir = Path(_os.environ.get("RECORDING_PROJECT_ROOT", str(Path(__file__).resolve().parent.parent.parent))) / "logs"
_log_dir.mkdir(exist_ok=True)

_file_handler = _TRFH(
    str(_log_dir / "backend.log"),
    when="midnight", backupCount=7, encoding="utf-8",
)
_file_handler.setFormatter(logging.Formatter(_log_fmt))

logging.basicConfig(level=logging.INFO, format=_log_fmt, handlers=[
    logging.StreamHandler(),  # 콘솔 (런처가 캡처)
    _file_handler,            # 파일 (날짜별 자동 로테이션)
])
logger = logging.getLogger(__name__)


async def _reconnect_loop():
    """백그라운드: 끊어진 디바이스 주기적 재연결 시도 (5초 간격).
    재생 중에는 상태 확인만 수행 (파괴적 명령 스킵).
    """
    while True:
        await asyncio.sleep(5)
        try:
            await device_manager.reconnect_disconnected(passive=playback_service.is_running)
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
                    else:
                        result.error_steps += 1
                        playback_service._monitor_state["error"] += 1

            if playback_service._should_stop:
                break

        result.finished_at = datetime.now(timezone.utc).isoformat()
        if result.failed_steps > 0 or result.error_steps > 0:
            result.status = "fail"
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    # --- Startup ---
    # ADB 서버를 명시적으로 미리 시작 (CREATE_NO_WINDOW 포함)
    # adb가 자체적으로 데몬을 spawn하면 별도 콘솔 창이 생길 수 있으므로 선제 실행
    try:
        await adb_service._run("start-server")
        logger.info("ADB server pre-started")
    except Exception as e:
        logger.debug("ADB server pre-start: %s", e)

    reconnect_task = asyncio.create_task(_reconnect_loop())

    # 저장된 SSH 디바이스를 시작 시 자동 재연결 시도 (메모리 전용 연결이므로 재시작 시 복구)
    try:
        ssh_devices = [d for d in device_manager.list_all() if d.type == "ssh"]
        for dev in ssh_devices:
            try:
                msg = await device_manager.connect_device_by_id(dev.id)
                logger.info("SSH auto-reconnect on startup: %s", msg)
            except Exception as e:
                logger.warning("SSH auto-reconnect failed for %s: %s", dev.id, e)
    except Exception as e:
        logger.debug("SSH startup reconnect sweep: %s", e)

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
app.include_router(webcam.router)

# Serve screenshots statically
screenshots_dir = Path(__file__).resolve().parent.parent / "screenshots"
screenshots_dir.mkdir(parents=True, exist_ok=True)
app.mount("/screenshots", StaticFiles(directory=str(screenshots_dir)), name="screenshots")

recordings_dir = Path(__file__).resolve().parent.parent.parent / "Results" / "Video"
recordings_dir.mkdir(parents=True, exist_ok=True)
app.mount("/recordings", StaticFiles(directory=str(recordings_dir)), name="recordings")

# 런 폴더 내 파일 접근 (logs, recordings 등)
results_dir = Path(__file__).resolve().parent.parent / "results"
results_dir.mkdir(parents=True, exist_ok=True)
app.mount("/results-files", StaticFiles(directory=str(results_dir)), name="results-files")

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
    JPEG screencap 기반 화면 스트리밍.
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
    is_isap = dev and dev.type == "isap_agent"
    is_vision_camera = dev and dev.type == "vision_camera"
    is_webcam = dev and dev.type == "webcam"

    dev_type_label = (
        "hkmc" if is_hkmc else
        ("isap" if is_isap else
         ("vision_camera" if is_vision_camera else
          ("webcam" if is_webcam else "adb"))))
    logger.debug("Screen mirror: device=%s type=%s", target_device_id, dev_type_label)

    # scrcpy 제거 — 항상 JPEG screencap 사용
    h264_mode = False
    recv_task = None

    try:
        await websocket.send_json({"mode": "jpeg"})

        while True:
            try:
                # 매 프레임마다 최신 서비스 인스턴스 조회 (재연결 대응)
                hkmc = device_manager.get_hkmc_service(target_device_id) if is_hkmc else None
                isap = device_manager.get_isap_service(target_device_id) if is_isap else None
                if hkmc and hkmc.is_connected:
                    jpeg_bytes = await hkmc.async_screencap_bytes(
                        screen_type=screen_type, fmt="jpeg", timeout=3.0
                    )
                    await websocket.send_bytes(jpeg_bytes)
                elif is_hkmc:
                    # HKMC 재연결 대기 중 — 빈 프레임 대신 잠시 대기
                    await asyncio.sleep(0.3)
                    continue
                elif isap and isap.is_connected:
                    jpeg_bytes = await isap.async_screencap_bytes(
                        screen_type=screen_type, fmt="jpeg", timeout=3.0
                    )
                    await websocket.send_bytes(jpeg_bytes)
                elif is_isap:
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
                elif is_webcam:
                    cam = device_manager.get_webcam_device(target_device_id)
                    if cam and cam.IsConnected():
                        try:
                            loop = asyncio.get_event_loop()
                            jpeg_bytes = await loop.run_in_executor(
                                None, cam.CaptureBytes, "jpeg"
                            )
                            await websocket.send_bytes(jpeg_bytes)
                        except RuntimeError as we:
                            logger.debug("Webcam capture error: %s", we)
                            await asyncio.sleep(0.3)
                            continue
                    else:
                        logger.warning("Webcam not ready: cam=%s connected=%s",
                                       cam is not None, cam.IsConnected() if cam else "no_cam")
                        await asyncio.sleep(0.3)
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
        if recv_task and not recv_task.done():
            recv_task.cancel()


# 현재 백그라운드 재생 태스크 (단일 재생만 허용)
_playback_bg_task: asyncio.Task | None = None


class _WebcamPlaybackSession:
    """재생 1회 동안의 웹캠 녹화 컨텍스트.

    멀티 사이클 시 cycle별로 stop+start 하면서 임시 파일들을 누적했다가
    재생 종료 시 결과 폴더의 recordings/ 안으로 일괄 이동한다.
    """
    def __init__(self) -> None:
        self.temp_dir: Optional[Path] = None
        self.cycle_files: list[tuple[int, Path]] = []  # (iteration, temp file path)
        self.current_cycle: int = 0
        self.current_path: Optional[Path] = None

    def is_active(self) -> bool:
        return self.temp_dir is not None


async def _webcam_session_start(iteration: int = 1) -> Optional[_WebcamPlaybackSession]:
    """첫 cycle의 녹화를 시작 + 세션 객체 반환. 웹캠 미오픈 시 None.

    start_recording()이 카메라 초기화/코덱 세팅에서 blocking 가능 → thread 이전.
    """
    try:
        from .services.webcam_service import get_webcam_service
        svc = get_webcam_service()
        if not svc.is_open():
            return None
        ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        session = _WebcamPlaybackSession()
        session.temp_dir = _RESULTS_DIR / f"_tmp_webcam_{ts}"
        session.temp_dir.mkdir(parents=True, exist_ok=True)
        path = session.temp_dir / f"webcam_r{iteration}.mp4"
        started = await asyncio.to_thread(svc.start_recording, str(path))
        if not started:
            return None
        session.current_cycle = iteration
        session.current_path = path
        logger.info("Webcam session started: cycle %d → %s", iteration, path)
        return session
    except Exception as e:
        logger.warning("Failed to start webcam session: %s", e)
        return None


def _try_move_cycle_to_final(iteration: int, src: Path) -> Optional[Path]:
    """완료된 cycle 녹화 파일을 가능한 경우 즉시 최종 recordings/ 위치로 이동한다.

    `_run_output_dir`이 설정되어 있지 않으면 (single-cycle 초기 등) None을 반환하여
    호출 측이 임시 경로를 그대로 유지하도록 한다.
    """
    try:
        from .services.playback_service import get_run_output_dir
        run_dir = get_run_output_dir()
        if run_dir is None:
            return None
        final_dir = run_dir / "recordings"
        final_dir.mkdir(parents=True, exist_ok=True)
        dst = final_dir / f"webcam_r{iteration}.mp4"
        if not src.exists():
            return None
        if src.resolve() == dst.resolve():
            return dst
        import shutil
        shutil.move(str(src), str(dst))
        logger.info("Webcam cycle %d published immediately: %s", iteration, dst)
        return dst
    except Exception as e:
        logger.warning("Failed to publish webcam cycle %d: %s", iteration, e)
        return None


async def _webcam_session_next_cycle(session: Optional[_WebcamPlaybackSession], iteration: int) -> None:
    """현재 cycle 녹화 종료 + 다음 cycle 녹화 시작.

    완료된 이전 cycle 파일은 즉시 `run_dir/recordings/`로 이동하여
    재생 중에도 결과 상세에서 해당 cycle의 영상을 조회할 수 있게 한다.

    stop_recording()은 코덱 finalize(프레임 flush, MP4 trailer 작성) 때문에
    수 초 단위 blocking이 가능하므로 thread로 이전하여 event loop를 지킨다.
    """
    if session is None or not session.is_active():
        return
    try:
        from .services.webcam_service import get_webcam_service
        svc = get_webcam_service()
        await asyncio.to_thread(svc.stop_recording)
        if session.current_path is not None:
            # 완료된 cycle 파일을 즉시 최종 위치로 이동 시도 (shutil.move = blocking)
            moved = await asyncio.to_thread(
                _try_move_cycle_to_final, session.current_cycle, session.current_path
            )
            session.cycle_files.append((session.current_cycle, moved or session.current_path))
        path = session.temp_dir / f"webcam_r{iteration}.mp4"  # type: ignore[union-attr]
        started = await asyncio.to_thread(svc.start_recording, str(path))
        if started:
            session.current_cycle = iteration
            session.current_path = path
            logger.info("Webcam session next cycle %d → %s", iteration, path)
        else:
            session.current_path = None
    except Exception as e:
        logger.warning("Failed to rotate webcam recording: %s", e)


def _webcam_session_finalize_sync(session: _WebcamPlaybackSession, result_path: Optional[str]) -> None:
    """Blocking 작업(stop/move/rmdir)을 모은 동기 함수. thread에서 실행."""
    try:
        from .services.webcam_service import get_webcam_service
        svc = get_webcam_service()
        svc.stop_recording()
        if session.current_path is not None:
            moved = _try_move_cycle_to_final(session.current_cycle, session.current_path)
            session.cycle_files.append((session.current_cycle, moved or session.current_path))
    except Exception as e:
        logger.warning("Failed to stop webcam session: %s", e)

    import shutil
    try:
        if not session.cycle_files:
            return
        if result_path:
            result_file = Path(result_path)
            if result_file.name == "result.json":
                run_dir = result_file.parent
            else:
                run_dir = result_file.parent / result_file.stem
                run_dir.mkdir(parents=True, exist_ok=True)
            final_dir = run_dir / "recordings"
            final_dir.mkdir(parents=True, exist_ok=True)
            for iteration, src in session.cycle_files:
                if not src.exists():
                    continue
                dst = final_dir / f"webcam_r{iteration}.mp4"
                try:
                    if src.resolve() == dst.resolve():
                        continue
                except Exception:
                    pass
                try:
                    shutil.move(str(src), str(dst))
                    logger.info("Webcam recording moved: %s → %s", src.name, dst)
                except Exception as e:
                    logger.warning("Failed to move %s: %s", src, e)
        else:
            logger.warning("Result path unknown — %d webcam files left at %s",
                           len(session.cycle_files), session.temp_dir)
            return
    except Exception as e:
        logger.warning("Failed to finalize webcam session: %s", e)
    finally:
        try:
            td = session.temp_dir
            if td and td.exists() and not any(td.iterdir()):
                td.rmdir()
        except Exception:
            pass


async def _webcam_session_finalize(session: Optional[_WebcamPlaybackSession], result_path: Optional[str]) -> None:
    """재생 종료 시 마지막 cycle 녹화 정지 + 남은 cycle 파일을 결과 폴더로 이동.

    cycle별 파일은 이미 `_webcam_session_next_cycle`에서 즉시 최종 위치로 옮겨져 있는 경우가 많으며,
    이 함수는 마지막(진행 중이던) cycle과 early-move가 실패했던 파일만 보완 이동한다.

    stop_recording + shutil.move 여러 번 = 수 초 블록 가능 → thread 이전.
    """
    if session is None or not session.is_active():
        return
    await asyncio.to_thread(_webcam_session_finalize_sync, session, result_path)


async def _run_play_job(data: dict):
    """백그라운드 태스크로 실행되는 play 로직. WebSocket과 무관하게 끝까지 실행된다.

    이벤트는 playback_service.publish_event를 통해 broadcaster에 전달되고,
    연결된 모든 WebSocket 구독자가 forward 태스크로 받아 전송한다.
    """
    from .services.playback_service import publish_event, clear_event_buffer, mark_playback_active
    scenario_name = data.get("scenario")
    verify = data.get("verify", True)
    repeat = data.get("repeat", 1)
    device_map_override = data.get("device_map")
    skip_steps: set[int] = set(data.get("skip_steps", []))
    _is_multi_cycle = False
    result_path: Optional[str] = None
    webcam_session: Optional[_WebcamPlaybackSession] = None
    try:
        playback_service._should_stop = False
        playback_service._pause_event.set()
        clear_event_buffer()
        mark_playback_active(True)
        publish_event({"type": "playback_reset", "scenario": scenario_name})
        # 웹캠 녹화 시작 (열려 있을 때만)
        webcam_session = await _webcam_session_start(iteration=1)

        scen = await recording_service.load_scenario(scenario_name)
        if skip_steps:
            scen.steps = [s for s in scen.steps if s.id not in skip_steps]

        preflight_errors = await playback_service.preflight_check(scen, device_map_override)
        if preflight_errors:
            publish_event({"type": "preflight_error", "errors": preflight_errors})
            return

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

        _is_multi_cycle = repeat > 1
        if _is_multi_cycle:
            playback_service._result_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            playback_service._setup_run_output_dir(scenario_name)

        global_step_seq = 0
        last_completed_iteration = 0
        for iteration in range(1, repeat + 1):
            playback_service._monitor_state["current_cycle"] = iteration
            if _is_multi_cycle:
                publish_event({
                    "type": "iteration_start",
                    "iteration": iteration,
                    "total": repeat,
                })
                # 두 번째 이상 cycle 시작 시 웹캠 녹화 분할 (rotate)
                if iteration > 1 and webcam_session is not None:
                    await _webcam_session_next_cycle(webcam_session, iteration)

            _step_idx = 0
            _pending_seq = 0
            async for item in playback_service.execute_scenario_stream(
                scen, verify=verify, repeat_index=iteration,
                device_map_override=device_map_override,
                group_scenario_index=iteration if _is_multi_cycle else 0,
            ):
                if isinstance(item, dict) and item.get("_type") == "step_start":
                    _step_idx += 1
                    playback_service._monitor_state["current_step"] = _step_idx
                    start_data = {k: v for k, v in item.items() if k != "_type"}
                    if _is_multi_cycle:
                        global_step_seq += 1
                        _pending_seq = global_step_seq
                        start_data["step_id"] = _pending_seq
                        start_data["description"] = f"[Cycle {iteration}] {start_data.get('description', '')}"
                    publish_event({
                        "type": "step_start",
                        "data": start_data,
                        "iteration": iteration,
                    })
                else:
                    step_result = item
                    if _is_multi_cycle:
                        step_result.step_id = _pending_seq
                        step_result.description = f"[Cycle {iteration}] {step_result.description}" if step_result.description else f"[Cycle {iteration}]"
                    result.step_results.append(step_result)
                    if step_result.status == "pass":
                        result.passed_steps += 1
                        playback_service._monitor_state["passed"] += 1
                    elif step_result.status == "fail":
                        result.failed_steps += 1
                        playback_service._monitor_state["failed"] += 1
                    else:
                        result.error_steps += 1
                        playback_service._monitor_state["error"] += 1
                    publish_event({
                        "type": "step_result",
                        "data": step_result.model_dump(),
                        "iteration": iteration,
                    })

            if playback_service._should_stop:
                break
            last_completed_iteration = iteration

            if _is_multi_cycle:
                _interim = ScenarioResult(
                    scenario_name=scenario_name,
                    device_serial="multi-device",
                    status="fail" if result.failed_steps > 0 or result.error_steps > 0 else "pass",
                    total_steps=global_step_seq if _is_multi_cycle else len(scen.steps),
                    total_repeat=last_completed_iteration,
                    started_at=result.started_at,
                    finished_at=datetime.now(timezone.utc).isoformat(),
                    step_results=list(result.step_results),
                    passed_steps=result.passed_steps,
                    failed_steps=result.failed_steps,
                    error_steps=result.error_steps,
                )
                await playback_service._save_result(_interim, interim=True)

        # 중단 처리
        if playback_service._should_stop:
            if last_completed_iteration == 0:
                publish_event({"type": "playback_stopped", "result_filename": ""})
            else:
                if _is_multi_cycle:
                    result.total_steps = global_step_seq
                else:
                    total_steps_per_cycle = len(scen.steps)
                    keep_count = last_completed_iteration * total_steps_per_cycle
                    result.step_results = result.step_results[:keep_count]
                result.passed_steps = sum(1 for sr in result.step_results if sr.status == "pass")
                result.failed_steps = sum(1 for sr in result.step_results if sr.status == "fail")
                result.error_steps = sum(1 for sr in result.step_results if sr.status not in ("pass", "fail"))
                result.total_repeat = last_completed_iteration
                result.finished_at = datetime.now(timezone.utc).isoformat()
                result.status = "fail" if (result.failed_steps > 0 or result.error_steps > 0) else "pass"
                result_path = await playback_service._save_result(result)
                publish_event({"type": "playback_stopped", "result_filename": _result_filename(result_path)})
        else:
            if _is_multi_cycle:
                result.total_steps = global_step_seq
            result.finished_at = datetime.now(timezone.utc).isoformat()
            result.status = "fail" if (result.failed_steps > 0 or result.error_steps > 0) else "pass"
            result_path = await playback_service._save_result(result)
            publish_event({"type": "playback_complete", "result_filename": _result_filename(result_path)})
    except Exception as e:
        logger.exception("Play job failed")
        publish_event({"type": "error", "message": str(e)})
    finally:
        await _webcam_session_finalize(webcam_session, result_path)
        if _is_multi_cycle:
            playback_service._cleanup_run_output_dir()
            playback_service._running = False
        mark_playback_active(False)


async def _run_play_group_job(data: dict):
    """백그라운드 태스크로 실행되는 play_group 로직."""
    from .services.playback_service import publish_event, clear_event_buffer, mark_playback_active
    group_members = data.get("scenarios", [])
    verify = data.get("verify", True)
    repeat = data.get("repeat", 1)
    device_map_override = data.get("device_map")

    entries: list[dict] = []
    for m in group_members:
        if isinstance(m, str):
            entries.append({"name": m, "on_pass_goto": None, "on_fail_goto": None})
        else:
            entries.append(m)

    result_path: Optional[str] = None
    webcam_session: Optional[_WebcamPlaybackSession] = None
    try:
        playback_service._should_stop = False
        playback_service._pause_event.set()
        clear_event_buffer()
        mark_playback_active(True)
        publish_event({"type": "playback_reset", "group": True})
        webcam_session = await _webcam_session_start(iteration=1)

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
            publish_event({"type": "preflight_error", "errors": all_preflight_errors})
            return

        group_name = data.get("group_name", entries[0]["name"])
        total_steps = 0
        for entry in entries:
            try:
                scen = await recording_service.load_scenario(entry["name"])
                total_steps += len(scen.steps)
            except FileNotFoundError:
                pass

        playback_service._result_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        playback_service._setup_run_output_dir(group_name)

        unified_result = ScenarioResult(
            scenario_name=group_name,
            device_serial="multi-device",
            status="pass",
            total_steps=total_steps,
            total_repeat=repeat,
            started_at=datetime.now(timezone.utc).isoformat(),
        )
        global_step_seq = 0

        for iteration in range(1, repeat + 1):
            if playback_service._should_stop:
                break
            if repeat > 1:
                publish_event({
                    "type": "iteration_start",
                    "iteration": iteration,
                    "total": repeat,
                })
                # 두 번째 이상 cycle 시작 시 웹캠 녹화 분할
                if iteration > 1 and webcam_session is not None:
                    await _webcam_session_next_cycle(webcam_session, iteration)

            sc_idx = 0
            start_step = 0
            while sc_idx < len(entries):
                if playback_service._should_stop:
                    break
                entry = entries[sc_idx]
                sc_name = entry["name"]
                scen = await recording_service.load_scenario(sc_name)
                publish_event({
                    "type": "group_scenario_start",
                    "scenario_name": sc_name,
                    "scenario_index": sc_idx + 1,
                    "total_scenarios": len(entries),
                    "start_step": start_step,
                })

                step_jumps = entry.get("step_jumps", {})
                step_jump_target = None

                _pending_seq = 0
                async for item in playback_service.execute_scenario_stream(
                    scen, verify=verify, repeat_index=iteration, start_step=start_step,
                    device_map_override=device_map_override, group_scenario_index=sc_idx + 1,
                ):
                    if isinstance(item, dict) and item.get("_type") == "step_start":
                        global_step_seq += 1
                        _pending_seq = global_step_seq
                        start_data = {k: v for k, v in item.items() if k != "_type"}
                        start_data["step_id"] = _pending_seq
                        start_data["description"] = f"[{sc_name}] {start_data.get('description', '')}" if start_data.get('description') else f"[{sc_name}]"
                        publish_event({
                            "type": "step_start",
                            "data": start_data,
                            "iteration": iteration,
                            "scenario_name": sc_name,
                        })
                        continue
                    step_result = item
                    original_step_id = step_result.step_id
                    step_result.step_id = _pending_seq
                    step_result.description = f"[{sc_name}] {step_result.description}" if step_result.description else f"[{sc_name}]"

                    unified_result.step_results.append(step_result)
                    if step_result.status == "pass":
                        unified_result.passed_steps += 1
                    elif step_result.status == "fail":
                        unified_result.failed_steps += 1
                    else:
                        unified_result.error_steps += 1
                    publish_event({
                        "type": "step_result",
                        "data": step_result.model_dump(),
                        "iteration": iteration,
                        "scenario_name": sc_name,
                    })

                    sj = step_jumps.get(str(original_step_id))
                    if sj:
                        if step_result.status == "pass":
                            sj_jump = sj.get("on_pass_goto")
                        else:
                            sj_jump = sj.get("on_fail_goto")
                        if sj_jump is not None:
                            step_jump_target = sj_jump
                            break

                if playback_service._should_stop:
                    break

                next_idx = sc_idx + 1
                start_step = 0
                jump = None

                if step_jump_target is not None:
                    jump = step_jump_target
                else:
                    last_sr = unified_result.step_results[-1] if unified_result.step_results else None
                    last_status = last_sr.status if last_sr else "pass"
                    if last_status == "pass":
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
                        break
                    next_idx = target_sc
                    start_step = target_step

                sc_idx = next_idx

            if repeat > 1 and not playback_service._should_stop:
                _interim = ScenarioResult(
                    scenario_name=group_name,
                    device_serial="multi-device",
                    status="fail" if unified_result.failed_steps > 0 or unified_result.error_steps > 0 else "pass",
                    total_steps=global_step_seq,
                    total_repeat=iteration,
                    started_at=unified_result.started_at,
                    finished_at=datetime.now(timezone.utc).isoformat(),
                    step_results=list(unified_result.step_results),
                    passed_steps=unified_result.passed_steps,
                    failed_steps=unified_result.failed_steps,
                    error_steps=unified_result.error_steps,
                )
                await playback_service._save_result(_interim, interim=True)

        unified_result.finished_at = datetime.now(timezone.utc).isoformat()
        unified_result.total_steps = global_step_seq
        if unified_result.failed_steps > 0 or unified_result.error_steps > 0:
            unified_result.status = "fail"
        else:
            unified_result.status = "pass"
        result_path = await playback_service._save_result(unified_result)
        rf = _result_filename(result_path)

        if playback_service._should_stop:
            publish_event({"type": "playback_stopped", "result_filename": rf})
        else:
            publish_event({"type": "playback_complete", "result_filename": rf})
    except Exception as e:
        logger.exception("Play group job failed")
        publish_event({"type": "error", "message": str(e)})
    finally:
        await _webcam_session_finalize(webcam_session, result_path)
        playback_service._cleanup_run_output_dir()
        playback_service._running = False
        mark_playback_active(False)


@app.websocket("/ws/webcam")
async def websocket_webcam(websocket: WebSocket):
    """Webcam preview WebSocket — 백엔드의 최신 프레임을 JPEG binary로 push.

    클라이언트 옵션 (첫 메시지 JSON):
      {"fps": 15, "quality": 70}
    fps: 1~30 (기본 15), quality: 1~100 (기본 70)

    녹화와 무관 — 캡처 스레드가 만든 _latest_frame을 단순 fan-out.
    """
    from .services.webcam_service import get_webcam_service
    await websocket.accept()
    logger.info("Webcam preview WS connected")
    fps = 15
    quality = 70
    svc = get_webcam_service()
    try:
        # 클라이언트 옵션 수신 (선택)
        try:
            opts = await asyncio.wait_for(websocket.receive_json(), timeout=0.2)
            if isinstance(opts, dict):
                fps = max(1, min(30, int(opts.get("fps", fps))))
                quality = max(1, min(100, int(opts.get("quality", quality))))
        except (asyncio.TimeoutError, Exception):
            pass
        interval = 1.0 / fps
        while True:
            t0 = asyncio.get_event_loop().time()
            jpg = svc.get_latest_jpeg(quality=quality)
            if jpg is None:
                # 카메라 미오픈 → 잠시 대기 후 재시도 (옵션: 끊기)
                await asyncio.sleep(0.5)
                continue
            try:
                await websocket.send_bytes(jpg)
            except Exception:
                break
            elapsed = asyncio.get_event_loop().time() - t0
            sleep_s = interval - elapsed
            if sleep_s > 0:
                await asyncio.sleep(sleep_s)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning("Webcam preview WS error: %s", e)
    finally:
        logger.info("Webcam preview WS disconnected")


@app.websocket("/ws/playback")
async def websocket_playback(websocket: WebSocket):
    """WebSocket endpoint: subscribe to playback events + handle commands.

    - WS가 닫혀도 백그라운드 재생 태스크는 계속 실행됨
    - 새 WS가 연결되면 최근 이벤트 버퍼를 replay 받아 현재 상태를 복구
    """
    global _playback_bg_task
    from .services.playback_service import subscribe_events, unsubscribe_events, publish_event, mark_playback_active
    await websocket.accept()
    logger.info("Playback WebSocket connected")

    # 구독 + forward task 생성
    event_queue = subscribe_events()

    async def _forward_loop():
        """event_queue → websocket으로 이벤트 forwarding."""
        try:
            while True:
                ev = await event_queue.get()
                try:
                    await websocket.send_json(ev)
                except Exception:
                    # WS 전송 실패 → 좀비 연결 방지를 위해 WS 명시적으로 close.
                    # 그래야 outer receive_json 루프가 WebSocketDisconnect로 빠져나와
                    # 정상 cleanup 경로를 탄다.
                    try:
                        await websocket.close()
                    except Exception:
                        pass
                    return
        except asyncio.CancelledError:
            return

    forward_task = asyncio.create_task(_forward_loop())

    try:
        while True:
            data = await websocket.receive_json()
            action = data.get("action")

            if action == "play":
                if playback_service.is_running or (_playback_bg_task and not _playback_bg_task.done()):
                    publish_event({"type": "error", "message": "이미 재생 중입니다"})
                    continue
                _playback_bg_task = asyncio.create_task(_run_play_job(data))

            elif action == "play_group":
                if playback_service.is_running or (_playback_bg_task and not _playback_bg_task.done()):
                    publish_event({"type": "error", "message": "이미 재생 중입니다"})
                    continue
                _playback_bg_task = asyncio.create_task(_run_play_group_job(data))

            elif action == "stop":
                await playback_service.stop()
                # 중단 즉시 inactive로 표시 — 새 WS가 연결되어도 이전 run의 버퍼가 replay되지 않도록.
                # 백그라운드 태스크의 finally에서도 다시 False로 설정되지만 여기서 먼저 걸어야 race가 없다.
                mark_playback_active(False)
                publish_event({"type": "playback_stopped", "result_filename": ""})

            elif action == "pause":
                await playback_service.pause()
                publish_event({"type": "playback_paused"})

            elif action == "resume":
                await playback_service.resume()
                publish_event({"type": "playback_resumed"})

            elif action == "subscribe":
                # 재연결 → 이미 subscribe_events가 최근 버퍼를 replay함
                pass

    except WebSocketDisconnect:
        logger.info("Playback WebSocket disconnected (playback continues in background)")
    finally:
        forward_task.cancel()
        try:
            await forward_task
        except (asyncio.CancelledError, Exception):
            pass
        unsubscribe_events(event_queue)
