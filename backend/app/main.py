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
from .dependencies import adb_service, device_manager, playback_service, recording_service
from .models.scenario import ScenarioResult

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    # --- Startup ---
    logger.info("Opening persistent serial connections...")
    await device_manager.open_all_serial_connections()
    yield
    # --- Shutdown ---
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
    """WebSocket endpoint for real-time screen mirroring."""
    await websocket.accept()
    logger.info("Screen mirror WebSocket connected")

    try:
        while True:
            try:
                png_bytes = await adb_service.screencap_bytes()
                b64 = base64.b64encode(png_bytes).decode("ascii")
                await websocket.send_json({
                    "type": "frame",
                    "image": b64,
                    "format": "png",
                })
            except Exception as e:
                await websocket.send_json({
                    "type": "error",
                    "message": str(e),
                })
            await asyncio.sleep(0.3)  # ~3 FPS
    except WebSocketDisconnect:
        logger.info("Screen mirror WebSocket disconnected")


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
                try:
                    scen = await recording_service.load_scenario(scenario_name)

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

                        async for step_result in playback_service.execute_scenario_stream(scen, verify=verify, repeat_index=iteration, device_map_override=device_map_override):
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
