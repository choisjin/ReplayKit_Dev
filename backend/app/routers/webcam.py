"""Webcam API — backend OpenCV 기반 캡처/녹화 제어.

Frontend MediaRecorder를 대체하여 WS 연결 상태와 무관하게 녹화가 유지된다.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from ..services.webcam_service import get_webcam_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/webcam", tags=["webcam"])


@router.get("/devices")
async def list_devices():
    """Enumerate detected webcam devices."""
    svc = get_webcam_service()
    return {"devices": svc.list_devices()}


@router.get("/resolutions/{device_index}")
async def probe_resolutions(device_index: int):
    """지원 해상도 목록."""
    svc = get_webcam_service()
    if svc.is_open() and svc._device_index == device_index:
        # 현재 열려 있는 장치는 재오픈 피함 — status에서 현재 해상도만 반환
        return {"resolutions": [f"{svc._width}x{svc._height}"]}
    return {"resolutions": svc.probe_resolutions(device_index)}


class OpenRequest(BaseModel):
    device_index: int = 0
    width: int = 640
    height: int = 480


@router.post("/open")
async def open_webcam(req: OpenRequest):
    """카메라 오픈 + 캡처 스레드 시작."""
    svc = get_webcam_service()
    ok = svc.open(req.device_index, req.width, req.height)
    if not ok:
        raise HTTPException(status_code=400, detail=f"Failed to open webcam device {req.device_index}")
    return svc.status()


@router.post("/close")
async def close_webcam():
    svc = get_webcam_service()
    svc.close()
    return {"ok": True}


@router.get("/status")
async def get_status():
    svc = get_webcam_service()
    return svc.status()


@router.get("/preview.jpg")
async def preview_jpeg():
    """최신 프레임을 JPEG로 반환 (프런트 PiP 폴링용)."""
    svc = get_webcam_service()
    data = svc.get_latest_jpeg()
    if data is None:
        # 카메라 닫힌 상태 → 404 (프런트가 폴링 중단)
        raise HTTPException(status_code=404, detail="No frame available")
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"},
    )


class RecordStartRequest(BaseModel):
    output_path: str  # absolute or relative to project


@router.post("/record/start")
async def start_record(req: RecordStartRequest):
    """녹화 시작."""
    svc = get_webcam_service()
    ok = svc.start_recording(req.output_path)
    if not ok:
        raise HTTPException(status_code=400, detail="Failed to start recording (webcam not open or already recording)")
    return svc.status()


@router.post("/record/stop")
async def stop_record():
    """녹화 정지 + 파일 경로 반환."""
    svc = get_webcam_service()
    path = svc.stop_recording()
    if path is None:
        raise HTTPException(status_code=400, detail="Not recording")
    return {"path": path}


@router.post("/record/pause")
async def pause_record():
    svc = get_webcam_service()
    svc.pause_recording()
    return {"ok": True}


@router.post("/record/resume")
async def resume_record():
    svc = get_webcam_service()
    svc.resume_recording()
    return {"ok": True}


class OverlayRequest(BaseModel):
    position: Optional[str] = None  # top-left | top-right | bottom-left | bottom-right | off
    color_hex: Optional[str] = None  # "#ffffff"
    font_scale: Optional[float] = None  # 0 = auto


@router.post("/overlay")
async def set_overlay(req: OverlayRequest):
    svc = get_webcam_service()
    svc.set_overlay(position=req.position, color_hex=req.color_hex, font_scale=req.font_scale)
    return svc.status()
