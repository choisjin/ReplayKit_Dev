"""Settings API routes."""

import json
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

router = APIRouter(prefix="/api/settings", tags=["settings"])

_SETTINGS_FILE = Path(__file__).resolve().parent.parent.parent / "settings.json"

_DEFAULTS = {
    "theme": "dark",
    "webcam_save_dir": "",
    "excel_export_dir": "",
}


def _load() -> dict:
    if _SETTINGS_FILE.exists():
        try:
            data = json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
            return {**_DEFAULTS, **data}
        except Exception:
            pass
    return dict(_DEFAULTS)


def _save(data: dict) -> None:
    _SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


@router.get("")
async def get_settings():
    return _load()


class UpdateSettingsRequest(BaseModel):
    theme: Optional[str] = None
    webcam_save_dir: Optional[str] = None
    excel_export_dir: Optional[str] = None


@router.post("")
async def update_settings(req: UpdateSettingsRequest):
    current = _load()
    if req.theme is not None:
        current["theme"] = req.theme
    if req.webcam_save_dir is not None:
        current["webcam_save_dir"] = req.webcam_save_dir
    if req.excel_export_dir is not None:
        current["excel_export_dir"] = req.excel_export_dir
    _save(current)
    return current


@router.post("/upload-webcam")
async def upload_webcam_recording(file: UploadFile = File(...), filename: str = Form("")):
    """Save uploaded webcam recording to the configured directory."""
    settings = _load()
    save_dir = settings.get("webcam_save_dir", "")
    if not save_dir:
        raise HTTPException(status_code=400, detail="웹캠 저장 경로가 설정되지 않았습니다. 설정 탭에서 경로를 지정하세요.")

    dirpath = Path(save_dir)
    if not dirpath.exists():
        try:
            dirpath.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"디렉토리 생성 실패: {e}")

    final_name = filename or file.filename or "webcam_recording.webm"
    dest = dirpath / final_name
    try:
        with open(dest, "wb") as f:
            shutil.copyfileobj(file.file, f)
        return {"result": "ok", "path": str(dest)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"파일 저장 실패: {e}")


@router.post("/save-excel/{result_filename}")
async def save_excel_to_dir(result_filename: str):
    """Export Excel and save directly to the configured directory."""
    settings = _load()
    save_dir = settings.get("excel_export_dir", "")
    if not save_dir:
        raise HTTPException(status_code=400, detail="Excel 저장 경로가 설정되지 않았습니다. 설정 탭에서 경로를 지정하세요.")

    dirpath = Path(save_dir)
    if not dirpath.exists():
        try:
            dirpath.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"디렉토리 생성 실패: {e}")

    # Reuse the export logic from results router
    from .results import RESULTS_DIR
    filepath = RESULTS_DIR / result_filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Result not found")

    data = json.loads(filepath.read_text(encoding="utf-8"))

    from .results import _build_excel_workbook
    try:
        wb = _build_excel_workbook(data, filepath)
    except ImportError:
        raise HTTPException(status_code=500, detail="openpyxl not installed")

    excel_name = result_filename.replace('.json', '.xlsx')
    dest = dirpath / excel_name
    try:
        wb.save(str(dest))
        return {"result": "ok", "path": str(dest)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Excel 저장 실패: {e}")
