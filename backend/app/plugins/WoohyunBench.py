# -*- coding: utf-8 -*-
"""CCIC 우현벤치 UDP control plugin.

UDP 패킷 형식: [0x55, 0xAA, sender(100), seq(0), cmd1, cmd2, len_hi, len_lo, ...data]
Reference: WoohyunBench_LIBRARY.py, CCIC_DEFINITION_LIBRARY.py (legacy)

벤치 기본값: BENCH_IP = 192.168.1.101, BENCH_PORT = 25000
"""

import socket
import logging
import time

logger = logging.getLogger(__name__)

START_1 = 0x55
START_2 = 0xAA
SENDER_ID = 100
DEFAULT_UDP_PORT = 25000

# CAN FD 전송 패킷 헤더 (cmd1=0x04, cmd2=0x30) — 레거시 UDP_CANFD_SEND() 기준
CANFD_SEND_PACKET_HEADER = [START_1, START_2, SENDER_ID, 0x00, 0x04, 0x30]


def get_dlc_from_payload_size(payload_size: int) -> int:
    """CAN FD 실제 페이로드 바이트 수 → DLC(0~15) 매핑.

    CAN 2.0은 0~8 그대로, CAN FD는 12/16/20/24/32/48/64 가 유효한 크기.
    매핑에 없는 값은 8로 폴백 (안전한 기본 프레임 크기).
    """
    _map = {
        0: 0, 1: 1, 2: 2, 3: 3,
        4: 4, 5: 5, 6: 6, 7: 7,
        8: 8, 12: 9, 16: 10, 20: 11,
        24: 12, 32: 13, 48: 14, 64: 15,
    }
    return _map.get(payload_size, 8)


