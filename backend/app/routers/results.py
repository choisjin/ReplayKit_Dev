"""Test results API routes."""

import json
import io
import subprocess
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse, StreamingResponse

router = APIRouter(prefix="/api/results", tags=["results"])

RESULTS_DIR = Path(__file__).resolve().parent.parent.parent / "results"
SCREENSHOTS_DIR = Path(__file__).resolve().parent.parent.parent / "screenshots"
RECORDINGS_DIR = Path(__file__).resolve().parent.parent.parent / "recordings"


@router.get("/list")
async def list_results():
    """List all test result files."""
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    for f in sorted(RESULTS_DIR.glob("*.json"), reverse=True):
        data = json.loads(f.read_text(encoding="utf-8"))
        results.append({
            "filename": f.name,
            "scenario_name": data.get("scenario_name", ""),
            "status": data.get("status", ""),
            "total_steps": data.get("total_steps", 0),
            "passed_steps": data.get("passed_steps", 0),
            "failed_steps": data.get("failed_steps", 0),
            "warning_steps": data.get("warning_steps", 0),
            "error_steps": data.get("error_steps", 0),
            "started_at": data.get("started_at", ""),
            "finished_at": data.get("finished_at", ""),
        })
    return {"results": results}


def _resolve_image_path(rel_path: str | None) -> Path | None:
    """Resolve a relative screenshot path to an absolute filesystem path."""
    if not rel_path:
        return None
    # Handle absolute paths from older results
    p = rel_path.replace("\\", "/")
    idx = p.find("/screenshots/")
    if idx >= 0:
        p = p[idx + len("/screenshots/"):]
    full = SCREENSHOTS_DIR / p
    return full if full.exists() else None


def _build_excel_workbook(data: dict, filepath: Path = None):
    """Build an openpyxl Workbook from result data. Reusable by settings router."""
    import openpyxl
    from openpyxl.drawing.image import Image as XlImage
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Test Report"

    header_fill = PatternFill(start_color="4472C4", end_color="4472C4", fill_type="solid")
    header_font = Font(bold=True, color="FFFFFF", size=10)
    desc_fill = PatternFill(start_color="D9E2F3", end_color="D9E2F3", fill_type="solid")
    desc_font = Font(color="44546A", size=9)
    pass_fill = PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid")
    fail_fill = PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid")
    warn_fill = PatternFill(start_color="FFEB9C", end_color="FFEB9C", fill_type="solid")
    error_fill = PatternFill(start_color="F4B084", end_color="F4B084", fill_type="solid")
    thin_border = Border(
        left=Side(style="thin"), right=Side(style="thin"),
        top=Side(style="thin"), bottom=Side(style="thin"),
    )
    center = Alignment(horizontal="center", vertical="center")

    col_headers = [
        "Time Stamp", "TOTAL TC REPEAT", "CURRENT TC REPEAT",
        "STEP INDEX", "Device", "Command", "Remark", "Status", "DELAY", "DURATION",
        "Expected Image", "Actual Image",
    ]
    col_descs = [
        "실행된 날짜/시간", "총 repeat", "현재 cycle",
        "스탭 순서", "장치", "action", "설명", "pass, fail, error, jump", "설정한 딜레이", "실제 걸린 시간",
        "기대 이미지", "비교 이미지 (annotated)",
    ]
    col_widths = [22, 16, 18, 12, 16, 30, 30, 12, 12, 14, 30, 30]

    for ci, w in enumerate(col_widths, start=1):
        ws.column_dimensions[get_column_letter(ci)].width = w

    for ci, h in enumerate(col_headers, start=1):
        cell = ws.cell(row=1, column=ci, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = center
        cell.border = thin_border

    for ci, d in enumerate(col_descs, start=1):
        cell = ws.cell(row=2, column=ci, value=d)
        cell.font = desc_font
        cell.fill = desc_fill
        cell.alignment = center
        cell.border = thin_border

    total_repeat = data.get("total_repeat", 1)
    img_row_height = 120

    for ri, sr in enumerate(data.get("step_results", []), start=3):
        status = sr.get("status", "")
        timestamp = sr.get("timestamp", data.get("started_at", ""))
        command = sr.get("command", sr.get("message", ""))
        delay_ms = sr.get("delay_ms", 0)
        duration_ms = sr.get("execution_time_ms", 0)

        try:
            from datetime import datetime as _dt
            ts = _dt.fromisoformat(timestamp.replace("Z", "+00:00"))
            ts_str = ts.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            ts_str = timestamp or ""

        dur_str = f"{duration_ms}ms" if duration_ms < 1000 else f"{duration_ms / 1000:.1f}s"
        delay_str = f"{delay_ms}ms" if delay_ms < 1000 else f"{delay_ms / 1000:.1f}s"

        ws.cell(row=ri, column=1, value=ts_str).border = thin_border
        ws.cell(row=ri, column=2, value=total_repeat).border = thin_border
        ws.cell(row=ri, column=2).alignment = center
        ws.cell(row=ri, column=3, value=sr.get("repeat_index", 1)).border = thin_border
        ws.cell(row=ri, column=3).alignment = center
        ws.cell(row=ri, column=4, value=sr.get("step_id", "")).border = thin_border
        ws.cell(row=ri, column=4).alignment = center
        ws.cell(row=ri, column=5, value=sr.get("device_id", "")).border = thin_border
        ws.cell(row=ri, column=6, value=command).border = thin_border
        ws.cell(row=ri, column=7, value=sr.get("description", "")).border = thin_border
        status_cell = ws.cell(row=ri, column=8, value=status.upper())
        status_cell.border = thin_border
        status_cell.alignment = center
        if status == "pass":
            status_cell.fill = pass_fill
        elif status == "fail":
            status_cell.fill = fail_fill
        elif status == "warning":
            status_cell.fill = warn_fill
        elif status == "error":
            status_cell.fill = error_fill
        ws.cell(row=ri, column=9, value=delay_str).border = thin_border
        ws.cell(row=ri, column=9).alignment = center
        ws.cell(row=ri, column=10, value=dur_str).border = thin_border
        ws.cell(row=ri, column=10).alignment = center

        exp_path = _resolve_image_path(sr.get("expected_image"))
        ws.cell(row=ri, column=11).border = thin_border
        if exp_path:
            try:
                img = XlImage(str(exp_path))
                img.width = 180
                img.height = 140
                ws.add_image(img, f"K{ri}")
                ws.row_dimensions[ri].height = img_row_height
            except Exception:
                ws.cell(row=ri, column=11, value=str(sr.get("expected_image", "")))

        act_img_path = sr.get("actual_annotated_image") or sr.get("actual_image")
        act_path = _resolve_image_path(act_img_path)
        ws.cell(row=ri, column=12).border = thin_border
        if act_path:
            try:
                img = XlImage(str(act_path))
                img.width = 180
                img.height = 140
                ws.add_image(img, f"L{ri}")
                if ws.row_dimensions[ri].height is None or ws.row_dimensions[ri].height < img_row_height:
                    ws.row_dimensions[ri].height = img_row_height
            except Exception:
                ws.cell(row=ri, column=12, value=str(act_img_path or ""))

    return wb


@router.get("/export/{filename}")
async def export_result_excel(filename: str):
    """Export a test result as Excel (.xlsx) — download to browser."""
    filepath = RESULTS_DIR / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Result not found")

    data = json.loads(filepath.read_text(encoding="utf-8"))

    try:
        wb = _build_excel_workbook(data, filepath)
    except ImportError:
        raise HTTPException(status_code=500, detail="openpyxl not installed")

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    export_name = filename.replace(".json", ".xlsx")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{export_name}"'},
    )


