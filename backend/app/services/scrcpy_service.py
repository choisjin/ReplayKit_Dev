"""scrcpy 기반 H.264 실시간 스크린 스트리밍 서비스.

scrcpy-server를 디바이스에 push → H.264 스트리밍 수신 → PyAV 디코딩 → JPEG 인코딩.
scrcpy 불가 시 기존 screencap 폴백.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import random
import socket
import struct
import threading
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# PyAV (H.264 디코딩) — 없으면 scrcpy 비활성
try:
    import av
    HAS_AV = True
except ImportError:
    HAS_AV = False
    logger.info("PyAV not installed — scrcpy streaming disabled (pip install av)")

# Pillow — JPEG 인코딩용
try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

# ADB 경로 (adb_service와 동일)
ADB_PATH = os.environ.get("ADB_PATH", "adb")

# scrcpy-server 탐색 순서
_SERVER_FILENAME = "scrcpy-server"
_SERVER_FILENAME_JAR = "scrcpy-server.jar"


def _find_scrcpy_server() -> Optional[str]:
    """scrcpy-server 파일 경로 탐색."""
    # 1. 환경변수
    env_path = os.environ.get("SCRCPY_SERVER_PATH")
    if env_path and os.path.isfile(env_path):
        return env_path

    project_root = Path(__file__).resolve().parent.parent.parent.parent

    # 2. 프로젝트 루트
    for name in [_SERVER_FILENAME, _SERVER_FILENAME_JAR]:
        p = project_root / name
        if p.is_file():
            return str(p)

    # 3. backend/bin/
    bin_dir = project_root / "backend" / "bin"
    for name in [_SERVER_FILENAME, _SERVER_FILENAME_JAR]:
        p = bin_dir / name
        if p.is_file():
            return str(p)

    # 4. ADB_PATH 디렉토리
    adb_dir = Path(ADB_PATH).parent
    if adb_dir != Path("."):
        for name in [_SERVER_FILENAME, _SERVER_FILENAME_JAR]:
            p = adb_dir / name
            if p.is_file():
                return str(p)

    return None


def _find_free_port() -> int:
    """사용 가능한 TCP 포트 찾기."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ScrcpyStream:
    """단일 디바이스+디스플레이에 대한 scrcpy H.264 스트림.

    백그라운드 스레드에서 H.264 패킷 수신 → PyAV 디코딩 → JPEG 인코딩.
    """

    def __init__(self, serial: str, display_id: int = 0,
                 max_fps: int = 30, bit_rate: int = 4_000_000,
                 max_size: int = 1024):
        self.serial = serial
        self.display_id = display_id
        self.max_fps = max_fps
        self.bit_rate = bit_rate
        self.max_size = max_size  # 긴 변이 최대 해상도

        self._lock = threading.Lock()
        self._latest_frame: Optional[bytes] = None  # JPEG bytes
        self._frame_event = asyncio.Event()
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

        self._scid = random.randint(1, 0x7FFFFFFF)
        self._port = 0
        self._server_proc = None

    @property
    def is_running(self) -> bool:
        return self._running

    def get_latest_frame(self) -> Optional[bytes]:
        """최신 JPEG 프레임 반환 (Lock 보호)."""
        with self._lock:
            return self._latest_frame

    async def async_wait_frame(self, timeout: float = 2.0) -> Optional[bytes]:
        """새 프레임이 올 때까지 대기 후 반환."""
        self._frame_event.clear()
        try:
            await asyncio.wait_for(self._frame_event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass
        return self.get_latest_frame()

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        """scrcpy 서버 시작 및 수신 스레드 실행."""
        if self._running:
            return
        self._loop = loop
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """스트림 종료."""
        self._running = False
        if self._server_proc:
            try:
                self._server_proc.kill()
            except Exception:
                pass
            self._server_proc = None
        # forward 제거
        if self._port:
            try:
                import subprocess
                subprocess.run(
                    f"{ADB_PATH} -s {self.serial} forward --remove tcp:{self._port}",
                    shell=True, timeout=5,
                    capture_output=True,
                )
            except Exception:
                pass
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)
        self._thread = None

    def _set_frame(self, jpeg_bytes: bytes) -> None:
        """프레임 업데이트 및 asyncio Event 통지."""
        with self._lock:
            self._latest_frame = jpeg_bytes
        if self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._frame_event.set)

    def _run(self) -> None:
        """백그라운드 스레드: push → start → connect → decode 루프."""
        import subprocess

        server_path = _find_scrcpy_server()
        if not server_path:
            logger.error("scrcpy-server not found for %s", self.serial)
            self._running = False
            return

        try:
            self._setup_and_stream(server_path)
        except Exception as e:
            logger.error("scrcpy stream error for %s: %s", self.serial, e)
        finally:
            self._running = False

    def _setup_and_stream(self, server_path: str) -> None:
        import subprocess

        serial = self.serial

        # 1. Push server to device
        logger.info("Pushing scrcpy-server to %s", serial)
        result = subprocess.run(
            f'{ADB_PATH} -s {serial} push "{server_path}" /data/local/tmp/scrcpy-server',
            shell=True, capture_output=True, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Push failed: {result.stderr.decode(errors='replace')}")

        # 2. Forward port
        self._port = _find_free_port()
        scid_hex = format(self._scid, "08x")
        abstract_name = f"scrcpy_{scid_hex}"

        result = subprocess.run(
            f"{ADB_PATH} -s {serial} forward tcp:{self._port} localabstract:{abstract_name}",
            shell=True, capture_output=True, timeout=10,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Forward failed: {result.stderr.decode(errors='replace')}")

        # 3. Detect server version — try v2 args first
        logger.info("Starting scrcpy-server on %s (port=%d, scid=%s)", serial, self._port, scid_hex)
        v2_cmd = (
            f"{ADB_PATH} -s {serial} shell "
            f"CLASSPATH=/data/local/tmp/scrcpy-server "
            f"app_process / com.genymobile.scrcpy.Server 2.7 "
            f"tunnel_forward=true scid={scid_hex} "
            f"audio=false control=false cleanup=false power_off_on_close=false "
            f"display_id={self.display_id} max_fps={self.max_fps} "
            f"video_bit_rate={self.bit_rate} video_codec=h264 "
            f"max_size={self.max_size} "
            f"send_frame_meta=true"
        )

        self._server_proc = subprocess.Popen(
            v2_cmd, shell=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

        # 4. Connect to video socket
        time.sleep(1.5)  # 서버 준비 대기
        sock = self._connect_video_socket()
        if sock is None:
            # v2 실패 → v1 시도
            logger.info("v2 connection failed, trying v1 protocol for %s", serial)
            if self._server_proc:
                self._server_proc.kill()
            self._start_v1_server(serial)
            time.sleep(1.5)
            sock = self._connect_video_socket()
            if sock is None:
                raise RuntimeError("Cannot connect to scrcpy video socket")
            self._decode_loop(sock, is_v1=True)
        else:
            self._decode_loop(sock, is_v1=False)

    def _start_v1_server(self, serial: str) -> None:
        """v1.x 프로토콜 서버 시작 (positional args)."""
        import subprocess
        scid_hex = format(self._scid, "08x")
        v1_cmd = (
            f"{ADB_PATH} -s {serial} shell "
            f"CLASSPATH=/data/local/tmp/scrcpy-server "
            f"app_process / com.genymobile.scrcpy.Server "
            f"1.25 0 {self.max_size} {self.bit_rate} {self.max_fps} "
            f"-1 true tunnel_forward=true "
            f"control=false"
        )
        self._server_proc = subprocess.Popen(
            v1_cmd, shell=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

    def _connect_video_socket(self, retries: int = 5, delay: float = 0.5) -> Optional[socket.socket]:
        """비디오 소켓 연결 시도."""
        for attempt in range(retries):
            if not self._running:
                return None
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(3)
                sock.connect(("127.0.0.1", self._port))
                sock.settimeout(5)
                return sock
            except (ConnectionRefusedError, OSError):
                time.sleep(delay)
        return None

    def _decode_loop(self, sock: socket.socket, is_v1: bool) -> None:
        """H.264 패킷 수신 → PyAV 디코딩 → JPEG 인코딩 루프."""
        try:
            # 더미 바이트 수신
            dummy = sock.recv(1)
            if not dummy:
                raise RuntimeError("No dummy byte received")

            if is_v1:
                # v1: 디바이스 이름 64바이트 + 해상도 4바이트(width 2 + height 2)
                name_data = self._recv_exact(sock, 64)
                size_data = self._recv_exact(sock, 4)
                if name_data and size_data:
                    w, h = struct.unpack(">HH", size_data)
                    device_name = name_data.rstrip(b'\x00').decode(errors='replace')
                    logger.info("scrcpy v1 connected: %s (%dx%d)", device_name, w, h)

            # PyAV codec context
            codec = av.CodecContext.create("h264", "r")

            while self._running:
                # 프레임 메타: PTS_FLAGS(8) + SIZE(4)
                header = self._recv_exact(sock, 12)
                if not header:
                    break

                pts_flags = struct.unpack(">Q", header[:8])[0]
                pkt_size = struct.unpack(">I", header[8:12])[0]

                if pkt_size == 0 or pkt_size > 10_000_000:  # sanity check
                    continue

                h264_data = self._recv_exact(sock, pkt_size)
                if not h264_data:
                    break

                # 디코딩
                try:
                    packet = av.Packet(h264_data)
                    frames = codec.decode(packet)
                    for frame in frames:
                        # frame → PIL Image → JPEG bytes
                        img = frame.to_image()
                        buf = io.BytesIO()
                        img.save(buf, format="JPEG", quality=80)
                        self._set_frame(buf.getvalue())
                except av.error.InvalidDataError:
                    # 디코더가 아직 키프레임을 받지 못한 경우
                    continue
                except Exception as e:
                    logger.debug("Decode error: %s", e)
                    continue
        except Exception as e:
            if self._running:
                logger.error("scrcpy decode loop error: %s", e)
        finally:
            sock.close()

    @staticmethod
    def _recv_exact(sock: socket.socket, n: int) -> Optional[bytes]:
        """소켓에서 정확히 n바이트 수신."""
        data = bytearray()
        while len(data) < n:
            try:
                chunk = sock.recv(n - len(data))
                if not chunk:
                    return None
                data.extend(chunk)
            except socket.timeout:
                return None
        return bytes(data)


class ScrcpyManager:
    """ScrcpyStream 싱글톤 관리자.

    (serial, display_id) 키로 스트림 관리, ref-count 기반 공유.
    """

    def __init__(self):
        self._streams: dict[tuple[str, int], ScrcpyStream] = {}
        self._refcounts: dict[tuple[str, int], int] = {}
        self._lock = threading.Lock()

    def is_available(self) -> bool:
        """scrcpy 사용 가능 여부 (PyAV + scrcpy-server 존재)."""
        if not HAS_AV:
            return False
        return _find_scrcpy_server() is not None

    async def acquire_stream(self, serial: str, display_id: int = 0,
                             max_fps: int = 30, max_size: int = 1024) -> Optional[ScrcpyStream]:
        """스트림 획득 (ref-count 증가). 없으면 생성."""
        if not self.is_available():
            return None

        key = (serial, display_id)
        loop = asyncio.get_event_loop()

        with self._lock:
            if key in self._streams and self._streams[key].is_running:
                self._refcounts[key] = self._refcounts.get(key, 0) + 1
                return self._streams[key]

            # 새 스트림 생성
            stream = ScrcpyStream(
                serial=serial,
                display_id=display_id,
                max_fps=max_fps,
                max_size=max_size,
            )
            self._streams[key] = stream
            self._refcounts[key] = 1

        # Lock 밖에서 시작 (블로킹 방지)
        stream.start(loop)

        # 첫 프레임 대기 (최대 5초)
        for _ in range(50):
            if stream.get_latest_frame() is not None:
                return stream
            if not stream.is_running:
                # 시작 실패
                with self._lock:
                    self._streams.pop(key, None)
                    self._refcounts.pop(key, None)
                return None
            await asyncio.sleep(0.1)

        # 5초 내 프레임 미수신 — 실패 처리
        logger.warning("scrcpy stream for %s:%d timed out waiting for first frame", serial, display_id)
        stream.stop()
        with self._lock:
            self._streams.pop(key, None)
            self._refcounts.pop(key, None)
        return None

    def release_stream(self, serial: str, display_id: int = 0) -> None:
        """스트림 해제 (ref-count 감소, 0이면 종료)."""
        key = (serial, display_id)
        with self._lock:
            count = self._refcounts.get(key, 0) - 1
            if count <= 0:
                stream = self._streams.pop(key, None)
                self._refcounts.pop(key, None)
                if stream:
                    stream.stop()
            else:
                self._refcounts[key] = count

    def stop_all(self) -> None:
        """모든 스트림 종료 (앱 종료 시)."""
        with self._lock:
            for stream in self._streams.values():
                stream.stop()
            self._streams.clear()
            self._refcounts.clear()
        logger.info("All scrcpy streams stopped")
