"""Playback & Verification service — 시나리오 재생 및 검증."""

from __future__ import annotations

import asyncio
import logging
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncGenerator, Optional

from ..models.scenario import CompareMode, Scenario, ScenarioResult, Step, StepResult, StepType, SubResult


def _set_sleep_block(block: bool):
    """Windows 절전 모드 차단/해제. 비Windows에서는 무시."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        ES_CONTINUOUS = 0x80000000
        if block:
            ctypes.windll.kernel32.SetThreadExecutionState(
                ES_CONTINUOUS | 0x00000001 | 0x00000002  # SYSTEM + DISPLAY
            )
        else:
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
    except Exception:
        pass
from .adb_service import ADBService
from .device_manager import DeviceManager
from .image_compare_service import ImageCompareService
from .module_service import execute_module_function

from ..utils.cv_io import safe_imread, safe_imwrite

logger = logging.getLogger(__name__)

SCREENSHOTS_DIR = Path(__file__).resolve().parent.parent.parent / "screenshots"


# ================================================================
# Event Broadcaster — 재생 이벤트를 여러 WebSocket 구독자에게 fan-out
# ================================================================
# WebSocket이 끊어져도 백그라운드 재생은 계속 동작하고, 새로 연결된
# client가 "subscribe" 하면 버퍼링된 최근 이벤트를 재전송 받아 상태를 복구할 수 있다.

_EVENT_BUFFER_MAX = 500  # 재연결 시 replay용 — 그 이전 이벤트는 result.json에서 복원 가능
_event_subscribers: set["asyncio.Queue[dict]"] = set()
_event_buffer: list[dict] = []
_event_buffer_lock = asyncio.Lock()
# 버퍼에 저장할 때 step_result payload에서 제거할 heavy 필드 집합.
# 라이브 브로드캐스트에는 그대로 전달되고, 버퍼 replay 시에만 축약된 형태가 사용된다.
_BUFFER_STRIP_FIELDS = {"sub_results", "match_location", "roi"}

# 현재 실행 중인 백그라운드 재생 태스크 — stop() 이 완전 종료를 기다릴 수 있도록
# 외부(main.py _run_play_job 등)에서 등록한다.
_bg_playback_task: "asyncio.Task | None" = None


def set_bg_playback_task(task: "asyncio.Task | None") -> None:
    """백그라운드 재생 태스크 참조 등록. 새 재생 시작 시 호출."""
    global _bg_playback_task
    _bg_playback_task = task


async def await_bg_playback_task(timeout: float = 15.0) -> bool:
    """등록된 백그라운드 재생 태스크가 완전히 종료될 때까지 대기.

    Returns True if the task finished (or was None), False on timeout.
    재시작 로직이 stop 직후 즉시 새 재생을 시작할 수 있도록 동기화 목적으로 사용.
    """
    t = _bg_playback_task
    if t is None or t.done():
        return True
    try:
        await asyncio.wait_for(asyncio.shield(t), timeout=timeout)
        return True
    except asyncio.TimeoutError:
        logger.warning("Background playback task did not finish within %ss", timeout)
        return False
    except Exception:
        # 태스크 내부 예외는 무시 — 종료만 기다림
        return True
# 현재 재생이 실제로 진행 중인지 여부 — 중단/완료된 run의 버퍼를 새 subscriber에게 replay하지 않기 위해 사용.
_playback_active: bool = False


def mark_playback_active(active: bool) -> None:
    """새 재생 시작 시 True, 종료/중단 시 False. 버퍼 replay 여부를 결정한다."""
    global _playback_active
    _playback_active = active


def subscribe_events() -> "asyncio.Queue[dict]":
    """재생 이벤트 구독 — 새 Queue를 생성한다.

    현재 재생이 진행 중일 때만 최근 버퍼를 replay한다 (재연결 시 상태 복구).
    재생이 끝났거나 중단된 상태에서는 이전 run의 이벤트가 새 subscriber에게
    유입되지 않도록 버퍼 replay를 건너뛴다.

    호출 측은 이벤트 처리 후 unsubscribe_events를 반드시 호출해야 함.
    """
    q: asyncio.Queue = asyncio.Queue(maxsize=5000)
    if _playback_active:
        for ev in list(_event_buffer):
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                break
    _event_subscribers.add(q)
    logger.debug("Event subscriber added (total=%d, replay=%s)",
                 len(_event_subscribers), _playback_active)
    return q


def unsubscribe_events(q: "asyncio.Queue[dict]") -> None:
    """구독 해제."""
    _event_subscribers.discard(q)
    logger.debug("Event subscriber removed (total=%d)", len(_event_subscribers))


def _slim_for_buffer(event: dict) -> dict:
    """버퍼 저장용 경량 복사본. step_result의 heavy 필드를 제거하여 장시간 재생 시
    이벤트 버퍼 메모리 점유를 크게 낮춘다. 라이브 구독자에는 원본이 전달된다."""
    if event.get("type") != "step_result":
        return event
    data = event.get("data")
    if not isinstance(data, dict):
        return event
    slim_data = {k: v for k, v in data.items() if k not in _BUFFER_STRIP_FIELDS}
    return {**event, "data": slim_data}


def publish_event(event: dict) -> None:
    """이벤트를 모든 구독자에게 브로드캐스트 + 버퍼에 추가.
    버퍼에는 축약본을 저장해 장시간 재생 시 메모리 점유를 억제한다."""
    _event_buffer.append(_slim_for_buffer(event))
    if len(_event_buffer) > _EVENT_BUFFER_MAX:
        _event_buffer.pop(0)
    for q in list(_event_subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            # 느린 subscriber → 이벤트 drop (재접속 시 버퍼에서 복구)
            pass


def clear_event_buffer() -> None:
    """새 재생 시작 시 버퍼 초기화 (구독자는 유지)."""
    _event_buffer.clear()


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
        self._run_output_dir_owned = False  # 이 함수가 직접 output dir을 만들었는지
        self._group_scenario_index: int = 0  # 그룹 내 시나리오 순서 (1-based, 0=단일)

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def is_paused(self) -> bool:
        return not self._pause_event.is_set()

    async def stop(self) -> None:
        """재생 중단 요청 + 백그라운드 태스크가 실제로 종료될 때까지 대기.

        호출이 리턴되면 이전 run이 완전히 정리된 상태이므로, 호출자는 바로
        다음 재생을 시작할 수 있다. 장시간 블록되는 액션(예: 모듈 커맨드)이
        걸려 있으면 최대 15초 대기 후 반환한다.
        """
        self._should_stop = True
        self._pause_event.set()  # 일시정지 중이면 풀어서 루프 종료 가능하게
        await await_bg_playback_task(timeout=15.0)

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
        _set_sleep_block(True)
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
                else:
                    result.error_steps += 1

                # Conditional jump
                next_idx = idx + 1
                if step_result.status == "pass" and step.on_pass_goto is not None:
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
            _set_sleep_block(False)
            self._cleanup_run_output_dir()
            result.finished_at = datetime.now(timezone.utc).isoformat()

        # Determine overall status
        if result.failed_steps > 0 or result.error_steps > 0:
            result.status = "fail"
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
        group_scenario_index: int = 0,
    ) -> AsyncGenerator:
        """Execute scenario and yield step results one by one (for WebSocket streaming).

        Args:
            start_step: 0-based step index to start execution from (skip earlier steps).
        """
        self._device_map = self._resolve_device_map(scenario, device_map_override)
        self._group_scenario_index = group_scenario_index
        self._running = True
        _set_sleep_block(True)
        # 그룹 재생에서 호출 시 _should_stop을 리셋하면 안 됨 (이미 설정된 경우)
        if not self._result_timestamp:
            self._should_stop = False
        self._current_iteration = repeat_index - 1  # 0-based for cycle wait
        if not self._result_timestamp:
            self._result_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            self._setup_run_output_dir(scenario.name)
            self._run_output_dir_owned = True
        else:
            self._run_output_dir_owned = False

        # Build step lookup by ID for conditional jumps
        step_by_id: dict[int, int] = {}  # step.id -> index
        for i, s in enumerate(scenario.steps):
            step_by_id[s.id] = i

        # 그룹 재생 시 호출자(main.py)가 _result_timestamp를 미리 설정하므로
        # 여기서 cleanup하면 안 됨 — _is_group_member로 판별
        _is_group_member = self._result_timestamp != "" and not self._run_output_dir_owned
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
                if step_result.status == "pass" and step.on_pass_goto is not None:
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
            _set_sleep_block(False)
            if not _is_group_member:
                self._cleanup_run_output_dir()

    async def execute_single_step(self, step: Step, scenario_name: str, device_map: Optional[dict[str, str]] = None) -> StepResult:
        """Execute a single step with verification (for testing individual steps).

        매 호출마다 ``actual_<ms_timestamp>/`` 서브디렉토리에 캡처를 저장하여
        이전 테스트 이미지와의 경로 충돌을 원천 차단한다 (브라우저/antd Image
        컴포넌트의 preview 캐싱 우회 목적). cleanup은 clean-test-screenshots가
        ``actual*`` 패턴을 일괄 삭제한다.

        이전 full playback이 중간에 끊겨 _run_output_dir이 남아 있으면 스크린샷이
        results 폴더로 저장되어 프론트엔드(/screenshots/ 기준)에서 404가 나므로
        상태를 명시적으로 리셋한다.
        """
        self._should_stop = False  # 이전 재생 중단 플래그 초기화
        self._pause_event.set()    # 이전 재생이 pause 상태로 끝난 경우 풀어줌
        self._device_map = device_map or {}
        self._current_iteration = 0  # 단일 테스트는 항상 0번째
        # 이전 run의 stale 상태 제거 — 프론트 이미지 URL 일관성 보장
        self._run_output_dir = None
        self._run_output_dir_owned = False
        # 매 호출마다 고유 ms timestamp → actual_<ms> 서브디렉토리 사용
        self._result_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
        self._group_scenario_index = 0
        try:
            return await self._execute_step(step, scenario_name, verify=True)
        finally:
            self._result_timestamp = ""

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
                step_result.message = "Stopped by user"
                return step_result
            t0 = time.time()
            action_device_id = self._resolve_real_device_id(step)
            if action_device_id:
                await self._ensure_device_connected(action_device_id)
            t1 = time.time()

            # Execute the action
            if self._should_stop:
                step_result.status = "error"
                step_result.message = "Stopped by user"
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

            # Wait (중단 가능)
            if await self._interruptible_sleep(step.delay_after_ms / 1000.0):
                step_result.status = "error"
                step_result.message = "Stopped by user"
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
                # 스크린샷을 results 런 폴더에 직접 저장
                if self._run_output_dir and self._run_output_dir.exists():
                    # 그룹 재생: {run_dir}/{scenario_name}/screenshots/
                    # 단일 재생: {run_dir}/screenshots/
                    if not self._run_output_dir_owned:
                        safe_sc = re.sub(r'[\\/:*?"<>|→]', '_', scenario_name).replace(" ", "_")
                        _gsi = self._group_scenario_index
                        prefix = f"{_gsi:02d}_" if _gsi > 0 else ""
                        actual_dir = self._run_output_dir / f"{prefix}{safe_sc}" / "screenshots"
                    else:
                        actual_dir = self._run_output_dir / "screenshots"
                else:
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
                elif ss_device["type"] == "isap_agent":
                    isap_svc = self.dm.get_isap_service(ss_device["id"])
                    if isap_svc:
                        img_bytes = await isap_svc.async_screencap_bytes(
                            screen_type=ss_device.get("screen_type", "front_center"), fmt="png"
                        )
                        with open(actual_path, "wb") as f:
                            f.write(img_bytes)
                    else:
                        raise RuntimeError(f"iSAP device {ss_device['id']} not connected")
                elif ss_device["type"] == "hkmc6th":
                    hkmc_svc = self.dm.get_hkmc_service(ss_device["id"])
                    if hkmc_svc:
                        img_bytes = await hkmc_svc.async_screencap_bytes(
                            screen_type=ss_device.get("screen_type", "front_center"), fmt="png"
                        )
                        Path(actual_path).write_bytes(img_bytes)
                    else:
                        raise RuntimeError(f"HKMC device {ss_device['id']} not connected")
                elif ss_device["type"] == "vision_camera":
                    cam = self.dm.get_vision_camera(ss_device["id"])
                    if cam:
                        loop = asyncio.get_event_loop()
                        saved = await loop.run_in_executor(
                            None, cam.CaptureToFile, actual_path
                        )
                elif ss_device["type"] == "webcam":
                    cam = self.dm.get_webcam_device(ss_device["id"])
                    if cam:
                        loop = asyncio.get_event_loop()
                        await loop.run_in_executor(
                            None, cam.CaptureToFile, actual_path
                        )
                    else:
                        raise RuntimeError(f"Webcam device {ss_device['id']} not connected")

                step_result.actual_image = self._rel_path(actual_path, scenario_name)

                # Verify against expected image
                if verify and has_expected:
                    mode = step.compare_mode or CompareMode.FULL
                    step_result.compare_mode = mode.value if isinstance(mode, CompareMode) else mode

                    expected_path = str(SCREENSHOTS_DIR / scenario_name / step.expected_image) if step.expected_image else ""
                    if step.expected_image:
                        step_result.expected_image = f"{scenario_name}/{step.expected_image}"
                    step_result.roi = step.roi

                    # 모든 비교/주석 경로에서 재사용할 단일 ndarray를 먼저 로드.
                    # 실패 스텝당 기존 3~5회 imread → 1회로 축소.
                    act_img_ndarray = await asyncio.to_thread(safe_imread, actual_path)
                    exp_img_ndarray = None
                    if expected_path:
                        exp_img_ndarray = await asyncio.to_thread(safe_imread, expected_path)

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
                        judgement = await asyncio.to_thread(
                            self.image_compare.judge,
                            expected_path="",
                            actual_path=actual_path,
                            threshold_pass=step.similarity_threshold,
                            compare_mode="multi_crop",
                            crop_items=crop_items,
                            img_act=act_img_ndarray,
                        )
                        step_result.status = judgement["status"]
                        step_result.sub_results = [SubResult(**sr) for sr in judgement.get("sub_results", [])]

                        if judgement["status"] == "error":
                            step_result.message = judgement.get("message", "Multi-crop comparison error")
                        else:
                            # Generate annotated image with all match boxes
                            try:
                                annotated_path = str(actual_dir / f"{file_prefix}_annotated.png")
                                await asyncio.to_thread(
                                    self.image_compare.generate_multi_crop_annotated,
                                    actual_path, judgement.get("sub_results", []), annotated_path,
                                    act_img_ndarray,
                                )
                                step_result.actual_annotated_image = self._rel_path(annotated_path, scenario_name)
                            except Exception as e:
                                logger.warning("Failed to generate multi-crop annotated image: %s", e)

                            # Generate annotated expected image: only crop regions visible, rest darkened
                            if exp_img_ndarray is not None:
                                def _build_multi_crop_expected_annotated():
                                    import cv2
                                    dark = (exp_img_ndarray * 0.2).astype("uint8")
                                    for ci in step.expected_images:
                                        if ci.roi:
                                            r = ci.roi
                                            dark[r.y:r.y + r.height, r.x:r.x + r.width] = exp_img_ndarray[r.y:r.y + r.height, r.x:r.x + r.width]
                                            cv2.rectangle(dark, (r.x, r.y), (r.x + r.width, r.y + r.height), (0, 255, 0), 2)
                                    exp_ann_path = str(actual_dir / f"{file_prefix}_expected_annotated.png")
                                    safe_imwrite(exp_ann_path, dark)
                                    return exp_ann_path
                                try:
                                    built = await asyncio.to_thread(_build_multi_crop_expected_annotated)
                                    if built:
                                        step_result.expected_annotated_image = self._rel_path(built, scenario_name)
                                except Exception as e:
                                    logger.warning("Failed to generate multi-crop expected annotated: %s", e)

                            parts = [f"{sr.label or f'#{i+1}'}:{sr.status}({sr.score:.2f})" for i, sr in enumerate(step_result.sub_results)]
                            step_result.message = f"Multi-crop: {', '.join(parts)}"

                    elif mode == CompareMode.FULL_EXCLUDE:
                        # --- Full-exclude mode ---
                        exclude_rois_dicts = [r.model_dump() for r in step.exclude_rois]
                        judgement = await asyncio.to_thread(
                            self.image_compare.judge,
                            expected_path,
                            actual_path,
                            threshold_pass=step.similarity_threshold,
                            compare_mode="full_exclude",
                            exclude_rois=exclude_rois_dicts,
                            img_exp=exp_img_ndarray,
                            img_act=act_img_ndarray,
                        )
                        step_result.status = judgement["status"]
                        step_result.similarity_score = judgement["score"]
                        _diff_array = judgement.get("diff_array")  # 재사용용 SSIM diff

                        if judgement["status"] == "error":
                            step_result.message = judgement.get("message", "Exclude comparison error")
                        else:
                            def _build_exclude_actual_annotated():
                                import cv2
                                if act_img_ndarray is None:
                                    return False
                                img_annotated = act_img_ndarray.copy()
                                overlay = img_annotated.copy()
                                for r in step.exclude_rois:
                                    cv2.rectangle(overlay, (r.x, r.y), (r.x + r.width, r.y + r.height), (128, 128, 128), -1)
                                cv2.addWeighted(overlay, 0.5, img_annotated, 0.5, 0, img_annotated)
                                for r in step.exclude_rois:
                                    cv2.rectangle(img_annotated, (r.x, r.y), (r.x + r.width, r.y + r.height), (0, 0, 255), 2)
                                annotated_path = str(actual_dir / f"{file_prefix}_annotated.png")
                                safe_imwrite(annotated_path, img_annotated)
                                return True
                            try:
                                if await asyncio.to_thread(_build_exclude_actual_annotated):
                                    step_result.actual_annotated_image = self._rel_path(str(actual_dir / f"{file_prefix}_annotated.png"), scenario_name)
                            except Exception as e:
                                logger.warning("Failed to generate exclude annotated image: %s", e)

                            if step_result.status != "pass":
                                diff_path = str(actual_dir / f"diff_{file_prefix}.png")
                                diff_rel = self._rel_path(diff_path, scenario_name)
                                try:
                                    await asyncio.to_thread(
                                        self.image_compare.generate_diff_heatmap,
                                        expected_path, actual_path, diff_path,
                                        None, exclude_rois_dicts,
                                        exp_img_ndarray, act_img_ndarray, _diff_array,
                                    )
                                    step_result.diff_image = diff_rel
                                except Exception as e:
                                    logger.warning("Failed to generate diff: %s", e)

                            if exp_img_ndarray is not None:
                                def _build_exclude_expected_annotated():
                                    import cv2
                                    overlay = exp_img_ndarray.copy()
                                    for r in step.exclude_rois:
                                        cv2.rectangle(overlay, (r.x, r.y), (r.x + r.width, r.y + r.height), (128, 128, 128), -1)
                                    cv2.addWeighted(overlay, 0.5, exp_img_ndarray, 0.5, 0, overlay)
                                    for r in step.exclude_rois:
                                        cv2.rectangle(overlay, (r.x, r.y), (r.x + r.width, r.y + r.height), (0, 0, 255), 2)
                                    exp_ann_path = str(actual_dir / f"{file_prefix}_expected_annotated.png")
                                    safe_imwrite(exp_ann_path, overlay)
                                    return True
                                try:
                                    if await asyncio.to_thread(_build_exclude_expected_annotated):
                                        step_result.expected_annotated_image = self._rel_path(str(actual_dir / f"{file_prefix}_expected_annotated.png"), scenario_name)
                                except Exception as e:
                                    logger.warning("Failed to generate exclude expected annotated: %s", e)

                            step_result.message = f"Exclude {len(step.exclude_rois)} regions: {judgement['score']:.4f}"

                    else:
                        # --- Full / Single-crop mode ---
                        compare_actual_path = actual_path
                        compare_actual_img = act_img_ndarray
                        if step.roi and act_img_ndarray is not None:
                            def _crop_actual_roi():
                                r = step.roi
                                cropped = act_img_ndarray[r.y:r.y + r.height, r.x:r.x + r.width]
                                cropped_path = str(actual_dir / f"{file_prefix}_roi.png")
                                safe_imwrite(cropped_path, cropped)
                                return cropped_path, cropped
                            cropped_ret = await asyncio.to_thread(_crop_actual_roi)
                            if cropped_ret:
                                compare_actual_path = cropped_ret[0]
                                compare_actual_img = cropped_ret[1]

                        judgement = await asyncio.to_thread(
                            self.image_compare.judge,
                            expected_path,
                            compare_actual_path,
                            threshold_pass=step.similarity_threshold,
                            img_exp=exp_img_ndarray,
                            img_act=compare_actual_img,
                        )
                        step_result.status = judgement["status"]
                        step_result.similarity_score = judgement["score"]
                        _diff_array = judgement.get("diff_array")

                        if judgement["status"] == "error":
                            step_result.message = judgement.get("message", "Image comparison error")
                        else:
                            match_loc = judgement.get("match_location")
                            if match_loc:
                                step_result.match_location = match_loc
                                def _build_match_annotated():
                                    import cv2
                                    if act_img_ndarray is None:
                                        return False
                                    img_annotated = act_img_ndarray.copy()
                                    x, y = match_loc["x"], match_loc["y"]
                                    w, h = match_loc["width"], match_loc["height"]
                                    cv2.rectangle(img_annotated, (x, y), (x + w, y + h), (0, 0, 255), 3)
                                    annotated_path = str(actual_dir / f"{file_prefix}_annotated.png")
                                    safe_imwrite(annotated_path, img_annotated)
                                    return True
                                try:
                                    if await asyncio.to_thread(_build_match_annotated):
                                        step_result.actual_annotated_image = self._rel_path(str(actual_dir / f"{file_prefix}_annotated.png"), scenario_name)
                                except Exception as e:
                                    logger.warning("Failed to generate annotated image: %s", e)
                            elif step.roi:
                                def _build_roi_annotated():
                                    import cv2
                                    if act_img_ndarray is None:
                                        return False
                                    img_annotated = act_img_ndarray.copy()
                                    r = step.roi
                                    cv2.rectangle(img_annotated, (r.x, r.y), (r.x + r.width, r.y + r.height), (0, 0, 255), 3)
                                    annotated_path = str(actual_dir / f"{file_prefix}_annotated.png")
                                    safe_imwrite(annotated_path, img_annotated)
                                    return True
                                try:
                                    if await asyncio.to_thread(_build_roi_annotated):
                                        step_result.actual_annotated_image = self._rel_path(str(actual_dir / f"{file_prefix}_annotated.png"), scenario_name)
                                        step_result.match_location = {"x": step.roi.x, "y": step.roi.y, "width": step.roi.width, "height": step.roi.height}
                                except Exception as e:
                                    logger.warning("Failed to generate annotated image: %s", e)

                            if step_result.status != "pass":
                                diff_path = str(actual_dir / f"diff_{file_prefix}.png")
                                diff_rel = self._rel_path(diff_path, scenario_name)
                                try:
                                    await asyncio.to_thread(
                                        self.image_compare.generate_diff_heatmap,
                                        expected_path, compare_actual_path, diff_path,
                                        None, None,
                                        exp_img_ndarray, compare_actual_img, _diff_array,
                                    )
                                    step_result.diff_image = diff_rel
                                except Exception as e:
                                    logger.warning("Failed to generate diff: %s", e)

                            sim_msg = f"Similarity: {judgement['score']:.4f}"
                            if step_result.message:
                                step_result.message = f"{step_result.message}\n{sim_msg}"
                            else:
                                step_result.message = sim_msg

                    # 이미지 ndarray 즉시 해제하여 GC가 곧바로 수거할 수 있게 한다.
                    act_img_ndarray = None
                    exp_img_ndarray = None
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
        # RAND 스텝은 random_log.txt에 별도 기록 + step 메시지 보강
        # (description이 "RAND " 로 시작하면 RAND 출처로 간주 — 프론트 randHK/SK/DRAG가 그렇게 라벨함)
        try:
            desc = (step.description or "")
            if desc.startswith("RAND "):
                self._log_random_step(scenario_name, step, step_result, repeat_index)
        except Exception as _e:
            logger.debug("random log write failed: %s", _e)
        return step_result

    def _format_random_action(self, step: Step) -> str:
        """RAND 스텝의 실제 동작을 사람이 읽기 쉬운 한 줄로 요약."""
        p = step.params or {}
        t = step.type
        if t == StepType.HKMC_KEY:
            kn = p.get("key_name", "")
            sub = p.get("sub_cmd", 0x43)
            sub_label = "LONG" if sub == 0x44 else "SHORT" if sub == 0x43 else f"sub=0x{int(sub):02X}"
            scr = p.get("screen_type", "")
            return f"HK key={kn} {sub_label} screen={scr}"
        if t == StepType.HKMC_TOUCH:
            return f"SK ({p.get('x',0)},{p.get('y',0)}) screen={p.get('screen_type','')}"
        if t == StepType.HKMC_SWIPE:
            return f"DRAG ({p.get('x1',0)},{p.get('y1',0)})→({p.get('x2',0)},{p.get('y2',0)}) {p.get('duration_ms',0)}ms screen={p.get('screen_type','')}"
        # 일반 ADB 등도 혹시 RAND 라벨이 붙으면 동일 포맷으로
        return f"{t.value if hasattr(t, 'value') else t} {p}"

    def _log_random_step(self, scenario_name: str, step: Step,
                         step_result: StepResult, repeat_index: int) -> None:
        """RAND 출처 step의 실행 결과를 run_dir/random_log.txt 에 append.

        목적: 스트레스 테스트 시 어느 cycle/step에서 어떤 무작위 동작이
        실행됐고 결과가 무엇이었는지 추적하기 위함.
        """
        # 출력 경로: run_dir 우선, 없으면 scenarioname 기반 results dir
        run_dir = self._run_output_dir
        if run_dir is None or not run_dir.exists():
            # 단일 시나리오 fallback
            run_dir = RESULTS_DIR / f"{scenario_name}_{self._result_timestamp or 'manual'}"
            run_dir.mkdir(parents=True, exist_ok=True)
        log_path = run_dir / "random_log.txt"

        # 첫 줄에 헤더 1회 작성
        is_new = not log_path.exists()
        action_summary = self._format_random_action(step)
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        line = (
            f"{ts}\tcycle={repeat_index}\tstep_id={step.id}\t"
            f"status={step_result.status}\tduration={step_result.execution_time_ms}ms\t"
            f"desc={(step.description or '').strip()}\t"
            f"action={action_summary}\n"
        )
        try:
            with open(log_path, "a", encoding="utf-8") as f:
                if is_new:
                    f.write("# Random action log — timestamp / cycle / step_id / status / duration / desc / action\n")
                f.write(line)
        except Exception as e:
            logger.debug("random_log.txt write failed: %s", e)

        # step_result.message 에도 한 줄 요약 prepend (UI 결과 테이블에서 즉시 확인 가능)
        prefix = f"[RAND] {action_summary}"
        if step_result.message and step_result.message.strip():
            step_result.message = f"{prefix}\n{step_result.message}"
        else:
            step_result.message = prefix

    @staticmethod
    def _format_command(step: Step) -> str:
        """Format a human-readable command description for the step."""
        p = step.params
        if step.type == StepType.TAP:
            return f"tap ({p.get('x', 0)}, {p.get('y', 0)})"
        elif step.type == StepType.REPEAT_TAP:
            return f"repeat_tap ({p.get('x', 0)}, {p.get('y', 0)}) ×{p.get('count', 5)} @{p.get('interval_ms', 100)}ms"
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
        elif step.type == StepType.ALL_RANDOM:
            rc = int(p.get("repeat_count", 1))
            iv = int(p.get("interval_ms", 0))
            return f"all_random ×{rc} @{iv}ms"
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
            # device_manager와 동일한 재연결 락으로 직렬화 — race condition 제거.
            # 잠긴 동안 monitor 루프가 같은 디바이스를 건드리지 못함.
            lock = self.dm.get_reconnect_lock(device_id)
            async with lock:
                # 락 획득 후 재검사: 다른 경로가 이미 성공시켰을 수 있음
                hkmc = self.dm.get_hkmc_service(device_id)
                if hkmc and hkmc.is_connected:
                    return
                for attempt in range(1, max_retries + 1):
                    if self._should_stop:
                        return
                    logger.info("Playback: reconnect %s attempt %d/%d", device_id, attempt, max_retries)
                    try:
                        hkmc = self.dm.get_hkmc_service(device_id)
                        if hkmc:
                            # disconnect()는 내부적으로 recv_thread.join(timeout=3)을 호출하는 blocking 호출.
                            # 직접 호출하면 event loop를 최대 3초 블록 → uvicorn WS ping 예산을 까먹음.
                            await hkmc.async_disconnect()
                        svc = HKMC6thService(dev.address, port, device_id=dev.id,
                                               key_overrides=dev.info.get("hkmc_keys"))
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

        elif dev.type == "isap_agent":
            isap = self.dm.get_isap_service(device_id)
            if isap and isap.is_connected:
                return
            port = dev.info.get("port", 0)
            if not port:
                return
            from .isap_agent_service import ISAPAgentService
            lock = self.dm.get_reconnect_lock(device_id)
            async with lock:
                isap = self.dm.get_isap_service(device_id)
                if isap and isap.is_connected:
                    return
                for attempt in range(1, max_retries + 1):
                    if self._should_stop:
                        return
                    logger.info("Playback: iSAP reconnect %s attempt %d/%d", device_id, attempt, max_retries)
                    try:
                        isap = self.dm.get_isap_service(device_id)
                        if isap:
                            await isap.async_disconnect()
                        svc = ISAPAgentService(dev.address, port, device_id=dev.id,
                                               key_overrides=dev.info.get("isap_keys"))
                        ok = await svc.async_connect()
                        if ok:
                            self.dm._isap_conns[dev.id] = svc
                            self.dm._isap_reconnect_attempts.pop(dev.id, None)
                            dev.status = "connected"
                            dev.info["agent_version"] = svc.agent_version
                            dev.info["screens"] = svc.get_info()["screens"]
                            logger.info("Playback: iSAP reconnected %s", device_id)
                            return
                    except Exception as e:
                        logger.debug("Playback: iSAP reconnect %s failed: %s", device_id, e)
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

    def _is_hkmc_device(self, device_id: Optional[str]) -> bool:
        """디바이스가 HKMC/iSAP 에이전트 TCP 프로토콜 타입인지 확인."""
        if not device_id:
            return False
        dev = self.dm.get_device(device_id)
        return dev is not None and dev.type in ("hkmc6th", "isap_agent")

    def _get_agent_service(self, device_id: Optional[str]):
        """Return (svc, is_isap) for hkmc6th 또는 isap_agent device, or (None, False)."""
        if not device_id:
            return None, False
        dev = self.dm.get_device(device_id)
        if not dev:
            return None, False
        if dev.type == "isap_agent":
            return self.dm.get_isap_service(device_id), True
        if dev.type == "hkmc6th":
            return self.dm.get_hkmc_service(device_id), False
        return None, False

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
        # all_random은 스트레스성 스텝이라 기대이미지 없으면 비교 스킵 (화면이 예측 불가)
        if step.type == StepType.ALL_RANDOM and not step.expected_image:
            return None

        # screenshot_device_id가 저장되어 있으면 해당 디바이스 우선 사용
        # device_map을 통해 실제 디바이스 ID로 매핑
        if step.screenshot_device_id:
            resolved_ss_id = self._resolve_alias(step.screenshot_device_id, self._device_map)
            ss_dev = self.dm.get_device(resolved_ss_id)
            if ss_dev:
                if ss_dev.type == "hkmc6th":
                    screen_type = step.screen_type or step.params.get("screen_type", "front_center")
                    return {"type": "hkmc6th", "id": ss_dev.id, "screen_type": screen_type}
                if ss_dev.type == "isap_agent":
                    screen_type = step.screen_type or step.params.get("screen_type", "front_center")
                    return {"type": "isap_agent", "id": ss_dev.id, "screen_type": screen_type}
                if ss_dev.type == "vision_camera":
                    return {"type": "vision_camera", "id": ss_dev.id}
                if ss_dev.type == "webcam":
                    return {"type": "webcam", "id": ss_dev.id}
                if ss_dev.type == "adb":
                    result = {"type": "adb", "id": ss_dev.id, "serial": ss_dev.address}
                    adb_screen = step.screen_type or step.params.get("screen_type")
                    if adb_screen:
                        result["screen_type"] = adb_screen
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
            elif dev and dev.type == "isap_agent":
                screen_type = step.screen_type or step.params.get("screen_type", "front_center")
                return {"type": "isap_agent", "id": dev.id, "screen_type": screen_type}
            elif dev and dev.type == "vision_camera":
                return {"type": "vision_camera", "id": dev.id}
            elif dev and dev.type == "webcam":
                return {"type": "webcam", "id": dev.id}
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
            if dev.type == "isap_agent":
                return {"type": "isap_agent", "id": dev.id, "screen_type": "front_center"}
            if dev.type == "vision_camera":
                return {"type": "vision_camera", "id": dev.id}
            if dev.type == "webcam":
                return {"type": "webcam", "id": dev.id}
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
            ssh_credentials = None
            adb_serial: Optional[str] = None
            if real_id:
                dev = self.dm.get_device(real_id)
                if dev:
                    ctor_kwargs = _build_ctor_kwargs(dev)
                    shared_conn = self.dm.get_serial_conn(real_id)
                    # SSH 디바이스: 저장된 자격증명을 SSHManager.create_ssh_client에 전달
                    if dev.type == "ssh":
                        ssh_credentials = {
                            "host": dev.info.get("host", dev.address),
                            "port": int(dev.info.get("port", 22)),
                            "username": dev.info.get("username", ""),
                            "password": dev.info.get("password", ""),
                            "key_file_path": dev.info.get("key_file_path", ""),
                        }
                    # ADB 디바이스: Android 모듈의 Send_adb_command가 사용
                    if dev.type == "adb":
                        adb_serial = dev.address
            logger.info("Module exec: %s.%s device=%s ctor=%s shared_conn=%s ssh=%s adb=%s",
                        module_name, func_name, real_id, ctor_kwargs,
                        shared_conn is not None, ssh_credentials is not None, adb_serial)
            result = await execute_module_function(
                module_name, func_name, func_args, ctor_kwargs, shared_conn,
                ssh_credentials, adb_serial,
            )
            self._last_module_result = result
        elif step.type == StepType.SERIAL_COMMAND:
            if not real_id:
                raise ValueError("serial_command requires device_id")
            await self.dm.send_serial_command(
                real_id,
                params["data"],
                params.get("read_timeout", 1.0),
            )
        elif step.type in (StepType.HKMC_TOUCH, StepType.HKMC_SWIPE, StepType.HKMC_KEY) or (step.type == StepType.REPEAT_TAP and self._is_hkmc_device(real_id)):
            if not real_id:
                raise ValueError("HKMC/iSAP step requires device_id")
            # 액션 실행 중 연결 끊김 시 재연결 후 재시도 (최대 2회)
            for _hkmc_attempt in range(2):
                svc, is_isap = self._get_agent_service(real_id)
                if not svc or not svc.is_connected:
                    raise ValueError(f"HKMC/iSAP device {real_id} not connected")
                try:
                    screen_type = step.screen_type or params.get("screen_type", "front_center")
                    if step.type == StepType.REPEAT_TAP:
                        await svc.async_repeat_tap(params["x"], params["y"],
                                                   int(params.get("count", 5)),
                                                   int(params.get("interval_ms", 100)), screen_type)
                    elif step.type == StepType.HKMC_TOUCH:
                        await svc.async_tap(params["x"], params["y"], screen_type)
                    elif step.type == StepType.HKMC_SWIPE:
                        if is_isap:
                            await svc.async_swipe(params["x1"], params["y1"], params["x2"], params["y2"],
                                                  screen_type, int(params.get("duration_ms", 0)))
                        else:
                            await svc.async_swipe(params["x1"], params["y1"], params["x2"], params["y2"], screen_type)
                    elif step.type == StepType.HKMC_KEY:
                        key_name = params.get("key_name")
                        direction = params.get("direction")
                        if key_name:
                            sub_cmd = params.get("sub_cmd", 0x43)
                            if is_isap:
                                await svc.async_send_key_by_name(key_name, sub_cmd, screen_type, direction)
                            else:
                                monitor = params.get("monitor", 0x00)
                                await svc.async_send_key_by_name(key_name, sub_cmd, monitor, direction, screen_type)
                        else:
                            if is_isap:
                                await svc.async_send_key(
                                    params["cmd"], params["sub_cmd"], params["key_data"],
                                    screen_type, direction,
                                )
                            else:
                                await svc.async_send_key(
                                    params["cmd"], params["sub_cmd"], params["key_data"],
                                    params.get("monitor", 0x00), direction,
                                )
                    break  # 성공 시 루프 탈출
                except (ConnectionError, OSError) as ce:
                    if _hkmc_attempt == 0:
                        logger.warning("HKMC/iSAP action failed (connection lost), reconnecting: %s", ce)
                        await self._ensure_device_connected(real_id, max_retries=2, retry_interval=2.0)
                    else:
                        raise  # 재시도 후에도 실패 → 상위 except에서 "error" 처리
        elif step.type == StepType.ALL_RANDOM:
            # 녹화 시 저장된 설정으로 랜덤 스트레스 재현
            # 가중치: HK 20% / SK 70% / DRAG 10% (참조 스크립트 CCIC RAND_ALL 기반)
            import random as _rnd
            if not real_id:
                raise ValueError("all_random step requires device_id")
            svc, is_isap = self._get_agent_service(real_id)
            if not svc or not svc.is_connected:
                raise ValueError(f"HKMC/iSAP device {real_id} not connected")

            repeat_count = max(1, int(params.get("repeat_count", 1)))
            interval_ms = max(0, int(params.get("interval_ms", 0)))
            screen_type = step.screen_type or params.get("screen_type", "front_center")
            hk_keys = params.get("hk_keys") or []
            sk_region = params.get("sk_region") or None  # {x,y,width,height} or None
            drag_region = params.get("drag_region") or None
            weights = params.get("weights") or {}
            w_hk = float(weights.get("hk", 0.20))
            w_sk = float(weights.get("sk", 0.70))
            # HKMC 일체형 표시에서 AVN 영역 오프셋 (녹화 측에서 이미 적용된 경우 0)
            x_offset = int(params.get("x_offset", 0))
            # 대상 해상도 — 녹화 시점 값 사용 (디바이스 해상도와 맞지 않으면 범위 전체에서 추출)
            res_w = int(params.get("res_width", 1920))
            res_h = int(params.get("res_height", 720))

            def _pick_xy(region):
                if region:
                    x0 = max(0, int(region.get("x", 0)))
                    y0 = max(0, int(region.get("y", 0)))
                    x_max = min(res_w, x0 + int(region.get("width", res_w)))
                    y_max = min(res_h, y0 + int(region.get("height", res_h)))
                else:
                    x0, y0, x_max, y_max = 0, 0, res_w, res_h
                rw = max(1, x_max - x0)
                rh = max(1, y_max - y0)
                return _rnd.randrange(x0, x0 + rw), _rnd.randrange(y0, y0 + rh)

            for _i in range(repeat_count):
                if self._should_stop:
                    break
                roll = _rnd.random()
                try:
                    if roll < w_hk and hk_keys:
                        key_name = _rnd.choice(hk_keys)
                        sub_cmd = 0x44 if _rnd.random() < 0.2 else 0x43
                        if is_isap:
                            await svc.async_send_key_by_name(key_name, sub_cmd, screen_type, None)
                        else:
                            await svc.async_send_key_by_name(key_name, sub_cmd, 0x00, None, screen_type)
                    elif roll < (w_hk + w_sk):
                        x, y = _pick_xy(sk_region)
                        x += x_offset
                        await svc.async_tap(x, y, screen_type)
                    else:
                        x1, y1 = _pick_xy(drag_region)
                        x2, y2 = _pick_xy(drag_region)
                        x1 += x_offset; x2 += x_offset
                        if is_isap:
                            await svc.async_swipe(x1, y1, x2, y2, screen_type, 300)
                        else:
                            await svc.async_swipe(x1, y1, x2, y2, screen_type)
                except (ConnectionError, OSError) as ce:
                    logger.warning("all_random iteration %d failed: %s", _i + 1, ce)
                if interval_ms > 0 and _i + 1 < repeat_count:
                    await self._interruptible_sleep(interval_ms / 1000.0)
        elif step.type == StepType.WAIT:
            wait_mode = params.get("wait_mode", "basic")
            if wait_mode == "cycle":
                start_ms = params.get("wait_start", 3000)
                interval_ms = params.get("wait_interval", 3000)
                cycle_idx = getattr(self, '_current_iteration', 0)
                actual_ms = start_ms + interval_ms * cycle_idx
                logger.info("Wait cycle: iteration=%d, wait=%dms (start=%d + interval=%d × %d)", cycle_idx, actual_ms, start_ms, interval_ms, cycle_idx)
            elif wait_mode == "random":
                import random
                wait_min = params.get("wait_min", 0)
                wait_max = params.get("wait_max", 10000)
                actual_ms = random.randint(wait_min, wait_max)
                logger.info("Wait random: %dms (range %d~%d)", actual_ms, wait_min, wait_max)
            else:
                actual_ms = params.get("duration_ms", 1000)
            # 긴 wait는 1초 chunk로 분할하며 주기적으로 wait_progress 이벤트 발행
            # → WebSocket idle 방지 + 프론트엔드 진행률 표시 가능
            total_s = actual_ms / 1000.0
            if total_s <= 2.0:
                await self._interruptible_sleep(total_s)
            else:
                PROGRESS_INTERVAL_S = 5.0
                CHUNK_S = 1.0
                elapsed = 0.0
                next_progress = PROGRESS_INTERVAL_S
                # 시작 시점 이벤트
                publish_event({
                    "type": "wait_progress",
                    "step_id": step.id,
                    "elapsed_ms": 0,
                    "total_ms": int(actual_ms),
                })
                while elapsed < total_s:
                    if self._should_stop:
                        return
                    sleep_s = min(CHUNK_S, total_s - elapsed)
                    await self._interruptible_sleep(sleep_s)
                    elapsed += sleep_s
                    if elapsed >= next_progress or elapsed >= total_s:
                        publish_event({
                            "type": "wait_progress",
                            "step_id": step.id,
                            "elapsed_ms": int(elapsed * 1000),
                            "total_ms": int(actual_ms),
                        })
                        next_progress = elapsed + PROGRESS_INTERVAL_S
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
            elif step.type == StepType.REPEAT_TAP:
                await self.adb.repeat_tap(params["x"], params["y"], int(params.get("count", 5)),
                                          int(params.get("interval_ms", 100)),
                                          serial=adb_serial, display_id=adb_display_id)
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
            elif step.type == StepType.MULTI_TOUCH:
                fingers = params.get("fingers", [])
                is_tap = all(f.get("x1") == f.get("x2") and f.get("y1") == f.get("y2") for f in fingers)
                if is_tap:
                    points = [{"x": f["x1"], "y": f["y1"]} for f in fingers]
                    await self.adb.multi_finger_tap(points, serial=adb_serial, display_id=adb_display_id)
                else:
                    await self.adb.multi_finger_swipe(fingers, params.get("duration_ms", 500), serial=adb_serial, display_id=adb_display_id)

    def _rel_path(self, abs_path: str, scenario_name: str) -> str:
        """절대 경로 → 웹 서빙용 상대 경로.
        런 폴더 내: /results-files/ 기준, 아닌 경우: /screenshots/ 기준."""
        p = Path(abs_path)
        if self._run_output_dir:
            try:
                return str(p.relative_to(RESULTS_DIR)).replace("\\", "/")
            except ValueError:
                pass
        try:
            return str(p.relative_to(SCREENSHOTS_DIR)).replace("\\", "/")
        except ValueError:
            return p.name

    def _setup_run_output_dir(self, scenario_name: str) -> None:
        """재생 런별 출력 디렉토리 생성: results/{timestamp}_{scenario_name}/

        구조:
          results/{ts}_{name}/
          ├── result.json          ← 결과 JSON
          ├── screenshots/         ← 실제 스크린샷 (직접 저장)
          ├── logs/                ← DLT/Serial 로그
          └── recordings/         ← 동영상 파일
        """
        global _current_run_output_dir
        safe_name = re.sub(r'[\\/:*?"<>|→]', '_', scenario_name).replace(" ", "_")
        folder_name = f"{self._result_timestamp}_{safe_name}"
        run_dir = RESULTS_DIR / folder_name
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "logs").mkdir(exist_ok=True)
        (run_dir / "recordings").mkdir(exist_ok=True)

        self._run_output_dir = run_dir
        _current_run_output_dir = run_dir
        logger.info("Run output dir: %s", run_dir)

    def _cleanup_run_output_dir(self) -> None:
        """재생 종료 시 글로벌 런 디렉토리 참조 해제.
        self._run_output_dir은 _save_result에서 사용하므로 여기서는 유지."""
        global _current_run_output_dir
        _current_run_output_dir = None
        self._result_timestamp = ""

    async def _save_result(self, result: ScenarioResult, interim: bool = False) -> str:
        """Save execution result to JSON + HTML (런 폴더 내 result.json + result.html).
        interim=True: 중간 저장 — _run_output_dir을 유지.

        JSON 직렬화/파일 쓰기/HTML 빌드를 thread로 이전해 event loop 블록을 막는다.
        Excel은 무거우므로 자동 생성하지 않고 /api/results/export에서 on-demand 생성한다.
        HTML이 참조할 Tabulator 라이브러리는 런 폴더의 assets/에 한 번 복사해둔다.
        """
        timestamp = self._result_timestamp or datetime.now().strftime("%Y%m%d_%H%M%S")

        if self._run_output_dir and self._run_output_dir.exists():
            filepath = self._run_output_dir / "result.json"
        else:
            RESULTS_DIR.mkdir(parents=True, exist_ok=True)
            filepath = RESULTS_DIR / f"{result.scenario_name}_{timestamp}.json"

        # model_dump 한 번만 수행하고 JSON/HTML 양쪽에 재사용 (JSON round-trip 제거)
        data = result.model_dump()

        def _write_json_and_html():
            import json as _json
            filepath.write_text(_json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
            try:
                from ..routers.results import _build_html_report
                html_path = filepath.with_suffix(".html")
                html_str = _build_html_report(data, html_path)
                html_path.write_text(html_str, encoding="utf-8")
            except Exception as e:
                logger.warning("HTML report generation failed: %s", e)

        await asyncio.to_thread(_write_json_and_html)
        logger.info("Result saved%s: %s", " (interim)" if interim else "", filepath)

        if not interim:
            self._run_output_dir = None
        return str(filepath)


