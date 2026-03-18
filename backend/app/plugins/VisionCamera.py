# -*- coding: utf-8 -*-
"""VisionCamera 플러그인 — 비전 카메라를 주 디바이스(스크린 소스)로 사용.

MATVisionLib.dll을 통해 하드웨어 비전 카메라에서 화면을 캡처하여
ADB/HKMC와 동일한 방식으로 스크린미러링 및 재생 검증에 활용.

connect_type: "vision_camera" (MAC 주소 + IP 기반 연결)
"""

import io
import os
import logging
import tempfile
import threading
from datetime import datetime
from pathlib import Path

from PIL import Image

logger = logging.getLogger(__name__)


class VisionCamera:
    """비전 카메라 플러그인 (주 디바이스로 등록 가능)."""

    def __init__(self, mac: str = "", model: str = "", serial: str = "",
                 ip: str = "", subnetmask: str = "255.255.0.0"):
        self._mac = mac
        self._model = model
        self._serial = serial
        self._ip = ip
        self._subnetmask = subnetmask
        self._client = None
        self._is_connected = False
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def Connect(self) -> str:
        """비전 카메라 연결."""
        if self._is_connected and self._client:
            return "Already connected"
        if not self._mac:
            raise RuntimeError("MAC address not set")

        from .VisionCameraClient import VisionCameraClient

        port = {
            "Port": self._serial,
            "MACAddress": self._mac,
            "IP": self._ip,
            "Subnetmask": self._subnetmask,
        }
        self._client = VisionCameraClient(self._model, port, None)
        ok, msg = self._client.md_VisionConnect()
        if ok:
            self._is_connected = True
            logger.info("VisionCamera connected: mac=%s ip=%s", self._mac, self._ip)
            return f"Connected: {msg}"
        else:
            self._client = None
            raise RuntimeError(f"VisionCamera connect failed: {msg}")

    def Disconnect(self) -> str:
        """비전 카메라 연결 해제."""
        if self._client:
            ok, msg = self._client.md_VisionDisconnect()
            self._is_connected = False
            self._client = None
            return f"Disconnected: {msg}"
        self._is_connected = False
        return "Already disconnected"

    def IsConnected(self) -> bool:
        """연결 상태 확인."""
        if not self._client or not self._is_connected:
            return False
        ok, _ = self._client.md_IsConnect()
        if not ok:
            self._is_connected = False
        return self._is_connected

    # ------------------------------------------------------------------
    # Capture
    # ------------------------------------------------------------------

    def Capture(self, save_path: str = "") -> str:
        """이미지 캡처. save_path가 비어있으면 임시 파일에 저장.

        Returns:
            저장된 이미지 파일 경로
        """
        if not self._client or not self._is_connected:
            raise RuntimeError("VisionCamera not connected")

        if not save_path:
            # 임시 디렉토리에 저장
            tmp_dir = Path(tempfile.gettempdir()) / "vision_camera"
            tmp_dir.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.now().strftime("%y%m%d_%H%M%S_%f")
            save_path = str(tmp_dir / f"{timestamp}.png")

        # 디렉토리 생성
        Path(save_path).parent.mkdir(parents=True, exist_ok=True)

        with self._lock:
            ok, msg = self._client.md_VisionCapture(save_path)
        if ok:
            return save_path
        else:
            raise RuntimeError(f"Capture failed: {msg}")

    def CaptureBytes(self, fmt: str = "png") -> bytes:
        """이미지 캡처 후 바이트로 반환 (WebSocket 스트리밍용).

        Args:
            fmt: 출력 포맷 ("png" | "jpeg")

        Returns:
            이미지 바이트 데이터
        """
        # 임시 파일에 캡처 후 읽기
        tmp_path = self.Capture()
        try:
            img = Image.open(tmp_path)
            buf = io.BytesIO()
            if fmt.lower() in ("jpg", "jpeg"):
                img = img.convert("RGB")  # RGBA → RGB (JPEG는 알파 불가)
                img.save(buf, format="JPEG", quality=85)
            else:
                img.save(buf, format="PNG")
            return buf.getvalue()
        finally:
            # 임시 파일 정리
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    def CaptureToFile(self, save_path: str) -> str:
        """지정된 경로에 PNG 이미지 캡처.

        Returns:
            저장된 파일 경로
        """
        return self.Capture(save_path)

    def CropCapture(self, save_path: str, left: int, top: int, right: int, bottom: int) -> str:
        """크롭된 이미지 캡처.

        Returns:
            저장된 파일 경로
        """
        if not self._client or not self._is_connected:
            raise RuntimeError("VisionCamera not connected")

        Path(save_path).parent.mkdir(parents=True, exist_ok=True)

        with self._lock:
            ok, msg = self._client.md_VisionCapture(save_path, left, top, right, bottom)
        if ok:
            return save_path
        else:
            raise RuntimeError(f"CropCapture failed: {msg}")

    # ------------------------------------------------------------------
    # Info
    # ------------------------------------------------------------------

    def GetInfo(self) -> dict:
        """카메라 정보 반환."""
        return {
            "mac": self._mac,
            "model": self._model,
            "serial": self._serial,
            "ip": self._ip,
            "subnetmask": self._subnetmask,
            "connected": self._is_connected,
        }
