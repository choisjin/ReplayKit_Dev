"""DLTLogging — DLT 데몬 TCP 연결로 로그 캡처·저장·키워드 판정 모듈.

DLT Viewer GUI 없이 시나리오 스텝 내에서:
  - DLT 데몬에 TCP 직접 연결하여 실시간 로그 수신
  - 로그를 파일로 저장 (시작/중단)
  - 키워드 검색으로 PASS/FAIL 판정
  - 스텝 인덱스 구간 지정 검색

사용 예 (시나리오 스텝):
  DLTLogging.StartSave("C:/logs/test.log")      # 연결 + 캡처 + 파일 저장 시작
  DLTLogging.MarkStep(1)                        # 스텝 1 경계 표시
  ... (다른 스텝들) ...
  DLTLogging.MarkStep(5)                        # 스텝 5 경계 표시
  DLTLogging.SearchAll("BootComplete")          # 전체 로그에서 키워드 판정
  DLTLogging.SearchRange("ERROR", 1, 5)         # 스텝 1~5 구간 키워드 판정
  DLTLogging.StopSave()                         # 파일 저장 중단 + 연결 해제
"""

import logging
import os
import socket
import struct
import threading
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def _get_run_output_dir() -> Optional[Path]:
    """현재 재생 런의 출력 디렉토리. 재생 중이 아니면 None."""
    try:
        from backend.app.services.playback_service import get_run_output_dir
        return get_run_output_dir()
    except Exception:
        return None


# DLT 프로토콜 상수
_MSG_TYPE = {0: "LOG", 1: "TRACE", 2: "NW", 3: "CTRL"}
_LOG_LEVEL = {0: "", 1: "FATAL", 2: "ERROR", 3: "WARN", 4: "INFO", 5: "DEBUG", 6: "VERBOSE"}
_TYLE_BYTES = {1: 1, 2: 2, 3: 4, 4: 8, 5: 16}


