"""Playback & Verification service — 시나리오 재생 및 검증."""

from __future__ import annotations

import asyncio
import logging
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncGenerator, Optional

from ..models.scenario import CompareMode, Scenario, ScenarioResult, Step, StepResult, StepType, SubResult
from .adb_service import ADBService
from .device_manager import DeviceManager
from .image_compare_service import ImageCompareService
from .module_service import execute_module_function

logger = logging.getLogger(__name__)

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
SCREENSHOTS_DIR = Path(__file__).resolve().parent.parent.parent / "screenshots"


# 백그라운드 CMD 태스크 저장소
_bg_tasks: dict[str, dict] = {}
_bg_task_counter = 0


def _bg_cmd_start(cmd: str) -> str:
    """백그라운드로 CMD 실행, task_id 반환."""
    global _bg_task_counter
    _bg_task_counter += 1
    task_id = f"bg_{_bg_task_counter}"
    _bg_tasks[task_id] = {"status": "running", "stdout": "", "stderr": "", "rc": None, "cmd": cmd}

    def _run():
        try:
            proc = subprocess.run(cmd, shell=True, capture_output=True, timeout=300, creationflags=_NO_WINDOW)
            for enc in ("utf-8", "cp949", "euc-kr"):
                try:
                    stdout = proc.stdout.decode(enc)
                    stderr = proc.stderr.decode(enc)
                    _bg_tasks[task_id].update({"status": "done", "stdout": stdout, "stderr": stderr, "rc": proc.returncode})
                    return
                except (UnicodeDecodeError, LookupError):
                    continue
            _bg_tasks[task_id].update({"status": "done", "stdout": proc.stdout.decode(errors="replace"), "stderr": proc.stderr.decode(errors="replace"), "rc": proc.returncode})
        except subprocess.TimeoutExpired:
            _bg_tasks[task_id].update({"status": "timeout", "stdout": "", "stderr": "Timeout (300s)", "rc": 1})
        except Exception as e:
            _bg_tasks[task_id].update({"status": "error", "stdout": "", "stderr": str(e), "rc": 1})

    import threading
    threading.Thread(target=_run, daemon=True, name=f"bg-cmd-{task_id}").start()
    return task_id


def bg_cmd_get(task_id: str) -> dict | None:
    """백그라운드 CMD 결과 조회."""
    return _bg_tasks.get(task_id)


def bg_cmd_cleanup(task_id: str) -> None:
    """완료된 태스크 정리."""
    _bg_tasks.pop(task_id, None)


def _cmd_run_sync(cmd: str, timeout: int = 30) -> tuple[str, str, int]:
    """CMD 명령어 실행 (subprocess). Windows cp949 인코딩 대응."""
    try:
        proc = subprocess.run(cmd, shell=True, capture_output=True, timeout=timeout, creationflags=_NO_WINDOW)
        # Windows cmd는 cp949, 실패 시 utf-8 폴백
        for enc in ("utf-8", "cp949", "euc-kr"):
            try:
                stdout = proc.stdout.decode(enc)
                stderr = proc.stderr.decode(enc)
                return (stdout, stderr, proc.returncode)
            except (UnicodeDecodeError, LookupError):
                continue
        return (proc.stdout.decode(errors="replace"),
                proc.stderr.decode(errors="replace"),
                proc.returncode)
    except subprocess.TimeoutExpired:
        return ("", f"Command timed out after {timeout}s", 1)


def _build_ctor_kwargs(dev) -> dict | None:
    """Build constructor kwargs from device info for module instantiation."""
    ct = dev.info.get("connect_type", "serial" if dev.type == "serial" else "none")
    if ct == "serial":
        return {"port": dev.address, "bps": dev.info.get("baudrate", 115200)}
    elif ct == "socket":
        kwargs = {"host": dev.address}
        for k, v in dev.info.items():
            if k not in ("module", "connect_type"):
                kwargs[k] = v
        return kwargs
    elif ct == "can":
        return {k: v for k, v in dev.info.items() if k not in ("module", "connect_type")}
    return None
RESULTS_DIR = Path(__file__).resolve().parent.parent.parent / "results"

# 현재 재생 런의 출력 디렉토리 (모듈에서 참조용)
_current_run_output_dir: Optional[Path] = None


def get_run_output_dir() -> Optional[Path]:
    """현재 재생 런의 출력 디렉토리 반환. 재생 중이 아니면 None."""
    return _current_run_output_dir


