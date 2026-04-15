"""HKMC 6th protocol service — TCP 소켓 기반 IVI 디바이스 통신.

IVIHKMC6thClient.py에서 프로토콜 로직을 추출, ATS 프레임워크 의존성 제거.
ADBService와 병렬 구조로 스크린샷 캡처, 터치, 키 입력 등을 지원.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import socket
import struct
import tempfile
import threading
import time
import queue
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Protocol constants (from IVIHKMC6thProtocol.py)
# ---------------------------------------------------------------------------
START_BIT = 0x61
END_BIT = 0x6F

CMD_GETIMG = 0x6A
CMD_ATSA_GETVERSION = 0xA0
CMD_ATSA_GETSCREENWIDTHHEIGHT = 0xA3

CMD_LCDTOUCH = 0x69
CMD_LCDTOUCH_DRAG = 0xD6
CMD_LCDTOUCHEXT = 0xB0

NOTI_CONNECTED = 0x5E

# Key commands
CMD_MKBD = 0x60
CMD_SWC = 0x70       # SWRC (기본)
CMD_SWRC2 = 0x71     # hkccic SWRC2 (CCIC 전용)
CMD_MKBD2 = 0x72     # hkccic MKBD2 (CCIC 전용)
CMD_CCP = 0x80
CMD_RRC = 0x90
CMD_MIRROR = 0x92

# Sub commands
RELEASE_KEY = 0x41
PRESS_KEY = 0x42
SHORT_KEY = 0x43
LONG_KEY = 0x44
MOVE_KEY = 0x45
DIAL_ACTION = 0x80

# Screen type mapping for touch
SCREEN_TOUCH_MAP = {
    "front_center": 0,
    "rear_right": 1,
    "rear_left": 2,
}

# Screen type mapping for image capture (bitmask)
SCREEN_CAPTURE_MAP = {
    "cluster": 1,       # 1 << 0
    "front_center": 8,  # 1 << 3
    "rear_left": 32,    # 1 << 5
    "rear_right": 128,  # 1 << 7
}

# Key definitions — HKMC 6th Connected Wide + hkccic.
# 각 디바이스는 info["hkmc_keys"]로 cmd/key/visible/dial을 개별 오버라이드할 수 있다.
HKMC_KEYS = {
    # ---------- MKBD (CMD_MKBD=0x60) — Navi/Non-Navi 공통 ----------
    "MKBD_MAP":         {"cmd": CMD_MKBD, "key": 0x0B},
    "MKBD_NAV":         {"cmd": CMD_MKBD, "key": 0x0C},
    "MKBD_RADIO":       {"cmd": CMD_MKBD, "key": 0x0D},
    "MKBD_MEDIA":       {"cmd": CMD_MKBD, "key": 0x0E},
    "MKBD_CUSTOM":      {"cmd": CMD_MKBD, "key": 0x11},
    "MKBD_SETUP":       {"cmd": CMD_MKBD, "key": 0x12},
    "MKBD_HOME":        {"cmd": CMD_MKBD, "key": 0x14},   # Non-Navi
    "MKBD_PHONE":       {"cmd": CMD_MKBD, "key": 0x29},   # Non-Navi

    # ---------- CCP (CMD_CCP=0x80) ----------
    "CCP_ENTER":        {"cmd": CMD_CCP, "key": 0x08},
    "CCP_UP":           {"cmd": CMD_CCP, "key": 0x00},
    "CCP_DOWN":         {"cmd": CMD_CCP, "key": 0x01},
    "CCP_LEFT":         {"cmd": CMD_CCP, "key": 0x03},
    "CCP_RIGHT":        {"cmd": CMD_CCP, "key": 0x06},
    "CCP_BACK":         {"cmd": CMD_CCP, "key": 0x09},
    "CCP_MENU":         {"cmd": CMD_CCP, "key": 0x0A},
    "CCP_HOME":         {"cmd": CMD_CCP, "key": 0x14},
    "CCP_POWER":        {"cmd": CMD_CCP, "key": 0x19},
    "CCP_TUNE_PUSH":    {"cmd": CMD_CCP, "key": 0x1E},
    "CCP_JOGDIAL":      {"cmd": CMD_CCP, "key": 0x00, "dial": True},
    "CCP_JOGDIAL_CLOCK_Right": {"cmd": CMD_CCP, "key": 0x00, "dial": True, "direction": 0x00},
    "CCP_JOGDIAL_CLOCK_Left":  {"cmd": CMD_CCP, "key": 0x00, "dial": True, "direction": 0x01},
    "CCP_VOLUME":       {"cmd": CMD_CCP, "key": 0x01, "dial": True},
    "CCP_TUNE":         {"cmd": CMD_CCP, "key": 0x04, "dial": True},

    # ---------- RRC (CMD_RRC=0x90) — Navi ----------
    "RRC_ENTER":        {"cmd": CMD_RRC, "key": 0x08},
    "RRC_UP":           {"cmd": CMD_RRC, "key": 0x00},
    "RRC_DOWN":         {"cmd": CMD_RRC, "key": 0x01},
    "RRC_LEFT":         {"cmd": CMD_RRC, "key": 0x03},
    "RRC_RIGHT":        {"cmd": CMD_RRC, "key": 0x06},
    "RRC_BACK":         {"cmd": CMD_RRC, "key": 0x09},
    "RRC_MENU":         {"cmd": CMD_RRC, "key": 0x0A},
    "RRC_HOME":         {"cmd": CMD_RRC, "key": 0x14},
    "RRC_POWER_LEFT":   {"cmd": CMD_RRC, "key": 0x1A},
    "RRC_POWER_RIGHT":  {"cmd": CMD_RRC, "key": 0x1B},
    "RRC_VOLUME_LEFT":  {"cmd": CMD_RRC, "key": 0x17},
    "RRC_VOLUME_RIGHT": {"cmd": CMD_RRC, "key": 0x18},
    "RRC_JOGDIAL":                  {"cmd": CMD_RRC, "key": 0x00, "dial": True},
    "RRC_VOLUME_LEFT_DIAL":         {"cmd": CMD_RRC, "key": 0x02, "dial": True},
    "RRC_VOLUME_RIGHT_DIAL":        {"cmd": CMD_RRC, "key": 0x03, "dial": True},
    # ---------- RRC (CMD_RRC=0x90) — Non-Navi 전용 ----------
    "RRC_RADIO":        {"cmd": CMD_RRC, "key": 0x0D},
    "RRC_MEDIA":        {"cmd": CMD_RRC, "key": 0x0E},
    "RRC_MUTE":         {"cmd": CMD_RRC, "key": 0x24},
    "RRC_SEEK_UP":      {"cmd": CMD_RRC, "key": 0x0F},
    "RRC_SEEK_DOWN":    {"cmd": CMD_RRC, "key": 0x10},
    "RRC_PRESET_UP":    {"cmd": CMD_RRC, "key": 0x20},
    "RRC_PRESET_DOWN":  {"cmd": CMD_RRC, "key": 0x21},
    "RRC_POWER":        {"cmd": CMD_RRC, "key": 0x19},
    "RRC_VOLUME":       {"cmd": CMD_RRC, "key": 0x01, "dial": True},

    # ---------- SWRC (CMD_SWC=0x70) ----------
    "SWRC_PTT":         {"cmd": CMD_SWC, "key": 0x22},
    "SWRC_MODE":        {"cmd": CMD_SWC, "key": 0x23},
    "SWRC_MUTE":        {"cmd": CMD_SWC, "key": 0x24},
    "SWRC_SEEK_UP":     {"cmd": CMD_SWC, "key": 0x0F},
    "SWRC_SEEK_DOWN":   {"cmd": CMD_SWC, "key": 0x10},
    "SWRC_SEND":        {"cmd": CMD_SWC, "key": 0x25},
    "SWRC_END":         {"cmd": CMD_SWC, "key": 0x26},
    "SWRC_CUSTOM":      {"cmd": CMD_SWC, "key": 0x11},
    "SWRC_VOLUME":      {"cmd": CMD_SWC, "key": 0x01, "dial": True},

    # ---------- MIRROR (CMD_MIRROR=0x92) ----------
    "MIRROR_SOS":                   {"cmd": CMD_MIRROR, "key": 0x27},
    "MIRROR_CONCIERGE":              {"cmd": CMD_MIRROR, "key": 0x2A},
    "MIRROR_CONCIERGE_POI":          {"cmd": CMD_MIRROR, "key": 0x2B},
    "MIRROR_VOICE_LOCAL_SEARCH":     {"cmd": CMD_MIRROR, "key": 0x2C},
    "MIRROR_ROADSIDE_ASSISTANT":     {"cmd": CMD_MIRROR, "key": 0x2D},

    # ---------- hkccic MKBD2 (CMD_MKBD2=0x72) ----------
    "MKBD2_TURN_LEFT":  {"cmd": CMD_MKBD2, "key": 0x01},
    "MKBD2_TURN_RIGHT": {"cmd": CMD_MKBD2, "key": 0x02},

    # ---------- hkccic SWRC2 (CMD_SWRC2=0x71) ----------
    "SWRC2_BACK":       {"cmd": CMD_SWRC2, "key": 0x01},
    "SWRC2_UP":         {"cmd": CMD_SWRC2, "key": 0x02},
    "SWRC2_DOWN":       {"cmd": CMD_SWRC2, "key": 0x03},
    "SWRC2_OK":         {"cmd": CMD_SWRC2, "key": 0x04},
    "SWRC2_ENTER":      {"cmd": CMD_SWRC2, "key": 0x05},
    # SWRC2 Optical mouse events (hkccic)
    "SWRC2_SWIPE_UP":            {"cmd": CMD_SWRC2, "key": 0x06},
    "SWRC2_SWIPE_DOWN":          {"cmd": CMD_SWRC2, "key": 0x07},
    "SWRC2_SWIPE_LEFT":          {"cmd": CMD_SWRC2, "key": 0x08},
    "SWRC2_SWIPE_RIGHT":         {"cmd": CMD_SWRC2, "key": 0x09},
    "SWRC2_SWIPE_FAST_UP":       {"cmd": CMD_SWRC2, "key": 0x0A},
    "SWRC2_SWIPE_FAST_DOWN":     {"cmd": CMD_SWRC2, "key": 0x0B},
    "SWRC2_SWIPE_FAST_LEFT":     {"cmd": CMD_SWRC2, "key": 0x0C},
    "SWRC2_SWIPE_FAST_RIGHT":    {"cmd": CMD_SWRC2, "key": 0x0D},
    "SWRC2_DRAG_UP":             {"cmd": CMD_SWRC2, "key": 0x0E},
    "SWRC2_DRAG_DOWN":           {"cmd": CMD_SWRC2, "key": 0x0F},
    "SWRC2_DRAG_LEFT":           {"cmd": CMD_SWRC2, "key": 0x10},
    "SWRC2_DRAG_RIGHT":          {"cmd": CMD_SWRC2, "key": 0x11},
    "SWRC2_TOUCH":               {"cmd": CMD_SWRC2, "key": 0x12},
    "SWRC2_DOUBLE_TOUCH":        {"cmd": CMD_SWRC2, "key": 0x13},
}


def _calc_crc16(data: list[int]) -> int:
    """CRC16 with 0xC659 polynomial (from IVIHKMC6thClient)."""
    crc = 0xFFFF
    key = 0xC659
    for b in data:
        tmp = (b & 0xFF) ^ (crc & 0x00FF)
        for _ in range(8):
            if tmp & 1:
                tmp = (tmp >> 1) ^ key
            else:
                tmp = tmp >> 1
        crc = (crc >> 8) ^ tmp
    return crc


def _parse_int32(data: list[int], offset: int) -> int:
    """Parse a big-endian 32-bit integer from a byte list."""
    return ((data[offset] << 24) | (data[offset + 1] << 16) |
            (data[offset + 2] << 8) | data[offset + 3])


class HKMC6thService:
    """TCP socket client for HKMC 6th generation IVI devices.

    Provides screenshot capture, touch/swipe input, and hardware key control.
    Each instance manages one TCP connection to one target device.
    """

    def __init__(self, host: str, port: int, device_id: str = "",
                 key_overrides: Optional[dict[str, dict]] = None):
        """
        Args:
            key_overrides: 디바이스별 키 오버라이드.
                {name: {"cmd": int, "key": int, "dial": bool, "visible": bool}}
                visible=False면 UI 표시 제외. cmd/key/dial은 spec default를 덮어쓴다.
                차종별로 키 값이 다를 때 사용 (Non-Navi/Navi 차이 등).
        """
        self.host = host
        self.port = port
        self.device_id = device_id
        self._key_overrides: dict[str, dict] = dict(key_overrides or {})

        self._socket: Optional[socket.socket] = None
        self._connected = False
        self._recv_thread: Optional[threading.Thread] = None
        self._exit_flag = False
        self._send_lock = threading.Lock()  # 송신 시퀀스 보호 (press-release 등)
        self._capture_lock = threading.Lock()  # 스크린샷 캡처 직렬화

        # Receive state
        self._recv_queue: queue.Queue = queue.Queue()
        self._recv_complete = True
        self._recv_packet_len = 0
        self._recv_data = ""

        # Image capture state
        self._img_event = threading.Event()
        self._img_filename = ""
        self._img_made = False
        self._img_buffer: bytes = b""  # 인메모리 BMP 데이터

        # Screen sizes (populated after reqScreenSize)
        self._screen_size_event = threading.Event()
        self.screen_width_front = 0
        self.screen_height_front = 0
        self.screen_width_rear_l = 0
        self.screen_height_rear_l = 0
        self.screen_width_rear_r = 0
        self.screen_height_rear_r = 0
        self.screen_width_cluster = 1920
        self.screen_height_cluster = 720

        # Version info
        self.agent_version = ""

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def connect(self, timeout: float = 10.0) -> bool:
        """Connect to the HKMC agent and start receive thread."""
        if self._socket:
            logger.warning("Already connected to %s:%d", self.host, self.port)
            return True

        try:
            self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self._socket.settimeout(timeout)
            self._socket.connect((self.host, self.port))
        except Exception as e:
            logger.error("Failed to connect to %s:%d: %s", self.host, self.port, e)
            if self._socket:
                try:
                    self._socket.close()
                except Exception:
                    pass
            self._socket = None
            return False

        # Wait for handshake (13 bytes) — 소켓 타임아웃으로 무한 블록 방지
        deadline = time.time() + timeout
        self._connected = False
        while not self._connected and time.time() < deadline:
            try:
                remaining = max(0.1, deadline - time.time())
                self._socket.settimeout(remaining)
                raw = self._socket.recv(13)
                if not raw:
                    logger.error("HKMC handshake: peer closed before handshake (%s:%d)", self.host, self.port)
                    break
                hex_val = raw.hex()
                if hex_val in ("6161000000035e002185fd6f6f", "6161000000035e0000df856f6f"):
                    self._connected = True
                    logger.info("HKMC agent connected: %s:%d", self.host, self.port)
                else:
                    logger.warning("Invalid handshake: %s", hex_val)
                    break
            except socket.timeout:
                logger.error("HKMC handshake recv timeout (%s:%d)", self.host, self.port)
                break
            except socket.error as e:
                logger.error("Socket error during handshake: %s", e)
                try:
                    self._socket.close()
                except Exception:
                    pass
                self._socket = None
                return False

        if not self._connected:
            logger.error("Handshake failed for %s:%d", self.host, self.port)
            try:
                self._socket.close()
            except Exception:
                pass
            self._socket = None
            return False

        # 핸드셰이크 완료 — receive thread는 블로킹 모드로 동작
        try:
            self._socket.settimeout(None)
        except Exception:
            pass

        # Start receive thread
        self._exit_flag = False
        self._recv_thread = threading.Thread(
            target=self._receive_thread, name=f"hkmc6th-recv-{self.device_id}", daemon=True
        )
        self._recv_thread.start()

        # 초기화 시퀀스 (레거시와 동일: version → 대기 → screen size → 대기)
        self._req_ats_agent_version()
        time.sleep(0.5)
        self._req_screen_size()
        # screen size 수신 대기 (Agent가 키 명령을 받으려면 초기화 완료 필요)
        if self.screen_height_front == 0:
            logger.warning("Screen size not received, retrying...")
            time.sleep(1)
            self._req_screen_size()

        return True

    def disconnect(self) -> None:
        """Close connection and stop receive thread."""
        self._exit_flag = True
        if self._socket:
            try:
                self._socket.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            try:
                self._socket.close()
            except Exception:
                pass
            self._socket = None
        self._connected = False
        if self._recv_thread and self._recv_thread.is_alive():
            self._recv_thread.join(timeout=3)
        self._recv_thread = None
        logger.info("HKMC disconnected: %s:%d", self.host, self.port)

    @property
    def is_connected(self) -> bool:
        return self._connected and self._socket is not None

    # ------------------------------------------------------------------
    # Packet send
    # ------------------------------------------------------------------

    def _send_raw(self, packet: list[int]) -> None:
        """Send raw packet bytes to socket."""
        if not self._socket:
            raise ConnectionError("Not connected to HKMC agent")
        msg = bytearray(packet)
        try:
            self._socket.send(msg)
        except (ConnectionResetError, ConnectionAbortedError, OSError) as e:
            # WinError 10054 등: 원격 호스트 연결 끊김 → 자동 disconnect
            logger.warning("HKMC connection lost (device=%s): %s", self.device_id, e)
            self.disconnect()
            raise ConnectionError(f"HKMC connection lost: {e}")

    def _make_send_packet(self, cmd: int, sub_cmd: int, resp: int, data: list[int]) -> None:
        """Build and send a framed packet with CRC16."""
        agent_cmd = [cmd, sub_cmd, resp] + data
        crc = _calc_crc16(agent_cmd)
        logger.debug("[HKMC SEND] cmd=0x%02X sub=0x%02X resp=0x%02X data_len=%d", cmd, sub_cmd, resp, len(data))
        packet_len = len(agent_cmd)

        packet = [START_BIT, START_BIT]
        packet.append((packet_len >> 24) & 0xFF)
        packet.append((packet_len >> 16) & 0xFF)
        packet.append((packet_len >> 8) & 0xFF)
        packet.append(packet_len & 0xFF)
        packet.extend(agent_cmd)
        packet.append((crc >> 8) & 0xFF)
        packet.append(crc & 0xFF)
        packet.append(END_BIT)
        packet.append(END_BIT)

        logger.debug("[HKMC PACKET] %s", ' '.join(f'{b:02X}' for b in packet))
        self._send_raw(packet)

    # ------------------------------------------------------------------
    # Receive thread
    # ------------------------------------------------------------------

    def _receive_thread(self) -> None:
        """Background thread that receives and decodes packets."""
        logger.info("Receive thread started for %s:%d", self.host, self.port)
        # 주기적 타임아웃으로 _exit_flag 검사 + 피어 silent 시 무한 블록 방지
        try:
            self._socket.settimeout(1.0)
        except Exception:
            pass
        while not self._exit_flag:
            try:
                if self._recv_complete:
                    try:
                        header = self._socket.recv(6)
                    except socket.timeout:
                        continue
                    if self._exit_flag or not header:
                        break
                    header_str = header.decode("iso-8859-1")

                    if ord(header_str[0]) == START_BIT and ord(header_str[1]) == START_BIT:
                        self._recv_packet_len = (
                            (ord(header_str[2]) << 24) | (ord(header_str[3]) << 16) |
                            (ord(header_str[4]) << 8) | ord(header_str[5])
                        )
                        self._recv_complete = False
                        self._recv_data = header_str
                    else:
                        logger.warning("Bad packet header")
                        self._recv_complete = True
                        self._recv_data = ""
                else:
                    remaining = self._recv_packet_len + 4  # cmd+crc+end
                    try:
                        payload = self._socket.recv(remaining)
                    except socket.timeout:
                        continue
                    if self._exit_flag or not payload:
                        break
                    payload_str = payload.decode("iso-8859-1")
                    self._recv_data += payload_str

                    if len(payload_str) == remaining:
                        self._recv_complete = True
                        self._recv_queue.put(self._recv_data)
                        self._decode_response()
                    elif len(payload_str) < remaining:
                        self._recv_complete = False
                        self._recv_packet_len -= len(payload_str)
                    else:
                        logger.warning("Packet length mismatch")
                        self._recv_complete = True

            except (socket.error, OSError):
                if not self._exit_flag:
                    logger.error("Receive thread socket error")
                break
            except Exception as e:
                if not self._exit_flag:
                    logger.error("Receive thread error: %s", e)
                break

        logger.info("Receive thread ended for %s:%d", self.host, self.port)

    def _decode_response(self) -> None:
        """Decode received packets from queue."""
        while not self._recv_queue.empty():
            msg = self._recv_queue.get()
            if len(msg) < 10:
                continue

            if ord(msg[0]) != START_BIT or ord(msg[1]) != START_BIT:
                continue

            packet_len = (
                (ord(msg[2]) << 24) | (ord(msg[3]) << 16) |
                (ord(msg[4]) << 8) | ord(msg[5])
            )
            cmd = ord(msg[6])
            data_str = msg[9:9 + packet_len - 3]
            data_len = len(data_str)

            if cmd == NOTI_CONNECTED:
                self._connected = True
                logger.info("Agent connection notification received")

            elif cmd == CMD_ATSA_GETVERSION:
                self.agent_version = data_str if data_len > 0 else ""
                logger.info("Agent version: %s", self.agent_version)

            elif cmd == CMD_ATSA_GETSCREENWIDTHHEIGHT:
                data = [ord(c) for c in data_str]
                if len(data) >= 8:
                    self.screen_width_front = _parse_int32(data, 0)
                    self.screen_height_front = _parse_int32(data, 4)
                if len(data) >= 24:
                    self.screen_width_rear_l = _parse_int32(data, 8)
                    self.screen_height_rear_l = _parse_int32(data, 12)
                    self.screen_width_rear_r = _parse_int32(data, 16)
                    self.screen_height_rear_r = _parse_int32(data, 20)
                logger.info(
                    "Screen sizes: front=%dx%d, rear_l=%dx%d, rear_r=%dx%d, cluster=%dx%d",
                    self.screen_width_front, self.screen_height_front,
                    self.screen_width_rear_l, self.screen_height_rear_l,
                    self.screen_width_rear_r, self.screen_height_rear_r,
                    self.screen_width_cluster, self.screen_height_cluster,
                )
                self._screen_size_event.set()

            elif cmd == CMD_GETIMG:
                # Image data received — store in memory buffer
                raw_bytes = data_str.encode("iso-8859-1")
                self._img_buffer = raw_bytes
                if self._img_filename:
                    with open(self._img_filename, "wb") as f:
                        f.write(raw_bytes)
                self._img_made = True
                self._img_event.set()
                logger.debug("Image received: %d bytes", len(raw_bytes))

    # ------------------------------------------------------------------
    # Info requests
    # ------------------------------------------------------------------

    def _req_ats_agent_version(self) -> None:
        self._make_send_packet(CMD_ATSA_GETVERSION, 0, 0, [])

    def _req_screen_size(self) -> None:
        self._screen_size_event.clear()
        self._make_send_packet(CMD_ATSA_GETSCREENWIDTHHEIGHT, 0, 0, [])
        self._screen_size_event.wait(timeout=5)

    # ------------------------------------------------------------------
    # Screenshot
    # ------------------------------------------------------------------

    # 화면 크기를 응답하지 않는 에이전트용 기본값
    _DEFAULT_SCREEN_SIZES = {
        "front_center": (1920, 720),
        "rear_left":    (1920, 720),
        "rear_right":   (1920, 720),
        "cluster":      (1920, 720),
    }

    def get_screen_size(self, screen_type: str = "front_center") -> tuple[int, int]:
        """Return (width, height) for the given screen type. Falls back to defaults if 0."""
        if screen_type == "front_center":
            w, h = self.screen_width_front, self.screen_height_front
        elif screen_type == "rear_left":
            w, h = self.screen_width_rear_l, self.screen_height_rear_l
        elif screen_type == "rear_right":
            w, h = self.screen_width_rear_r, self.screen_height_rear_r
        elif screen_type == "cluster":
            w, h = self.screen_width_cluster, self.screen_height_cluster
        else:
            w, h = self.screen_width_front, self.screen_height_front
        # 0이면 기본값 사용 (최초 1회만 로그)
        if w == 0 or h == 0:
            dw, dh = self._DEFAULT_SCREEN_SIZES.get(screen_type, (1920, 720))
            if not getattr(self, '_screen_default_logged', False):
                logger.info("Screen size 0 for %s, using default %dx%d", screen_type, dw, dh)
                self._screen_default_logged = True
            return dw, dh
        return w, h

    def _request_img(self, left: int, top: int, right: int, bottom: int,
                     filename: str, screen_type_bits: Optional[int] = None) -> None:
        """Send image capture request to agent."""
        self._img_made = False
        self._img_event.clear()
        self._img_filename = filename

        data = []
        data.append((left >> 8) & 0xFF)
        data.append(left & 0xFF)
        data.append((top >> 8) & 0xFF)
        data.append(top & 0xFF)
        data.append((right >> 8) & 0xFF)
        data.append(right & 0xFF)
        data.append((bottom >> 8) & 0xFF)
        data.append(bottom & 0xFF)
        if screen_type_bits is not None:
            data.append((screen_type_bits >> 8) & 0xFF)
            data.append(screen_type_bits & 0xFF)

        with self._send_lock:
            self._make_send_packet(CMD_GETIMG, 0, 0, data)

    def screencap(self, output_path: str, screen_type: str = "front_center",
                  timeout: float = 10.0) -> str:
        """Capture a screenshot and save to output_path (BMP from agent).

        Returns the output path on success, raises on failure.
        """
        w, h = self.get_screen_size(screen_type)
        screen_bits = SCREEN_CAPTURE_MAP.get(screen_type)

        self._request_img(0, 0, w, h, output_path, screen_bits)

        # Wait for image
        if not self._img_event.wait(timeout=timeout):
            raise TimeoutError(f"Screenshot timeout ({timeout}s) for {screen_type}")

        if not os.path.exists(output_path):
            raise FileNotFoundError(f"Screenshot file not created: {output_path}")

        return output_path

    def screencap_bytes(self, screen_type: str = "front_center",
                        fmt: str = "png", timeout: float = 10.0) -> bytes:
        """Capture screenshot and return as PNG/JPEG bytes.

        The agent sends BMP format. We convert to the requested format.
        _capture_lock으로 동시 호출을 직렬화하여 _img_event 경쟁 방지.
        """
        with self._capture_lock:
            w, h = self.get_screen_size(screen_type)
            screen_bits = SCREEN_CAPTURE_MAP.get(screen_type)

            self._img_buffer = b""
            self._img_made = False
            self._img_event.clear()
            self._img_filename = ""

            img_data = [0, 0, 0, 0]  # left=0, top=0
            img_data.append((w >> 8) & 0xFF)
            img_data.append(w & 0xFF)
            img_data.append((h >> 8) & 0xFF)
            img_data.append(h & 0xFF)
            if screen_bits is not None:
                img_data.append((screen_bits >> 8) & 0xFF)
                img_data.append(screen_bits & 0xFF)

            with self._send_lock:
                self._make_send_packet(CMD_GETIMG, 0, 0, img_data)

            if not self._img_event.wait(timeout=timeout):
                raise TimeoutError(f"Screenshot timeout ({timeout}s) for {screen_type}")

            bmp_bytes = self._img_buffer
            if not bmp_bytes:
                raise ValueError("Empty image buffer")

        # 변환은 lock 밖에서 (다른 캡처를 블로킹하지 않도록)
        try:
            import cv2
            import numpy as np
            arr = np.frombuffer(bmp_bytes, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is not None:
                if fmt == "jpeg":
                    _, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 60])
                else:
                    _, buf = cv2.imencode(".png", img)
                return buf.tobytes()
        except Exception:
            pass

        try:
            from PIL import Image
            pil_img = Image.open(io.BytesIO(bmp_bytes))
            bio = io.BytesIO()
            pil_img.save(bio, format="PNG" if fmt == "png" else "JPEG", quality=60)
            return bio.getvalue()
        except Exception:
            pass

        return bmp_bytes

    # ------------------------------------------------------------------
    # Touch input
    # ------------------------------------------------------------------

    def tap(self, x: int, y: int, screen_type: str = "front_center") -> None:
        """Tap at (x, y) using lcdTouch."""
        x, y = int(x), int(y)
        # _capture_lock: 탭 동안 스크린샷 CMD_GETIMG 차단
        with self._capture_lock:
            time.sleep(0.3)
            with self._send_lock:
                self._lcd_touch(x, y)
                logger.info("[TAP] (%d,%d) screen=%s", x, y, screen_type)
            time.sleep(0.05)

    def repeat_tap(self, x: int, y: int, count: int = 5, interval_ms: int = 100,
                   screen_type: str = "front_center") -> None:
        """연속 터치 — lock/sleep 오버헤드를 최소화하여 빠르게 실행."""
        x, y = int(x), int(y)
        interval_sec = interval_ms / 1000.0
        with self._capture_lock:
            with self._send_lock:
                for i in range(count):
                    self._lcd_touch(x, y)
                    if i < count - 1 and interval_sec > 0:
                        time.sleep(interval_sec)
                logger.info("[REPEAT_TAP] (%d,%d) ×%d @%dms screen=%s", x, y, count, interval_ms, screen_type)
            time.sleep(0.05)

    def long_press(self, x: int, y: int, duration_ms: int = 3000,
                   screen_type: str = "front_center") -> None:
        """Long press at (x, y) — press, hold, release."""
        x, y = int(x), int(y)
        with self._capture_lock:
            time.sleep(0.3)
            with self._send_lock:
                self._lcd_touch(x, y)
                logger.info("[LONG_PRESS] (%d,%d) %dms", x, y, duration_ms)
                time.sleep(duration_ms / 1000.0)
                self._lcd_touch(x, y)
            time.sleep(0.05)

    def swipe(self, x1: int, y1: int, x2: int, y2: int,
              screen_type: str = "front_center") -> None:
        """Swipe (drag) from (x1, y1) to (x2, y2) using lcdDrag."""
        x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)
        with self._capture_lock:
            time.sleep(0.3)
            with self._send_lock:
                self._lcd_drag(x1, y1, x2, y2)
                logger.info("[SWIPE] (%d,%d)->(%d,%d) screen=%s", x1, y1, x2, y2, screen_type)
            time.sleep(0.05)

    def _lcd_touch_ext_6th(self, events: list[list[int]]) -> None:
        """Send extended touch event for 6th gen (with screen type per finger).

        Each event is [x, y, action, screenType].
        """
        data = []
        num_fingers = len(events)
        data.append(num_fingers)
        for idx, ev in enumerate(events):
            x, y, action, st = ev
            data.append(idx)  # finger index
            data.append((x >> 8) & 0xFF)
            data.append(x & 0xFF)
            data.append((y >> 8) & 0xFF)
            data.append(y & 0xFF)
            data.append(action)
            data.append((st >> 8) & 0xFF)
            data.append(st & 0xFF)

        self._make_send_packet(CMD_LCDTOUCHEXT, 0, 0, data)

    def _lcd_touch(self, x: int, y: int, screen_type: Optional[int] = None) -> None:
        """Simple LCD touch (legacy)."""
        data = []
        data.append((x >> 8) & 0xFF)
        data.append(x & 0xFF)
        data.append((y >> 8) & 0xFF)
        data.append(y & 0xFF)
        if screen_type is not None:
            data.append((screen_type >> 8) & 0xFF)
            data.append(screen_type & 0xFF)
        self._make_send_packet(CMD_LCDTOUCH, 0, 0, data)

    def _lcd_drag(self, sx: int, sy: int, ex: int, ey: int,
                  screen_type: Optional[int] = None) -> None:
        """LCD drag (swipe)."""
        data = []
        for v in (sx, sy, ex, ey):
            data.append((v >> 8) & 0xFF)
            data.append(v & 0xFF)
        if screen_type is not None:
            data.append((screen_type >> 8) & 0xFF)
            data.append(screen_type & 0xFF)
        self._make_send_packet(CMD_LCDTOUCH_DRAG, 0, 0, data)

    # ------------------------------------------------------------------
    # Hardware keys
    # ------------------------------------------------------------------

    def send_key(self, cmd: int, sub_cmd: int, key_data: int,
                 monitor: int = 0x00, direction: Optional[int] = None) -> None:
        """Send a hardware key event (6th gen keyExt6th).

        Args:
            cmd: Key category command (CMD_MKBD, CMD_CCP, CMD_RRC, CMD_SWC, CMD_MIRROR)
            sub_cmd: Sub command (SHORT_KEY, LONG_KEY, PRESS_KEY, RELEASE_KEY, DIAL_ACTION)
            key_data: Key code
            monitor: Target monitor (0x00=NONE, 0x01=LEFT, 0x02=RIGHT)
            direction: Optional direction byte for dial/knob events
        """
        resp = 0xFE
        data = []
        data.append((key_data >> 24) & 0xFF)
        data.append((key_data >> 16) & 0xFF)
        data.append((key_data >> 8) & 0xFF)
        data.append(key_data & 0xFF)
        if direction is not None:
            data.append(direction)
        data.append(monitor)

        logger.debug("[HKMC KEY] cmd=0x%02X sub=0x%02X key=0x%02X monitor=0x%02X dir=%s",
                     cmd, sub_cmd, key_data, monitor, direction)

        with self._send_lock:
            self._make_send_packet(cmd, sub_cmd, resp, data)

    def resolve_key(self, key_name: str) -> Optional[dict]:
        """spec default + device override 병합된 키 정보 반환.

        cmd/key/dial/direction 개별 필드만 덮어쓴다 (visible은 UI 전용).
        """
        base = HKMC_KEYS.get(key_name, {})
        ov = self._key_overrides.get(key_name, {})
        merged = dict(base)
        for k in ("cmd", "key", "dial", "direction"):
            if k in ov:
                merged[k] = ov[k]
        if "cmd" not in merged or "key" not in merged:
            return None
        return merged

    def set_key_overrides(self, overrides: Optional[dict[str, dict]]) -> None:
        """디바이스 키 오버라이드 일괄 갱신 (설정 모달 저장 시 호출)."""
        self._key_overrides = dict(overrides or {})

    def get_key_overrides(self) -> dict[str, dict]:
        return dict(self._key_overrides)

    def send_key_by_name(self, key_name: str, sub_cmd: int = SHORT_KEY,
                         monitor: int = 0x00, direction: Optional[int] = None) -> None:
        """Send a hardware key by its name (e.g. 'CCP_ENTER', 'MKBD_MAP').

        Args:
            key_name: Key name from HKMC_KEYS
            sub_cmd: SHORT_KEY, LONG_KEY, PRESS_KEY, RELEASE_KEY, DIAL_ACTION
            monitor: Target monitor
            direction: Direction for dial events
        """
        key_info = self.resolve_key(key_name)
        if not key_info:
            raise ValueError(f"Unknown HKMC key: {key_name}")

        cmd = key_info["cmd"]
        key_data = key_info["key"]

        # _capture_lock: 키 시퀀스 중 스크린샷 CMD_GETIMG 차단
        with self._capture_lock:
            # Agent가 이전 이미지 응답 전송을 마칠 시간 확보
            time.sleep(0.3)
            if key_info.get("dial"):
                dir_val = direction if direction is not None else key_info.get("direction")
                self.send_key(cmd, DIAL_ACTION, key_data, monitor, dir_val)
            elif sub_cmd == SHORT_KEY:
                # 일반 키: PRESS → SHORT → RELEASE 3단계 시퀀스
                self.send_key(cmd, PRESS_KEY, key_data, monitor, direction)
                time.sleep(0.1)
                self.send_key(cmd, SHORT_KEY, key_data, monitor, direction)
                time.sleep(0.1)
                self.send_key(cmd, RELEASE_KEY, key_data, monitor, direction)
            elif sub_cmd == LONG_KEY:
                # 롱프레스: PRESS → LONG → RELEASE
                self.send_key(cmd, PRESS_KEY, key_data, monitor, direction)
                time.sleep(1.0)
                self.send_key(cmd, LONG_KEY, key_data, monitor, direction)
                time.sleep(0.1)
                self.send_key(cmd, RELEASE_KEY, key_data, monitor, direction)
            else:
                self.send_key(cmd, sub_cmd, key_data, monitor, direction)
            # Agent 처리 시간 확보 (CMD_GETIMG 즉시 진입 방지)
            time.sleep(0.05)

    # ------------------------------------------------------------------
    # Async wrappers (for use from FastAPI/asyncio context)
    # ------------------------------------------------------------------

    async def async_connect(self, timeout: float = 10.0) -> bool:
        """Async wrapper for connect()."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self.connect, timeout)

    async def async_disconnect(self) -> None:
        """Async wrapper for disconnect()."""
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self.disconnect)

    async def async_screencap(self, output_path: str, screen_type: str = "front_center",
                              timeout: float = 10.0) -> str:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self.screencap, output_path, screen_type, timeout)

    async def async_screencap_bytes(self, screen_type: str = "front_center",
                                    fmt: str = "png", timeout: float = 10.0) -> bytes:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self.screencap_bytes, screen_type, fmt, timeout)

    async def async_tap(self, x: int, y: int, screen_type: str = "front_center") -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self.tap, x, y, screen_type)

    async def async_repeat_tap(self, x: int, y: int, count: int = 5, interval_ms: int = 100,
                               screen_type: str = "front_center") -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self.repeat_tap, x, y, count, interval_ms, screen_type)

    async def async_long_press(self, x: int, y: int, duration_ms: int = 3000,
                               screen_type: str = "front_center") -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self.long_press, x, y, duration_ms, screen_type)

    async def async_swipe(self, x1: int, y1: int, x2: int, y2: int,
                          screen_type: str = "front_center") -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self.swipe, x1, y1, x2, y2, screen_type)

    async def async_send_key(self, cmd: int, sub_cmd: int, key_data: int,
                             monitor: int = 0x00, direction: Optional[int] = None) -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self.send_key, cmd, sub_cmd, key_data, monitor, direction)

    async def async_send_key_by_name(self, key_name: str, sub_cmd: int = SHORT_KEY,
                                     monitor: int = 0x00, direction: Optional[int] = None) -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self.send_key_by_name, key_name, sub_cmd, monitor, direction)

    # ------------------------------------------------------------------
    # Utility
    # ------------------------------------------------------------------

    def get_info(self) -> dict:
        """Return device info dict."""
        return {
            "host": self.host,
            "port": self.port,
            "connected": self.is_connected,
            "agent_version": self.agent_version,
            "screens": {
                "front_center": {"width": self.screen_width_front, "height": self.screen_height_front},
                "rear_left": {"width": self.screen_width_rear_l, "height": self.screen_height_rear_l},
                "rear_right": {"width": self.screen_width_rear_r, "height": self.screen_height_rear_r},
                "cluster": {"width": self.screen_width_cluster, "height": self.screen_height_cluster},
            },
        }
