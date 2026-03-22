# -*- coding: utf-8 -*-
"""VisionCamera 클라이언트 — MATVisionLib.dll 기반.

DLL을 통해 카메라 연결/캡처를 수행하고,
백그라운드 스레드에서 주기적으로 캡처하여 최신 프레임을 유지.
"""

import io
import os
import logging
import tempfile
import threading
import time
from ctypes import cdll, c_wchar_p
from pathlib import Path
from PIL import Image

logger = logging.getLogger(__name__)


def _find_dll() -> str:
    """MATVisionLib.dll 경로 탐색."""
    search_dirs = [
        Path(__file__).parent,                          # plugins/
        Path(__file__).parent.parent / "modules",       # app/modules/
        Path(__file__).parent.parent.parent / "modules", # backend/modules/
    ]
    for d in search_dirs:
        dll = d / "MATVisionLib.dll"
        if dll.exists():
            return str(dll)
    raise FileNotFoundError(
        "MATVisionLib.dll을 찾을 수 없습니다. "
        "backend/app/plugins/ 또는 backend/app/modules/에 배치하세요."
    )


class VisionCameraClient:
    """MATVisionLib.dll 기반 비전 카메라 제어.

    백그라운드 스레드에서 주기적 캡처 → 최신 프레임 즉시 반환.
    """

    def __init__(self, model: str, port: dict, context=None):
        self._device = model
        self._isConnected = False
        self._macaddress = port.get("MACAddress", "")

        # DLL 로드 (원본 디렉토리에서 직접 로드 — 의존 DLL 경로 유지)
        dll_path = _find_dll()
        dll_dir = os.path.dirname(dll_path)
        # 의존 DLL 검색 경로 추가 (Python 3.8+)
        if hasattr(os, 'add_dll_directory'):
            os.add_dll_directory(dll_dir)
        self._dll = cdll.LoadLibrary(dll_path)

        # 백그라운드 프레임 캡처
        self._frame_thread = None
        self._frame_stop = threading.Event()
        self._frame_lock = threading.Lock()
        self._latest_frame: Image.Image | None = None
        self._tmp_dir = Path(tempfile.gettempdir()) / "vision_camera" / self._macaddress
        self._tmp_dir.mkdir(parents=True, exist_ok=True)

        logger.info("VisionCameraClient: mac=%s, DLL=%s", self._macaddress, dll_path)

    # ------------------------------------------------------------------
    # 백그라운드 프레임 캡처 스레드
    # ------------------------------------------------------------------

    def _frame_loop(self):
        """백그라운드에서 주기적으로 DLL 캡처 → _latest_frame 갱신."""
        logger.info("VisionCamera frame loop started")
        tmp_path = str(self._tmp_dir / "latest.bmp")
        error_count = 0
        frame_count = 0

        while not self._frame_stop.is_set():
            try:
                result = self._dll.Vision_Capture(c_wchar_p(tmp_path))
                if result == 0 and os.path.exists(tmp_path):
                    img = Image.open(tmp_path).convert("RGB")
                    with self._frame_lock:
                        self._latest_frame = img
                    frame_count += 1
                    if frame_count == 1:
                        logger.info("VisionCamera first frame received")
                    error_count = 0
                else:
                    error_count += 1
                    if error_count <= 3 or error_count % 30 == 0:
                        logger.warning("VisionCamera capture failed (count=%d, code=%d)",
                                       error_count, result)
                    time.sleep(0.1)
                    continue
            except Exception as e:
                error_count += 1
                if error_count <= 3 or error_count % 30 == 0:
                    logger.warning("VisionCamera frame error (%d): %s", error_count, e)
                time.sleep(0.1)

            # 캡처 간격 (~30fps 상한)
            time.sleep(0.033)

        logger.info("VisionCamera frame loop stopped (total frames: %d)", frame_count)

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def md_VisionConnect(self) -> tuple[bool, str]:
        """카메라 연결 + 백그라운드 캡처 시작."""
        if self._isConnected:
            return True, "[VisionCamera] Already connected"

        try:
            result = self._dll.Vision_Connect(c_wchar_p(self._macaddress))
            if result != 0:
                return False, f"[VisionCamera] Connect fail (code={result})"

            self._isConnected = True

            # 백그라운드 프레임 캡처 스레드 시작
            self._frame_stop.clear()
            self._frame_thread = threading.Thread(
                target=self._frame_loop, name="visioncam_frame", daemon=True
            )
            self._frame_thread.start()

            logger.info("VisionCamera connected: %s", self._macaddress)
            return True, f"[VisionCamera] Connect OK ({self._macaddress})"

        except Exception as e:
            self._isConnected = False
            return False, f"[VisionCamera] Connect fail: {e}"

    def md_VisionDisconnect(self) -> tuple[bool, str]:
        if not self._isConnected:
            return True, "[VisionCamera] Already disconnected"
        try:
            self._cleanup()
            return True, "[VisionCamera] Disconnect OK"
        except Exception as e:
            return False, f"[VisionCamera] Disconnect fail: {e}"

    def md_IsConnect(self) -> tuple[bool, str]:
        if not self._isConnected:
            return False, "[VisionCamera] Not connected"
        try:
            result = self._dll.isConnect()
            if result == 0:
                return True, "[VisionCamera] Connected"
            self._isConnected = False
            return False, f"[VisionCamera] Connection lost (code={result})"
        except Exception:
            return False, "[VisionCamera] Not connected"

    # ------------------------------------------------------------------
    # Capture — 최신 프레임 즉시 반환 (블로킹 없음)
    # ------------------------------------------------------------------

    def md_VisionCapture(self, szPath: str, left=-1, top=-1, right=-1, bottom=-1) -> tuple[bool, str]:
        """최신 프레임을 파일로 저장."""
        if not self._isConnected:
            return False, "[VisionCamera] Not connected"

        with self._frame_lock:
            img = self._latest_frame

        if img is None:
            return False, "[VisionCamera] No frame available yet"

        try:
            if left >= 0 and top >= 0 and right >= 0 and bottom >= 0:
                img = img.crop((left, top, right, bottom))
            Path(szPath).parent.mkdir(parents=True, exist_ok=True)
            img.save(szPath)
            return True, "[VisionCamera] Capture OK"
        except Exception as e:
            return False, f"[VisionCamera] Capture fail: {e}"

    def md_CaptureBytes(self, fmt: str = "jpeg") -> bytes:
        """최신 프레임을 바이트로 즉시 반환."""
        if not self._isConnected:
            raise RuntimeError("[VisionCamera] Not connected")

        with self._frame_lock:
            img = self._latest_frame

        if img is None:
            raise RuntimeError("[VisionCamera] No frame available yet")

        buf = io.BytesIO()
        if fmt.lower() in ("jpg", "jpeg"):
            img.save(buf, format="JPEG", quality=85)
        else:
            img.save(buf, format="PNG")
        return buf.getvalue()

    # ------------------------------------------------------------------

    @property
    def is_connected(self) -> bool:
        return self._isConnected

    def _cleanup(self):
        """리소스 정리."""
        # 프레임 스레드 중지
        self._frame_stop.set()
        if self._frame_thread and self._frame_thread.is_alive():
            self._frame_thread.join(timeout=5)
        self._frame_thread = None
        self._latest_frame = None
        # DLL disconnect
        if self._isConnected:
            try:
                self._dll.Vision_Disconnect()
            except Exception:
                pass
        self._isConnected = False

    def dispose(self):
        self._cleanup()