class PlaybackService:
    """Execute scenarios and verify results."""

    def __init__(self, adb: ADBService, image_compare: ImageCompareService, device_manager: DeviceManager):
        self.adb = adb
        self.image_compare = image_compare
        self.dm = device_manager
        self._running = False
        self._should_stop = False
        self._pause_event = asyncio.Event()
        self._pause_event.set()  # 초기: 일시정지 아님
        self._device_map: dict[str, str] = {}  # alias -> real device id for current playback
        self._result_timestamp: str = ""  # 재생 세션별 고유 타임스탬프 (actual 이미지 폴더용)
        self._run_output_dir: Optional[Path] = None  # 런별 출력 디렉토리

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def is_paused(self) -> bool:
        return not self._pause_event.is_set()

    async def stop(self) -> None:
        self._should_stop = True
        self._pause_event.set()  # 일시정지 중이면 풀어서 루프 종료 가능하게

    async def pause(self) -> None:
        self._pause_event.clear()

    async def resume(self) -> None:
        self._pause_event.set()

    async def _wait_if_paused(self) -> bool:
        """일시정지 상태면 재개될 때까지 대기. 중단 시 True 반환."""
        await self._pause_event.wait()
        return self._should_stop

    async def _interruptible_sleep(self, seconds: float) -> bool:
        """중단 가능한 sleep. _should_stop이면 즉시 반환. 중단 시 True 반환."""
        interval = 0.5
        remaining = seconds
        while remaining > 0:
            if self._should_stop:
                return True
            await asyncio.sleep(min(interval, remaining))
            remaining -= interval
        return False

    def _resolve_device_map(self, scenario: Scenario, override_map: Optional[dict[str, str]] = None) -> dict[str, str]:
        """Build alias -> real device ID mapping.

        If override_map is provided (from frontend), use it.
        Otherwise fall back to scenario.device_map.
        """
        if override_map:
            return override_map
        return dict(scenario.device_map) if scenario.device_map else {}

    def _resolve_alias(self, alias: Optional[str], device_map: dict[str, str]) -> Optional[str]:
        """Resolve a device alias to real device ID. If not in map, return as-is (backward compat)."""
        if not alias:
            return alias
        return device_map.get(alias, alias)

    async def preflight_check(self, scenario: Scenario, device_map_override: Optional[dict[str, str]] = None) -> list[str]:
        """Check that all devices referenced in scenario steps are connected.

        Returns a list of error messages. Empty list means all good.
        """
        errors: list[str] = []
        device_map = self._resolve_device_map(scenario, device_map_override)

        # Collect unique device aliases/IDs from steps
        aliases: set[str] = set()
        for step in scenario.steps:
            if step.device_id:
                aliases.add(step.device_id)

        if not aliases:
            return errors

        for alias in sorted(aliases):
            real_id = device_map.get(alias, alias)
            dev = self.dm.get_device(real_id)
            if not dev:
                if alias != real_id:
                    errors.append(f"'{alias}' → 디바이스 '{real_id}'을(를) 찾을 수 없습니다")
                else:
                    errors.append(f"디바이스 '{alias}'을(를) 찾을 수 없습니다 (매핑 없음)")
            elif dev.status not in ("device", "connected"):
                label = f"'{alias}' → " if alias != real_id else ""
                errors.append(f"{label}디바이스 '{dev.name or real_id}'이(가) 연결되어 있지 않습니다 (상태: {dev.status})")

        return errors

    async def execute_scenario(
        self,
        scenario: Scenario,
        verify: bool = True,
        device_map_override: Optional[dict[str, str]] = None,
    ) -> ScenarioResult:
        """Execute all steps in a scenario and optionally verify each step."""
        if self._running:
            raise RuntimeError("Playback already in progress")

        self._device_map = self._resolve_device_map(scenario, device_map_override)
        self._running = True
        self._should_stop = False
        self._result_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self._setup_run_output_dir(scenario.name)
        started_at = datetime.now(timezone.utc).isoformat()

        result = ScenarioResult(
            scenario_name=scenario.name,
            device_serial="multi-device",
            status="pass",
            total_steps=len(scenario.steps),
            started_at=started_at,
        )

        # Build step lookup by ID for conditional jumps
        step_by_id: dict[int, int] = {}
        for i, s in enumerate(scenario.steps):
            step_by_id[s.id] = i

        try:
            idx = 0
            while idx < len(scenario.steps):
                if self._should_stop:
                    logger.info("Playback stopped by user")
                    break

                step = scenario.steps[idx]
                step_result = await self._execute_step(step, scenario.name, verify)
                result.step_results.append(step_result)

                if step_result.status == "pass":
                    result.passed_steps += 1
                elif step_result.status == "fail":
                    result.failed_steps += 1
                elif step_result.status == "warning":
                    result.warning_steps += 1
                else:
                    result.error_steps += 1

                # Conditional jump
                next_idx = idx + 1
                if step_result.status in ("pass", "warning") and step.on_pass_goto is not None:
                    if step.on_pass_goto == -1:
                        break
                    target = step_by_id.get(step.on_pass_goto)
                    if target is not None:
                        next_idx = target
                elif step_result.status in ("fail", "error") and step.on_fail_goto is not None:
                    if step.on_fail_goto == -1:
                        break
                    target = step_by_id.get(step.on_fail_goto)
                    if target is not None:
                        next_idx = target
                idx = next_idx
        except Exception as e:
            logger.error("Playback error: %s", e)
            result.status = "error"
        finally:
            self._running = False
            self._cleanup_run_output_dir()
            result.finished_at = datetime.now(timezone.utc).isoformat()

        # Determine overall status
        if result.failed_steps > 0 or result.error_steps > 0:
            result.status = "fail"
        elif result.warning_steps > 0:
            result.status = "warning"
        else:
            result.status = "pass"

        # Save result
        await self._save_result(result)
        return result

    async def execute_scenario_stream(
        self,
        scenario: Scenario,
        verify: bool = True,
        repeat_index: int = 1,
        start_step: int = 0,
        device_map_override: Optional[dict[str, str]] = None,
    ) -> AsyncGenerator[StepResult, None]:
        """Execute scenario and yield step results one by one (for WebSocket streaming).

        Args:
            start_step: 0-based step index to start execution from (skip earlier steps).
        """
        self._device_map = self._resolve_device_map(scenario, device_map_override)
        self._running = True
        self._should_stop = False
        self._current_iteration = repeat_index - 1  # 0-based for cycle wait
        if not self._result_timestamp:
            self._result_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            self._setup_run_output_dir(scenario.name)

        # Build step lookup by ID for conditional jumps
        step_by_id: dict[int, int] = {}  # step.id -> index
        for i, s in enumerate(scenario.steps):
            step_by_id[s.id] = i

        try:
            idx = max(0, start_step)
            while idx < len(scenario.steps):
                if self._should_stop:
                    break
                step = scenario.steps[idx]

                # 스텝 시작 알림
                yield {
                    "_type": "step_start",
                    "step_id": step.id,
                    "repeat_index": repeat_index,
                    "device_id": step.device_id or "",
                    "command": self._format_command(step),
                    "description": step.description or "",
                    "delay_ms": step.delay_after_ms,
                }

                step_result = await self._execute_step(step, scenario.name, verify, repeat_index=repeat_index)
                yield step_result

                # Determine next step based on conditional jump
                next_idx = idx + 1
                if step_result.status in ("pass", "warning") and step.on_pass_goto is not None:
                    if step.on_pass_goto == -1:
                        break  # END
                    target = step_by_id.get(step.on_pass_goto)
                    if target is not None:
                        next_idx = target
                elif step_result.status in ("fail", "error") and step.on_fail_goto is not None:
                    if step.on_fail_goto == -1:
                        break  # END
                    target = step_by_id.get(step.on_fail_goto)
                    if target is not None:
                        next_idx = target
                idx = next_idx
        finally:
            self._running = False
            self._cleanup_run_output_dir()

    async def execute_single_step(self, step: Step, scenario_name: str, device_map: Optional[dict[str, str]] = None) -> StepResult:
        """Execute a single step with verification (for testing individual steps)."""
        self._device_map = device_map or {}
        self._current_iteration = 0  # 단일 테스트는 항상 0번째
        return await self._execute_step(step, scenario_name, verify=True)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _execute_step(
        self,
        step: Step,
        scenario_name: str,
        verify: bool,
        repeat_index: int = 1,
    ) -> StepResult:
        """Execute a single step, capture screenshot, and verify."""
        start_time = time.time()
        step_result = StepResult(
            step_id=step.id,
            repeat_index=repeat_index,
            status="pass",
            timestamp=datetime.now(timezone.utc).isoformat(),
            device_id=step.device_id or "",
            command=self._format_command(step),
            description=step.description or "",
            delay_ms=step.delay_after_ms,
        )

        # File prefix includes cycle number to avoid overwriting across repeats
        file_prefix = f"c{repeat_index}_step_{step.id:03d}"

        # 일시정지 상태면 재개될 때까지 대기
        if await self._wait_if_paused():
            step_result.status = "error"
            step_result.message = "Stopped by user"
            return step_result

        t0 = t1 = t2 = t3 = t4 = start_time
        try:
            # 1) 액션 실행 전: 해당 스텝의 디바이스 연결 확인
            if self._should_stop:
                step_result.status = "error"
                step_result.error_message = "Stopped by user"
                return step_result
            t0 = time.time()
            action_device_id = self._resolve_real_device_id(step)
            if action_device_id:
                await self._ensure_device_connected(action_device_id)
            t1 = time.time()

            # Execute the action
            if self._should_stop:
                step_result.status = "error"
                step_result.error_message = "Stopped by user"
                return step_result
            await self._run_action(step)
            t2 = time.time()

            # Module command 결과 반영 (이미지 비교가 없을 때만 PASS/FAIL 판정)
            if step.type == StepType.MODULE_COMMAND and hasattr(self, '_last_module_result'):
                mod_result = str(self._last_module_result)
                del self._last_module_result
                step_result.message = mod_result
                has_expected = step.expected_image or (step.compare_mode == CompareMode.MULTI_CROP and step.expected_images)
                if not has_expected and mod_result.startswith("FAIL:"):
                    step_result.status = "fail"

            # CMD 결과 반영
            if step.type == StepType.CMD_SEND and hasattr(self, '_last_cmd_result'):
                stdout, _, _ = self._last_cmd_result
                step_result.message = stdout if stdout else ""
                del self._last_cmd_result
            elif step.type == StepType.CMD_CHECK and hasattr(self, '_last_cmd_result'):
                stdout, _, _ = self._last_cmd_result
                del self._last_cmd_result
                actual = stdout.strip()
                expected = step.params.get("expected", "")
                match_mode = step.params.get("match_mode", "contains")
                if match_mode == "exact":
                    passed = actual == expected.strip()
                else:
                    passed = expected.strip() in actual
                # 구조화된 메시지: 프론트에서 파싱하여 하이라이트
                step_result.message = f"[CMD_CHECK]\nexpected({match_mode}): {expected}\n---\n{actual}"
                if not passed:
                    step_result.status = "fail"

            # Wait (중단 가능)
            if await self._interruptible_sleep(step.delay_after_ms / 1000.0):
                step_result.status = "error"
                step_result.error_message = "Stopped by user"
                return step_result
            t3 = time.time()

            # 2) 이미지 비교 전: 기대이미지가 있을 때만 스크린샷 캡처
            has_expected = step.expected_image or (step.compare_mode == CompareMode.MULTI_CROP and step.expected_images)
            ss_device = self._resolve_screenshot_device(step) if has_expected else None
            if ss_device:
                await self._ensure_device_connected(ss_device["id"])
            t4 = time.time()
            actual_path = None
            if ss_device:
                actual_subdir = f"actual_{self._result_timestamp}" if self._result_timestamp else "actual"
                actual_dir = SCREENSHOTS_DIR / scenario_name / actual_subdir
                actual_dir.mkdir(parents=True, exist_ok=True)
                actual_path = str(actual_dir / f"{file_prefix}.png")

                if ss_device["type"] == "adb":
                    # screen_type이 숫자면 display_id로 사용
                    adb_did = None
                    _st = ss_device.get("screen_type")
                    if _st is not None:
                        try:
                            adb_did = int(_st)
                        except (ValueError, TypeError):
                            pass
                    # SF display ID 조회
                    sf_did = None
                    if adb_did is not None:
                        dev_obj = self.dm.get_device(ss_device["id"])
                        if dev_obj:
                            from .adb_service import resolve_sf_display_id
                            sf_did = resolve_sf_display_id(dev_obj.info, adb_did)
                    adb_serial = ss_device.get("serial") or ss_device["id"]
                    logger.debug("Screenshot capture: device=%s adb_did=%s sf_did=%s",
                                 ss_device["id"], adb_did, sf_did)
                    await self.adb.screencap(actual_path, serial=adb_serial, sf_display_id=sf_did)
                elif ss_device["type"] == "hkmc6th":
                    hkmc_svc = self.dm.get_hkmc_service(ss_device["id"])
                    if hkmc_svc:
                        img_bytes = await hkmc_svc.async_screencap_bytes(
                            screen_type=ss_device.get("screen_type", "front_center"), fmt="png"
                        )
                        Path(actual_path).write_bytes(img_bytes)
                elif ss_device["type"] == "vision_camera":
                    cam = self.dm.get_vision_camera(ss_device["id"])
                    if cam:
                        loop = asyncio.get_event_loop()
                        saved = await loop.run_in_executor(
                            None, cam.CaptureToFile, actual_path
                        )

                actual_rel = f"{scenario_name}/{actual_subdir}/{file_prefix}.png"
                step_result.actual_image = actual_rel

                # Verify against expected image
                if verify and has_expected:
                    mode = step.compare_mode or CompareMode.FULL
                    step_result.compare_mode = mode.value if isinstance(mode, CompareMode) else mode

                    expected_path = str(SCREENSHOTS_DIR / scenario_name / step.expected_image) if step.expected_image else ""
                    if step.expected_image:
                        step_result.expected_image = f"{scenario_name}/{step.expected_image}"
                    step_result.roi = step.roi

                    if mode == CompareMode.MULTI_CROP:
                        # --- Multi-crop mode ---
                        crop_items = [
                            {
                                "image": str(SCREENSHOTS_DIR / scenario_name / ci.image),
                                "rel_path": f"{scenario_name}/{ci.image}",
                                "label": ci.label,
                            }
                            for ci in step.expected_images
                        ]
                        judgement = self.image_compare.judge(
                            expected_path="",
                            actual_path=actual_path,
                            threshold_pass=step.similarity_threshold,
                            threshold_warning=step.similarity_threshold - 0.10,
                            compare_mode="multi_crop",
                            crop_items=crop_items,
                        )
                        step_result.status = judgement["status"]
                        step_result.sub_results = [SubResult(**sr) for sr in judgement.get("sub_results", [])]

                        if judgement["status"] == "error":
                            step_result.message = judgement.get("message", "Multi-crop comparison error")
                        else:
                            # Generate annotated image with all match boxes
                            try:
                                annotated_path = str(actual_dir / f"{file_prefix}_annotated.png")
                                self.image_compare.generate_multi_crop_annotated(
                                    actual_path, judgement.get("sub_results", []), annotated_path
                                )
                                step_result.actual_annotated_image = f"{scenario_name}/{actual_subdir}/{file_prefix}_annotated.png"
                            except Exception as e:
                                logger.warning("Failed to generate multi-crop annotated image: %s", e)

                            # Generate annotated expected image: only crop regions visible, rest darkened
                            if expected_path:
                                try:
                                    import cv2
                                    img_exp = cv2.imread(expected_path)
                                    if img_exp is not None:
                                        dark = (img_exp * 0.2).astype("uint8")
                                        for ci in step.expected_images:
                                            if ci.roi:
                                                r = ci.roi
                                                dark[r.y:r.y + r.height, r.x:r.x + r.width] = img_exp[r.y:r.y + r.height, r.x:r.x + r.width]
                                                cv2.rectangle(dark, (r.x, r.y), (r.x + r.width, r.y + r.height), (0, 255, 0), 2)
                                        exp_ann_path = str(actual_dir / f"{file_prefix}_expected_annotated.png")
                                        cv2.imwrite(exp_ann_path, dark)
                                        step_result.expected_annotated_image = f"{scenario_name}/{actual_subdir}/{file_prefix}_expected_annotated.png"
                                except Exception as e:
                                    logger.warning("Failed to generate multi-crop expected annotated: %s", e)

                            # Build message from individual results
                            parts = [f"{sr.label or f'#{i+1}'}:{sr.status}({sr.score:.2f})" for i, sr in enumerate(step_result.sub_results)]
                            step_result.message = f"Multi-crop: {', '.join(parts)}"

                    elif mode == CompareMode.FULL_EXCLUDE:
                        # --- Full-exclude mode ---
                        exclude_rois_dicts = [r.model_dump() for r in step.exclude_rois]
                        judgement = self.image_compare.judge(
                            expected_path,
                            actual_path,
                            threshold_pass=step.similarity_threshold,
                            threshold_warning=step.similarity_threshold - 0.10,
                            compare_mode="full_exclude",
                            exclude_rois=exclude_rois_dicts,
                        )
                        step_result.status = judgement["status"]
                        step_result.similarity_score = judgement["score"]

                        if judgement["status"] == "error":
                            step_result.message = judgement.get("message", "Exclude comparison error")
                        else:
                            # Generate annotated image with excluded regions
                            try:
                                import cv2
                                img_annotated = cv2.imread(actual_path)
                                if img_annotated is not None:
                                    overlay = img_annotated.copy()
                                    for r in step.exclude_rois:
                                        cv2.rectangle(overlay, (r.x, r.y), (r.x + r.width, r.y + r.height), (128, 128, 128), -1)
                                    cv2.addWeighted(overlay, 0.5, img_annotated, 0.5, 0, img_annotated)
                                    for r in step.exclude_rois:
                                        cv2.rectangle(img_annotated, (r.x, r.y), (r.x + r.width, r.y + r.height), (0, 0, 255), 2)
                                    annotated_path = str(actual_dir / f"{file_prefix}_annotated.png")
                                    cv2.imwrite(annotated_path, img_annotated)
                                    step_result.actual_annotated_image = f"{scenario_name}/{actual_subdir}/{file_prefix}_annotated.png"
                            except Exception as e:
                                logger.warning("Failed to generate exclude annotated image: %s", e)

                            if step_result.status != "pass":
                                diff_path = str(actual_dir / f"diff_{file_prefix}.png")
                                diff_rel = f"{scenario_name}/{actual_subdir}/diff_{file_prefix}.png"
                                try:
                                    self.image_compare.generate_diff_heatmap(
                                        expected_path, actual_path, diff_path,
                                        exclude_rois=exclude_rois_dicts,
                                    )
                                    step_result.diff_image = diff_rel
                                except Exception as e:
                                    logger.warning("Failed to generate diff: %s", e)

                            # Generate annotated expected image: gray out excluded regions
                            if expected_path:
                                try:
                                    import cv2
                                    img_exp = cv2.imread(expected_path)
                                    if img_exp is not None:
                                        overlay = img_exp.copy()
                                        for r in step.exclude_rois:
                                            cv2.rectangle(overlay, (r.x, r.y), (r.x + r.width, r.y + r.height), (128, 128, 128), -1)
                                        cv2.addWeighted(overlay, 0.5, img_exp, 0.5, 0, overlay)
                                        for r in step.exclude_rois:
                                            cv2.rectangle(overlay, (r.x, r.y), (r.x + r.width, r.y + r.height), (0, 0, 255), 2)
                                        exp_ann_path = str(actual_dir / f"{file_prefix}_expected_annotated.png")
                                        cv2.imwrite(exp_ann_path, overlay)
                                        step_result.expected_annotated_image = f"{scenario_name}/{actual_subdir}/{file_prefix}_expected_annotated.png"
                                except Exception as e:
                                    logger.warning("Failed to generate exclude expected annotated: %s", e)

                            step_result.message = f"Exclude {len(step.exclude_rois)} regions: {judgement['score']:.4f}"

                    else:
                        # --- Full / Single-crop mode (existing behavior) ---
                        compare_actual = actual_path
                        if step.roi:
                            import cv2
                            img_act = cv2.imread(actual_path)
                            if img_act is not None:
                                r = step.roi
                                cropped = img_act[r.y:r.y + r.height, r.x:r.x + r.width]
                                cropped_path = str(actual_dir / f"{file_prefix}_roi.png")
                                cv2.imwrite(cropped_path, cropped)
                                compare_actual = cropped_path

                        judgement = self.image_compare.judge(
                            expected_path,
                            compare_actual,
                            threshold_pass=step.similarity_threshold,
                            threshold_warning=step.similarity_threshold - 0.10,
                        )
                        step_result.status = judgement["status"]
                        step_result.similarity_score = judgement["score"]

                        # 이미지 읽기 실패 시 에러 메시지 보존
                        if judgement["status"] == "error":
                            step_result.message = judgement.get("message", "Image comparison error")
                        else:
                            match_loc = judgement.get("match_location")
                            if match_loc:
                                step_result.match_location = match_loc
                                try:
                                    import cv2
                                    img_annotated = cv2.imread(actual_path)
                                    if img_annotated is not None:
                                        x, y = match_loc["x"], match_loc["y"]
                                        w, h = match_loc["width"], match_loc["height"]
                                        cv2.rectangle(img_annotated, (x, y), (x + w, y + h), (0, 0, 255), 3)
                                        annotated_path = str(actual_dir / f"{file_prefix}_annotated.png")
                                        cv2.imwrite(annotated_path, img_annotated)
                                        step_result.actual_annotated_image = f"{scenario_name}/{actual_subdir}/{file_prefix}_annotated.png"
                                except Exception as e:
                                    logger.warning("Failed to generate annotated image: %s", e)
                            elif step.roi:
                                try:
                                    import cv2
                                    img_annotated = cv2.imread(actual_path)
                                    if img_annotated is not None:
                                        r = step.roi
                                        cv2.rectangle(img_annotated, (r.x, r.y), (r.x + r.width, r.y + r.height), (0, 0, 255), 3)
                                        annotated_path = str(actual_dir / f"{file_prefix}_annotated.png")
                                        cv2.imwrite(annotated_path, img_annotated)
                                        step_result.actual_annotated_image = f"{scenario_name}/{actual_subdir}/{file_prefix}_annotated.png"
                                        step_result.match_location = {"x": r.x, "y": r.y, "width": r.width, "height": r.height}
                                except Exception as e:
                                    logger.warning("Failed to generate annotated image: %s", e)

                            if step_result.status != "pass":
                                diff_path = str(actual_dir / f"diff_{file_prefix}.png")
                                diff_rel = f"{scenario_name}/{actual_subdir}/diff_{file_prefix}.png"
                                try:
                                    self.image_compare.generate_diff_heatmap(
                                        expected_path, compare_actual, diff_path
                                    )
                                    step_result.diff_image = diff_rel
                                except Exception as e:
                                    logger.warning("Failed to generate diff: %s", e)

                            sim_msg = f"Similarity: {judgement['score']:.4f}"
                            if step_result.message and step_result.message.startswith("[CMD_CHECK]"):
                                # CMD 결과와 Similarity를 구분자로 분리
                                step_result.message += f"\n[SIMILARITY]\n{sim_msg}"
                            elif step_result.message:
                                step_result.message = f"{step_result.message}\n{sim_msg}"
                            else:
                                step_result.message = sim_msg
                else:
                    dev_label = ss_device["id"] if ss_device else step.device_id or "default"
                    if not step_result.message:
                        step_result.message = f"Executed on {dev_label} (기대 이미지 없음)"
            else:
                if not step_result.message:
                    step_result.message = f"Executed on {step.device_id or 'default'}"

        except Exception as e:
            step_result.status = "error"
            step_result.message = str(e)
            logger.error("Step %d execution error: %s", step.id, e)

        t_end = time.time()
        step_result.execution_time_ms = int((t_end - start_time) * 1000)
        logger.info(
            "Step %d timing: check1=%.1fs action=%.1fs delay=%.1fs check2=%.1fs rest=%.1fs total=%.1fs",
            step.id,
            t1 - t0, t2 - t1, t3 - t2, t4 - t3, t_end - t4, t_end - start_time,
        )
        return step_result

    @staticmethod
    def _format_command(step: Step) -> str:
        """Format a human-readable command description for the step."""
        p = step.params
        if step.type == StepType.TAP:
            return f"tap ({p.get('x', 0)}, {p.get('y', 0)})"
        elif step.type == StepType.LONG_PRESS:
            return f"long_press ({p.get('x', 0)}, {p.get('y', 0)}) {p.get('duration_ms', 1000)}ms"
        elif step.type == StepType.SWIPE:
            return f"swipe ({p.get('x1',0)},{p.get('y1',0)})→({p.get('x2',0)},{p.get('y2',0)})"
        elif step.type == StepType.INPUT_TEXT:
            return f"input_text \"{p.get('text', '')}\""
        elif step.type == StepType.KEY_EVENT:
            return f"key {p.get('keycode', '')}"
        elif step.type == StepType.WAIT:
            return f"wait {p.get('duration_ms', 1000)}ms"
        elif step.type == StepType.ADB_COMMAND:
            return f"adb {p.get('command', '')}"
        elif step.type == StepType.CMD_SEND:
            return f"cmd_send: {p.get('command', '')}"
        elif step.type == StepType.CMD_CHECK:
            mm = p.get('match_mode', 'contains')
            return f"cmd_check: {p.get('command', '')} (expect[{mm}]: {p.get('expected', '')})"
        elif step.type == StepType.SERIAL_COMMAND:
            return f"serial \"{p.get('data', '')}\""
        elif step.type == StepType.MODULE_COMMAND:
            return f"{p.get('module', '')}::{p.get('function', '')}()"
        elif step.type == StepType.HKMC_TOUCH:
            st = step.screen_type or p.get("screen_type", "")
            return f"hkmc_touch ({p.get('x', 0)}, {p.get('y', 0)}) [{st}]"
        elif step.type == StepType.HKMC_SWIPE:
            st = step.screen_type or p.get("screen_type", "")
            return f"hkmc_swipe ({p.get('x1',0)},{p.get('y1',0)})→({p.get('x2',0)},{p.get('y2',0)}) [{st}]"
        elif step.type == StepType.HKMC_KEY:
            key = p.get("key_name", f"0x{p.get('key_data', 0):02X}")
            return f"hkmc_key {key}"
        return step.type.value

    async def _ensure_device_connected(self, device_id: str, max_retries: int = 24, retry_interval: float = 5.0) -> None:
        """특정 디바이스의 연결 상태 확인 + 끊어진 경우 재연결 시도.

        Args:
            device_id: 실제 디바이스 ID (alias가 아닌 resolve된 ID)
        """
        if not device_id:
            return
        dev = self.dm.get_device(device_id)
        if not dev:
            return

        if dev.type == "hkmc6th":
            hkmc = self.dm.get_hkmc_service(device_id)
            if hkmc and hkmc.is_connected:
                return
            port = dev.info.get("port", 0)
            if not port:
                return
            from .hkmc6th_service import HKMC6thService
            for attempt in range(1, max_retries + 1):
                if self._should_stop:
                    return
                logger.info("Playback: reconnect %s attempt %d/%d", device_id, attempt, max_retries)
                try:
                    hkmc = self.dm.get_hkmc_service(device_id)
                    if hkmc:
                        hkmc.disconnect()
                    svc = HKMC6thService(dev.address, port, device_id=dev.id)
                    ok = await svc.async_connect()
                    if ok:
                        self.dm._hkmc_conns[dev.id] = svc
                        self.dm._hkmc_reconnect_attempts.pop(dev.id, None)
                        dev.status = "connected"
                        dev.info["agent_version"] = svc.agent_version
                        dev.info["screens"] = svc.get_info()["screens"]
                        logger.info("Playback: reconnected %s", device_id)
                        return
                except Exception as e:
                    logger.debug("Playback: reconnect %s failed: %s", device_id, e)
                if attempt < max_retries:
                    if await self._interruptible_sleep(retry_interval):
                        return
            dev.status = "disconnected"

        elif dev.type == "adb":
            # 먼저 현재 상태 확인
            try:
                adb_devices = await self.adb.list_devices()
                found = next((d for d in adb_devices if d.serial == dev.address), None)
                if found and found.status == "device":
                    dev.status = "device"
                    self.dm.reset_reconnect_attempts(device_id)
                    return
            except Exception:
                pass

            # 연결 안 됨 → 재연결 대기 (백그라운드 루프가 상태 갱신 중)
            adb_serial = dev.address
            self.dm.reset_reconnect_attempts(device_id)
            server_reset_done = False
            for attempt in range(1, max_retries + 1):
                if self._should_stop:
                    return
                logger.info("Playback: ADB reconnect %s attempt %d/%d", device_id, attempt, max_retries)
                try:
                    adb_devices = await self.adb.list_devices()
                    found = next((d for d in adb_devices if d.serial == adb_serial), None)
                    if found and found.status == "device":
                        dev.status = "device"
                        self.dm.reset_reconnect_attempts(device_id)
                        logger.info("Playback: ADB reconnected %s", device_id)
                        return
                    elif found:
                        logger.info("Playback: ADB %s status=%s, waiting...", device_id, found.status)
                    else:
                        # 디바이스 목록에 없으면 ADB 서버 리셋 시도 (1회만)
                        if not server_reset_done:
                            logger.info("Playback: ADB server reset for %s", device_id)
                            try:
                                await self.adb._run("kill-server")
                                await asyncio.sleep(1)
                                await self.adb._run("start-server")
                                await asyncio.sleep(2)
                            except Exception:
                                pass
                            server_reset_done = True
                except Exception as e:
                    logger.debug("Playback: ADB reconnect %s failed: %s", device_id, e)
                if attempt < max_retries:
                    if await self._interruptible_sleep(retry_interval):
                        return
            dev.status = "offline"

    def _resolve_real_device_id(self, step: Step) -> Optional[str]:
        """Resolve step's device_id alias to real device ID."""
        if not step.device_id:
            return None
        return self._resolve_alias(step.device_id, self._device_map)

    def _resolve_screenshot_device(self, step: Step) -> Optional[dict]:
        """Resolve which device to take screenshots from.

        Returns:
            {"type": "adb", "id": serial} or
            {"type": "hkmc6th", "id": device_id, "screen_type": ...} or
            {"type": "vision_camera", "id": device_id} or
            None (no screenshot possible)
        """
        # 스크린샷 불필요한 경우: serial/module이면서 기대이미지 없음, wait이면서 기대이미지 없음
        if step.type in (StepType.SERIAL_COMMAND, StepType.MODULE_COMMAND) and not step.expected_image:
            return None
        if step.type == StepType.WAIT and not step.expected_image:
            return None

        # screenshot_device_id가 저장되어 있으면 해당 디바이스 우선 사용
        # device_map을 통해 실제 디바이스 ID로 매핑
        if step.screenshot_device_id:
            resolved_ss_id = self._resolve_alias(step.screenshot_device_id, self._device_map)
            ss_dev = self.dm.get_device(resolved_ss_id)
            if ss_dev:
                if ss_dev.type == "hkmc6th":
                    screen_type = step.screen_type or "front_center"
                    return {"type": "hkmc6th", "id": ss_dev.id, "screen_type": screen_type}
                if ss_dev.type == "vision_camera":
                    return {"type": "vision_camera", "id": ss_dev.id}
                if ss_dev.type == "adb":
                    result = {"type": "adb", "id": ss_dev.id, "serial": ss_dev.address}
                    if step.screen_type:
                        result["screen_type"] = step.screen_type
                    return result

        real_id = self._resolve_real_device_id(step)
        if real_id:
            dev = self.dm.get_device(real_id)
            if dev and dev.type in ("serial", "module"):
                # 보조 디바이스는 스크린샷 불가 → primary 디바이스로 폴백
                pass
            elif dev and dev.type == "hkmc6th":
                screen_type = step.screen_type or step.params.get("screen_type", "front_center")
                return {"type": "hkmc6th", "id": dev.id, "screen_type": screen_type}
            elif dev and dev.type == "vision_camera":
                return {"type": "vision_camera", "id": dev.id}
            elif dev:
                # ADB — dev.address가 실제 ADB 시리얼
                adb_screen = step.screen_type or step.params.get("screen_type")
                result = {"type": "adb", "id": dev.id, "serial": dev.address}
                if adb_screen is not None:
                    result["screen_type"] = adb_screen
                elif len(dev.info.get("displays", [])) > 1:
                    # 멀티 디스플레이: screen_type 미지정 시 display 0 기본값
                    result["screen_type"] = "0"
                return result
        # device_id 없거나, 보조 디바이스인 경우 → 첫 번째 primary 디바이스로 스크린샷
        primary = self.dm.list_primary()
        if primary:
            dev = primary[0]
            if dev.type == "hkmc6th":
                return {"type": "hkmc6th", "id": dev.id, "screen_type": "front_center"}
            if dev.type == "vision_camera":
                return {"type": "vision_camera", "id": dev.id}
            return {"type": "adb", "id": dev.id, "serial": dev.address}
        return None

    def _resolve_adb_serial(self, step: Step) -> Optional[str]:
        """Resolve the ADB serial for a step. Returns None for non-ADB steps.

        Backward-compatible wrapper around _resolve_screenshot_device.
        """
        info = self._resolve_screenshot_device(step)
        if info and info["type"] == "adb":
            return info["id"]
        return None

    async def _run_action(self, step: Step) -> None:
        """Execute step action on the appropriate device."""
        params = step.params
        real_id = self._resolve_real_device_id(step)

        if step.type == StepType.MODULE_COMMAND:
            module_name = params.get("module", "")
            func_name = params.get("function", "")
            func_args = params.get("args", {})
            # Pass device connection info as constructor kwargs
            ctor_kwargs = None
            shared_conn = None
            if real_id:
                dev = self.dm.get_device(real_id)
                if dev:
                    ctor_kwargs = _build_ctor_kwargs(dev)
                    shared_conn = self.dm.get_serial_conn(real_id)
            logger.info("Module exec: %s.%s device=%s ctor=%s shared_conn=%s",
                        module_name, func_name, real_id, ctor_kwargs, shared_conn is not None)
            result = await execute_module_function(module_name, func_name, func_args, ctor_kwargs, shared_conn)
            self._last_module_result = result
        elif step.type == StepType.SERIAL_COMMAND:
            if not real_id:
                raise ValueError("serial_command requires device_id")
            await self.dm.send_serial_command(
                real_id,
                params["data"],
                params.get("read_timeout", 1.0),
            )
        elif step.type in (StepType.HKMC_TOUCH, StepType.HKMC_SWIPE, StepType.HKMC_KEY):
            if not real_id:
                raise ValueError("HKMC step requires device_id")
            # 액션 실행 중 연결 끊김 시 재연결 후 재시도 (최대 2회)
            for _hkmc_attempt in range(2):
                hkmc = self.dm.get_hkmc_service(real_id)
                if not hkmc or not hkmc.is_connected:
                    raise ValueError(f"HKMC device {real_id} not connected")
                try:
                    screen_type = step.screen_type or params.get("screen_type", "front_center")
                    if step.type == StepType.HKMC_TOUCH:
                        await hkmc.async_tap(params["x"], params["y"], screen_type)
                    elif step.type == StepType.HKMC_SWIPE:
                        await hkmc.async_swipe(params["x1"], params["y1"], params["x2"], params["y2"], screen_type)
                    elif step.type == StepType.HKMC_KEY:
                        key_name = params.get("key_name")
                        if key_name:
                            sub_cmd = params.get("sub_cmd", 0x43)
                            monitor = params.get("monitor", 0x00)
                            direction = params.get("direction")
                            await hkmc.async_send_key_by_name(key_name, sub_cmd, monitor, direction)
                        else:
                            await hkmc.async_send_key(
                                params["cmd"], params["sub_cmd"], params["key_data"],
                                params.get("monitor", 0x00), params.get("direction"),
                            )
                    break  # 성공 시 루프 탈출
                except (ConnectionError, OSError) as ce:
                    if _hkmc_attempt == 0:
                        logger.warning("HKMC action failed (connection lost), reconnecting: %s", ce)
                        await self._ensure_device_connected(real_id, max_retries=2, retry_interval=2.0)
                    else:
                        raise  # 재시도 후에도 실패 → 상위 except에서 "error" 처리
        elif step.type == StepType.WAIT:
            wait_mode = params.get("wait_mode", "basic")
            if wait_mode == "cycle":
                start_ms = params.get("wait_start", 3000)
                interval_ms = params.get("wait_interval", 3000)
                # current_iteration은 0-based (execute_scenario에서 설정)
                cycle_idx = getattr(self, '_current_iteration', 0)
                actual_ms = start_ms + interval_ms * cycle_idx
                logger.info("Wait cycle: iteration=%d, wait=%dms (start=%d + interval=%d × %d)", cycle_idx, actual_ms, start_ms, interval_ms, cycle_idx)
                await self._interruptible_sleep(actual_ms / 1000.0)
            elif wait_mode == "random":
                import random
                wait_min = params.get("wait_min", 0)
                wait_max = params.get("wait_max", 10000)
                actual_ms = random.randint(wait_min, wait_max)
                logger.info("Wait random: %dms (range %d~%d)", actual_ms, wait_min, wait_max)
                await self._interruptible_sleep(actual_ms / 1000.0)
            else:
                await self._interruptible_sleep(params.get("duration_ms", 1000) / 1000.0)
        elif step.type in (StepType.CMD_SEND, StepType.CMD_CHECK):
            cmd = params.get("command", "")
            background = params.get("background", False)
            if background:
                task_id = _bg_cmd_start(cmd)
                logger.info("[%s] background task_id=%s: %s", step.type.value, task_id, cmd)
                self._last_cmd_result = (f"[BG_TASK:{task_id}]", "", 0)
            else:
                timeout = params.get("timeout", 30)
                loop = asyncio.get_event_loop()
                stdout, stderr, rc = await loop.run_in_executor(None, _cmd_run_sync, cmd, timeout)
                logger.info("[%s] rc=%d: %s", step.type.value, rc, cmd)
                self._last_cmd_result = (stdout, stderr, rc)
        else:
            # ADB actions — real_id를 ADB 시리얼(dev.address)로 변환
            adb_serial = real_id
            if adb_serial:
                dev = self.dm.get_device(adb_serial)
                if dev and dev.type != "adb":
                    raise ValueError(f"Device {adb_serial} is not an ADB device, cannot run {step.type.value}")
                if dev:
                    adb_serial = dev.address  # 커스텀 ID → 실제 ADB 시리얼

            # screen_type이 숫자면 ADB display_id로 사용
            # 멀티 디스플레이: display 0도 명시적으로 전달 (input -d 0 필수)
            adb_display_id = None
            st = step.screen_type or params.get("screen_type")
            if st is not None:
                try:
                    adb_display_id = int(st)
                except (ValueError, TypeError):
                    pass
            # 멀티 디스플레이인데 display_id 미지정이면 0으로 기본값
            if adb_display_id is None and dev and len(dev.info.get("displays", [])) > 1:
                adb_display_id = 0

            if step.type == StepType.TAP:
                await self.adb.tap(params["x"], params["y"], serial=adb_serial, display_id=adb_display_id)
            elif step.type == StepType.LONG_PRESS:
                await self.adb.long_press(params["x"], params["y"], params.get("duration_ms", 1000), serial=adb_serial, display_id=adb_display_id)
            elif step.type == StepType.SWIPE:
                await self.adb.swipe(
                    params["x1"], params["y1"],
                    params["x2"], params["y2"],
                    params.get("duration_ms", 300),
                    serial=adb_serial, display_id=adb_display_id,
                )
            elif step.type == StepType.INPUT_TEXT:
                await self.adb.input_text(params["text"], serial=adb_serial, display_id=adb_display_id)
            elif step.type == StepType.KEY_EVENT:
                await self.adb.key_event(params["keycode"], serial=adb_serial, display_id=adb_display_id)
            elif step.type == StepType.ADB_COMMAND:
                await self.adb.run_shell_command(params["command"], serial=adb_serial)

    def _setup_run_output_dir(self, scenario_name: str) -> None:
        """재생 런별 출력 디렉토리 생성: results/{timestamp}_{scenario_name}/

        구조:
          results/{ts}_{name}/
          ├── result.json          ← 결과 JSON
          ├── screenshots/         ← 실제 스크린샷 디렉토리 (심볼릭 링크)
          ├── logs/                ← DLT/Serial 로그
          └── recordings/         ← 동영상 파일
        """
        global _current_run_output_dir
        safe_name = scenario_name.replace(" ", "_").replace("/", "_").replace("\\", "_")
        folder_name = f"{self._result_timestamp}_{safe_name}"
        run_dir = RESULTS_DIR / folder_name
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "logs").mkdir(exist_ok=True)
        (run_dir / "recordings").mkdir(exist_ok=True)

        # 스크린샷은 기존 위치에 저장하되 런 폴더에서 링크로 참조
        actual_subdir = f"actual_{self._result_timestamp}"
        actual_dir = SCREENSHOTS_DIR / scenario_name / actual_subdir
        actual_dir.mkdir(parents=True, exist_ok=True)
        link_path = run_dir / "screenshots"
        if not link_path.exists():
            try:
                # Windows: directory junction (관리자 권한 불필요)
                import _winapi
                _winapi.CreateJunction(str(actual_dir), str(link_path))
            except Exception:
                try:
                    link_path.symlink_to(actual_dir, target_is_directory=True)
                except Exception:
                    # 심볼릭 링크 실패 시 경로만 텍스트로 기록
                    (run_dir / "screenshots_path.txt").write_text(str(actual_dir), encoding="utf-8")

        self._run_output_dir = run_dir
        _current_run_output_dir = run_dir
        logger.info("Run output dir: %s", run_dir)

    def _cleanup_run_output_dir(self) -> None:
        """재생 종료 시 글로벌 런 디렉토리 참조 해제.
        self._run_output_dir은 _save_result에서 사용하므로 여기서는 유지."""
        global _current_run_output_dir
        _current_run_output_dir = None
        self._result_timestamp = ""

    async def _save_result(self, result: ScenarioResult) -> str:
        """Save execution result to JSON + Excel (런 폴더 내 result.json + result.xlsx)."""
        timestamp = self._result_timestamp or datetime.now().strftime("%Y%m%d_%H%M%S")

        if self._run_output_dir and self._run_output_dir.exists():
            filepath = self._run_output_dir / "result.json"
        else:
            RESULTS_DIR.mkdir(parents=True, exist_ok=True)
            filepath = RESULTS_DIR / f"{result.scenario_name}_{timestamp}.json"

        filepath.write_text(result.model_dump_json(indent=2), encoding="utf-8")
        logger.info("Result saved: %s", filepath)

        # Excel 자동 생성
        self._save_excel(filepath)

        self._run_output_dir = None
        return str(filepath)

    def _save_excel(self, json_path: Path) -> None:
        """result.json 옆에 Excel 파일을 자동 생성."""
        try:
            from ..routers.results import _build_excel_workbook
            import json as _json
            data = _json.loads(json_path.read_text(encoding="utf-8"))
            wb = _build_excel_workbook(data, json_path)
            excel_path = json_path.with_suffix(".xlsx")
            wb.save(str(excel_path))
            logger.info("Excel saved: %s", excel_path)
        except Exception as e:
            logger.warning("Excel auto-generation failed: %s", e)
