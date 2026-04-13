"""Scenario management API routes."""

import base64
import json
import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

logger = logging.getLogger(__name__)

from ..dependencies import adb_service as adb_svc
from ..dependencies import device_manager as dm
from ..dependencies import playback_service as playback_svc
from ..dependencies import recording_service as recording_svc
from ..models.scenario import ROI, CompareMode, CropItem, Scenario, StepType
from ..services.recording_service import SCREENSHOTS_DIR

router = APIRouter(prefix="/api/scenario", tags=["scenario"])


# ------------------------------------------------------------------
# Recording
# ------------------------------------------------------------------

class StartRecordingRequest(BaseModel):
    name: str
    description: str = ""


class AddStepRequest(BaseModel):
    type: StepType
    device_id: str = ""
    params: dict
    description: str = ""
    delay_after_ms: int = 1000
    roi: Optional[dict] = None
    similarity_threshold: float = 0.95
    skip_execute: bool = False


@router.post("/record/start")
async def start_recording(req: StartRecordingRequest):
    """Start a new recording session."""
    try:
        scenario = await recording_svc.start_recording(req.name, req.description)
        return {"status": "recording", "scenario": scenario.model_dump()}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/record/step")
async def add_step(req: AddStepRequest):
    """Add a step to the current recording."""
    try:
        step, response = await recording_svc.add_step(
            step_type=req.type,
            params=req.params,
            device_id=req.device_id,
            description=req.description,
            delay_after_ms=req.delay_after_ms,
            roi=req.roi,
            similarity_threshold=req.similarity_threshold,
            skip_execute=req.skip_execute,
        )
        result = {"status": "ok", "step": step.model_dump()}
        if response is not None:
            result["response"] = response
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


class ResumeRecordingRequest(BaseModel):
    name: str


