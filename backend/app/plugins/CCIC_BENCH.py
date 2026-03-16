# -*- coding: utf-8 -*-
"""CCIC 우현벤치 UDP control plugin.

UDP 패킷 형식: [0x55, 0xAA, sender(100), seq(0), cmd1, cmd2, len_hi, len_lo, ...data]
Reference: CCIC_BENCH_LIBRARY.py, CCIC_DEFINITION_LIBRARY.py (legacy)

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


class CCIC_BENCH:
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
        logger.info("CCIC_BENCH connected to %s:%d", self._host, self._udp_port)
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

    def _send(self, data: list, recv: bool = True, recv_timeout: float = 60.0) -> list | bool:
        """UDP 패킷 전송 및 응답 수신.

        레거시 UDP_SEND() 함수와 동일한 패킷 구조 및 응답 검증 로직.
        """
        if not self._sock:
            raise RuntimeError("Not connected — call Connect() first")

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
            logger.error("CCIC_BENCH send failed: %s", e)
            return False

        logger.info("CCIC_BENCH TX: %s", hex_str)

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
                logger.error("CCIC_BENCH recv error: %s", e)
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
                logger.info("CCIC_BENCH RX: %s", recv_hex)
                return recv_list

        logger.warning("CCIC_BENCH: no matching response within %ds", recv_timeout)
        return True

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
        """IGN1 상태 읽기."""
        res = self._send([0x24, 0x32])
        return res[-1] if isinstance(res, list) else -1

    def IGN2(self, on_off: int = 1) -> str:
        """IGN2 제어 (0=OFF, 1=ON). 레거시 WOOHYUN_IGN2()."""
        data = [0x24, 0x28, on_off]
        res = self._send(data)
        status = "ON" if on_off else "OFF"
        return f"IGN2 {status}: {'OK' if res else 'FAIL'}"

    def IGN2_Read(self) -> int:
        """IGN2 상태 읽기."""
        res = self._send([0x24, 0x38])
        return res[-1] if isinstance(res, list) else -1

    def ACC(self, on_off: int = 1) -> str:
        """ACC 제어 (0=OFF, 1=ON). 레거시 WOOHYUN_ACC()."""
        data = [0x24, 0x21, on_off]
        res = self._send(data)
        status = "ON" if on_off else "OFF"
        return f"ACC {status}: {'OK' if res else 'FAIL'}"

    def ACC_Read(self) -> int:
        """ACC 상태 읽기."""
        res = self._send([0x24, 0x31])
        return res[-1] if isinstance(res, list) else -1

    def BATTERY(self, on_off: int = 1) -> str:
        """Battery relay 제어 (0=OFF, 1=ON). 레거시 WOOHYUN_BATTERY()."""
        data = [0x24, 0x23, on_off]
        res = self._send(data)
        status = "ON" if on_off else "OFF"
        return f"BATTERY {status}: {'OK' if res else 'FAIL'}"

    def BATTERY_Read(self) -> int:
        """Battery relay 상태 읽기."""
        res = self._send([0x24, 0x33])
        return res[-1] if isinstance(res, list) else -1

    def BatterySet(self, voltage: float = 14.4) -> str:
        """배터리 전압 설정 (V). 레거시 BATTERY_SET()."""
        data = [0x20, 0x01, int(voltage * 10)]
        res = self._send(data)
        return f"Battery set to {voltage}V: {'OK' if res else 'FAIL'}"

    def BatteryCheck(self) -> float:
        """배터리 전압 읽기 (V). 레거시 BATTERY_CHECK()."""
        res = self._send([0x20, 0x02])
        if isinstance(res, list):
            return float(res[-1]) / 10
        return -1.0

    def AmpereCheck(self) -> float:
        """전류 읽기 (A). 레거시 AMPERE_CHECK()."""
        res = self._send([0x20, 0x03])
        if isinstance(res, list) and len(res) >= 2:
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
