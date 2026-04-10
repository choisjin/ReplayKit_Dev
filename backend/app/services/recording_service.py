"""Recording service — 사용자 동작을 시나리오로 기록."""

from __future__ import annotations

import io
import json
import logging
import re
import shutil
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..models.scenario import ROI, Scenario, Step, StepType
from .adb_service import ADBService
from .device_manager import DeviceManager

logger = logging.getLogger(__name__)

SCENARIOS_DIR = Path(__file__).resolve().parent.parent.parent / "scenarios"
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
GROUPS_FILE = SCENARIOS_DIR / "groups.json"
FOLDERS_FILE = SCENARIOS_DIR / "folders.json"


class RecordingService:
    """Record user actions into a Scenario."""

    def __init__(self, adb: ADBService, device_manager: DeviceManager):
        self.adb = adb
        self.dm = device_manager
        self._recording = False
        self._current_scenario: Optional[Scenario] = None
        self._step_counter = 0
        self._last_action_time: Optional[float] = None

    @property
    def is_recording(self) -> bool:
        return self._recording

    async def start_recording(self, scenario_name: str, description: str = "") -> Scenario:
        """Start a new recording session."""
        if self._recording:
            raise RuntimeError("Already recording")

        self._current_scenario = Scenario(
            name=scenario_name,
            description=description,
            steps=[],
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        self._step_counter = 0
        self._last_action_time = time.time()
        self._recording = True
        logger.info("Recording started: %s", scenario_name)
        return self._current_scenario

    async def resume_recording(self, scenario_name: str) -> Scenario:
        """Resume recording on an existing saved scenario."""
        if self._recording:
            raise RuntimeError("Already recording")

        scenario = await self.load_scenario(scenario_name)
        self._current_scenario = scenario
        self._step_counter = max((s.id for s in scenario.steps), default=0)
        self._last_action_time = time.time()
        self._recording = True
        logger.info("Recording resumed: %s (from step %d)", scenario_name, self._step_counter)
        return self._current_scenario

    def _ensure_device_mapped(self, device_id: str) -> str:
        """Ensure the device_id is recorded in device_map (id → real address).

        Since device IDs are now human-readable aliases (Android_1, Serial_1, etc.),
        we store them directly and map to their real address for portability.
        """
        if not device_id or self._current_scenario is None:
            return device_id

        dmap = self._current_scenario.device_map
        if device_id not in dmap:
            # Store mapping: device_id → real address
            dev = self.dm.get_device(device_id)
            if dev:
                dmap[device_id] = dev.address
            else:
                dmap[device_id] = device_id
        return device_id

    async def add_step(
        self,
        step_type: StepType,
        params: dict,
        device_id: str = "",
        description: str = "",
        delay_after_ms: int = 1000,
        roi: Optional[dict] = None,
        similarity_threshold: float = 0.95,
        skip_execute: bool = False,
    ) -> tuple[Step, str | None]:
        """Add a recorded step and optionally execute the action on the target device.

        Returns (step, response) where response is non-None for serial_command.
        """
        if not self._recording or self._current_scenario is None:
            raise RuntimeError("Not recording")

        self._step_counter += 1
        step_id = self._step_counter

        response = None
        if not skip_execute:
            response = await self._execute_step_action(step_type, params, device_id)

        # Ensure device_id is recorded in device_map (maps to real address)
        mapped_id = self._ensure_device_mapped(device_id) if device_id else None

        # params에 screen_type이 있으면 Step 최상위 필드에도 저장
        step_screen_type = params.get("screen_type") if params else None

        step = Step(
            id=step_id,
            type=step_type,
            device_id=mapped_id,
            screen_type=step_screen_type,
            params=params,
            delay_after_ms=delay_after_ms,
            expected_image=None,
            description=description,
            roi=ROI(**roi) if roi else None,
            similarity_threshold=similarity_threshold,
        )
        self._current_scenario.steps.append(step)
        self._last_action_time = time.time()
        logger.info("Step %d recorded: %s on device %s", step_id, step_type.value, device_id or "default")
        return step, response

    async def stop_recording(self) -> Scenario:
        """Stop recording and save the scenario."""
        if not self._recording or self._current_scenario is None:
            raise RuntimeError("Not recording")

        self._current_scenario.updated_at = datetime.now(timezone.utc).isoformat()
        self._recording = False

        # Save scenario to JSON
        await self.save_scenario(self._current_scenario)
        logger.info("Recording stopped: %s (%d steps)", self._current_scenario.name, len(self._current_scenario.steps))
        scenario = self._current_scenario
        self._current_scenario = None
        return scenario

    async def save_scenario(self, scenario: Scenario) -> str:
        """Save scenario to JSON file."""
        SCENARIOS_DIR.mkdir(parents=True, exist_ok=True)
        filepath = SCENARIOS_DIR / f"{scenario.name}.json"
        filepath.write_text(scenario.model_dump_json(indent=2), encoding="utf-8")
        return str(filepath)

    async def load_scenario(self, name: str) -> Scenario:
        """Load scenario from JSON file."""
        filepath = SCENARIOS_DIR / f"{name}.json"
        if not filepath.exists():
            raise FileNotFoundError(f"Scenario not found: {name}")
        data = json.loads(filepath.read_text(encoding="utf-8"))
        scenario = Scenario(**data)
        # 이미지 참조 자동 수리: 파일이 없으면 폴더 내에서 같은 step ID 파일 탐색
        if self._repair_image_refs(name, scenario):
            await self.save_scenario(scenario)
        return scenario

    def _repair_image_refs(self, name: str, scenario: "Scenario") -> bool:
        """expected_image가 실제 파일과 불일치하면 자동 수리. 변경 시 True 반환."""
        ss_dir = SCREENSHOTS_DIR / name
        if not ss_dir.exists():
            return False
        changed = False
        for step in scenario.steps:
            if step.expected_image:
                if not (ss_dir / step.expected_image).exists():
                    # step ID로 매칭되는 파일 탐색
                    pattern = f"*_step_{step.id:03d}_*"
                    candidates = [f for f in ss_dir.glob(pattern) if "crop" not in f.name and "annotated" not in f.name and "actual" not in f.stem]
                    if candidates:
                        step.expected_image = candidates[0].name
                        changed = True
                    else:
                        step.expected_image = None
                        changed = True
            for ci in step.expected_images:
                if ci.image and not (ss_dir / ci.image).exists():
                    ci.image = None
                    changed = True
            # None이 된 crop 항목 제거
            step.expected_images = [ci for ci in step.expected_images if ci.image]
        return changed

    async def list_scenarios(self) -> list[str]:
        """List all saved scenario names."""
        SCENARIOS_DIR.mkdir(parents=True, exist_ok=True)
        return [p.stem for p in SCENARIOS_DIR.glob("*.json") if p.name not in ("groups.json", "folders.json")]

    async def delete_scenario(self, name: str) -> bool:
        """Delete a scenario file + screenshots folder."""
        import shutil
        filepath = SCENARIOS_DIR / f"{name}.json"
        if filepath.exists():
            filepath.unlink()
            # 스크린샷 폴더 삭제 (기대 이미지 포함)
            ss_dir = SCREENSHOTS_DIR / name
            if ss_dir.is_dir():
                shutil.rmtree(str(ss_dir), ignore_errors=True)
            # Remove from any groups
            groups = self._load_groups()
            changed = False
            for gname in list(groups.keys()):
                before = len(groups[gname])
                groups[gname] = [m for m in groups[gname] if m["name"] != name]
                if len(groups[gname]) < before:
                    changed = True
            if changed:
                self._save_groups(groups)
            return True
        return False

    async def rename_scenario(self, old_name: str, new_name: str) -> bool:
        """Rename a scenario file and update group references."""
        old_path = SCENARIOS_DIR / f"{old_name}.json"
        new_path = SCENARIOS_DIR / f"{new_name}.json"
        if not old_path.exists():
            return False
        if new_path.exists():
            raise ValueError(f"Scenario '{new_name}' already exists")
        # Load, update name, save to new path
        data = json.loads(old_path.read_text(encoding="utf-8"))
        data["name"] = new_name
        # Rename screenshots directory
        old_ss = SCREENSHOTS_DIR / old_name
        new_ss = SCREENSHOTS_DIR / new_name
        if old_ss.exists() and not new_ss.exists():
            old_ss.rename(new_ss)
        # 이미지 파일명과 expected_image 필드도 새 이름으로 갱신
        ss_dir = new_ss if new_ss.exists() else old_ss
        if ss_dir.exists():
            for step_data in data.get("steps", []):
                ei = step_data.get("expected_image")
                if ei:
                    new_ei = self._rename_image_file(ss_dir, ei, new_name, step_data.get("id", 0))
                    step_data["expected_image"] = new_ei
                for ci in step_data.get("expected_images", []):
                    ci_img = ci.get("image")
                    if ci_img:
                        new_ci = self._rename_image_file(ss_dir, ci_img, new_name, step_data.get("id", 0), crop=True)
                        ci["image"] = new_ci
        new_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        old_path.unlink()
        # Update group references
        groups = self._load_groups()
        changed = False
        for members in groups.values():
            for m in members:
                if m["name"] == old_name:
                    m["name"] = new_name
                    changed = True
        if changed:
            self._save_groups(groups)
        return True

    @staticmethod
    def _rename_image_file(ss_dir: Path, old_filename: str, new_name: str, step_id: int, crop: bool = False) -> str:
        """이미지 파일을 새 시나리오 이름 기반으로 리네임하고 새 파일명을 반환."""
        old_path = ss_dir / old_filename
        if not old_path.exists():
            return old_filename
        # 기존 파일 확장자 및 타임스탬프/crop 인덱스 보존
        stem = Path(old_filename).stem
        ext = Path(old_filename).suffix or ".png"
        # _step_NNN 이후의 suffix 추출 (타임스탬프, crop 인덱스 등)
        m = re.search(r'_step_\d+(.*)', stem)
        suffix = m.group(1) if m else ""
        new_filename = f"{new_name}_step_{step_id:03d}{suffix}{ext}"
        if new_filename == old_filename:
            return old_filename
        new_path = ss_dir / new_filename
        old_path.rename(new_path)
        return new_filename

    # ------------------------------------------------------------------
    # Folders (가상 폴더 — 시나리오 파일은 flat, 메타데이터로 관리)
    # ------------------------------------------------------------------

    def _load_folders(self) -> dict[str, list[str]]:
        """Load folder assignments. {folder_name: [scenario_name, ...]}"""
        SCENARIOS_DIR.mkdir(parents=True, exist_ok=True)
        if FOLDERS_FILE.exists():
            return json.loads(FOLDERS_FILE.read_text(encoding="utf-8"))
        return {}

    def _save_folders(self, folders: dict[str, list[str]]) -> None:
        SCENARIOS_DIR.mkdir(parents=True, exist_ok=True)
        FOLDERS_FILE.write_text(json.dumps(folders, ensure_ascii=False, indent=2), encoding="utf-8")

    def get_folders(self) -> dict[str, list[str]]:
        return self._load_folders()

    def create_folder(self, name: str) -> dict[str, list[str]]:
        folders = self._load_folders()
        if name in folders:
            raise ValueError(f"폴더 '{name}'이(가) 이미 존재합니다")
        folders[name] = []
        self._save_folders(folders)
        return folders

    def rename_folder(self, old_name: str, new_name: str) -> dict[str, list[str]]:
        folders = self._load_folders()
        if new_name in folders:
            raise ValueError(f"폴더 '{new_name}'이(가) 이미 존재합니다")
        if old_name in folders:
            folders[new_name] = folders.pop(old_name)
        self._save_folders(folders)
        return folders

    def delete_folder(self, name: str) -> dict[str, list[str]]:
        folders = self._load_folders()
        folders.pop(name, None)
        self._save_folders(folders)
        return folders

    def move_to_folder(self, scenario_name: str, folder_name: str | None) -> dict[str, list[str]]:
        """시나리오를 폴더로 이동. folder_name=None이면 루트로."""
        folders = self._load_folders()
        # 기존 위치에서 제거
        for items in folders.values():
            if scenario_name in items:
                items.remove(scenario_name)
        # 새 위치에 추가
        if folder_name and folder_name in folders:
            if scenario_name not in folders[folder_name]:
                folders[folder_name].append(scenario_name)
        self._save_folders(folders)
        return folders

    # ------------------------------------------------------------------
    # Groups
    # ------------------------------------------------------------------

    def _load_groups_raw(self) -> dict:
        SCENARIOS_DIR.mkdir(parents=True, exist_ok=True)
        if GROUPS_FILE.exists():
            return json.loads(GROUPS_FILE.read_text(encoding="utf-8"))
        return {}

    def _load_groups(self) -> dict[str, list[dict]]:
        """Load groups, auto-migrating old formats to new dict-based jump format.

        Current format: on_pass_goto / on_fail_goto = {scenario: int, step: int} | null
        Old format v1: list[str] (just scenario names)
        Old format v2: on_pass_goto / on_fail_goto = int | null (scenario index only)
        """
        raw = self._load_groups_raw()
        migrated = False
        result: dict[str, list[dict]] = {}
        for gname, members in raw.items():
            if isinstance(members, list) and len(members) > 0 and isinstance(members[0], str):
                # Old format v1: list of scenario names
                result[gname] = [{"name": m, "on_pass_goto": None, "on_fail_goto": None} for m in members]
                migrated = True
            else:
                entries = members if isinstance(members, list) else []
                # Migrate v2 integer jumps to dict format
                for entry in entries:
                    for key in ("on_pass_goto", "on_fail_goto"):
                        val = entry.get(key)
                        if isinstance(val, int):
                            entry[key] = {"scenario": val, "step": 0}
                            migrated = True
                result[gname] = entries
        if migrated:
            self._save_groups(result)
        return result

    def _save_groups(self, groups: dict[str, list[dict]]) -> None:
        SCENARIOS_DIR.mkdir(parents=True, exist_ok=True)
        GROUPS_FILE.write_text(json.dumps(groups, ensure_ascii=False, indent=2), encoding="utf-8")

    def get_groups(self) -> dict[str, list[dict]]:
        return self._load_groups()

    def create_group(self, group_name: str) -> dict[str, list[dict]]:
        groups = self._load_groups()
        if group_name in groups:
            raise ValueError(f"그룹 '{group_name}'이(가) 이미 존재합니다")
        groups[group_name] = []
        self._save_groups(groups)
        return groups

    def delete_group(self, group_name: str) -> dict[str, list[dict]]:
        groups = self._load_groups()
        groups.pop(group_name, None)
        self._save_groups(groups)
        return groups

    def rename_group(self, old_name: str, new_name: str) -> dict[str, list[dict]]:
        groups = self._load_groups()
        if new_name in groups:
            raise ValueError(f"그룹 '{new_name}'이(가) 이미 존재합니다")
        if old_name in groups:
            groups[new_name] = groups.pop(old_name)
            self._save_groups(groups)
        return groups

    def add_to_group(self, group_name: str, scenario_name: str) -> dict[str, list[dict]]:
        groups = self._load_groups()
        if group_name not in groups:
            groups[group_name] = []
        names = [m["name"] for m in groups[group_name]]
        if scenario_name not in names:
            groups[group_name].append({"name": scenario_name, "on_pass_goto": None, "on_fail_goto": None})
        self._save_groups(groups)
        return groups

    def remove_from_group(self, group_name: str, scenario_name: str) -> dict[str, list[dict]]:
        groups = self._load_groups()
        if group_name in groups:
            old_members = groups[group_name]
            removed_idx = next((i for i, m in enumerate(old_members) if m["name"] == scenario_name), None)
            groups[group_name] = [m for m in old_members if m["name"] != scenario_name]
            # 제거된 멤버 이후의 goto 참조 재매핑
            if removed_idx is not None:
                self._remap_group_jumps_after_remove(groups[group_name], removed_idx)
        self._save_groups(groups)
        return groups

    @staticmethod
    def _remap_jump_idx(jump, removed_idx: int):
        """제거된 인덱스 이후의 jump 참조를 -1 시프트. 제거 대상을 가리키면 None 반환."""
        if jump is None:
            return jump
        if isinstance(jump, dict):
            sc = jump.get("scenario", -1)
            if sc == -1:
                return jump
            if sc == removed_idx:
                return None
            if sc > removed_idx:
                return {**jump, "scenario": sc - 1}
            return jump
        return jump

    def _remap_group_jumps_after_remove(self, members: list[dict], removed_idx: int):
        """그룹 멤버 제거 후 모든 jump 참조를 재매핑."""
        for m in members:
            m["on_pass_goto"] = self._remap_jump_idx(m.get("on_pass_goto"), removed_idx)
            m["on_fail_goto"] = self._remap_jump_idx(m.get("on_fail_goto"), removed_idx)
            for sj in (m.get("step_jumps") or {}).values():
                sj["on_pass_goto"] = self._remap_jump_idx(sj.get("on_pass_goto"), removed_idx)
                sj["on_fail_goto"] = self._remap_jump_idx(sj.get("on_fail_goto"), removed_idx)

    def reorder_group(self, group_name: str, ordered: list[str]) -> dict[str, list[dict]]:
        groups = self._load_groups()
        if group_name in groups:
            old_members = groups[group_name]
            old_map = {m["name"]: m for m in old_members}
            # 이전 이름 → 이전 인덱스 매핑
            old_idx_map = {m["name"]: i for i, m in enumerate(old_members)}
            # 이전 인덱스 → 새 인덱스 매핑
            idx_remap = {}
            for new_i, name in enumerate(ordered):
                old_i = old_idx_map.get(name)
                if old_i is not None:
                    idx_remap[old_i] = new_i
            new_members = [old_map.get(n, {"name": n, "on_pass_goto": None, "on_fail_goto": None}) for n in ordered]
            # jump 참조의 scenario 인덱스를 새 인덱스로 재매핑
            for m in new_members:
                m["on_pass_goto"] = self._remap_jump_reorder(m.get("on_pass_goto"), idx_remap)
                m["on_fail_goto"] = self._remap_jump_reorder(m.get("on_fail_goto"), idx_remap)
                for sj in (m.get("step_jumps") or {}).values():
                    sj["on_pass_goto"] = self._remap_jump_reorder(sj.get("on_pass_goto"), idx_remap)
                    sj["on_fail_goto"] = self._remap_jump_reorder(sj.get("on_fail_goto"), idx_remap)
            groups[group_name] = new_members
        self._save_groups(groups)
        return groups

    @staticmethod
    def _remap_jump_reorder(jump, idx_remap: dict):
        """순서 변경 시 jump의 scenario 인덱스를 새 인덱스로 매핑."""
        if jump is None:
            return jump
        if isinstance(jump, dict):
            sc = jump.get("scenario", -1)
            if sc == -1:
                return jump
            new_sc = idx_remap.get(sc, sc)
            return {**jump, "scenario": new_sc}
        return jump

    def update_group_jumps(self, group_name: str, index: int, on_pass_goto, on_fail_goto) -> dict[str, list[dict]]:
        """Update conditional jump settings for a scenario in a group."""
        groups = self._load_groups()
        if group_name in groups and 0 <= index < len(groups[group_name]):
            groups[group_name][index]["on_pass_goto"] = on_pass_goto
            groups[group_name][index]["on_fail_goto"] = on_fail_goto
        self._save_groups(groups)
        return groups

    def update_group_step_jumps(self, group_name: str, index: int, step_id: int, on_pass_goto, on_fail_goto) -> dict[str, list[dict]]:
        """Update conditional jump settings for a specific step within a scenario in a group."""
        groups = self._load_groups()
        if group_name in groups and 0 <= index < len(groups[group_name]):
            entry = groups[group_name][index]
            if "step_jumps" not in entry:
                entry["step_jumps"] = {}
            key = str(step_id)
            if on_pass_goto is None and on_fail_goto is None:
                entry["step_jumps"].pop(key, None)
            else:
                entry["step_jumps"][key] = {"on_pass_goto": on_pass_goto, "on_fail_goto": on_fail_goto}
            # Clean up empty step_jumps
            if not entry["step_jumps"]:
                del entry["step_jumps"]
        self._save_groups(groups)
        return groups

    # ------------------------------------------------------------------
    # Copy & Merge
    # ------------------------------------------------------------------

    async def copy_scenario(self, source_name: str, target_name: str) -> Scenario:
        """Copy a scenario with a new name, including screenshots."""
        source = await self.load_scenario(source_name)
        source.name = target_name
        source.created_at = datetime.now(timezone.utc).isoformat()
        source.updated_at = source.created_at

        # Remap expected_image filenames
        src_ss_dir = SCREENSHOTS_DIR / source_name
        tgt_ss_dir = SCREENSHOTS_DIR / target_name
        tgt_ss_dir.mkdir(parents=True, exist_ok=True)

        for step in source.steps:
            if step.expected_image:
                old_file = src_ss_dir / step.expected_image
                # 새 파일명 생성 (replace 대신 step ID 기반으로 안전하게)
                stem = Path(step.expected_image).stem
                ext = Path(step.expected_image).suffix or ".png"
                m = re.search(r'_step_\d+(.*)', stem)
                suffix = m.group(1) if m else ""
                new_filename = f"{target_name}_step_{step.id:03d}{suffix}{ext}"
                new_file = tgt_ss_dir / new_filename
                if old_file.exists():
                    shutil.copy2(str(old_file), str(new_file))
                step.expected_image = new_filename
            # multi_crop 이미지도 복사
            for ci_idx, ci in enumerate(step.expected_images):
                if ci.image:
                    old_ci = src_ss_dir / ci.image
                    new_ci_name = f"{target_name}_step_{step.id:03d}_crop_{ci_idx:02d}.png"
                    new_ci = tgt_ss_dir / new_ci_name
                    if old_ci.exists():
                        shutil.copy2(str(old_ci), str(new_ci))
                    ci.image = new_ci_name

        await self.save_scenario(source)
        return source

    async def merge_scenarios(self, names: list[str], target_name: str) -> Scenario:
        """Merge multiple scenarios into one new scenario."""
        merged_steps: list[Step] = []
        merged_device_map: dict[str, str] = {}
        step_id = 0

        tgt_ss_dir = SCREENSHOTS_DIR / target_name
        tgt_ss_dir.mkdir(parents=True, exist_ok=True)

        for name in names:
            scen = await self.load_scenario(name)
            src_ss_dir = SCREENSHOTS_DIR / name
            # device_map 합치기 (뒤 시나리오가 동일 alias면 덮어씀)
            merged_device_map.update(scen.device_map or {})
            # 원본 step ID → 새 step ID 매핑 (goto 갱신용)
            id_map: dict[int, int] = {}
            scenario_steps: list[Step] = []
            for step in scen.steps:
                old_id = step.id
                step_id += 1
                step.id = step_id
                id_map[old_id] = step_id
                if step.expected_image:
                    old_file = src_ss_dir / step.expected_image
                    new_filename = f"{target_name}_step_{step_id:03d}.png"
                    new_file = tgt_ss_dir / new_filename
                    if old_file.exists():
                        shutil.copy2(str(old_file), str(new_file))
                    step.expected_image = new_filename
                # multi_crop 이미지도 복사
                for ci_idx, ci in enumerate(step.expected_images):
                    if ci.image:
                        old_ci = src_ss_dir / ci.image
                        new_ci_name = f"{target_name}_step_{step_id:03d}_crop_{ci_idx}.png"
                        new_ci = tgt_ss_dir / new_ci_name
                        if old_ci.exists():
                            shutil.copy2(str(old_ci), str(new_ci))
                        ci.image = new_ci_name
                scenario_steps.append(step)
            # on_pass_goto / on_fail_goto를 새 ID로 갱신
            for step in scenario_steps:
                if step.on_pass_goto is not None and step.on_pass_goto in id_map:
                    step.on_pass_goto = id_map[step.on_pass_goto]
                if step.on_fail_goto is not None and step.on_fail_goto in id_map:
                    step.on_fail_goto = id_map[step.on_fail_goto]
            merged_steps.extend(scenario_steps)

        merged = Scenario(
            name=target_name,
            steps=merged_steps,
            device_map=merged_device_map,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        await self.save_scenario(merged)
        return merged

    # ------------------------------------------------------------------
    # Export / Import
    # ------------------------------------------------------------------

    async def export_zip(self, scenario_names: list[str], group_names: list[str]) -> bytes:
        """Export selected scenarios and groups as a ZIP archive."""
        groups = self._load_groups()

        # Resolve: add scenarios referenced by selected groups
        all_scenario_names = set(scenario_names)
        selected_groups: dict[str, list[dict]] = {}
        for gn in group_names:
            if gn in groups:
                selected_groups[gn] = groups[gn]
                for m in groups[gn]:
                    all_scenario_names.add(m["name"])

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            manifest = {
                "version": 1,
                "exported_at": datetime.now(timezone.utc).isoformat(),
                "scenarios": sorted(all_scenario_names),
                "groups": sorted(selected_groups.keys()),
            }
            zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

            # Scenario JSONs
            for name in sorted(all_scenario_names):
                spath = SCENARIOS_DIR / f"{name}.json"
                if spath.exists():
                    zf.write(spath, f"scenarios/{name}.json")

            # Screenshots
            for name in sorted(all_scenario_names):
                ss_dir = SCREENSHOTS_DIR / name
                if ss_dir.is_dir():
                    for fpath in ss_dir.rglob("*"):
                        if fpath.is_file() and "actual" not in fpath.parts:
                            arcname = f"screenshots/{name}/{fpath.relative_to(ss_dir).as_posix()}"
                            zf.write(fpath, arcname)

            # Groups
            if selected_groups:
                zf.writestr("groups.json", json.dumps(selected_groups, ensure_ascii=False, indent=2))

        return buf.getvalue()

    async def import_preview(self, zip_data: bytes) -> dict:
        """Analyze a ZIP for conflicts before importing."""
        existing_scenarios = set(await self.list_scenarios())
        existing_groups = set(self._load_groups().keys())

        with zipfile.ZipFile(io.BytesIO(zip_data), "r") as zf:
            manifest = {}
            if "manifest.json" in zf.namelist():
                manifest = json.loads(zf.read("manifest.json"))

            scenario_names = manifest.get("scenarios", [])
            group_names = manifest.get("groups", [])

            # Fallback: scan for scenario files if no manifest
            if not scenario_names:
                for n in zf.namelist():
                    if n.startswith("scenarios/") and n.endswith(".json"):
                        scenario_names.append(Path(n).stem)

            if not group_names and "groups.json" in zf.namelist():
                gdata = json.loads(zf.read("groups.json"))
                group_names = list(gdata.keys())

            scenarios_info = []
            for sn in scenario_names:
                scenarios_info.append({"name": sn, "conflict": sn in existing_scenarios})

            groups_info = []
            for gn in group_names:
                groups_info.append({"name": gn, "conflict": gn in existing_groups})

        return {"scenarios": scenarios_info, "groups": groups_info}

    async def import_apply(self, zip_data: bytes, resolutions: dict) -> dict:
        """Apply import from ZIP with conflict resolutions.

        resolutions = {
            "scenarios": {"name": {"action": "overwrite|rename|skip", "new_name": "..."}},
            "groups": {"name": {"action": "overwrite|rename|skip|merge", "new_name": "..."}},
        }
        """
        SCENARIOS_DIR.mkdir(parents=True, exist_ok=True)
        scenario_res = resolutions.get("scenarios", {})
        group_res = resolutions.get("groups", {})
        imported_scenarios: list[str] = []
        imported_groups: list[str] = []
        skipped: list[str] = []

        with zipfile.ZipFile(io.BytesIO(zip_data), "r") as zf:
            manifest = {}
            if "manifest.json" in zf.namelist():
                manifest = json.loads(zf.read("manifest.json"))

            # --- Import scenarios ---
            scenario_names = manifest.get("scenarios", [])
            if not scenario_names:
                for n in zf.namelist():
                    if n.startswith("scenarios/") and n.endswith(".json"):
                        scenario_names.append(Path(n).stem)

            name_map: dict[str, str] = {}  # original -> final name

            for orig_name in scenario_names:
                res = scenario_res.get(orig_name, {"action": "import"})
                action = res.get("action", "import")
                if action == "skip":
                    skipped.append(orig_name)
                    continue

                final_name = orig_name
                if action == "rename":
                    final_name = res.get("new_name", orig_name)

                name_map[orig_name] = final_name

                # Read scenario JSON
                json_path = f"scenarios/{orig_name}.json"
                if json_path in zf.namelist():
                    sdata = json.loads(zf.read(json_path))
                    sdata["name"] = final_name
                    # Remap expected_image filenames if renamed
                    if final_name != orig_name:
                        for step in sdata.get("steps", []):
                            if step.get("expected_image"):
                                step["expected_image"] = step["expected_image"].replace(orig_name, final_name, 1)
                            new_imgs = []
                            for ci in step.get("expected_images", []):
                                if ci.get("image"):
                                    ci["image"] = ci["image"].replace(orig_name, final_name, 1)
                                new_imgs.append(ci)
                            step["expected_images"] = new_imgs

                    out_path = SCENARIOS_DIR / f"{final_name}.json"
                    out_path.write_text(json.dumps(sdata, ensure_ascii=False, indent=2), encoding="utf-8")

                # Extract screenshots
                ss_prefix = f"screenshots/{orig_name}/"
                tgt_dir = SCREENSHOTS_DIR / final_name
                tgt_dir.mkdir(parents=True, exist_ok=True)
                for entry in zf.namelist():
                    if entry.startswith(ss_prefix) and not entry.endswith("/"):
                        rel = entry[len(ss_prefix):]
                        if final_name != orig_name:
                            rel = rel.replace(orig_name, final_name, 1)
                        out_file = tgt_dir / rel
                        out_file.parent.mkdir(parents=True, exist_ok=True)
                        out_file.write_bytes(zf.read(entry))

                imported_scenarios.append(final_name)

            # --- Import groups ---
            if "groups.json" in zf.namelist():
                imported_groups_data = json.loads(zf.read("groups.json"))
                existing_groups = self._load_groups()

                for gname, members in imported_groups_data.items():
                    res = group_res.get(gname, {"action": "import"})
                    action = res.get("action", "import")
                    if action == "skip":
                        skipped.append(f"group:{gname}")
                        continue

                    final_gname = gname
                    if action == "rename":
                        final_gname = res.get("new_name", gname)

                    # Remap member scenario names
                    remapped = []
                    for m in members:
                        orig_sname = m["name"]
                        mapped = name_map.get(orig_sname, orig_sname)
                        if mapped not in skipped:
                            m["name"] = mapped
                            remapped.append(m)

                    if action == "merge" and gname in existing_groups:
                        existing_names = {m["name"] for m in existing_groups[gname]}
                        for m in remapped:
                            if m["name"] not in existing_names:
                                existing_groups[gname].append(m)
                        existing_groups[final_gname] = existing_groups.pop(gname, existing_groups.get(final_gname, []))
                    else:
                        existing_groups[final_gname] = remapped

                    imported_groups.append(final_gname)

                self._save_groups(existing_groups)

        return {
            "imported_scenarios": imported_scenarios,
            "imported_groups": imported_groups,
            "skipped": skipped,
        }

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _execute_step_action(self, step_type: StepType, params: dict, device_id: str = "") -> str | None:
        """Execute an action on the target device. Returns response for serial_command."""
        if step_type == StepType.MODULE_COMMAND:
            from .module_service import execute_module_function
            module_name = params.get("module", "")
            func_name = params.get("function", "")
            func_args = params.get("args", {})
            # Pass device connection info + shared serial connection
            ctor_kwargs = None
            shared_conn = None
            if device_id:
                dev = self.dm.get_device(device_id)
                if dev:
                    ctor_kwargs = _build_ctor_kwargs(dev)
                    shared_conn = self.dm.get_serial_conn(device_id)
            await execute_module_function(module_name, func_name, func_args, ctor_kwargs, shared_conn)
            return None
        elif step_type == StepType.SERIAL_COMMAND:
            if not device_id:
                raise ValueError("serial_command requires a device_id")
            response = await self.dm.send_serial_command(
                device_id,
                params["data"],
                params.get("read_timeout", 1.0),
            )
            return response
        elif step_type in (StepType.HKMC_TOUCH, StepType.HKMC_SWIPE, StepType.HKMC_KEY):
            if not device_id:
                raise ValueError("HKMC step requires a device_id")
            hkmc = self.dm.get_hkmc_service(device_id)
            if not hkmc:
                raise ValueError(f"HKMC device {device_id} not connected")
            screen_type = params.get("screen_type", "front_center")
            if step_type == StepType.HKMC_TOUCH:
                await hkmc.async_tap(params["x"], params["y"], screen_type)
            elif step_type == StepType.HKMC_SWIPE:
                await hkmc.async_swipe(params["x1"], params["y1"], params["x2"], params["y2"], screen_type)
            elif step_type == StepType.HKMC_KEY:
                key_name = params.get("key_name")
                if key_name:
                    sub_cmd = params.get("sub_cmd", 0x43)  # SHORT_KEY
                    monitor = params.get("monitor", 0x00)
                    direction = params.get("direction")
                    await hkmc.async_send_key_by_name(key_name, sub_cmd, monitor, direction)
                else:
                    await hkmc.async_send_key(
                        params["cmd"], params["sub_cmd"], params["key_data"],
                        params.get("monitor", 0x00), params.get("direction"),
                    )
        elif step_type == StepType.WAIT:
            await _async_sleep(params.get("duration_ms", 1000) / 1000.0)
        else:
            # ADB actions — use device_id or fallback to active device
            serial = device_id or await self.adb.get_active_device()
            if not serial:
                raise ValueError("No ADB device specified")
            if step_type == StepType.TAP:
                await self.adb.tap(params["x"], params["y"], serial=serial)
            elif step_type == StepType.LONG_PRESS:
                await self.adb.long_press(params["x"], params["y"], params.get("duration_ms", 1000), serial=serial)
            elif step_type == StepType.SWIPE:
                await self.adb.swipe(
                    params["x1"], params["y1"],
                    params["x2"], params["y2"],
                    params.get("duration_ms", 300),
                    serial=serial,
                )
            elif step_type == StepType.INPUT_TEXT:
                await self.adb.input_text(params["text"], serial=serial)
            elif step_type == StepType.KEY_EVENT:
                await self.adb.key_event(params["keycode"], serial=serial)
            elif step_type == StepType.ADB_COMMAND:
                await self.adb.run_shell_command(params["command"], serial=serial)
            elif step_type == StepType.MULTI_TOUCH:
                fingers = params.get("fingers", [])
                is_tap = all(f.get("x1") == f.get("x2") and f.get("y1") == f.get("y2") for f in fingers)
                if is_tap:
                    points = [{"x": f["x1"], "y": f["y1"]} for f in fingers]
                    await self.adb.multi_finger_tap(points, serial=serial)
                else:
                    await self.adb.multi_finger_swipe(fingers, params.get("duration_ms", 500), serial=serial)

        return None


async def _async_sleep(seconds: float) -> None:
    import asyncio
    await asyncio.sleep(seconds)