@router.post("/record/resume")
async def resume_recording(req: ResumeRecordingRequest):
    """Resume recording on an existing scenario."""
    try:
        scenario = await recording_svc.resume_recording(req.name)
        return {"status": "recording", "scenario": scenario.model_dump()}
    except (RuntimeError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/record/stop")
async def stop_recording():
    """Stop recording and save the scenario."""
    try:
        scenario = await recording_svc.stop_recording()
        return {"status": "saved", "scenario": scenario.model_dump()}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


class DeleteStepRequest(BaseModel):
    step_index: int  # 0-based


@router.post("/record/delete-step")
async def delete_step(req: DeleteStepRequest):
    """Delete a step from the current recording session."""
    if not recording_svc.is_recording or not recording_svc._current_scenario:
        raise HTTPException(status_code=400, detail="Not recording")
    scenario = recording_svc._current_scenario
    if req.step_index < 0 or req.step_index >= len(scenario.steps):
        raise HTTPException(status_code=400, detail=f"Invalid step index: {req.step_index}")
    removed = scenario.steps.pop(req.step_index)
    # Re-number step IDs sequentially
    for i, step in enumerate(scenario.steps):
        step.id = i + 1
    await recording_svc.save_scenario(scenario)
    return {"status": "ok", "removed_step_id": removed.id, "remaining": len(scenario.steps)}


class UpdateStepRequest(BaseModel):
    scenario_name: str
    step_index: int
    updates: dict  # e.g. {"delay_after_ms": 5000}


@router.post("/record/update-step")
async def update_step(req: UpdateStepRequest):
    """시나리오 스텝의 속성을 업데이트 (딜레이 등)."""
    scenario = await _resolve_scenario(req.scenario_name)
    if req.step_index < 0 or req.step_index >= len(scenario.steps):
        raise HTTPException(status_code=400, detail=f"Invalid step index: {req.step_index}")
    step = scenario.steps[req.step_index]
    for k, v in req.updates.items():
        if hasattr(step, k):
            setattr(step, k, v)
    await recording_svc.save_scenario(scenario)
    return {"status": "ok"}


@router.get("/record/status")
async def recording_status():
    """Check if recording is in progress."""
    return {"recording": recording_svc.is_recording}


class SaveExpectedImageRequest(BaseModel):
    scenario_name: str
    step_index: int  # 0-based
    image_base64: str  # PNG base64 data (without data:image/png;base64, prefix)
    crop: Optional[dict] = None  # {x, y, width, height} in image pixels
    compare_mode: Optional[str] = None  # "multi_crop" to append to expected_images
    crop_label: str = ""  # label for multi_crop item


async def _resolve_scenario(scenario_name: str):
    """Get scenario from in-memory recording or disk."""
    if recording_svc.is_recording and recording_svc._current_scenario:
        return recording_svc._current_scenario
    try:
        return await recording_svc.load_scenario(scenario_name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Scenario '{scenario_name}' not found")


@router.post("/record/save-expected-image")
async def save_expected_image(req: SaveExpectedImageRequest):
    """Manually save an expected image for a step."""
    scenario = await _resolve_scenario(req.scenario_name)

    if req.step_index < 0 or req.step_index >= len(scenario.steps):
        raise HTTPException(status_code=400, detail=f"Invalid step index: {req.step_index}")

    step = scenario.steps[req.step_index]

    # Decode base64 PNG
    try:
        raw = req.image_base64
        if raw.startswith("data:"):
            raw = raw.split(",", 1)[1]
        png_bytes = base64.b64decode(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image data")

    # Optionally crop
    if req.crop:
        import cv2
        import numpy as np
        arr = np.frombuffer(png_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise HTTPException(status_code=400, detail="Cannot decode image")
        x, y, w, h = req.crop["x"], req.crop["y"], req.crop["width"], req.crop["height"]
        cropped = img[y:y + h, x:x + w]
        _, png_bytes = cv2.imencode(".png", cropped)
        png_bytes = png_bytes.tobytes()

    save_dir = SCREENSHOTS_DIR / req.scenario_name
    save_dir.mkdir(parents=True, exist_ok=True)

    if req.compare_mode == "multi_crop":
        # Multi-crop: append to expected_images list
        crop_idx = len(step.expected_images)
        filename = f"{req.scenario_name}_step_{step.id:03d}_crop_{crop_idx:02d}.png"
        (save_dir / filename).write_bytes(png_bytes)
        crop_roi = ROI(x=int(req.crop["x"]), y=int(req.crop["y"]),
                       width=int(req.crop["width"]), height=int(req.crop["height"])) if req.crop else None
        step.expected_images.append(CropItem(image=filename, label=req.crop_label, roi=crop_roi))
    else:
        # Single image (full or single_crop)
        filename = f"{req.scenario_name}_step_{step.id:03d}.png"
        (save_dir / filename).write_bytes(png_bytes)
        step.expected_image = filename
        if req.crop:
            step.roi = ROI(x=int(req.crop["x"]), y=int(req.crop["y"]),
                           width=int(req.crop["width"]), height=int(req.crop["height"]))
        else:
            step.roi = None

    await recording_svc.save_scenario(scenario)
    return {"status": "ok", "filename": filename, "step_id": step.id}


class CaptureExpectedImageRequest(BaseModel):
    scenario_name: str
    step_index: int  # 0-based
    device_id: str  # ADB serial or HKMC device ID to take screenshot from
    screen_type: str = "front_center"  # HKMC screen type
    crop: Optional[dict] = None  # {x, y, width, height} in device pixels
    compare_mode: Optional[str] = None  # "multi_crop" to append
    crop_label: str = ""
    preserve_crops: bool = False  # True이면 기존 multi_crop 이미지 보존


@router.post("/record/capture-expected-image")
async def capture_expected_image(req: CaptureExpectedImageRequest):
    """Capture a screenshot from the device and save as expected image."""
    scenario = await _resolve_scenario(req.scenario_name)

    if req.step_index < 0 or req.step_index >= len(scenario.steps):
        raise HTTPException(status_code=400, detail=f"Invalid step index: {req.step_index}")

    step = scenario.steps[req.step_index]

    # Resolve device and take screenshot
    dev = dm.get_device(req.device_id)
    try:
        if dev and dev.type == "hkmc6th":
            hkmc = dm.get_hkmc_service(req.device_id)
            if not hkmc:
                raise HTTPException(status_code=400, detail=f"HKMC device {req.device_id} not connected")
            png_bytes = await hkmc.async_screencap_bytes(screen_type=req.screen_type, fmt="png")
        elif dev and dev.type == "vision_camera":
            cam = dm.get_vision_camera(req.device_id)
            if not cam or not cam.IsConnected():
                raise HTTPException(status_code=400, detail=f"VisionCamera {req.device_id} not connected")
            import asyncio
            loop = asyncio.get_event_loop()
            png_bytes = await loop.run_in_executor(None, cam.CaptureBytes, "png")
        else:
            adb_serial = dev.address if dev else req.device_id
            # screen_type → SF display ID 변환
            from ..services.adb_service import resolve_sf_display_id
            adb_did = None
            try:
                adb_did = int(req.screen_type)
            except (ValueError, TypeError):
                pass
            sf_did = resolve_sf_display_id(dev.info if dev else None, adb_did)
            png_bytes = await adb_svc.screencap_bytes(serial=adb_serial, sf_display_id=sf_did)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Screenshot failed: {e}")

    # Optionally crop
    if req.crop:
        import cv2
        import numpy as np
        arr = np.frombuffer(png_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise HTTPException(status_code=400, detail="Cannot decode screenshot")
        x, y, w, h = int(req.crop["x"]), int(req.crop["y"]), int(req.crop["width"]), int(req.crop["height"])
        cropped = img[y:y + h, x:x + w]
        _, buf = cv2.imencode(".png", cropped)
        png_bytes = buf.tobytes()

    scenario_name = scenario.name
    save_dir = SCREENSHOTS_DIR / scenario_name
    save_dir.mkdir(parents=True, exist_ok=True)

    if req.compare_mode == "multi_crop":
        # Multi-crop: append to expected_images list
        crop_idx = len(step.expected_images)
        filename = f"{scenario_name}_step_{step.id:03d}_crop_{crop_idx:02d}.png"
        (save_dir / filename).write_bytes(png_bytes)
        crop_roi = ROI(x=int(req.crop["x"]), y=int(req.crop["y"]),
                       width=int(req.crop["width"]), height=int(req.crop["height"])) if req.crop else None
        step.expected_images.append(CropItem(image=filename, label=req.crop_label, roi=crop_roi))
    else:
        # Single image (full or single_crop) — 타임스탬프 포함으로 캐시 충돌 방지
        import time as _time
        ts = int(_time.time() * 1000) % 1000000
        filename = f"{scenario_name}_step_{step.id:03d}_{ts}.png"
        # 이전 기대이미지 파일 삭제
        if step.expected_image and step.expected_image != filename:
            old_file = save_dir / step.expected_image
            if old_file.exists():
                old_file.unlink(missing_ok=True)
        if not req.preserve_crops:
            # 이전 multi_crop 이미지 파일 삭제
            for ci in step.expected_images:
                if ci.image:
                    old_crop = save_dir / ci.image
                    if old_crop.exists():
                        old_crop.unlink(missing_ok=True)
            step.expected_images.clear()
            step.exclude_rois.clear()
        (save_dir / filename).write_bytes(png_bytes)
        step.expected_image = filename
        if req.crop:
            step.roi = ROI(x=int(req.crop["x"]), y=int(req.crop["y"]),
                           width=int(req.crop["width"]), height=int(req.crop["height"]))
        else:
            step.roi = None

    # 스크린샷 디바이스 기록 (재생/테스트 시 동일 디바이스로 캡처)
    step.screenshot_device_id = req.device_id

    await recording_svc.save_scenario(scenario)
    return {"status": "ok", "filename": filename, "step_id": step.id}


class RemoveExpectedImageRequest(BaseModel):
    scenario_name: str
    step_index: int


@router.post("/record/remove-expected-image")
async def remove_expected_image(req: RemoveExpectedImageRequest):
    """Remove expected image and crop files from a step."""
    scenario = await _resolve_scenario(req.scenario_name)
    if req.step_index < 0 or req.step_index >= len(scenario.steps):
        raise HTTPException(status_code=400, detail=f"Invalid step index: {req.step_index}")

    step = scenario.steps[req.step_index]
    save_dir = SCREENSHOTS_DIR / scenario.name

    # 기대이미지 파일 삭제
    if step.expected_image:
        f = save_dir / step.expected_image
        if f.exists():
            f.unlink(missing_ok=True)
        step.expected_image = None

    # multi_crop 이미지 파일 삭제
    for ci in step.expected_images:
        if ci.image:
            f = save_dir / ci.image
            if f.exists():
                f.unlink(missing_ok=True)
    step.expected_images.clear()
    step.exclude_rois.clear()
    step.roi = None

    await recording_svc.save_scenario(scenario)
    return {"status": "ok"}


class ImportStepsRequest(BaseModel):
    target_name: str
    source_name: str
    step_indices: list[int]  # 0-based indices
    move: bool = False  # True면 복사 후 소스에서 제거 (move 동작)


@router.post("/record/import-steps")
async def import_steps(req: ImportStepsRequest):
    """소스 시나리오에서 선택된 스텝들을 복사해온다 (기대이미지 포함).

    move=True이면 복사 후 소스 시나리오에서 해당 스텝들을 제거하고 소스도 저장.
    동일 시나리오(source == target)에서 move는 허용되지 않음 (드래그앤드롭 사용).
    """
    import shutil, time as _time
    source = await recording_svc.load_scenario(req.source_name)
    tgt_ss_dir = SCREENSHOTS_DIR / req.target_name
    tgt_ss_dir.mkdir(parents=True, exist_ok=True)
    src_ss_dir = SCREENSHOTS_DIR / req.source_name

    is_move = req.move and req.source_name != req.target_name

    imported = []
    src_images_to_delete: list[Path] = []
    for idx in req.step_indices:
        if idx < 0 or idx >= len(source.steps):
            continue
        orig = source.steps[idx]
        step_data = orig.model_dump()
        # 새 타임스탬프 기반 ID (충돌 방지)
        ts = int(_time.time() * 1000) % 1000000
        new_id = 900 + len(imported)  # 프론트에서 재인덱싱하므로 임시값

        # 기대이미지 복사
        if step_data.get("expected_image"):
            old_file = src_ss_dir / step_data["expected_image"]
            new_filename = f"{req.target_name}_step_{new_id:03d}_{ts}.png"
            new_file = tgt_ss_dir / new_filename
            if old_file.exists():
                shutil.copy2(str(old_file), str(new_file))
                if is_move:
                    src_images_to_delete.append(old_file)
            step_data["expected_image"] = new_filename
            ts += 1

        # multi_crop 이미지 복사
        new_crops = []
        for ci_idx, ci in enumerate(step_data.get("expected_images", [])):
            if ci.get("image"):
                old_ci = src_ss_dir / ci["image"]
                new_ci_name = f"{req.target_name}_step_{new_id:03d}_crop_{ci_idx:02d}.png"
                new_ci = tgt_ss_dir / new_ci_name
                if old_ci.exists():
                    shutil.copy2(str(old_ci), str(new_ci))
                    if is_move:
                        src_images_to_delete.append(old_ci)
                ci["image"] = new_ci_name
            new_crops.append(ci)
        step_data["expected_images"] = new_crops
        step_data["id"] = new_id
        # goto는 초기화 (다른 시나리오에서 온 경우 의미 없음)
        step_data["on_pass_goto"] = None
        step_data["on_fail_goto"] = None
        imported.append(step_data)

    # Move: 소스에서 선택된 스텝 제거 + 소스 저장 + 이미지 파일 정리
    if is_move and req.step_indices:
        remove_set = {i for i in req.step_indices if 0 <= i < len(source.steps)}
        # 제거 후 id 재번호 + goto 참조 재매핑
        remaining_pairs = [(i, s) for i, s in enumerate(source.steps) if i not in remove_set]
        # old 1-based position → new 1-based position (제거된 것은 None)
        pos_map: dict[int, Optional[int]] = {}
        for new_idx, (old_idx, _s) in enumerate(remaining_pairs):
            pos_map[old_idx + 1] = new_idx + 1
        for old_idx in remove_set:
            pos_map[old_idx + 1] = None

        def _remap_goto(g):
            if g is None or g == -1:
                return g
            return pos_map.get(g, None)

        new_steps = []
        for new_idx, (_old_idx, s) in enumerate(remaining_pairs):
            s_copy = s.model_copy(update={
                "id": new_idx + 1,
                "on_pass_goto": _remap_goto(s.on_pass_goto),
                "on_fail_goto": _remap_goto(s.on_fail_goto),
            })
            new_steps.append(s_copy)
        source.steps = new_steps
        await recording_svc.save_scenario(source)

        # 원본 이미지 파일 제거
        for f in src_images_to_delete:
            try:
                if f.exists():
                    f.unlink()
            except Exception as e:
                logger.warning("Failed to delete source image %s: %s", f, e)

    return {"steps": imported, "moved": is_move}


class RemoveCropRequest(BaseModel):
    scenario_name: str
    step_index: int
    crop_index: int


@router.post("/record/remove-crop")
async def remove_crop(req: RemoveCropRequest):
    """Remove a crop item from a multi-crop step."""
    scenario = await _resolve_scenario(req.scenario_name)

    if req.step_index < 0 or req.step_index >= len(scenario.steps):
        raise HTTPException(status_code=400, detail=f"Invalid step index: {req.step_index}")

    step = scenario.steps[req.step_index]
    if req.crop_index < 0 or req.crop_index >= len(step.expected_images):
        raise HTTPException(status_code=400, detail=f"Invalid crop index: {req.crop_index}")

    removed = step.expected_images.pop(req.crop_index)
    # Delete the image file
    img_path = SCREENSHOTS_DIR / req.scenario_name / removed.image
    if img_path.exists():
        img_path.unlink()

    await recording_svc.save_scenario(scenario)
    return {"status": "ok", "removed": removed.image}


class CropFromExpectedRequest(BaseModel):
    scenario_name: str
    step_index: int
    crop: dict  # {x, y, width, height}
    crop_label: str = ""
    replace_index: Optional[int] = None  # if set, replace existing crop at this index


@router.post("/record/crop-from-expected")
async def crop_from_expected(req: CropFromExpectedRequest):
    """Crop a region from the step's expected_image and save as a multi-crop item."""
    import cv2
    import numpy as np

    scenario = await _resolve_scenario(req.scenario_name)

    if req.step_index < 0 or req.step_index >= len(scenario.steps):
        raise HTTPException(status_code=400, detail=f"Invalid step index: {req.step_index}")

    step = scenario.steps[req.step_index]
    if not step.expected_image:
        raise HTTPException(status_code=400, detail="Step has no expected image to crop from")

    # Read the expected image (한글 경로 대응)
    from ..utils.cv_io import safe_imread
    img_path = SCREENSHOTS_DIR / req.scenario_name / step.expected_image
    img = safe_imread(img_path)
    if img is None:
        raise HTTPException(status_code=400, detail=f"기대이미지를 읽을 수 없음: {step.expected_image} (exists={img_path.exists()})")

    img_h, img_w = img.shape[:2]
    x, y = int(req.crop["x"]), int(req.crop["y"])
    w, h = int(req.crop["width"]), int(req.crop["height"])
    # 범위 클램핑
    x = max(0, min(x, img_w - 1))
    y = max(0, min(y, img_h - 1))
    w = min(w, img_w - x)
    h = min(h, img_h - y)
    if w <= 0 or h <= 0:
        raise HTTPException(status_code=400, detail=f"Crop region out of bounds (image: {img_w}x{img_h}, crop: x={x} y={y} w={w} h={h})")
    cropped = img[y:y + h, x:x + w]

    save_dir = SCREENSHOTS_DIR / req.scenario_name
    save_dir.mkdir(parents=True, exist_ok=True)

    roi = ROI(x=x, y=y, width=w, height=h)

    if req.replace_index is not None:
        # Replace existing crop
        if req.replace_index < 0 or req.replace_index >= len(step.expected_images):
            raise HTTPException(status_code=400, detail=f"Invalid replace index: {req.replace_index}")
        old = step.expected_images[req.replace_index]
        from ..utils.cv_io import safe_imwrite
        filename = old.image  # reuse same filename
        safe_imwrite(save_dir / filename, cropped)
        step.expected_images[req.replace_index] = CropItem(
            image=filename, label=req.crop_label or old.label, roi=roi,
        )
    else:
        # Append new crop
        from ..utils.cv_io import safe_imwrite
        crop_idx = len(step.expected_images)
        filename = f"{req.scenario_name}_step_{step.id:03d}_crop_{crop_idx:02d}.png"
        safe_imwrite(save_dir / filename, cropped)
        step.expected_images.append(CropItem(image=filename, label=req.crop_label, roi=roi))

    await recording_svc.save_scenario(scenario)
    return {
        "status": "ok",
        "filename": filename,
        "roi": roi.model_dump(),
        "index": req.replace_index if req.replace_index is not None else len(step.expected_images) - 1,
    }


# ------------------------------------------------------------------
# Groups
# ------------------------------------------------------------------
# Folders
# ------------------------------------------------------------------

@router.get("/folders")
async def get_folders():
    return {"folders": recording_svc.get_folders()}


class FolderRequest(BaseModel):
    name: str


class FolderRenameRequest(BaseModel):
    old_name: str
    new_name: str


class FolderMoveRequest(BaseModel):
    scenario_name: str
    folder_name: Optional[str] = None  # None = 루트


@router.post("/folders/create")
async def create_folder(req: FolderRequest):
    try:
        folders = recording_svc.create_folder(req.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"folders": folders}


@router.post("/folders/rename")
async def rename_folder(req: FolderRenameRequest):
    try:
        folders = recording_svc.rename_folder(req.old_name, req.new_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"folders": folders}


@router.post("/folders/delete")
async def delete_folder(req: FolderRequest):
    folders = recording_svc.delete_folder(req.name)
    return {"folders": folders}


@router.post("/folders/move")
async def move_to_folder(req: FolderMoveRequest):
    folders = recording_svc.move_to_folder(req.scenario_name, req.folder_name)
    return {"folders": folders}


# ------------------------------------------------------------------
# Groups
# ------------------------------------------------------------------

@router.get("/groups")
async def get_groups():
    """Get all scenario groups."""
    return {"groups": recording_svc.get_groups()}


class CreateGroupRequest(BaseModel):
    name: str


@router.post("/groups")
async def create_group(req: CreateGroupRequest):
    try:
        groups = recording_svc.create_group(req.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"groups": groups}


class RenameGroupRequest(BaseModel):
    old_name: str
    new_name: str


@router.put("/groups")
async def rename_group(req: RenameGroupRequest):
    try:
        groups = recording_svc.rename_group(req.old_name, req.new_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"groups": groups}


@router.delete("/groups/{group_name}")
async def delete_group(group_name: str):
    groups = recording_svc.delete_group(group_name)
    return {"groups": groups}


class GroupScenarioRequest(BaseModel):
    scenario_name: str


@router.post("/groups/{group_name}/add")
async def add_to_group(group_name: str, req: GroupScenarioRequest):
    groups = recording_svc.add_to_group(group_name, req.scenario_name)
    return {"groups": groups}


@router.post("/groups/{group_name}/remove")
async def remove_from_group(group_name: str, req: GroupScenarioRequest):
    groups = recording_svc.remove_from_group(group_name, req.scenario_name)
    return {"groups": groups}


class ReorderGroupRequest(BaseModel):
    ordered: list[str]


@router.post("/groups/{group_name}/reorder")
async def reorder_group(group_name: str, req: ReorderGroupRequest):
    groups = recording_svc.reorder_group(group_name, req.ordered)
    return {"groups": groups}


class JumpTarget(BaseModel):
    scenario: int  # group index (0-based), -1 = END
    step: int = 0  # step index within the scenario (0-based)


class UpdateGroupJumpsRequest(BaseModel):
    index: int
    on_pass_goto: Optional[JumpTarget] = None
    on_fail_goto: Optional[JumpTarget] = None


@router.post("/groups/{group_name}/jumps")
async def update_group_jumps(group_name: str, req: UpdateGroupJumpsRequest):
    pass_goto = req.on_pass_goto.model_dump() if req.on_pass_goto else None
    fail_goto = req.on_fail_goto.model_dump() if req.on_fail_goto else None
    groups = recording_svc.update_group_jumps(group_name, req.index, pass_goto, fail_goto)
    return {"groups": groups}


class UpdateGroupStepJumpsRequest(BaseModel):
    index: int        # scenario index in group
    step_id: int      # step id within scenario
    on_pass_goto: Optional[JumpTarget] = None
    on_fail_goto: Optional[JumpTarget] = None


@router.post("/groups/{group_name}/step-jumps")
async def update_group_step_jumps(group_name: str, req: UpdateGroupStepJumpsRequest):
    pass_goto = req.on_pass_goto.model_dump() if req.on_pass_goto else None
    fail_goto = req.on_fail_goto.model_dump() if req.on_fail_goto else None
    groups = recording_svc.update_group_step_jumps(
        group_name, req.index, req.step_id, pass_goto, fail_goto
    )
    return {"groups": groups}


# ------------------------------------------------------------------
# Copy & Merge
# ------------------------------------------------------------------

class CopyScenarioRequest(BaseModel):
    target_name: str


@router.post("/copy/{name}")
async def copy_scenario(name: str, req: CopyScenarioRequest):
    """Copy a scenario with a new name."""
    try:
        scenario = await recording_svc.copy_scenario(name, req.target_name)
        return {"status": "ok", "scenario": scenario.model_dump()}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Scenario '{name}' not found")


class MergeRequest(BaseModel):
    names: list[str]
    target_name: str


@router.post("/merge")
async def merge_scenarios(req: MergeRequest):
    """Merge multiple scenarios into one."""
    try:
        scenario = await recording_svc.merge_scenarios(req.names, req.target_name)
        return {"status": "ok", "scenario": scenario.model_dump()}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ------------------------------------------------------------------
# Playback & Verification (before /{name} to avoid conflicts)
# ------------------------------------------------------------------

class TestStepRequest(BaseModel):
    scenario_name: str
    step_index: int  # 0-based
    step_data: Optional[dict] = None  # current (unsaved) step data from frontend


@router.post("/clean-test-screenshots")
async def clean_test_screenshots(scenario_name: str = ""):
    """단일 스텝 테스트 임시 스크린샷(actual/) 삭제."""
    import shutil
    cleaned = 0
    if scenario_name:
        actual = SCREENSHOTS_DIR / scenario_name / "actual"
        if actual.is_dir():
            shutil.rmtree(str(actual), ignore_errors=True)
            cleaned += 1
    else:
        # 전체 시나리오의 actual 폴더 삭제
        if SCREENSHOTS_DIR.is_dir():
            for d in SCREENSHOTS_DIR.iterdir():
                actual = d / "actual"
                if actual.is_dir():
                    shutil.rmtree(str(actual), ignore_errors=True)
                    cleaned += 1
    return {"cleaned": cleaned}


@router.post("/test-step")
async def test_step(req: TestStepRequest):
    """Execute a single step on the device and verify against expected image."""
    device_map: dict = {}

    if req.step_data:
        # Use the step data sent from frontend (may differ from saved file)
        from ..models.scenario import Step
        step = Step(**req.step_data)
        scenario_name = req.scenario_name
        # Load device_map from in-memory scenario or saved file
        cur = recording_svc._current_scenario
        if cur and cur.name == req.scenario_name and cur.device_map:
            device_map = dict(cur.device_map)
        else:
            try:
                scenario = await recording_svc.load_scenario(req.scenario_name)
                device_map = dict(scenario.device_map) if scenario.device_map else {}
            except FileNotFoundError:
                pass
    else:
        # 녹화 중 메모리 시나리오 또는 저장된 파일에서 로드
        cur = recording_svc._current_scenario
        if cur and cur.name == req.scenario_name:
            scenario = cur
        else:
            try:
                scenario = await recording_svc.load_scenario(req.scenario_name)
            except FileNotFoundError:
                raise HTTPException(status_code=404, detail=f"Scenario '{req.scenario_name}' not found")

        if req.step_index < 0 or req.step_index >= len(scenario.steps):
            raise HTTPException(status_code=400, detail=f"Invalid step index: {req.step_index}")

        step = scenario.steps[req.step_index]
        scenario_name = scenario.name
        device_map = dict(scenario.device_map) if scenario.device_map else {}

    result = await playback_svc.execute_single_step(step, scenario_name, device_map=device_map)
    return result.model_dump()


@router.delete("/cmd-result/{task_id}")
async def cancel_cmd_task(task_id: str):
    """백그라운드 태스크 취소 요청. SSH 스트리밍 reader가 다음 tick에 채널을 닫고 종료한다."""
    from ..services import bg_task_store
    ok = bg_task_store.request_cancel(task_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"cancelled": True, "task_id": task_id}


@router.get("/cmd-result/{task_id}")
async def get_cmd_result(task_id: str):
    """백그라운드 CMD 결과 폴링.

    완료 시 expected/match_mode가 저장되어 있으면 서버에서 비교까지 수행하여
    final_message와 final_status를 반환한다. 프론트엔드는 이 값을 step result에
    그대로 반영하기만 하면 된다.
    """
    from ..services import bg_task_store
    result = bg_task_store.get_task(task_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Task not found")

    if result["status"] != "running":
        # 완료된 태스크: 최종 메시지/판정 계산
        stdout = result.get("stdout", "") or ""
        stderr = result.get("stderr", "") or ""
        rc = result.get("rc")
        expected = result.get("expected")
        match_mode = result.get("match_mode", "contains")

        combined = stdout
        if stderr:
            combined = (combined + "\n" + stderr).strip() if combined else stderr

        if expected is not None:
            # CheckCapture 결과: 비교 수행
            actual = combined.strip()
            exp = (expected or "").strip()
            if match_mode == "exact":
                passed = actual == exp
            else:
                passed = exp in actual
            if passed:
                result["final_message"] = combined if combined else f"(exit code: {rc})"
                result["final_status"] = "pass"
            else:
                result["final_message"] = f"FAIL: expected({match_mode}): {expected}\n---\n{combined}"
                result["final_status"] = "fail"
        else:
            # RunCapture 결과: 메시지만 제공, 상태는 변경하지 않음
            result["final_message"] = combined if combined else f"(exit code: {rc})"
            result["final_status"] = None

        # 반환 후 정리
        bg_task_store.cleanup_task(task_id)
    return result


class PlaybackRequest(BaseModel):
    verify: bool = True


@router.post("/playback/stop")
async def stop_playback():
    """Stop the currently running playback.

    WebSocket과 무관하게 REST로도 호출 가능 — 프론트엔드가 죽거나
    연결이 끊어진 상태에서 백그라운드 재생을 강제 중단할 때 사용.
    """
    from ..services.playback_service import (
        publish_event, mark_playback_active,
    )
    was_running = playback_svc.is_running
    await playback_svc.stop()
    # 새 WS 연결 시 이전 run의 버퍼가 replay되지 않도록 즉시 inactive 처리
    mark_playback_active(False)
    # 연결되어 있는 기존 subscriber들에게도 알림
    publish_event({"type": "playback_stopped", "result_filename": "", "source": "rest"})
    return {"status": "stopping", "was_running": was_running}


@router.get("/playback/status")
async def playback_status():
    """Check if playback is running + current monitor state (scenario name, progress)."""
    return {
        "running": playback_svc.is_running,
        "monitor": getattr(playback_svc, "_monitor_state", {}) or {},
    }


# ------------------------------------------------------------------
# Scenario CRUD (/{name} wildcard routes MUST be last)
# ------------------------------------------------------------------

@router.get("/list")
async def list_scenarios():
    """List all saved scenarios."""
    names = await recording_svc.list_scenarios()
    return {"scenarios": names}


# ------------------------------------------------------------------
# Export / Import
# ------------------------------------------------------------------

class ExportRequest(BaseModel):
    scenarios: list[str] = []
    groups: list[str] = []
    include_all: bool = False


@router.post("/export")
async def export_scenarios(req: ExportRequest):
    """Export selected scenarios and groups as a ZIP file."""
    scenario_names = req.scenarios
    group_names = req.groups

    if req.include_all:
        scenario_names = await recording_svc.list_scenarios()
        group_names = list(recording_svc.get_groups().keys())

    if not scenario_names and not group_names:
        raise HTTPException(status_code=400, detail="Nothing to export")

    zip_bytes = await recording_svc.export_zip(scenario_names, group_names)
    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="replaykit_export_{ts}.zip"'},
    )


@router.post("/import/preview")
async def import_preview(file: UploadFile = File(...)):
    """Preview a ZIP import and check for conflicts."""
    zip_data = await file.read()
    try:
        result = await recording_svc.import_preview(zip_data)
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/import/apply")
async def import_apply(file: UploadFile = File(...), resolutions: str = Form("{}")):
    """Apply a ZIP import with conflict resolutions."""
    zip_data = await file.read()
    try:
        res_dict = json.loads(resolutions)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid resolutions JSON")

    try:
        result = await recording_svc.import_apply(zip_data, res_dict)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{name}")
async def get_scenario(name: str):
    """Load a scenario by name."""
    try:
        scenario = await recording_svc.load_scenario(name)
        return scenario.model_dump()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Scenario '{name}' not found")


@router.delete("/{name}")
async def delete_scenario(name: str):
    """Delete a scenario."""
    deleted = await recording_svc.delete_scenario(name)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Scenario '{name}' not found")
    return {"status": "deleted"}


class RenameScenarioRequest(BaseModel):
    new_name: str


@router.post("/{name}/rename")
async def rename_scenario(name: str, req: RenameScenarioRequest):
    """Rename a scenario."""
    try:
        ok = await recording_svc.rename_scenario(name, req.new_name)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    if not ok:
        raise HTTPException(status_code=404, detail=f"Scenario '{name}' not found")
    return {"status": "renamed", "old_name": name, "new_name": req.new_name}


@router.put("/{name}")
async def update_scenario(name: str, scenario: Scenario):
    """Update a scenario."""
    await recording_svc.save_scenario(scenario)
    return {"status": "updated"}


@router.post("/{name}/play")
async def play_scenario(name: str, req: PlaybackRequest):
    """Execute a saved scenario."""
    try:
        scenario = await recording_svc.load_scenario(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Scenario '{name}' not found")

    # Preflight device check
    errors = await playback_svc.preflight_check(scenario)
    if errors:
        raise HTTPException(status_code=400, detail="디바이스 연결 확인 실패:\n" + "\n".join(errors))

    try:
        result = await playback_svc.execute_scenario(scenario, verify=req.verify)
        return result.model_dump()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
