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
    "monitor_server_url": "",
    "admin_server_url": "",
    "threshold_full": 0.95,
    "threshold_single_crop": 0.90,
    "threshold_full_exclude": 0.93,
    "threshold_multi_crop": 0.85,
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
    monitor_server_url: Optional[str] = None
    admin_server_url: Optional[str] = None
    threshold_full: Optional[float] = None
    threshold_single_crop: Optional[float] = None
    threshold_full_exclude: Optional[float] = None
    threshold_multi_crop: Optional[float] = None


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
    if req.monitor_server_url is not None:
        current["monitor_server_url"] = req.monitor_server_url
    if req.admin_server_url is not None:
        current["admin_server_url"] = req.admin_server_url
    if req.threshold_full is not None:
        current["threshold_full"] = req.threshold_full
    if req.threshold_single_crop is not None:
        current["threshold_single_crop"] = req.threshold_single_crop
    if req.threshold_full_exclude is not None:
        current["threshold_full_exclude"] = req.threshold_full_exclude
    if req.threshold_multi_crop is not None:
        current["threshold_multi_crop"] = req.threshold_multi_crop
    _save(current)

    # 관제 서버 URL 변경 시 monitor_client 재연결
    if req.monitor_server_url is not None:
        try:
            from ..dependencies import monitor_client
            import asyncio
            asyncio.create_task(monitor_client.update_server_url(req.monitor_server_url))
        except Exception as e:
            logger.debug("Monitor client URL update: %s", e)

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


@router.get("/power-status")
async def power_status():
    """PC 절전 모드 설정 조회 (Windows 전용)."""
    result = {"ac_standby_seconds": None, "dc_standby_seconds": None, "warning": None}
    if sys.platform != "win32":
        result["warning"] = "Windows만 지원"
        return result
    try:
        import ctypes
        import ctypes.wintypes as wt
        powrprof = ctypes.windll.powrprof
        GUID = ctypes.c_byte * 16
        SLEEP_SUB = (GUID)(0x38, 0x83, 0x30, 0x23, 0x82, 0x15, 0xD2, 0x11, 0x9C, 0xE7, 0x00, 0x80, 0xC7, 0x3C, 0x88, 0x81)
        STANDBY = (GUID)(0x1D, 0xC1, 0xF6, 0x29, 0xEA, 0x42, 0x6D, 0x47, 0x82, 0x8A, 0x3B, 0x06, 0x42, 0x6B, 0xD1, 0xFD)
        val = wt.DWORD(0)
        powrprof.PowerReadACValueIndex(None, None, ctypes.byref(SLEEP_SUB), ctypes.byref(STANDBY), ctypes.byref(val))
        result["ac_standby_seconds"] = val.value
        powrprof.PowerReadDCValueIndex(None, None, ctypes.byref(SLEEP_SUB), ctypes.byref(STANDBY), ctypes.byref(val))
        result["dc_standby_seconds"] = val.value
        if val.value > 0 or result["ac_standby_seconds"] > 0:
            mins = min(result["ac_standby_seconds"] or 99999, result["dc_standby_seconds"] or 99999) // 60
            result["warning"] = f"절전 모드가 {mins}분으로 설정되어 있습니다. 장시간 재생 시 중단될 수 있습니다."
    except Exception as e:
        result["warning"] = f"절전 설정 조회 실패: {e}"
    return result


@router.get("/launcher-log")
async def get_launcher_log(lines: int = 200, date: str = "", source: str = ""):
    """런처/백엔드 로그 읽기 (날짜별 로그 파일).
    source: '' = 런처(날짜별), 'backend' = 백엔드(backend.log + 로테이션)
    """
    from datetime import datetime as _dt
    log_dir = _PROJECT_ROOT / "logs"
    if not log_dir.is_dir():
        return {"lines": [], "dates": [], "sources": ["launcher", "backend"]}

    if source == "backend":
        # 백엔드 로그: backend.log + backend.log.2026-04-09 등
        files = sorted(log_dir.glob("backend.log*"), reverse=True)
        dates = []
        for f in files:
            if f.name == "backend.log":
                dates.append("today")
            else:
                dates.append(f.name.replace("backend.log.", ""))
        target = date or "today"
        if target == "today":
            log_file = log_dir / "backend.log"
        else:
            log_file = log_dir / f"backend.log.{target}"
    else:
        # 런처 로그: 날짜별
        dates = sorted([f.stem for f in log_dir.glob("*.log") if not f.name.startswith("backend")], reverse=True)
        target = date or _dt.now().strftime("%Y-%m-%d")
        log_file = log_dir / f"{target}.log"

    if not log_file.exists():
        return {"lines": [], "dates": dates, "sources": ["launcher", "backend"]}
    try:
        content = log_file.read_text(encoding="utf-8", errors="replace")
        all_lines = content.strip().split("\n") if content.strip() else []
        return {"lines": all_lines[-lines:], "dates": dates, "sources": ["launcher", "backend"]}
    except Exception:
        return {"lines": [], "dates": dates, "sources": ["launcher", "backend"]}


