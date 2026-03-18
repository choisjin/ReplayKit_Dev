"""Settings API routes."""

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/settings", tags=["settings"])

_SETTINGS_FILE = Path(__file__).resolve().parent.parent.parent / "settings.json"

_DEFAULTS = {
    "theme": "dark",
    "webcam_save_dir": "",
    "excel_export_dir": "",
    "scenario_export_dir": "",
    "language": "ko",
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
    scenario_export_dir: Optional[str] = None
    language: Optional[str] = None


@router.post("")
async def update_settings(req: UpdateSettingsRequest):
    current = _load()
    if req.theme is not None:
        current["theme"] = req.theme
    if req.webcam_save_dir is not None:
        current["webcam_save_dir"] = req.webcam_save_dir
    if req.excel_export_dir is not None:
        current["excel_export_dir"] = req.excel_export_dir
    if req.scenario_export_dir is not None:
        current["scenario_export_dir"] = req.scenario_export_dir
    if req.language is not None:
        current["language"] = req.language
    _save(current)
    return current


class BrowseFolderRequest(BaseModel):
    initial_dir: Optional[str] = None


def _open_folder_dialog(initial_dir: str = "") -> str:
    """Open a native folder picker dialog using tkinter (runs in main thread)."""
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    kwargs = {}
    if initial_dir and Path(initial_dir).is_dir():
        kwargs["initialdir"] = initial_dir
    folder = filedialog.askdirectory(**kwargs)
    root.destroy()
    return folder or ""


@router.post("/browse-folder")
async def browse_folder(req: BrowseFolderRequest):
    """Open native folder picker dialog and return the selected path."""
    loop = asyncio.get_event_loop()
    try:
        selected = await loop.run_in_executor(None, _open_folder_dialog, req.initial_dir or "")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"폴더 선택 실패: {e}")
    return {"path": selected}


@router.post("/upload-webcam")
async def upload_webcam_recording(file: UploadFile = File(...), filename: str = ""):
    """Save uploaded webcam recording to Results/Video/ directory."""
    dirpath = Path(__file__).resolve().parent.parent.parent.parent / "Results" / "Video"
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


class SaveExcelRequest(BaseModel):
    result_filename: str


@router.post("/save-excel")
async def save_excel_to_dir(req: SaveExcelRequest):
    """Export Excel and save directly to the configured directory."""
    result_filename = req.result_filename
    print(f"[save-excel] result_filename={result_filename!r}, settings_file={_SETTINGS_FILE}")
    settings = _load()
    save_dir = settings.get("excel_export_dir", "")
    print(f"[save-excel] excel_export_dir={save_dir!r}")
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


class SaveExportZipRequest(BaseModel):
    scenarios: list[str] = []
    groups: list[str] = []
    include_all: bool = False


@router.post("/save-export-zip")
async def save_export_zip(req: SaveExportZipRequest):
    """Export scenarios/groups as ZIP and save to the configured directory."""
    settings = _load()
    save_dir = settings.get("scenario_export_dir", "")
    if not save_dir:
        raise HTTPException(status_code=400, detail="내보내기 저장 경로가 설정되지 않았습니다. 설정 탭에서 경로를 지정하세요.")

    dirpath = Path(save_dir)
    if not dirpath.exists():
        try:
            dirpath.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"디렉토리 생성 실패: {e}")

    from ..dependencies import recording_service as recording_svc
    scenario_names = req.scenarios
    group_names = req.groups

    if req.include_all:
        scenario_names = await recording_svc.list_scenarios()
        group_names = list(recording_svc.get_groups().keys())

    if not scenario_names and not group_names:
        raise HTTPException(status_code=400, detail="내보낼 항목이 없습니다.")

    zip_bytes = await recording_svc.export_zip(scenario_names, group_names)

    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    zip_name = f"replaykit_export_{ts}.zip"
    dest = dirpath / zip_name
    try:
        dest.write_bytes(zip_bytes)
        return {"result": "ok", "path": str(dest)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ZIP 저장 실패: {e}")


_PROJECT_ROOT = Path(os.environ.get("RECORDING_PROJECT_ROOT",
                     str(Path(__file__).resolve().parent.parent.parent.parent)))
_RESTART_FLAG = _PROJECT_ROOT / ".restart"


@router.post("/server-restart")
async def server_restart():
    """서버 재시작 요청. server.py(또는 exe)가 .restart 플래그를 감지하여 재시작."""
    logger.info("Server restart requested via API")
    _RESTART_FLAG.write_text("restart", encoding="utf-8")
    return {"status": "restarting"}


@router.post("/update-and-restart")
async def update_and_restart():
    """git pull + 의존성 업데이트 + 서버 재시작."""
    results = {"git": "", "pip": "", "npm": ""}
    npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"
    cwd = str(_PROJECT_ROOT)
    no_window = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

    try:
        # 1) 로컬 변경 초기화 + untracked 정리 + git pull
        subprocess.run(["git", "checkout", "--", "."],
                       cwd=cwd, capture_output=True, text=True, timeout=30, creationflags=no_window)
        subprocess.run(["git", "clean", "-fd", "--exclude=ReplayKit.exe"],
                       cwd=cwd, capture_output=True, text=True, timeout=30, creationflags=no_window)
        r = subprocess.run(["git", "pull", "origin", "main"],
                           cwd=cwd, capture_output=True, text=True, timeout=60, creationflags=no_window)
        results["git"] = (r.stdout.strip() + "\n" + r.stderr.strip()).strip()
        if r.returncode != 0:
            return {"status": "error", "step": "git pull", "detail": results["git"], "results": results}

        # 2) pip install
        venv_py = _PROJECT_ROOT / "venv" / "Scripts" / "python.exe"
        if not venv_py.exists():
            venv_py = _PROJECT_ROOT / "venv" / "bin" / "python"
        python = str(venv_py) if venv_py.exists() else sys.executable
        r = subprocess.run([python, "-m", "pip", "install", "-r", "requirements.txt", "-q"],
                           cwd=cwd, capture_output=True, text=True, timeout=120, creationflags=no_window)
        results["pip"] = r.stdout.strip() or "OK"

        # 3) npm install
        r = subprocess.run([npm_cmd, "install", "--silent"],
                           cwd=str(_PROJECT_ROOT / "frontend"), capture_output=True, text=True, timeout=120, creationflags=no_window)
        results["npm"] = r.stdout.strip() or "OK"

    except subprocess.TimeoutExpired as e:
        return {"status": "error", "step": "timeout", "detail": str(e), "results": results}
    except Exception as e:
        return {"status": "error", "step": "exception", "detail": str(e), "results": results}

    # 4) .restart 플래그로 server.py에 재시작 요청
    logger.info("Update complete — requesting restart via flag")
    _RESTART_FLAG.write_text("restart", encoding="utf-8")
    return {"status": "restarting", "results": results}
