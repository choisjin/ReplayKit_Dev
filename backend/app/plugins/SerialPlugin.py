"""Generic serial communication plugin.

Provides basic serial port operations (send, read, send+read)
without depending on lge.auto.

NOTE: ``import serial`` is deferred to Connect() so that the plugin
can be *discovered* (listed in the module dropdown) even on machines
where pyserial is not installed.
"""

from __future__ import annotations

import time
import threading


class SerialPlugin:
    """Generic serial communication plugin."""

    def __init__(self, port: str = "", bps: int = 115200):
        self.port = port
        self.bps = bps
        self._serial = None  # serial.Serial instance (lazy import)

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def Connect(self) -> str:
        """Open the serial port."""
        if self._serial and self._serial.is_open:
            return "Already connected"
        import serial
        self._serial = serial.Serial(self.port, self.bps, timeout=1)
        return f"Connected to {self.port} @ {self.bps}"

    def Disconnect(self) -> str:
        """Close the serial port."""
        if self._serial and self._serial.is_open:
            self._serial.close()
        self._serial = None
        return "Disconnected"

    def IsConnected(self) -> bool:
        """Check if the serial port is open."""
        return self._serial is not None and self._serial.is_open

    # ------------------------------------------------------------------
    # I/O
    # ------------------------------------------------------------------

    def SendCommand(self, command: str, encoding: str = "utf-8",
                    append_newline: bool = True) -> str:
        """Send a string command to the serial port."""
        if not self._serial or not self._serial.is_open:
            raise RuntimeError("Serial port not connected")
        data = command
        if append_newline and not data.endswith("\n"):
            data += "\n"
        self._serial.write(data.encode(encoding))
        return "OK"

    def ReadLine(self, timeout: float = 1.0) -> str:
        """Read one line from the serial port."""
        if not self._serial or not self._serial.is_open:
            raise RuntimeError("Serial port not connected")
        self._serial.timeout = timeout
        return self._serial.readline().decode("utf-8", errors="replace").strip()

    def ReadAll(self, timeout: float = 1.0) -> str:
        """Read all available data from the serial port."""
        if not self._serial or not self._serial.is_open:
            raise RuntimeError("Serial port not connected")
        self._serial.timeout = timeout
        data = self._serial.read(self._serial.in_waiting or 1)
        return data.decode("utf-8", errors="replace")

    def SendAndRead(self, command: str, timeout: float = 1.0,
                    encoding: str = "utf-8") -> str:
        """Send a command and read the response line."""
        self.SendCommand(command, encoding)
        return self.ReadLine(timeout)

    def SendHex(self, hex_string: str) -> str:
        """Send raw hex bytes (e.g. 'FF 01 A0')."""
        if not self._serial or not self._serial.is_open:
            raise RuntimeError("Serial port not connected")
        raw = bytes.fromhex(hex_string.replace(" ", ""))
        self._serial.write(raw)
        return f"Sent {len(raw)} bytes"

    def ReadHex(self, count: int = 1, timeout: float = 1.0) -> str:
        """Read N bytes and return as hex string."""
        if not self._serial or not self._serial.is_open:
            raise RuntimeError("Serial port not connected")
        self._serial.timeout = timeout
        data = self._serial.read(count)
        return data.hex(" ").upper()

    # ------------------------------------------------------------------
    # Log monitoring
    # ------------------------------------------------------------------

    def LOG_SERIAL(self, keyword: str, timeout: int = 30) -> str:
        """시리얼 수신 데이터에서 키워드가 나타날 때까지 대기 (블로킹).

        timeout 동안 수신되는 모든 라인을 저장하고,
        키워드가 포함된 라인이 나오면 즉시 PASS를 반환합니다.
        여러 키워드를 공백으로 구분하면 AND 조건입니다.

        Args:
            keyword: 검색할 키워드 (공백 구분 시 AND 조건)
            timeout: 최대 대기 시간 (초, 기본 30)

        Returns:
            "PASS: <매칭된 라인>" 또는 "FAIL: keyword not found within {timeout}s"
            로그 전체는 [LOG] 접두사로 함께 출력됩니다.
        """
        if not self._serial or not self._serial.is_open:
            raise RuntimeError("Serial port not connected")

        keywords = keyword.split()
        timeout_sec = float(timeout)
        start = time.time()
        collected_lines = []
        original_timeout = self._serial.timeout

        self._serial.timeout = 0.5  # 0.5초 단위로 읽기

        try:
            while time.time() - start < timeout_sec:
                try:
                    line = self._serial.readline().decode("utf-8", errors="replace").strip()
                except Exception:
                    continue
                if not line:
                    continue
                collected_lines.append(line)
                if all(k in line for k in keywords):
                    log_text = "\n".join(f"[LOG] {l}" for l in collected_lines)
                    return f"PASS: {line}\n{log_text}"
        finally:
            self._serial.timeout = original_timeout

        log_text = "\n".join(f"[LOG] {l}" for l in collected_lines)
        return f"FAIL: keyword '{keyword}' not found within {int(timeout_sec)}s\n{log_text}"

    def StartMonitor(self, keyword: str, timeout: int = 60) -> str:
        """백그라운드에서 시리얼 키워드를 감시합니다 (논블로킹).

        다음 스텝으로 즉시 넘어가며, 결과는 GetMonitorResult로 확인합니다.

        Args:
            keyword: 검색할 키워드 (공백 구분 시 AND 조건)
            timeout: 최대 감시 시간 (초, 기본 60)

        Returns:
            모니터 ID (예: "mon_1")
        """
        if not self._serial or not self._serial.is_open:
            raise RuntimeError("Serial port not connected")

        if not hasattr(self, '_monitors'):
            self._monitors = {}
            self._monitor_counter = 0

        self._monitor_counter += 1
        mon_id = f"mon_{self._monitor_counter}"

        monitor = {
            "keyword": keyword,
            "start": time.time(),
            "timeout": float(timeout),
            "result": None,
            "matched_line": "",
            "lines": [],
        }
        self._monitors[mon_id] = monitor

        def _watch():
            keywords = keyword.split()
            timeout_sec = float(timeout)
            start = time.time()
            saved_timeout = self._serial.timeout if self._serial else 1.0

            try:
                if self._serial:
                    self._serial.timeout = 0.5
                while time.time() - start < timeout_sec:
                    if mon_id not in self._monitors:
                        return
                    if not self._serial or not self._serial.is_open:
                        monitor["result"] = "FAIL"
                        return
                    try:
                        line = self._serial.readline().decode("utf-8", errors="replace").strip()
                    except Exception:
                        continue
                    if not line:
                        continue
                    monitor["lines"].append(line)
                    if all(k in line for k in keywords):
                        monitor["result"] = "PASS"
                        monitor["matched_line"] = line
                        return
                monitor["result"] = "FAIL"
            finally:
                if self._serial and self._serial.is_open:
                    try:
                        self._serial.timeout = saved_timeout
                    except Exception:
                        pass

        t = threading.Thread(target=_watch, name=f"Serial-Monitor-{mon_id}", daemon=True)
        t.start()
        return mon_id

    def StopMonitor(self, monitor_id: str = "") -> str:
        """백그라운드 모니터링을 중지합니다.

        Args:
            monitor_id: 중지할 모니터 ID. 비워두면 전체 중지

        Returns:
            결과 메시지
        """
        if not hasattr(self, '_monitors'):
            return "(no monitors)"
        if not monitor_id:
            count = len(self._monitors)
            self._monitors.clear()
            return f"All monitors stopped ({count})"
        mon = self._monitors.pop(monitor_id, None)
        if not mon:
            return f"Monitor '{monitor_id}' not found"
        return f"Monitor '{monitor_id}' stopped"

    def GetMonitorResult(self, monitor_id: str = "") -> str:
        """백그라운드 모니터링 결과를 확인합니다.

        Args:
            monitor_id: 확인할 모니터 ID. 비워두면 전체 결과

        Returns:
            PASS/FAIL/RUNNING 상태와 수집된 로그
        """
        if not hasattr(self, '_monitors'):
            return "(no monitors)"

        if monitor_id:
            mon = self._monitors.get(monitor_id)
            if not mon:
                return f"Monitor '{monitor_id}' not found"
            log_text = "\n".join(f"[LOG] {l}" for l in mon["lines"])
            if mon["result"] is None:
                elapsed = int(time.time() - mon["start"])
                return f"RUNNING: '{mon['keyword']}' ({elapsed}s / {int(mon['timeout'])}s)\n{log_text}"
            elif mon["result"] == "PASS":
                return f"PASS: {mon['matched_line']}\n{log_text}"
            else:
                return f"FAIL: keyword '{mon['keyword']}' not found within {int(mon['timeout'])}s\n{log_text}"

        if not self._monitors:
            return "(no monitors)"

        lines = []
        for mid, mon in self._monitors.items():
            if mon["result"] is None:
                elapsed = int(time.time() - mon["start"])
                lines.append(f"{mid}: RUNNING '{mon['keyword']}' ({elapsed}s)")
            elif mon["result"] == "PASS":
                lines.append(f"{mid}: PASS {mon['matched_line'][:60]}")
            else:
                lines.append(f"{mid}: FAIL '{mon['keyword']}'")
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Configuration
    # ------------------------------------------------------------------

    def SetBaudrate(self, baudrate: int) -> str:
        """Change the baud rate."""
        self.bps = baudrate
        if self._serial and self._serial.is_open:
            self._serial.baudrate = baudrate
        return f"Baudrate set to {baudrate}"

    def GetPortInfo(self) -> str:
        """Return current port and baud rate info."""
        connected = self.IsConnected()
        return f"port={self.port}, baud={self.bps}, connected={connected}"