@router.delete("/{filename}")
async def delete_result(filename: str):
    """Delete a test result."""
    filepath = RESULTS_DIR / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Result not found")
    filepath.unlink()
    return {"status": "deleted"}


# --- Webcam recording endpoints ---

@router.post("/webcam-upload")
async def upload_webcam_recording(
    file: UploadFile = File(...),
    result_filename: str = Form(...),
    repeat_index: int = Form(1),
):
    """Upload a webcam recording linked to a test result."""
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    base = result_filename.replace(".json", "")
    filename = f"{base}_webcam_r{repeat_index}.webm"
    filepath = RECORDINGS_DIR / filename
    content = await file.read()
    filepath.write_bytes(content)
    return {"filename": filename, "url": f"/recordings/{filename}"}


@router.get("/recordings-for/{result_filename}")
async def list_recordings_for_result(result_filename: str):
    """List webcam recordings linked to a test result."""
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    base = result_filename.replace(".json", "")
    recordings = []
    for f in sorted(RECORDINGS_DIR.glob(f"{base}_webcam_*.webm")):
        recordings.append({
            "filename": f.name,
            "size": f.stat().st_size,
            "url": f"/recordings/{f.name}",
        })
    return {"recordings": recordings}


@router.delete("/recordings/{filename}")
async def delete_recording(filename: str):
    """Delete a webcam recording."""
    filepath = RECORDINGS_DIR / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Recording not found")
    filepath.unlink()
    return {"deleted": filename}


@router.post("/recordings/{filename}/trim")
async def trim_recording(
    filename: str,
    start: float = Form(...),
    end: float = Form(...),
):
    """Trim a webcam recording (requires ffmpeg)."""
    filepath = RECORDINGS_DIR / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Recording not found")
    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=500, detail="ffmpeg not installed")
    output_name = f"trim_{start:.1f}_{end:.1f}_{filename}"
    output_path = RECORDINGS_DIR / output_name
    try:
        subprocess.run(
            ["ffmpeg", "-i", str(filepath), "-ss", str(start), "-to", str(end),
             "-c", "copy", str(output_path), "-y"],
            check=True, capture_output=True,
        )
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"ffmpeg error: {e.stderr.decode()[:200]}")
    return {"filename": output_name, "url": f"/recordings/{output_name}"}


@router.get("/{filename}")
async def get_result(filename: str):
    """Get a specific test result."""
    filepath = RESULTS_DIR / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Result not found")
    data = json.loads(filepath.read_text(encoding="utf-8"))
    return data


@router.get("/image/{scenario_name}/{image_path:path}")
async def get_image(scenario_name: str, image_path: str):
    """Serve a screenshot image."""
    filepath = SCREENSHOTS_DIR / scenario_name / image_path
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(str(filepath), media_type="image/png")