class DLTLogging:
    """DLT 로그 캡처·저장·키워드 판정 모듈.

    생성자:
        host: DLT 데몬 IP 주소
        port: DLT 데몬 TCP 포트 (기본 3490)
    """

    def __init__(self, host: str = "", port: int = 3490):
        self._host = host
        self._port = int(port)
        self._socket: Optional[socket.socket] = None
        self._capture_thread: Optional[threading.Thread] = None
        self._capturing = False
        self._lock = threading.Lock()
        self._recv_buffer = bytearray()

        # 로그 버퍼 (전체 캡처된 로그)
        self._logs: list[str] = []
        self._msg_counter = 0

        # 파일 저장
        self._save_file = None
        self._save_path: Optional[str] = None

        # 스텝 마킹: {step_index: log_buffer_index}
        self._step_marks: dict[int, int] = {}

    # ------------------------------------------------------------------
    # 연결 관리 (내부)
    # ------------------------------------------------------------------

    def _connect(self) -> str:
        """DLT 데몬에 TCP 연결 후 로그 캡처를 시작."""
        if not self._host:
            return "ERROR: host가 설정되지 않았습니다"
        if self._socket:
            return ""  # 이미 연결됨 — 정상

        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5)
            sock.connect((self._host, self._port))
            sock.settimeout(1)
            self._socket = sock
            self._recv_buffer.clear()
            self._logs.clear()
            self._msg_counter = 0
            self._step_marks.clear()
            self._start_capture()
            logger.info("[DLTLogging] Connected to %s:%d", self._host, self._port)
            return ""
        except Exception as e:
            self._socket = None
            logger.error("[DLTLogging] Connection failed: %s", e)
            return f"ERROR: 연결 실패 — {e}"

    def _disconnect(self):
        """DLT 데몬 연결 해제."""
        self._stop_capture()
        if self._socket:
            try:
                self._socket.close()
            except Exception:
                pass
            self._socket = None
        logger.info("[DLTLogging] Disconnected")

    def IsConnected(self) -> bool:
        """연결 상태 확인. StartSave 전에도 모듈은 사용 가능 (지연 연결)."""
        return True

    # ------------------------------------------------------------------
    # 로그 저장 시작/중단 (연결 포함)
    # ------------------------------------------------------------------

    def StartSave(self, save_path: str = "") -> str:
        """DLT 데몬에 연결하고 로그 캡처 + 파일 저장을 시작합니다.

        Args:
            save_path: 저장 파일 경로. 빈 값이면 자동 생성 (backend/logs/dlt_YYYYMMDD_HHMMSS.log)

        Returns:
            결과 메시지
        """
        if self._save_file:
            return f"ERROR: 이미 저장 중입니다 ({self._save_path}). StopSave() 먼저 호출하세요."

        # 연결이 안 되어 있으면 자동 연결
        err = self._connect()
        if err:
            return err

        if not save_path:
            # 재생 중이면 런 폴더의 logs/ 하위에 저장
            run_dir = _get_run_output_dir()
            if run_dir:
                log_dir = run_dir / "logs"
            else:
                log_dir = Path(__file__).resolve().parent.parent.parent / "logs"
            log_dir.mkdir(exist_ok=True)
            ts = time.strftime("%Y%m%d_%H%M%S")
            save_path = str(log_dir / f"dlt_{ts}.log")
        else:
            os.makedirs(os.path.dirname(save_path) or ".", exist_ok=True)

        try:
            self._save_file = open(save_path, "w", encoding="utf-8")
            self._save_path = save_path
            logger.info("[DLTLogging] Save started: %s", save_path)
            return f"Save started: {save_path}"
        except Exception as e:
            return f"ERROR: 파일 열기 실패 — {e}"

    def StopSave(self) -> str:
        """로그 파일 저장을 중단하고 DLT 연결을 해제합니다.

        Returns:
            저장된 파일 경로
        """
        if not self._save_file:
            return "저장 중이 아닙니다."

        path = self._save_path
        self._close_save_file()
        self._disconnect()
        logger.info("[DLTLogging] Save stopped + disconnected: %s", path)
        return f"Save stopped: {path}"

    def _close_save_file(self):
        if self._save_file:
            try:
                self._save_file.close()
            except Exception:
                pass
            self._save_file = None
            self._save_path = None

    # ------------------------------------------------------------------
    # 스텝 마킹
    # ------------------------------------------------------------------

    def MarkStep(self, step_index: int) -> str:
        """현재 로그 버퍼 위치에 스텝 경계를 표시합니다.

        SearchRange에서 구간 검색할 때 사용됩니다.

        Args:
            step_index: 스텝 인덱스 번호

        Returns:
            결과 메시지
        """
        with self._lock:
            pos = len(self._logs)
        self._step_marks[int(step_index)] = pos
        logger.info("[DLTLogging] MarkStep %d at log index %d", step_index, pos)
        return f"Step {step_index} marked at log index {pos}"

    # ------------------------------------------------------------------
    # 키워드 검색 — PASS/FAIL 판정
    # ------------------------------------------------------------------

    def SearchAll(self, keyword: str, count: int = 5) -> str:
        """전체 로그에서 키워드를 검색하여 PASS/FAIL 판정합니다.

        처음부터 현재까지 캡처된 모든 로그를 대상으로 검색합니다.

        Args:
            keyword: 검색 키워드 (공백 구분 시 AND 조건)
            count: 최대 매칭 결과 수 (기본 5)

        Returns:
            "PASS: N건 발견 — (첫 매칭 로그)" 또는 "FAIL: keyword not found"
        """
        keywords = keyword.split()
        with self._lock:
            logs = list(self._logs)

        matches = []
        for line in logs:
            if all(k in line for k in keywords):
                matches.append(line.strip())
                if len(matches) >= int(count):
                    break

        if matches:
            summary = matches[0][:120]
            logger.info("[DLTLogging] SearchAll PASS: '%s' → %d건", keyword, len(matches))
            return f"PASS: {len(matches)}건 발견 — {summary}"
        else:
            logger.info("[DLTLogging] SearchAll FAIL: '%s'", keyword)
            return f"FAIL: keyword '{keyword}' not found"

    def SearchRange(self, keyword: str, from_step: int, to_step: int, count: int = 5) -> str:
        """스텝 구간 내 로그에서 키워드를 검색하여 PASS/FAIL 판정합니다.

        MarkStep으로 표시된 구간만 대상으로 검색합니다.

        Args:
            keyword: 검색 키워드 (공백 구분 시 AND 조건)
            from_step: 시작 스텝 인덱스 (이 스텝 이후 로그부터)
            to_step: 종료 스텝 인덱스 (이 스텝까지의 로그)
            count: 최대 매칭 결과 수 (기본 5)

        Returns:
            "PASS: N건 발견 — (첫 매칭 로그)" 또는 "FAIL: keyword not found in step range"
        """
        from_step = int(from_step)
        to_step = int(to_step)

        if from_step not in self._step_marks:
            return f"ERROR: step {from_step}이 마킹되지 않았습니다. MarkStep({from_step})을 먼저 호출하세요."
        if to_step not in self._step_marks:
            # to_step이 마킹 안 되었으면 현재 끝까지
            with self._lock:
                end_idx = len(self._logs)
        else:
            end_idx = self._step_marks[to_step]

        start_idx = self._step_marks[from_step]
        keywords = keyword.split()

        with self._lock:
            logs_slice = self._logs[start_idx:end_idx]

        matches = []
        for line in logs_slice:
            if all(k in line for k in keywords):
                matches.append(line.strip())
                if len(matches) >= int(count):
                    break

        if matches:
            summary = matches[0][:120]
            logger.info("[DLTLogging] SearchRange PASS: '%s' step %d~%d → %d건",
                        keyword, from_step, to_step, len(matches))
            return f"PASS: {len(matches)}건 발견 (step {from_step}~{to_step}) — {summary}"
        else:
            logger.info("[DLTLogging] SearchRange FAIL: '%s' step %d~%d", keyword, from_step, to_step)
            return f"FAIL: keyword '{keyword}' not found in step {from_step}~{to_step}"

    def WaitLog(self, keyword: str, timeout: int = 30) -> str:
        """키워드가 포함된 로그가 나타날 때까지 대기합니다 (블로킹).

        Args:
            keyword: 검색 키워드 (공백 구분 시 AND 조건)
            timeout: 최대 대기 시간 (초, 기본 30)

        Returns:
            "PASS: (매칭된 로그)" 또는 "FAIL: keyword not found within {timeout}s"
        """
        if not self._capturing:
            return "ERROR: 캡처가 실행 중이 아닙니다. Connect() 먼저 호출하세요."

        keywords = keyword.split()
        timeout_sec = float(timeout)
        start = time.time()
        check_idx = 0

        while time.time() - start < timeout_sec:
            with self._lock:
                logs = list(self._logs)

            for i in range(check_idx, len(logs)):
                if all(k in logs[i] for k in keywords):
                    line = logs[i].strip()
                    logger.info("[DLTLogging] WaitLog PASS: %s", line)
                    return f"PASS: {line}"

            check_idx = len(logs)
            time.sleep(0.3)

        logger.info("[DLTLogging] WaitLog FAIL: '%s' not found in %ds", keyword, timeout_sec)
        return f"FAIL: keyword '{keyword}' not found within {int(timeout_sec)}s"

    def ExpectFound(self, keyword: str, timeout: int = 60, max_retries: int = 5) -> str:
        """키워드가 나타날 때까지 전체 로그를 주기적으로 검색합니다.

        먼저 현재 버퍼를 즉시 검색하고, 없으면 (timeout / max_retries) 간격으로
        최대 max_retries회 재시도합니다.

        Args:
            keyword: 검색 키워드 (공백 구분 시 AND 조건)
            timeout: 총 대기 시간 (초, 기본 60)
            max_retries: 최대 재시도 횟수 (기본 5)

        Returns:
            "PASS: 발견 (N회차) — (매칭 로그)" 또는 "FAIL: keyword not found after N retries"
        """
        keywords = keyword.split()
        timeout_sec = float(timeout)
        max_retries = max(1, int(max_retries))
        interval = timeout_sec / max_retries

        for attempt in range(1, max_retries + 1):
            with self._lock:
                logs = list(self._logs)

            for line in logs:
                if all(k in line for k in keywords):
                    summary = line.strip()[:120]
                    logger.info("[DLTLogging] ExpectFound PASS: '%s' → attempt %d/%d — %s",
                                keyword, attempt, max_retries, summary)
                    return f"PASS: 발견 ({attempt}회차) — {summary}"

            if attempt < max_retries:
                logger.info("[DLTLogging] ExpectFound: '%s' not found, retry %d/%d (next in %.1fs)",
                            keyword, attempt, max_retries, interval)
                time.sleep(interval)

        logger.info("[DLTLogging] ExpectFound FAIL: '%s' not found after %d retries (%.0fs)",
                    keyword, max_retries, timeout_sec)
        return f"FAIL: keyword '{keyword}' not found after {max_retries} retries ({int(timeout_sec)}s)"

    def ExpectNotFound(self, keyword: str, timeout: int = 60, max_retries: int = 5) -> str:
        """키워드가 끝까지 없는지 전체 로그를 주기적으로 확인합니다.

        먼저 현재 버퍼를 즉시 검색하고, 발견되면 즉시 FAIL.
        없으면 (timeout / max_retries) 간격으로 최대 max_retries회 재확인합니다.
        끝까지 없으면 PASS.

        Args:
            keyword: 검색 키워드 (공백 구분 시 AND 조건)
            timeout: 총 확인 시간 (초, 기본 60)
            max_retries: 최대 확인 횟수 (기본 5)

        Returns:
            "PASS: keyword not found after N checks" 또는 "FAIL: 발견 (N회차) — (매칭 로그)"
        """
        keywords = keyword.split()
        timeout_sec = float(timeout)
        max_retries = max(1, int(max_retries))
        interval = timeout_sec / max_retries

        for attempt in range(1, max_retries + 1):
            with self._lock:
                logs = list(self._logs)

            for line in logs:
                if all(k in line for k in keywords):
                    summary = line.strip()[:120]
                    logger.info("[DLTLogging] ExpectNotFound FAIL: '%s' → found at attempt %d/%d — %s",
                                keyword, attempt, max_retries, summary)
                    return f"FAIL: 발견 ({attempt}회차) — {summary}"

            if attempt < max_retries:
                logger.info("[DLTLogging] ExpectNotFound: '%s' absent, check %d/%d (next in %.1fs)",
                            keyword, attempt, max_retries, interval)
                time.sleep(interval)

        logger.info("[DLTLogging] ExpectNotFound PASS: '%s' not found after %d checks (%.0fs)",
                    keyword, max_retries, timeout_sec)
        return f"PASS: keyword '{keyword}' not found after {max_retries} checks ({int(timeout_sec)}s)"

    # ------------------------------------------------------------------
    # 상태 조회
    # ------------------------------------------------------------------

    def GetStatus(self) -> str:
        """현재 모듈 상태를 조회합니다.

        Returns:
            상태 문자열
        """
        connected = self._socket is not None
        with self._lock:
            log_count = len(self._logs)
        saving = self._save_path or "N/A"
        marks = ", ".join(f"{k}:{v}" for k, v in sorted(self._step_marks.items()))

        parts = [
            f"Host: {self._host}:{self._port}",
            f"Connected: {connected}",
            f"Capturing: {self._capturing}",
            f"Logs: {log_count} (total: {self._msg_counter})",
            f"Saving: {saving}",
            f"StepMarks: {marks or 'none'}",
        ]
        return " | ".join(parts)

    def ClearLogs(self) -> str:
        """로그 버퍼와 스텝 마킹을 초기화합니다.

        Returns:
            결과 메시지
        """
        with self._lock:
            self._logs.clear()
        self._msg_counter = 0
        self._step_marks.clear()
        return "Logs and step marks cleared"

    # ------------------------------------------------------------------
    # 로그 캡처 (백그라운드 스레드)
    # ------------------------------------------------------------------

    def _start_capture(self):
        if self._capturing:
            return
        self._capturing = True
        self._capture_thread = threading.Thread(
            target=self._capture_loop, name="DLTLogging-Capture", daemon=True
        )
        self._capture_thread.start()

    def _stop_capture(self):
        self._capturing = False
        if self._capture_thread:
            self._capture_thread.join(timeout=3)
            self._capture_thread = None

    def _capture_loop(self):
        """백그라운드 스레드: DLT 메시지 수신 및 파싱."""
        while self._capturing and self._socket:
            try:
                data = self._socket.recv(65536)
                if not data:
                    logger.warning("[DLTLogging] Connection closed by remote")
                    break
                self._recv_buffer.extend(data)
                self._process_buffer()
            except socket.timeout:
                continue
            except OSError:
                break
            except Exception as e:
                logger.error("[DLTLogging] Capture error: %s", e)
                break

        self._capturing = False
        logger.info("[DLTLogging] Capture loop ended (logs=%d)", len(self._logs))

    def _process_buffer(self):
        """수신 버퍼에서 완전한 DLT 메시지를 파싱."""
        while len(self._recv_buffer) >= 4:
            htyp = self._recv_buffer[0]
            version = (htyp >> 5) & 0x07

            if version != 1:
                del self._recv_buffer[0]
                continue

            msg_len = struct.unpack(">H", self._recv_buffer[2:4])[0]
            if msg_len < 4 or msg_len > 65535:
                del self._recv_buffer[0]
                continue

            if len(self._recv_buffer) < msg_len:
                break

            msg_data = bytes(self._recv_buffer[:msg_len])
            del self._recv_buffer[:msg_len]

            line = self._parse_message(msg_data)
            if line:
                with self._lock:
                    self._logs.append(line)
                    self._msg_counter += 1

                # 파일 저장 중이면 기록
                if self._save_file:
                    try:
                        self._save_file.write(line + "\n")
                        self._save_file.flush()
                    except Exception:
                        pass

    # ------------------------------------------------------------------
    # DLT 메시지 파싱 (DLTViewer와 동일 로직)
    # ------------------------------------------------------------------

    def _parse_message(self, data: bytes) -> Optional[str]:
        """DLT 메시지 1개를 파싱하여 텍스트 한 줄로 변환."""
        if len(data) < 4:
            return None

        htyp = data[0]
        msg_len = struct.unpack(">H", data[2:4])[0]
        pos = 4

        ecu_id = ""
        timestamp = 0

        if htyp & 0x04:  # WEID
            if pos + 4 > msg_len:
                return None
            ecu_id = data[pos:pos + 4].decode("ascii", errors="replace").rstrip("\x00")
            pos += 4

        if htyp & 0x08:  # WSID
            pos += 4

        if htyp & 0x10:  # WTMS
            if pos + 4 <= msg_len:
                timestamp = struct.unpack(">I", data[pos:pos + 4])[0]
            pos += 4

        apid = ""
        ctid = ""
        msg_type_str = ""
        verbose = False
        noar = 0

        if htyp & 0x01:  # UEH
            if pos + 10 > msg_len:
                return None
            msin = data[pos]
            noar = data[pos + 1]
            apid = data[pos + 2:pos + 6].decode("ascii", errors="replace").rstrip("\x00")
            ctid = data[pos + 6:pos + 10].decode("ascii", errors="replace").rstrip("\x00")
            pos += 10

            verbose = bool(msin & 0x01)
            mtype = (msin >> 1) & 0x07
            msub = (msin >> 4) & 0x0F

            mtype_name = _MSG_TYPE.get(mtype, str(mtype))
            if mtype == 0:
                msub_name = _LOG_LEVEL.get(msub, str(msub))
            else:
                msub_name = str(msub)
            msg_type_str = f"{mtype_name} {msub_name}".strip()

        payload_data = data[pos:msg_len]
        payload_text = ""

        if verbose and noar > 0 and len(payload_data) > 0:
            payload_text = self._parse_verbose_payload(payload_data, noar)
        elif len(payload_data) > 0:
            payload_text = self._extract_printable(payload_data)

        if not payload_text.strip():
            return None

        ts_sec = timestamp / 10000.0
        ts_str = f"{ts_sec:>12.4f}"

        return f"{ts_str} {ecu_id:<4s} {apid:<4s} {ctid:<4s} {msg_type_str:<12s} {payload_text}"

    def _parse_verbose_payload(self, data: bytes, noar: int) -> str:
        """Verbose 모드 DLT payload 파싱."""
        parts = []
        pos = 0

        for _ in range(noar):
            if pos + 4 > len(data):
                break

            type_info = struct.unpack("<I", data[pos:pos + 4])[0]
            pos += 4

            tyle = type_info & 0x0F
            is_bool = bool(type_info & 0x10)
            is_sint = bool(type_info & 0x20)
            is_uint = bool(type_info & 0x40)
            is_float = bool(type_info & 0x80)
            is_string = bool(type_info & 0x200)
            is_raw = bool(type_info & 0x400)
            has_vari = bool(type_info & 0x800)

            if has_vari:
                if pos + 2 > len(data):
                    break
                name_len = struct.unpack("<H", data[pos:pos + 2])[0]
                pos += 2
                if pos + name_len > len(data):
                    break
                pos += name_len

            if is_string:
                if pos + 2 > len(data):
                    break
                str_len = struct.unpack("<H", data[pos:pos + 2])[0]
                pos += 2
                if pos + str_len > len(data):
                    break
                s = data[pos:pos + str_len].decode("utf-8", errors="replace").rstrip("\x00")
                parts.append(s)
                pos += str_len
            elif is_raw:
                if pos + 2 > len(data):
                    break
                raw_len = struct.unpack("<H", data[pos:pos + 2])[0]
                pos += 2
                if pos + raw_len > len(data):
                    break
                parts.append(data[pos:pos + raw_len].hex())
                pos += raw_len
            elif is_bool:
                byte_len = _TYLE_BYTES.get(tyle, 1)
                if pos + byte_len > len(data):
                    break
                parts.append(str(bool(data[pos])))
                pos += byte_len
            elif is_uint:
                byte_len = _TYLE_BYTES.get(tyle, 4)
                if pos + byte_len > len(data):
                    break
                val = int.from_bytes(data[pos:pos + byte_len], "little", signed=False)
                parts.append(str(val))
                pos += byte_len
            elif is_sint:
                byte_len = _TYLE_BYTES.get(tyle, 4)
                if pos + byte_len > len(data):
                    break
                val = int.from_bytes(data[pos:pos + byte_len], "little", signed=True)
                parts.append(str(val))
                pos += byte_len
            elif is_float:
                byte_len = 4 if tyle <= 3 else 8
                if pos + byte_len > len(data):
                    break
                if byte_len == 4:
                    val = struct.unpack("<f", data[pos:pos + byte_len])[0]
                else:
                    val = struct.unpack("<d", data[pos:pos + byte_len])[0]
                parts.append(f"{val:.6f}")
                pos += byte_len
            else:
                parts.append(self._extract_printable(data[pos:]))
                break

        return " ".join(parts)

    @staticmethod
    def _extract_printable(data: bytes) -> str:
        """바이트에서 출력 가능한 텍스트 추출."""
        text = data.decode("utf-8", errors="replace")
        return "".join(c if c.isprintable() or c in "\n\t " else "" for c in text).strip()
