"""Playback & Verification service — 시나리오 재생 및 검증."""

from __future__ import annotations

import asyncio
import logging
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

SCREENSHOTS_DIR = Path(__file__).resolve().parent.parent.parent / "screenshots"


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


class PlaybackService:
    """Execute scenarios and verify results."""

    def __init__(self, adb: ADBService, image_compare: ImageCompareService, device_manager: DeviceManager):
        self.adb = adb
        self.image_compare = image_compare
        self.dm = device_manager
        self._running = False
        self._should_stop = False
        self._device_map: dict[str, str] = {}  # alias -> real device id for current playback

    @property
    def is_running(self) -> bool:
        return self._running

    async def stop(self) -> None:
        self._should_stop = True

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

        # Refresh device statuses
        await self.dm.refresh_adb()
        await self.dm.refresh_auxiliary()

        for alias in sorted(aliases):
            real_id = device_map.get(alias, alias)
            dev = self.dm.get_device(real_id)
            if not dev:
                if alias != real_id:
                    errors.append(f"'{alias}' → 디바이스 '{real_id}'을(를) 찾을 수 없습니다")
                else:
                    errors.append(f"디바이스 '{alias}'을(를) 찾을 수 없습니다 (매핑 없음)")
            elif dev.status in ("offline", "disconnected"):
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

    async def execute_single_step(self, step: Step, scenario_name: str, device_map: Optional[dict[str, str]] = None) -> StepResult:
        """Execute a single step with verification (for testing individual steps)."""
        self._device_map = device_map or {}
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

            # Wait (중단 가능)
            if await self._interruptible_sleep(step.delay_after_ms / 1000.0):
                step_result.status = "error"
                step_result.error_message = "Stopped by user"
                return step_result
            t3 = time.time()

            # 2) 이미지 비교 전: 스크린샷 대상 디바이스 연결 확인
            ss_device = self._resolve_screenshot_device(step)
            if ss_device:
                await self._ensure_device_connected(ss_device["id"])
            t4 = time.time()
            actual_path = None
            if ss_device:
                actual_dir = SCREENSHOTS_DIR / scenario_name / "actual"
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
                    await self.adb.screencap(actual_path, serial=adb_serial, sf_display_id=sf_did)
                elif ss_device["type"] == "hkmc6th":
                    hkmc_svc = self.dm.get_hkmc_service(ss_device["id"])
                    if hkmc_svc:
                        img_bytes = await hkmc_svc.async_screencap_bytes(
                            screen_type=ss_device.get("screen_type", "front_center"), fmt="png"
                        )
                        Path(actual_path).write_bytes(img_bytes)

                actual_rel = f"{scenario_name}/actual/{file_prefix}.png"
                step_result.actual_image = actual_rel

                # Verify against expected image
                has_expected = step.expected_image or (step.compare_mode == CompareMode.MULTI_CROP and step.expected_images)
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
                                step_result.actual_annotated_image = f"{scenario_name}/actual/{file_prefix}_annotated.png"
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
                                        step_result.expected_annotated_image = f"{scenario_name}/actual/{file_prefix}_expected_annotated.png"
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
                                    step_result.actual_annotated_image = f"{scenario_name}/actual/{file_prefix}_annotated.png"
                            except Exception as e:
                                logger.warning("Failed to generate exclude annotated image: %s", e)

                            if step_result.status != "pass":
                                diff_path = str(actual_dir / f"diff_{file_prefix}.png")
                                diff_rel = f"{scenario_name}/actual/diff_{file_prefix}.png"
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
                                        step_result.expected_annotated_image = f"{scenario_name}/actual/{file_prefix}_expected_annotated.png"
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
                                        step_result.actual_annotated_image = f"{scenario_name}/actual/{file_prefix}_annotated.png"
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
                                        step_result.actual_annotated_image = f"{scenario_name}/actual/{file_prefix}_annotated.png"
                                        step_result.match_location = {"x": r.x, "y": r.y, "width": r.width, "height": r.height}
                                except Exception as e:
                                    logger.warning("Failed to generate annotated image: %s", e)

                            if step_result.status != "pass":
                                diff_path = str(actual_dir / f"diff_{file_prefix}.png")
                                diff_rel = f"{scenario_name}/actual/diff_{file_prefix}.png"
                                try:
                                    self.image_compare.generate_diff_heatmap(
                                        expected_path, compare_actual, diff_path
                                    )
                                    step_result.diff_image = diff_rel
                                except Exception as e:
                                    logger.warning("Failed to generate diff: %s", e)

                            step_result.message = f"Similarity: {judgement['score']:.4f}"
                else:
                    dev_label = ss_device["id"] if ss_device else step.device_id or "default"
                    step_result.message = f"Executed on {dev_label} (기대 이미지 없음)"
            else:
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

    async def _ensure_device_connected(self, device_id: str, max_retries: int = 3, retry_interval: float = 3.0) -> None:
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
            try:
                adb_devices = await self.adb.list_devices()
                found = next((d for d in adb_devices if d.serial == dev.address), None)
                if found and found.status == "device":
                    dev.status = "connected"
                else:
                    dev.status = "offline"
            except Exception:
                pass

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
            None (no screenshot possible)
        """
        # 스크린샷 불필요한 경우: serial/module이면서 기대이미지 없음, wait이면서 기대이미지 없음
        if step.type in (StepType.SERIAL_COMMAND, StepType.MODULE_COMMAND) and not step.expected_image:
            return None
        if step.type == StepType.WAIT and not step.expected_image:
            return None
        real_id = self._resolve_real_device_id(step)
        if real_id:
            dev = self.dm.get_device(real_id)
            if dev and dev.type in ("serial", "module"):
                # 보조 디바이스는 스크린샷 불가 → primary 디바이스로 폴백
                pass
            elif dev and dev.type == "hkmc6th":
                screen_type = step.screen_type or step.params.get("screen_type", "front_center")
                return {"type": "hkmc6th", "id": dev.id, "screen_type": screen_type}
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
            if real_id:
                dev = self.dm.get_device(real_id)
                if dev:
                    ctor_kwargs = _build_ctor_kwargs(dev)
            await execute_module_function(module_name, func_name, func_args, ctor_kwargs)
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
            hkmc = self.dm.get_hkmc_service(real_id)
            if not hkmc:
                raise ValueError(f"HKMC device {real_id} not connected")
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
        elif step.type == StepType.WAIT:
            await self._interruptible_sleep(params.get("duration_ms", 1000) / 1000.0)
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
            adb_display_id = None
            st = step.screen_type or params.get("screen_type")
            if st is not None:
                try:
                    adb_display_id = int(st)
                    if adb_display_id == 0:
                        adb_display_id = None
                except (ValueError, TypeError):
                    pass

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
                await self.adb.run_shell_command(params["command"], serial=serial)

    async def _save_result(self, result: ScenarioResult) -> str:
        """Save execution result to JSON."""
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filepath = RESULTS_DIR / f"{result.scenario_name}_{timestamp}.json"
        filepath.write_text(result.model_dump_json(indent=2), encoding="utf-8")
        logger.info("Result saved: %s", filepath)
        return str(filepath)
