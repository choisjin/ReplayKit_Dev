"""SerialLogging — 시리얼 포트 로그 캡처·저장·키워드 판정 모듈.

시나리오 스텝 내에서:
  - 시리얼 포트에 연결하여 실시간 로그 수신
  - 로그를 파일로 저장 (시작/중단)
  - 키워드 검색으로 PASS/FAIL 판정
  - 스텝 인덱스 구간 지정 검색

사용 예 (시나리오 스텝):
  SerialLogging.StartSave("C:/logs/serial.log")  # 연결 + 캡처 + 파일 저장 시작
  SerialLogging.MarkStep(1)                      # 스텝 1 경계 표시
  ... (다른 스텝들) ...
  SerialLogging.MarkStep(5)                      # 스텝 5 경계 표시
  SerialLogging.SearchAll("BootComplete")        # 전체 로그에서 키워드 판정
  SerialLogging.SearchRange("ERROR", 1, 5)       # 스텝 1~5 구간 키워드 판정
  SerialLogging.StopSave()                       # 파일 저장 중단 + 연결 해제
"""

import logging
import os
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


class SerialLogging:
    """시리얼 로그 캡처·저장·키워드 판정 모듈.

    생성자:
        port: 시리얼 포트 (예: COM3)
        bps: 보드레이트 (기본 115200)
    """

    def __init__(self, port: str = "", bps: int = 115200):
        self._port = port
        self._bps = int(bps)
        self._serial = None  # serial.Serial (lazy import)
        self._capture_thread: Optional[threading.Thread] = None
        self._capturing = False
        self._lock = threading.Lock()

        # 로그 버퍼
        self._logs: list[str] = []
        self._line_counter = 0

        # 파일 저장
        self._save_file = None
        self._save_path: Optional[str] = None

        # 스텝 마킹: {step_index: log_buffer_index}
        self._step_marks: dict[int, int] = {}

    # ------------------------------------------------------------------
    # 연결 관리 (내부)
    # ------------------------------------------------------------------

    def _connect(self) -> str:
        """시리얼 포트 연결."""
        if not self._port:
            return "ERROR: port가 설정되지 않았습니다"
        if self._serial and self._serial.is_open:
            return ""  # 이미 연결됨 — 정상

        try:
            import serial as pyserial
            self._serial = pyserial.Serial(self._port, self._bps, timeout=1)
            self._logs.clear()
            self._line_counter = 0
            self._step_marks.clear()
            self._start_capture()
            logger.info("[SerialLogging] Connected to %s @ %d", self._port, self._bps)
            return ""
        except Exception as e:
            self._serial = None
            logger.error("[SerialLogging] Connection failed: %s", e)
            return f"ERROR: 연결 실패 — {e}"

    def _disconnect(self):
        """시리얼 포트 연결 해제."""
        self._stop_capture()
        if self._serial and self._serial.is_open:
            try:
                self._serial.close()
            except Exception:
                pass
        self._serial = None
        logger.info("[SerialLogging] Disconnected")

    def IsConnected(self) -> bool:
        """연결 상태 확인. StartSave 전에도 모듈은 사용 가능 (지연 연결)."""
        return True

    # ------------------------------------------------------------------
    # 로그 저장 시작/중단 (연결 포함)
    # ------------------------------------------------------------------

    def StartSave(self, save_path: str = "") -> str:
        """시리얼 포트에 연결하고 로그 캡처 + 파일 저장을 시작합니다.

        Args:
            save_path: 저장 파일 경로. 빈 값이면 자동 생성 (backend/logs/serial_YYYYMMDD_HHMMSS.log)

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
            save_path = str(log_dir / f"serial_{ts}.log")
        else:
            os.makedirs(os.path.dirname(save_path) or ".", exist_ok=True)

        try:
            self._save_file = open(save_path, "w", encoding="utf-8")
            self._save_path = save_path
            logger.info("[SerialLogging] Save started: %s", save_path)
            return f"Save started: {save_path}"
        except Exception as e:
            return f"ERROR: 파일 열기 실패 — {e}"

    def StopSave(self) -> str:
        """로그 파일 저장을 중단하고 시리얼 연결을 해제합니다.

        Returns:
            저장된 파일 경로
        """
        if not self._save_file:
            return "저장 중이 아닙니다."

        path = self._save_path
        self._close_save_file()
        self._disconnect()
        logger.info("[SerialLogging] Save stopped + disconnected: %s", path)
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
        logger.info("[SerialLogging] MarkStep %d at log index %d", step_index, pos)
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
            logger.info("[SerialLogging] SearchAll PASS: '%s' → %d건", keyword, len(matches))
            return f"PASS: {len(matches)}건 발견 — {summary}"
        else:
            logger.info("[SerialLogging] SearchAll FAIL: '%s'", keyword)
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
            logger.info("[SerialLogging] SearchRange PASS: '%s' step %d~%d → %d건",
                        keyword, from_step, to_step, len(matches))
            return f"PASS: {len(matches)}건 발견 (step {from_step}~{to_step}) — {summary}"
        else:
            logger.info("[SerialLogging] SearchRange FAIL: '%s' step %d~%d", keyword, from_step, to_step)
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
            return "ERROR: 캡처가 실행 중이 아닙니다. StartSave() 먼저 호출하세요."

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
                    logger.info("[SerialLogging] WaitLog PASS: %s", line)
                    return f"PASS: {line}"

            check_idx = len(logs)
            time.sleep(0.3)

        logger.info("[SerialLogging] WaitLog FAIL: '%s' not found in %ds", keyword, timeout_sec)
        return f"FAIL: keyword '{keyword}' not found within {int(timeout_sec)}s"

    # ------------------------------------------------------------------
    # 명령어 전송
    # ------------------------------------------------------------------

    def SendCommand(self, command: str, encoding: str = "utf-8", append_newline: bool = True) -> str:
        """시리얼 포트로 문자열 명령어를 전송합니다.

        Args:
            command: 전송할 명령어
            encoding: 인코딩 (기본 utf-8)
            append_newline: 개행 문자 자동 추가 (기본 True)

        Returns:
            결과 메시지
        """
        if not self._serial or not self._serial.is_open:
            return "ERROR: 시리얼 포트가 연결되어 있지 않습니다. StartSave() 먼저 호출하세요."
        data = command
        if append_newline and not data.endswith("\n"):
            data += "\n"
        self._serial.write(data.encode(encoding))
        logger.info("[SerialLogging] SendCommand: %s", command.strip())
        return "OK"

    def SendHex(self, hex_string: str) -> str:
        """시리얼 포트로 HEX 바이트를 전송합니다.

        Args:
            hex_string: 전송할 HEX 문자열 (예: 'FF 01 A0')

        Returns:
            결과 메시지
        """
        if not self._serial or not self._serial.is_open:
            return "ERROR: 시리얼 포트가 연결되어 있지 않습니다. StartSave() 먼저 호출하세요."
        raw = bytes.fromhex(hex_string.replace(" ", ""))
        self._serial.write(raw)
        logger.info("[SerialLogging] SendHex: %d bytes", len(raw))
        return f"Sent {len(raw)} bytes"

    def SendAndWait(self, command: str, keyword: str, timeout: int = 10) -> str:
        """명령어를 전송하고 키워드가 포함된 응답을 대기합니다 (블로킹).

        Args:
            command: 전송할 명령어
            keyword: 응답에서 검색할 키워드 (공백 구분 시 AND 조건)
            timeout: 최대 대기 시간 (초, 기본 10)

        Returns:
            "PASS: (매칭된 응답)" 또는 "FAIL: keyword not found within {timeout}s"
        """
        send_result = self.SendCommand(command)
        if send_result != "OK":
            return send_result
        return self.WaitLog(keyword, timeout)

    # ------------------------------------------------------------------
    # 상태 조회
    # ------------------------------------------------------------------

    def GetStatus(self) -> str:
        """현재 모듈 상태를 조회합니다.

        Returns:
            상태 문자열
        """
        connected = self.IsConnected()
        with self._lock:
            log_count = len(self._logs)
        saving = self._save_path or "N/A"
        marks = ", ".join(f"{k}:{v}" for k, v in sorted(self._step_marks.items()))

        parts = [
            f"Port: {self._port} @ {self._bps}",
            f"Connected: {connected}",
            f"Capturing: {self._capturing}",
            f"Logs: {log_count} (total: {self._line_counter})",
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
        self._line_counter = 0
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
            target=self._capture_loop, name="SerialLogging-Capture", daemon=True
        )
        self._capture_thread.start()

    def _stop_capture(self):
        self._capturing = False
        if self._capture_thread:
            self._capture_thread.join(timeout=3)
            self._capture_thread = None

    def _capture_loop(self):
        """백그라운드 스레드: 시리얼 데이터를 줄 단위로 수신."""
        while self._capturing and self._serial and self._serial.is_open:
            try:
                raw = self._serial.readline()
                if not raw:
                    continue
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue

                ts = time.strftime("%H:%M:%S")
                stamped = f"[{ts}] {line}"

                with self._lock:
                    self._logs.append(stamped)
                    self._line_counter += 1

                # 파일 저장 중이면 기록
                if self._save_file:
                    try:
                        self._save_file.write(stamped + "\n")
                        self._save_file.flush()
                    except Exception:
                        pass

            except Exception as e:
                if self._capturing:
                    logger.error("[SerialLogging] Capture error: %s", e)
                break

        self._capturing = False
        logger.info("[SerialLogging] Capture loop ended (logs=%d)", len(self._logs))