@router.post("/update-and-restart")
async def update_and_restart():
    """서버 종료 → ReplayKit.bat이 git pull + 서버 재시작."""
    logger.info("Update requested — writing .restart flag")
    _RESTART_FLAG.write_text("restart", encoding="utf-8")
    return {"status": "restarting"}


@router.get("/disk-usage")
async def disk_usage():
    """연결된 모든 디스크 드라이브의 사용량 조회."""
    import platform
    drives: list[dict] = []
    if platform.system() == "Windows":
        # Windows: A~Z 드라이브 스캔
        for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
            dp = f"{letter}:\\"
            try:
                total, used, free = shutil.disk_usage(dp)
                if total > 0:
                    drives.append({
                        "drive": f"{letter}:",
                        "total_gb": round(total / (1024 ** 3), 1),
                        "used_gb": round(used / (1024 ** 3), 1),
                        "free_gb": round(free / (1024 ** 3), 1),
                        "used_percent": round(used / total * 100, 1),
                    })
            except (OSError, PermissionError):
                continue
    else:
        # Linux/Mac: 루트 드라이브
        drive = Path(_PROJECT_ROOT).anchor or "/"
        total, used, free = shutil.disk_usage(drive)
        drives.append({
            "drive": drive.rstrip("/") or "/",
            "total_gb": round(total / (1024 ** 3), 1),
            "used_gb": round(used / (1024 ** 3), 1),
            "free_gb": round(free / (1024 ** 3), 1),
            "used_percent": round(used / total * 100, 1),
        })
    return drives


@router.get("/git-log")
async def git_log(limit: int = 100, fetch: bool = False):
    """Git 커밋 내역 조회. fetch=true면 원격에서 최신 커밋 가져온 후 조회."""
    try:
        no_window = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        if fetch:
            fetch_r = subprocess.run(
                ["git", "fetch", "origin", "main"],
                cwd=str(_PROJECT_ROOT), capture_output=True, timeout=15,
                encoding="utf-8", errors="replace", creationflags=no_window,
            )
            if fetch_r.returncode != 0:
                raise HTTPException(status_code=502, detail=f"원격 저장소 연결 실패: {fetch_r.stderr.strip()}")

        # origin/main 커밋 조회 (setup.bat이 git_remote.txt URL을 origin으로 등록)
        r = subprocess.run(
            ["git", "log", "origin/main", f"-{limit}", "--pretty=format:%H||%h||%an||%ae||%aI||%s"],
            cwd=str(_PROJECT_ROOT),
            capture_output=True, timeout=10, encoding="utf-8", errors="replace",
            creationflags=no_window,
        )
        if r.returncode != 0:
            raise HTTPException(status_code=500, detail=f"git log failed: {r.stderr.strip()}")

        commits = []
        for line in r.stdout.strip().split("\n"):
            if not line:
                continue
            parts = line.split("||", 5)
            if len(parts) < 6:
                continue
            commits.append({
                "hash": parts[0],
                "short_hash": parts[1],
                "author": parts[2],
                "email": parts[3],
                "date": parts[4],
                "message": parts[5],
            })

        # 현재 브랜치, 태그 정보
        branch_r = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=str(_PROJECT_ROOT), capture_output=True, timeout=5, encoding="utf-8", errors="replace",
            creationflags=no_window,
        )
        branch = branch_r.stdout.strip() if branch_r.returncode == 0 else "unknown"

        tag_r = subprocess.run(
            ["git", "tag", "--sort=-creatordate"],
            cwd=str(_PROJECT_ROOT), capture_output=True, timeout=5, encoding="utf-8", errors="replace",
            creationflags=no_window,
        )
        tags = [t for t in tag_r.stdout.strip().split("\n") if t] if tag_r.returncode == 0 else []

        return {"branch": branch, "tags": tags, "commits": commits}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="git command timed out")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="git not found")


@router.post("/open-results-folder")
async def open_results_folder():
    """Results 폴더를 파일 탐색기로 열기."""
    results_dir = _PROJECT_ROOT / "Results"
    results_dir.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        os.startfile(str(results_dir))
    else:
        subprocess.Popen(["xdg-open", str(results_dir)])
    return {"status": "ok", "path": str(results_dir)}
