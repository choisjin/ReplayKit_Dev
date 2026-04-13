"""Backend webcam service — OpenCV 기반 캡처/녹화.

Frontend MediaRecorder를 대체하여 WebSocket 연결 상태와 무관하게
녹화가 계속 유지되도록 한다.

- 캡처 스레드 1개가 백그라운드에서 프레임을 계속 읽음
- 최신 프레임은 _latest_frame에 저장 (미리보기 JPEG 생성용)
- 녹화 중에는 각 프레임에 타임스탬프 오버레이 후 VideoWriter에 기록
- 녹화 파일 포맷: mp4 (mp4v 코덱) — 브라우저 재생 호환
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)


class WebcamService:
    """OpenCV 기반 webcam 캡처/녹화 싱글톤."""

    def __init__(self) -> None:
        self._device_index: int = 0
        self._width: int = 640
        self._height: int = 480
        self._requested_fps: float = 30.0
        self._actual_fps: float = 30.0
        self._cap: Optional[cv2.VideoCapture] = None
        self._capture_thread: Optional[threading.Thread] = None
        self._stop_flag = threading.Event()
        self._latest_frame: Optional[np.ndarray] = None
        self._latest_frame_lock = threading.Lock()

        # Recording state
        self._writer: Optional[cv2.VideoWriter] = None
        self._recording_path: Optional[Path] = None
        self._recording_paused = False
        self._recording_lock = threading.Lock()
        self._record_start_ts: float = 0.0
        self._frames_written: int = 0

        # Overlay config (matches frontend preferences)
        self._overlay_position: str = "bottom-right"  # top-left|top-right|bottom-left|bottom-right|off
        self._overlay_color: tuple[int, int, int] = (255, 255, 255)  # BGR for cv2
        self._overlay_font_scale: float = 0.0  # 0 = auto

    # ------------------------------------------------------------
    # Device enumeration / probe
    # ------------------------------------------------------------
    def list_devices(self, max_index: int = 5) -> list[dict]:
        """장착된 카메라 index 탐지 (간이 — DSHOW로 0..N을 순회)."""
        found = []
        for idx in range(max_index):
            cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW)
            if cap.isOpened():
                w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 640
                h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 480
                found.append({"index": idx, "label": f"Camera {idx} ({w}x{h})"})
                cap.release()
            else:
                cap.release()
        return found

    def probe_resolutions(self, device_index: int) -> list[str]:
        """카메라가 지원하는 대표 해상도 후보를 set/get으로 검증."""
        candidates = [
            (3840, 2160), (2560, 1440), (1920, 1080),
            (1280, 720), (960, 540), (640, 480), (320, 240),
        ]
        supported: list[str] = []
        cap = cv2.VideoCapture(device_index, cv2.CAP_DSHOW)
        if not cap.isOpened():
            return []
        try:
            for w, h in candidates:
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, w)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
                aw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                ah = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                if aw == w and ah == h:
                    supported.append(f"{w}x{h}")
        finally:
            cap.release()
        return supported

    # ------------------------------------------------------------
    # Capture lifecycle
    # ------------------------------------------------------------
    def is_open(self) -> bool:
        return self._cap is not None and self._cap.isOpened()

    def open(self, device_index: int = 0, width: int = 640, height: int = 480) -> bool:
        """카메라 오픈 + 캡처 스레드 시작. 이미 열려 있으면 close 후 재오픈."""
        self.close()
        cap = cv2.VideoCapture(device_index, cv2.CAP_DSHOW)
        if not cap.isOpened():
            logger.warning("Webcam open failed: device %d", device_index)
            return False
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or width
        actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or height
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        self._cap = cap
        self._device_index = device_index
        self._width = actual_w
        self._height = actual_h
        self._actual_fps = float(fps) if fps > 0 else 30.0
        self._requested_fps = self._actual_fps
        self._stop_flag.clear()
        self._capture_thread = threading.Thread(target=self._capture_loop, daemon=True, name="webcam-capture")
        self._capture_thread.start()
        logger.info("Webcam opened: device=%d %dx%d @%.1ffps", device_index, actual_w, actual_h, self._actual_fps)
        return True

    def close(self) -> None:
        """캡처 스레드 종료 + 카메라 해제 (녹화 중이면 먼저 정지)."""
        self.stop_recording()
        self._stop_flag.set()
        if self._capture_thread and self._capture_thread.is_alive():
            self._capture_thread.join(timeout=2.0)
        self._capture_thread = None
        if self._cap is not None:
            try:
                self._cap.release()
            except Exception:
                pass
            self._cap = None
        with self._latest_frame_lock:
            self._latest_frame = None
        logger.info("Webcam closed")

    def _capture_loop(self) -> None:
        """백그라운드 스레드: 프레임을 계속 읽어 최신본 유지 + 녹화 중이면 writer에 기록."""
        frame_interval = 1.0 / max(1.0, self._actual_fps)
        next_deadline = time.monotonic()
        while not self._stop_flag.is_set():
            cap = self._cap
            if cap is None or not cap.isOpened():
                time.sleep(0.05)
                continue
            ret, frame = cap.read()
            if not ret or frame is None:
                time.sleep(0.03)
                continue
            # 최신 프레임 저장
            with self._latest_frame_lock:
                self._latest_frame = frame
            # 녹화 중이면 오버레이 후 writer 기록
            with self._recording_lock:
                if self._writer is not None and not self._recording_paused:
                    self._write_frame_unlocked(frame)
            # 간이 frame pacing (과도한 CPU 방지)
            now = time.monotonic()
            next_deadline += frame_interval
            sleep_s = next_deadline - now
            if sleep_s > 0:
                time.sleep(sleep_s)
            else:
                next_deadline = now  # 드리프트 리셋

    # ------------------------------------------------------------
    # Preview
    # ------------------------------------------------------------
    def get_latest_jpeg(self, quality: int = 80) -> Optional[bytes]:
        """최신 프레임을 JPEG bytes로 인코딩. 카메라 미오픈 or 프레임 없음 시 None."""
        with self._latest_frame_lock:
            frame = self._latest_frame
            if frame is None:
                return None
            frame_copy = frame.copy()
        # 프리뷰에도 오버레이 적용 (사용자가 최종 출력과 동일한 모습 확인)
        self._apply_overlay(frame_copy)
        ok, buf = cv2.imencode(".jpg", frame_copy, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        if not ok:
            return None
        return buf.tobytes()

    # ------------------------------------------------------------
    # Recording
    # ------------------------------------------------------------
    def start_recording(self, output_path: str | Path) -> bool:
        """녹화 시작. output_path의 상위 폴더는 미리 존재해야 함."""
        with self._recording_lock:
            if self._writer is not None:
                logger.warning("Webcam recording already in progress")
                return False
            if not self.is_open():
                logger.warning("Webcam not open — cannot start recording")
                return False
            path = Path(output_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            writer = cv2.VideoWriter(str(path), fourcc, self._actual_fps, (self._width, self._height))
            if not writer.isOpened():
                logger.error("Failed to open VideoWriter: %s", path)
                return False
            self._writer = writer
            self._recording_path = path
            self._recording_paused = False
            self._record_start_ts = time.monotonic()
            self._frames_written = 0
            logger.info("Webcam recording started: %s (%dx%d @%.1ffps)", path, self._width, self._height, self._actual_fps)
            return True

    def stop_recording(self) -> Optional[str]:
        """녹화 정지 + 파일 경로 반환. 녹화 중이 아니면 None."""
        with self._recording_lock:
            if self._writer is None:
                return None
            try:
                self._writer.release()
            except Exception as e:
                logger.warning("VideoWriter release error: %s", e)
            path = self._recording_path
            duration = time.monotonic() - self._record_start_ts
            logger.info("Webcam recording stopped: %s frames=%d duration=%.1fs",
                        path, self._frames_written, duration)
            self._writer = None
            self._recording_path = None
            self._recording_paused = False
            return str(path) if path else None

    def pause_recording(self) -> None:
        with self._recording_lock:
            if self._writer is not None:
                self._recording_paused = True

    def resume_recording(self) -> None:
        with self._recording_lock:
            if self._writer is not None:
                self._recording_paused = False

    def is_recording(self) -> bool:
        with self._recording_lock:
            return self._writer is not None

    def _write_frame_unlocked(self, frame: np.ndarray) -> None:
        """녹화 writer에 프레임 기록 (lock 내에서 호출). 오버레이 포함."""
        if self._writer is None:
            return
        display = frame.copy()
        self._apply_overlay(display)
        try:
            self._writer.write(display)
            self._frames_written += 1
        except Exception as e:
            logger.warning("VideoWriter write error: %s", e)

    # ------------------------------------------------------------
    # Overlay
    # ------------------------------------------------------------
    def set_overlay(self, position: Optional[str] = None,
                    color_hex: Optional[str] = None,
                    font_scale: Optional[float] = None) -> None:
        if position is not None:
            self._overlay_position = position
        if color_hex is not None:
            self._overlay_color = self._hex_to_bgr(color_hex)
        if font_scale is not None:
            self._overlay_font_scale = float(font_scale)

    @staticmethod
    def _hex_to_bgr(color_hex: str) -> tuple[int, int, int]:
        s = color_hex.lstrip("#")
        if len(s) == 3:
            s = "".join(c * 2 for c in s)
        try:
            r = int(s[0:2], 16)
            g = int(s[2:4], 16)
            b = int(s[4:6], 16)
            return (b, g, r)  # cv2 uses BGR
        except Exception:
            return (255, 255, 255)

    def _apply_overlay(self, frame: np.ndarray) -> None:
        """frame에 타임스탬프 오버레이 in-place."""
        pos = self._overlay_position
        if pos == "off":
            return
        h, w = frame.shape[:2]
        now = datetime.now()
        ts = now.strftime("%Y-%m-%d %H:%M:%S")
        font = cv2.FONT_HERSHEY_SIMPLEX
        # 폰트 스케일 auto: 높이의 ~3%를 목표
        auto_scale = max(0.4, h * 0.0014)
        scale = self._overlay_font_scale if self._overlay_font_scale > 0 else auto_scale
        thickness = max(1, int(scale * 2))
        (text_w, text_h), baseline = cv2.getTextSize(ts, font, scale, thickness)
        pad = 4
        margin = 6
        box_w = text_w + pad * 2
        box_h = text_h + pad * 2

        if pos == "top-left":
            bx, by = margin, margin
            tx, ty = bx + pad, by + pad + text_h
        elif pos == "top-right":
            bx, by = w - box_w - margin, margin
            tx, ty = bx + pad, by + pad + text_h
        elif pos == "bottom-left":
            bx, by = margin, h - box_h - margin
            tx, ty = bx + pad, by + pad + text_h
        else:  # bottom-right (default)
            bx, by = w - box_w - margin, h - box_h - margin
            tx, ty = bx + pad, by + pad + text_h

        # 반투명 박스
        overlay = frame.copy()
        cv2.rectangle(overlay, (bx, by), (bx + box_w, by + box_h), (0, 0, 0), thickness=-1)
        cv2.addWeighted(overlay, 0.5, frame, 0.5, 0, frame)
        cv2.putText(frame, ts, (tx, ty), font, scale, self._overlay_color, thickness, cv2.LINE_AA)

    # ------------------------------------------------------------
    # Exposure (Level 2 — 노출만 노출)
    # ------------------------------------------------------------
    def get_exposure(self) -> dict:
        """현재 노출값/모드 + 카메라 지원 범위 반환.

        OpenCV의 CAP_PROP_EXPOSURE 의미:
        - DSHOW 백엔드 기준: 음수 값 (예: -13 ~ -1, log2 1/sec)
        - CAP_PROP_AUTO_EXPOSURE: 0.25 = manual, 0.75 = auto (DSHOW)
        - 카메라마다 다르므로 min/max는 set/get 시 cap.get으로 추정
        """
        if not self.is_open() or self._cap is None:
            return {"supported": False}
        try:
            value = self._cap.get(cv2.CAP_PROP_EXPOSURE)
            auto = self._cap.get(cv2.CAP_PROP_AUTO_EXPOSURE)
            return {
                "supported": True,
                "value": float(value),
                "auto": auto >= 0.5,  # 0.75 = auto, 0.25 = manual
                "min": -13.0,  # DSHOW 일반 범위
                "max": 0.0,
                "step": 1.0,
            }
        except Exception as e:
            logger.warning("get_exposure failed: %s", e)
            return {"supported": False}

    def set_exposure(self, value: Optional[float] = None, auto: Optional[bool] = None) -> bool:
        """노출값 설정. value를 주면 manual 모드로 전환 후 적용. auto=True면 자동 모드."""
        if not self.is_open() or self._cap is None:
            return False
        try:
            if auto is True:
                # 자동 노출 모드 (DSHOW: 0.75)
                self._cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.75)
                logger.info("Webcam exposure: AUTO")
                return True
            if value is not None:
                # 수동 모드 + 값 설정
                self._cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
                self._cap.set(cv2.CAP_PROP_EXPOSURE, float(value))
                actual = self._cap.get(cv2.CAP_PROP_EXPOSURE)
                logger.info("Webcam exposure: MANUAL value=%.2f (actual=%.2f)", value, actual)
                return True
        except Exception as e:
            logger.warning("set_exposure failed: %s", e)
        return False

    # ------------------------------------------------------------
    # Status
    # ------------------------------------------------------------
    def status(self) -> dict:
        with self._recording_lock:
            recording = self._writer is not None
            rec_path = str(self._recording_path) if self._recording_path else ""
            duration = time.monotonic() - self._record_start_ts if recording else 0.0
            frames = self._frames_written
        return {
            "open": self.is_open(),
            "device_index": self._device_index,
            "width": self._width,
            "height": self._height,
            "fps": self._actual_fps,
            "recording": recording,
            "recording_path": rec_path,
            "recording_duration_s": duration,
            "frames_written": frames,
            "overlay_position": self._overlay_position,
        }


# Singleton
_webcam_service: Optional[WebcamService] = None


def get_webcam_service() -> WebcamService:
    global _webcam_service
    if _webcam_service is None:
        _webcam_service = WebcamService()
    return _webcam_service