class WoohyunBench:
    """CCIC 우현벤치 UDP 제어 플러그인."""

    def __init__(self, host: str = "", udp_port: int = DEFAULT_UDP_PORT):
        self._host = host
        self._udp_port = int(udp_port)
        self._sock = None

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def Connect(self) -> str:
        """UDP 소켓 연결. 레거시 UDP_INIT() 동일."""
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None
        if not self._host:
            raise RuntimeError("Host not set")
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # 레거시 코드와 동일: connect()로 기본 목적지 설정 (타임아웃 미설정)
        self._sock.connect((self._host, self._udp_port))
        logger.info("WoohyunBench connected to %s:%d", self._host, self._udp_port)
        return f"Connected to {self._host}:{self._udp_port}"

    def Disconnect(self) -> str:
        """UDP 소켓 해제. 레거시 UDP_DEINIT() 동일."""
        if self._sock:
            self._sock.close()
            self._sock = None
        return "Disconnected"

    def IsConnected(self) -> bool:
        """연결 상태 확인."""
        return self._sock is not None

    # ------------------------------------------------------------------
    # Internal — 레거시 UDP_SEND()와 동일한 로직
    # ------------------------------------------------------------------

    def _drain_rx(self) -> int:
        """수신 버퍼에 남아있는 이전 응답들을 모두 비워 현재 요청 응답과 섞이지 않게 한다.

        Returns: drop된 패킷 수 (디버깅용).
        """
        if not self._sock:
            return 0
        dropped = 0
        orig_timeout = self._sock.gettimeout()
        try:
            self._sock.setblocking(False)
            while True:
                try:
                    data = self._sock.recv(64)
                    if not data:
                        break
                    dropped += 1
                    if dropped > 32:
                        break  # 안전장치
                except BlockingIOError:
                    break
                except Exception:
                    break
        finally:
            try:
                self._sock.settimeout(orig_timeout)
            except Exception:
                pass
        if dropped:
            logger.debug("WoohyunBench drained %d stale packet(s) from rx buffer", dropped)
        return dropped

    def _send(self, data: list, recv: bool = True, recv_timeout: float = 60.0) -> list | bool:
        """UDP 패킷 전송 및 응답 수신.

        레거시 UDP_SEND() 함수와 동일한 패킷 구조 및 응답 검증 로직.
        단, 요청 전에 수신 버퍼를 비워 이전 응답이 섞이지 않도록 한다.
        """
        if not self._sock:
            raise RuntimeError("Not connected — call Connect() first")

        # 이전 명령 응답이 버퍼에 남아있으면 매칭 루프에서 오래 소모됨 → 보내기 전 비움
        self._drain_rx()

        data_len = len(data) - 2
        packet = [START_1, START_2, SENDER_ID, 0,
                  data[0], data[1],
                  (data_len >> 8) & 0xFF, data_len & 0xFF]
        for i in range(data_len):
            packet.append(data[2 + i])

        encoded = bytearray(packet)
        hex_str = " ".join(f"0x{b:02X}" for b in packet)

        try:
            self._sock.sendto(encoded, (self._host, self._udp_port))
        except Exception as e:
            logger.error("WoohyunBench send failed: %s", e)
            return False

        logger.info("WoohyunBench TX: %s", hex_str)

        if not recv:
            return True

        # 레거시와 동일: recv_timeout(60초) 내에서 1초 타임아웃으로 반복 수신
        current_time = time.time()
        while (time.time() - current_time) < recv_timeout:
            self._sock.settimeout(1)
            try:
                recv_data = self._sock.recv(16)
            except socket.timeout:
                continue
            except Exception as e:
                logger.error("WoohyunBench recv error: %s", e)
                return False
            finally:
                self._sock.settimeout(None)  # 레거시와 동일: recv 후 blocking 복원

            recv_list = [int(c) for c in recv_data]

            # 레거시와 동일: 송신 패킷과 응답 패킷의 [0],[1],[3],[4],[5] 비교
            res = True
            for idx, packet_value in enumerate(packet):
                if idx == 2:
                    continue
                elif idx >= len(recv_list) or packet_value != recv_list[idx]:
                    res = False
                    break
                if idx == 5:
                    res = True
                    break

            if res:
                recv_hex = " ".join(f"0x{b:02X}" for b in recv_list)
                logger.info("WoohyunBench RX: %s", recv_hex)
                return recv_list

        logger.warning("WoohyunBench: no matching response within %ds", recv_timeout)
        return True

    # ------------------------------------------------------------------
    # CAN FD — 레거시 UDP_CANFD_SEND() 동일
    # ------------------------------------------------------------------

    def _canfd_send(self, canid: int, payload: list | bytearray, fd_mode: bool = True) -> bool:
        """CAN FD 프레임을 UDP로 전송 (fire-and-forget, 응답 수신 없음).

        패킷 구조:
          [0x55, 0xAA, sender, seq,
           0x04, 0x30,                       # cmd1, cmd2 (CAN FD send)
           len_hi, len_lo,                   # payload+header 전체 길이
           can_id(4B, big-endian),
           can_frame(1B: FD플래그 0x80 | DLC),
           reserved(1B, 0x00),
           payload...]

        Args:
            canid:    CAN ID (int).
            payload:  전송할 데이터 바이트 배열 (0~64 바이트, CAN FD 유효 크기).
            fd_mode:  True이면 FD 플래그(0x80) + DLC 매핑 적용, False면 클래식 CAN.

        Returns:
            True=송신 성공 (서버 응답 확인 없음), False=소켓 오류.
        """
        if not self._sock:
            raise RuntimeError("Not connected — call Connect() first")

        payload = list(payload)
        dlc = get_dlc_from_payload_size(len(payload)) if fd_mode else len(payload)

        # CAN ID → 4바이트 big-endian
        can_id_bytes = [
            (canid >> 24) & 0xFF,
            (canid >> 16) & 0xFF,
            (canid >>  8) & 0xFF,
             canid        & 0xFF,
        ]

        # CAN 프레임 바이트: FD 플래그(0x80) | DLC
        can_frame = (0x80 if fd_mode else 0x00) | dlc

        data = can_id_bytes + [can_frame, 0x00] + payload

        packet = CANFD_SEND_PACKET_HEADER + [
            (len(data) >> 8) & 0xFF,
             len(data)       & 0xFF,
        ] + data

        encoded = bytearray(packet)
        hex_str = " ".join(f"0x{b:02X}" for b in packet)

        try:
            self._sock.sendto(encoded, (self._host, self._udp_port))
        except Exception as e:
            logger.error("WoohyunBench CANFD send failed: %s", e)
            return False

        logger.info("WoohyunBench CANFD TX (ID=0x%X, DLC=%d): %s", canid, dlc, hex_str)
        return True

    # ------------------------------------------------------------------
    # Door Control — 레거시 DRIVER_DOOR() 동일
    # ------------------------------------------------------------------

    def DRIVER_DOOR(self, open_close: int = 1) -> str:
        """운전석 도어 열림/닫힘 CAN FD 명령 전송. 레거시 DRIVER_DOOR() 동일.

        CAN FD ID 0x411 (ICU_02) payload를 200ms 간격으로 **5회 반복** 송신
        (차량 ICU 수신 주기 200ms에 맞춤). payload[3]이 1=OPEN, 0=CLOSE.

        Args:
            open_close: 1=OPEN, 0=CLOSE.

        Returns:
            "DRIVER_DOOR OPEN: OK" / "DRIVER_DOOR CLOSE: OK" 등 결과 문자열.
            소켓 오류로 송신이 하나라도 실패하면 "FAIL"로 마킹.
        """
        if open_close:
            payload = [0, 0, 0, 1, 0, 0, 0, 0]  # open
            status = "OPEN"
        else:
            payload = [0, 0, 0, 0, 0, 0, 0, 0]  # close
            status = "CLOSE"

        all_ok = True
        for _ in range(5):
            ok = self._canfd_send(0x411, payload)
            if not ok:
                all_ok = False
                break
            time.sleep(0.2)  # ICU_02 200ms 주기

        logger.info("WoohyunBench DRIVER_DOOR %s: %s", status, "OK" if all_ok else "FAIL")
        return f"DRIVER_DOOR {status}: {'OK' if all_ok else 'FAIL'}"

    # ------------------------------------------------------------------
    # Power Control — 레거시 WOOHYUN_* 함수 동일
    # ------------------------------------------------------------------

    def IGN1(self, on_off: int = 1) -> str:
        """IGN1 제어 (0=OFF, 1=ON). 레거시 WOOHYUN_IGN1()."""
        data = [0x24, 0x22, on_off]
        res = self._send(data)
        status = "ON" if on_off else "OFF"
        return f"IGN1 {status}: {'OK' if res else 'FAIL'}"

    def IGN1_Read(self) -> int:
        """IGN1 상태 읽기. 응답이 3초 내 오지 않으면 -1."""
        res = self._send([0x24, 0x32], recv_timeout=3.0)
        # 응답 packet은 헤더 8바이트 + 1바이트 상태 = 9바이트 이상이어야 유효
        if isinstance(res, list) and len(res) >= 9:
            return res[-1]
        return -1

    def IGN2(self, on_off: int = 1) -> str:
        """IGN2 제어 (0=OFF, 1=ON). 레거시 WOOHYUN_IGN2()."""
        data = [0x24, 0x28, on_off]
        res = self._send(data)
        status = "ON" if on_off else "OFF"
        return f"IGN2 {status}: {'OK' if res else 'FAIL'}"

    def IGN2_Read(self) -> int:
        """IGN2 상태 읽기. 응답이 3초 내 오지 않으면 -1."""
        res = self._send([0x24, 0x38], recv_timeout=3.0)
        if isinstance(res, list) and len(res) >= 9:
            return res[-1]
        return -1

    def ACC(self, on_off: int = 1) -> str:
        """ACC 제어 (0=OFF, 1=ON). 레거시 WOOHYUN_ACC()."""
        data = [0x24, 0x21, on_off]
        res = self._send(data)
        status = "ON" if on_off else "OFF"
        return f"ACC {status}: {'OK' if res else 'FAIL'}"

    def ACC_Read(self) -> int:
        """ACC 상태 읽기. 응답이 3초 내 오지 않으면 -1."""
        res = self._send([0x24, 0x31], recv_timeout=3.0)
        if isinstance(res, list) and len(res) >= 9:
            return res[-1]
        return -1

    def BATTERY(self, on_off: int = 1) -> str:
        """Battery relay 제어 (0=OFF, 1=ON). 레거시 WOOHYUN_BATTERY()."""
        data = [0x24, 0x23, on_off]
        res = self._send(data)
        status = "ON" if on_off else "OFF"
        return f"BATTERY {status}: {'OK' if res else 'FAIL'}"

    def BATTERY_Read(self) -> int:
        """Battery relay 상태 읽기. 응답이 3초 내 오지 않으면 -1.

        장비가 echo만 반환(상태 payload 없음)하면 len(res)==8이어서 -1로 처리.
        정상 응답은 헤더 8 + 상태 1 = 최소 9바이트.
        """
        res = self._send([0x24, 0x33], recv_timeout=3.0)
        if isinstance(res, list) and len(res) >= 9:
            return res[-1]
        return -1

    def BatterySet(self, voltage: float = 14.4) -> str:
        """배터리 전압 설정 (V). 레거시 BATTERY_SET()."""
        data = [0x20, 0x01, int(voltage * 10)]
        res = self._send(data)
        return f"Battery set to {voltage}V: {'OK' if res else 'FAIL'}"

    def BatteryCheck(self) -> float:
        """배터리 전압 읽기 (V). 레거시 BATTERY_CHECK()."""
        res = self._send([0x20, 0x02], recv_timeout=3.0)
        if isinstance(res, list) and len(res) >= 9:
            return float(res[-1]) / 10
        return -1.0

    def AmpereCheck(self) -> float:
        """전류 읽기 (A). 레거시 AMPERE_CHECK()."""
        res = self._send([0x20, 0x03], recv_timeout=3.0)
        if isinstance(res, list) and len(res) >= 10:
            raw = (res[-1] << 8) | res[-2]
            return float(raw) / 1000
        return -1.0

    # ------------------------------------------------------------------
    # Generic
    # ------------------------------------------------------------------

    def SendCommand(self, cmd1: int, cmd2: int, data_hex: str = "") -> str:
        """범용 UDP 명령 전송. data_hex: 공백 구분 hex (예: 'FF 01')."""
        cmd = [cmd1, cmd2]
        if data_hex:
            cmd.extend(int(b, 16) for b in data_hex.split())
        res = self._send(cmd)
        if isinstance(res, list):
            return " ".join(f"0x{b:02X}" for b in res)
        return str(res)

    def GetInfo(self) -> str:
        """연결 정보."""
        return f"host={self._host}, port={self._udp_port}, connected={self.IsConnected()}"
