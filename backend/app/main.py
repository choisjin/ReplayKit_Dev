"""Android System Auto Test Recording — FastAPI Backend."""

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
from .dependencies import adb_service, device_manager, playback_service, recording_service, scrcpy_manager
from .services.adb_service import resolve_sf_display_id
from .models.scenario import ScenarioResult

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)


async def _reconnect_loop():
    """백그라운드: 끊어진 디바이스 주기적 재연결 시도 (30초 간격)."""
    while True:
        await asyncio.sleep(30)
        try:
            await device_manager.reconnect_disconnected()
        except Exception as e:
            logger.debug("Reconnect loop error: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    # --- Startup ---
    logger.info("Opening persistent serial connections...")
    await device_manager.open_all_serial_connections()
    reconnect_task = asyncio.create_task(_reconnect_loop())
    yield
    # --- Shutdown ---
    reconnect_task.cancel()
    scrcpy_manager.stop_all()
    logger.info("Closing all serial connections...")
    device_manager.close_all_serial_connections()


app = FastAPI(
    title="Android System Auto Test Recording",
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


@app.get("/")
async def root():
    return {
        "app": "Android System Auto Test Recording",
        "version": "0.1.0",
        "docs": "/docs",
    }


@app.websocket("/ws/screen")
async def websocket_screen_mirror(websocket: WebSocket):
    """WebSocket endpoint for real-time screen mirroring.

    클라이언트가 첫 메시지로 {"device_id": "...", "screen_type": "front_center"} 전송.
    바이너리 JPEG 프레임을 연속 전송. device_id 미전송 시 기존 ADB 방식 폴백.
    """
    await websocket.accept()
    logger.info("Screen mirror WebSocket connected")

    # 클라이언트로부터 device_id 수신 (선택)
    target_device_id = ""
    screen_type = "front_center"
    try:
        init_msg = await asyncio.wait_for(websocket.receive_json(), timeout=2.0)
        target_device_id = init_msg.get("device_id", "")
        screen_type = init_msg.get("screen_type", "front_center")
    except (asyncio.TimeoutError, Exception):
        pass  # 타임아웃이면 ADB 폴백

    # 디바이스 타입 판별
    dev = device_manager.get_device(target_device_id) if target_device_id else None
    is_hkmc = dev and dev.type == "hkmc6th"

    logger.info("Screen mirror: device=%s type=%s", target_device_id, "hkmc" if is_hkmc else "adb")

    # ADB scrcpy 스트림 참조 (정리용)
    scrcpy_stream = None
    scrcpy_serial = ""
    scrcpy_display = 0

    try:
        # ADB 디바이스: scrcpy 스트림 획득 시도
        if not is_hkmc and dev:
            adb_display_id = 0
            try:
                adb_display_id = int(screen_type)
            except (ValueError, TypeError):
                pass
            scrcpy_serial = dev.address or target_device_id
            scrcpy_display = adb_display_id
            scrcpy_stream = await scrcpy_manager.acquire_stream(
                serial=scrcpy_serial, display_id=scrcpy_display
            )
            if scrcpy_stream:
                logger.info("scrcpy stream acquired for %s (display=%d)", scrcpy_serial, scrcpy_display)
            else:
                logger.info("scrcpy unavailable for %s, falling back to screencap", scrcpy_serial)

        while True:
            try:
                # 매 프레임마다 최신 서비스 인스턴스 조회 (재연결 대응)
                hkmc = device_manager.get_hkmc_service(target_device_id) if is_hkmc else None
                if hkmc and hkmc.is_connected:
                    jpeg_bytes = await hkmc.async_screencap_bytes(
                        screen_type=screen_type, fmt="jpeg", timeout=10.0
                    )
                    await websocket.send_bytes(jpeg_bytes)
                elif is_hkmc:
                    # HKMC 재연결 대기 중 — 빈 프레임 대신 잠시 대기
                    await asyncio.sleep(1)
                    continue
                elif scrcpy_stream and scrcpy_stream.is_running:
                    # scrcpy H.264 스트리밍 — binary JPEG
                    jpeg_bytes = await scrcpy_stream.async_wait_frame(timeout=2.0)
                    if jpeg_bytes:
                        await websocket.send_bytes(jpeg_bytes)
                    else:
                        await asyncio.sleep(0.03)
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
                await websocket.send_json({
                    "type": "error",
                    "message": str(e),
                })
                await asyncio.sleep(1)
                continue
            await asyncio.sleep(0.03)  # ~30fps 프레임 간격
    except WebSocketDisconnect:
        logger.info("Screen mirror WebSocket disconnected")
    finally:
        # scrcpy 스트림 해제
        if scrcpy_stream:
            scrcpy_manager.release_stream(scrcpy_serial, scrcpy_display)


@app.websocket("/ws/playback")
async def websocket_playback(websocket: WebSocket):
    """WebSocket endpoint for streaming playback results step by step."""
    await websocket.accept()
    logger.info("Playback WebSocket connected")

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
                        if repeat > 1:
                            await websocket.send_json({
                                "type": "iteration_start",
                                "iteration": iteration,
                                "total": repeat,
                            })

                        async for item in playback_service.execute_scenario_stream(scen, verify=verify, repeat_index=iteration, device_map_override=device_map_override):
                            if isinstance(item, dict) and item.get("_type") == "step_start":
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
                    await playback_service._save_result(result)

                    await websocket.send_json({"type": "playback_complete"})
                except Exception as e:
                    await websocket.send_json({"type": "error", "message": str(e)})

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
                        await playback_service._save_result(result)

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

                    await websocket.send_json({"type": "playback_complete"})
                except Exception as e:
                    await websocket.send_json({"type": "error", "message": str(e)})

            elif action == "stop":
                await playback_service.stop()
                await websocket.send_json({"type": "playback_stopped"})

    except WebSocketDisconnect:
        logger.info("Playback WebSocket disconnected")
