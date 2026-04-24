# -*- coding: utf-8 -*-
"""CCIC 우현벤치 UDP control plugin — 전원(IGN/ACC/BATTERY) + CAN FD 송신 통합.

UDP 패킷 형식: [0x55, 0xAA, sender(100), seq(0), cmd1, cmd2, len_hi, len_lo, ...data]
Reference: WoohyunBench_LIBRARY.py, CCIC_DEFINITION_LIBRARY.py (legacy)

벤치 기본값: BENCH_IP = 192.168.1.101, BENCH_PORT = 25000

CAN FD 기능은 공용 UDP_CANFD 라이브러리(backend/app/lib/UDP_CANFD.py)를 composition
방식으로 내부 보관하며, 단일 UDP 소켓을 공유해 동작한다(원본 라이브러리는 수정하지 않음).
신호 정의 파일(signal_file, 선택)이 주어지면 Connect 시 자동 로드된다.
"""

from __future__ import annotations

import socket
import logging
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

START_1 = 0x55
START_2 = 0xAA
SENDER_ID = 100
DEFAULT_UDP_PORT = 25000


class WoohyunBench:
    """CCIC 우현벤치 UDP 제어 플러그인 (전원 + CAN FD)."""

    def __init__(self, host: str = "", udp_port: int = DEFAULT_UDP_PORT, signal_file: str = ""):
        self._host = host
        self._udp_port = int(udp_port) if udp_port else DEFAULT_UDP_PORT
        self._signal_file = (signal_file or "").strip()
        self._sock = None
        # CAN FD 위임 객체. Connect 시 생성 + 이 플러그인의 _sock을 공유 바인딩.
        self._canfd = None

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def Connect(self) -> str:
        """UDP 소켓 연결 + (signal_file 지정 시) CAN FD 서브시스템 초기화."""
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

        # CAN FD 서브시스템 (공용 UDP_CANFD와 소켓 공유)
        # 임포트 실패(pandas/robotframework 미설치)해도 전원 제어는 정상 동작하도록 경고만.
        try:
            from ..lib.UDP_CANFD import UDP_CANFD
        except Exception as e:
            logger.warning("WoohyunBench: UDP_CANFD 라이브러리 로드 실패 — CAN FD 기능 비활성 (%s)", e)
            self._canfd = None
        else:
            cf = UDP_CANFD()
            cf.sock = self._sock          # 동일 소켓 공유 (별도 자원 없음)
            cf.udp_ip = self._host
            cf.udp_port = self._udp_port
            self._canfd = cf
            # signal_file 주어졌다면 신호 정의 로드 + CAN FD 버스 INIT 패킷
            if self._signal_file:
                try:
                    self._load_signals_into(cf, self._signal_file)
                    cf.UDP_CANFD_INIT_MESSAGE()
                    logger.info("WoohyunBench CAN FD ready (signals=%d from %s)",
                                len(cf.signal_defs), self._signal_file)
                except Exception as e:
                    logger.warning("WoohyunBench CAN FD 사전 로드 실패 (비치명): %s", e)

        return f"Connected to {self._host}:{self._udp_port}"

    def Disconnect(self) -> str:
        """UDP 소켓 해제. CAN FD 서브시스템도 함께 정리."""
        # UDP_CANFD.UDP_DEINIT()가 내부적으로 sock.close() 후 None 처리. 소켓이 공유이므로
        # 이 경로로 닫으면 self._sock도 같은 객체가 닫힌 상태가 된다.
        if self._canfd is not None:
            try:
                self._canfd.UDP_DEINIT()
            except Exception:
                pass
            self._canfd = None
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None
        return "Disconnected"

    def IsConnected(self) -> bool:
        """연결 상태 확인."""
        return self._sock is not None

    # ------------------------------------------------------------------
    # CAN FD — 공용 UDP_CANFD 라이브러리 위임
    # ------------------------------------------------------------------

    @staticmethod
    def _load_signals_into(canfd_impl, file_path: str) -> None:
        """파일 확장자에 따라 UDP_CANFD에 신호 정의를 로드."""
        p = Path(file_path)
        if not p.is_file():
            raise FileNotFoundError(f"signal file not found: {file_path}")
        if file_path.lower().endswith('.can'):
            canfd_impl.load_signal_definitions_from_xml(file_path)
        else:
            canfd_impl.load_signal_definitions_from_excel(file_path)

    def LoadSignals(self, file_path: str) -> str:
        """런타임에 CAN FD 신호 정의를 Excel/XML에서 다시 로드."""
        if self._canfd is None:
            return "FAIL: CAN FD 비활성 (UDP_CANFD 라이브러리 미설치 또는 연결 전)"
        try:
            self._load_signals_into(self._canfd, file_path)
            try:
                self._canfd.UDP_CANFD_INIT_MESSAGE()
            except Exception as e:
                logger.warning("WoohyunBench CAN FD INIT 재전송 실패: %s", e)
            return f"OK: {len(self._canfd.signal_defs)} signals loaded from {file_path}"
        except Exception as e:
            logger.error("WoohyunBench LoadSignals failed: %s", e)
            return f"FAIL: LoadSignals: {e}"

    def SendSignal(self, signal_name: str, physical_value) -> str:
        """이름으로 지정한 CAN 신호를 physical_value로 전송 (200ms × 5회 반복)."""
        if self._canfd is None:
            return "FAIL: CAN FD 비활성"
        if not self._canfd.signal_defs:
            return "FAIL: 신호 정의 미로드 — signal_file 설정 또는 LoadSignals 호출 필요"
        ok = self._canfd.SEND_CANEthernetData(signal_name, physical_value)
        return f"{'OK' if ok else 'FAIL'}: SendSignal {signal_name}={physical_value}"

    def DoorTest(self) -> str:
        """운전석 도어 스위치 신호(Warn_DrvDrSwSta)를 ON/OFF 반복 송신."""
        if self._canfd is None:
            return "FAIL: CAN FD 비활성"
        ok = self._canfd.door_test()
        return f"{'OK' if ok else 'FAIL'}: DoorTest"

    def TestAllSignals(self) -> str:
        """로드된 모든 신호를 중간값으로 순차 송신 (부하/연결 확인용)."""
        if self._canfd is None:
            return "FAIL: CAN FD 비활성"
        ok = self._canfd.test_all_canfd_signals()
        return f"{'OK' if ok else 'FAIL'}: TestAllSignals"

    def CheckSignals(self) -> str:
        """로드된 CAN 신호 정의를 로그로 덤프."""
        if self._canfd is None:
            return "FAIL: CAN FD 비활성"
        self._canfd.CHECK_CAN_SIGNAL()
        return f"OK: {len(self._canfd.signal_defs)} signals"

    def SendCanFd(self, can_id: int, payload_hex: str = "") -> str:
        """Raw CAN FD 프레임 직접 송신 (신호 정의 불필요)."""
        if self._canfd is None:
            return "FAIL: CAN FD 비활성"
        try:
            cleaned = (payload_hex or "").replace(" ", "").replace(",", "")
            payload = bytearray.fromhex(cleaned) if cleaned else bytearray()
            self._canfd.UDP_CANFD_SEND(int(can_id), payload)
            return f"OK: SendCanFd ID=0x{int(can_id):X} ({len(payload)}B)"
        except Exception as e:
            logger.error("WoohyunBench SendCanFd failed: %s", e)
            return f"FAIL: SendCanFd: {e}"

    def ReinitCanFd(self, baudrate: int = 0x1F4, databit_time: int = 0x7D0) -> str:
        """CAN FD 버스 재초기화 (기본 500k/2M)."""
        if self._canfd is None:
            return "FAIL: CAN FD 비활성"
        try:
            self._canfd.UDP_CANFD_INIT_MESSAGE(int(baudrate), int(databit_time))
            return f"OK: ReinitCanFd baudrate=0x{int(baudrate):X} databit=0x{int(databit_time):X}"
        except Exception as e:
            logger.error("WoohyunBench ReinitCanFd failed: %s", e)
            return f"FAIL: ReinitCanFd: {e}"

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
        """연결 정보 (host/port + CAN FD 신호 수 포함)."""
        sig_count = len(self._canfd.signal_defs) if self._canfd is not None else 0
        return (f"host={self._host}, port={self._udp_port}, "
                f"signal_file={self._signal_file}, signals={sig_count}, "
                f"canfd={'on' if self._canfd is not None else 'off'}, "
                f"connected={self.IsConnected()}")
