"""CMD 모듈 — 시스템 명령어 실행 플러그인.

실행 방식:
  - Run(command): 블로킹 실행, stdout+stderr 반환
  - Check(command, expected, match_mode): 블로킹 실행 + 기대값 비교. 실패 시 "FAIL: ..." 반환
  - RunCapture(command): 비블로킹 실행, [BG_TASK:bg_x] placeholder 반환 (폴링으로 결과 회수)
  - CheckCapture(command, expected, match_mode): 비블로킹 + 기대값 비교 (서버 폴링 시 최종 판정)
  - RunBackground(command): 서브프로세스 fire-and-forget (PID 반환, 결과 회수 불가)
  - Kill(pid), ListBackground(): 백그라운드 프로세스 관리
"""

import subprocess
import sys


class CMD:
    """시스템 명령어 실행 모듈."""

    def __init__(self):
        self._bg_processes: dict[int, subprocess.Popen] = {}

    def Run(self, command: str, timeout: int = 300) -> str:
        """명령어를 실행하고 완료될 때까지 대기.

        Args:
            command: 실행할 명령어 (예: "ping 127.0.0.1 -n 3")
            timeout: 최대 대기 시간 (초, 기본 300)

        Returns:
            stdout + stderr 출력 결과
        """
        try:
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            output = (result.stdout.strip() + "\n" + result.stderr.strip()).strip()
            return output or f"(exit code: {result.returncode})"
        except subprocess.TimeoutExpired:
            return f"TIMEOUT ({timeout}s)"
        except Exception as e:
            return f"ERROR: {e}"

    def Check(self, command: str, expected: str, match_mode: str = "contains", timeout: int = 300) -> str:
        """명령어를 실행하고 출력 결과를 기대값과 비교 (블로킹).

        Args:
            command: 실행할 명령어
            expected: 기대값 (출력에 포함되거나 완전히 일치해야 하는 문자열)
            match_mode: "contains" (부분 일치) 또는 "exact" (완전 일치). 기본값: contains
            timeout: 최대 대기 시간 (초). 기본값: 300

        Returns:
            통과 시: stdout 원문
            실패 시: "FAIL: expected(<mode>): <expected>\\n---\\n<stdout>"
                    ("FAIL:" 접두사로 module_command가 자동으로 fail 처리)
        """
        output = self.Run(command, timeout)
        actual = output.strip()
        exp = (expected or "").strip()
        if match_mode == "exact":
            passed = actual == exp
        else:
            passed = exp in actual
        if passed:
            return output
        return f"FAIL: expected({match_mode}): {expected}\n---\n{output}"

    def RunCapture(self, command: str) -> str:
        """명령어를 백그라운드로 실행 (비블로킹). 결과 회수 가능.

        반환된 [BG_TASK:bg_x] placeholder를 통해 /api/scenarios/cmd-result/{task_id}로
        실제 결과를 폴링할 수 있다.

        Args:
            command: 실행할 명령어

        Returns:
            "[BG_TASK:bg_x]" 형태의 placeholder
        """
        from backend.app.services import bg_task_store
        task_id = bg_task_store.start_task(command)
        return f"[BG_TASK:{task_id}]"

    def CheckCapture(self, command: str, expected: str, match_mode: str = "contains") -> str:
        """명령어를 백그라운드로 실행 + 기대값 비교 (비블로킹).

        폴링 엔드포인트가 완료 시 기대값 비교를 수행하여 최종 pass/fail을 판정한다.

        Args:
            command: 실행할 명령어
            expected: 기대값
            match_mode: "contains" 또는 "exact"

        Returns:
            "[BG_TASK:bg_x]" 형태의 placeholder
        """
        from backend.app.services import bg_task_store
        task_id = bg_task_store.start_task(command, expected=expected, match_mode=match_mode)
        return f"[BG_TASK:{task_id}]"

    def RunBackground(self, command: str) -> str:
        """명령어를 서브프로세스로 실행 (백그라운드, non-blocking).

        Args:
            command: 실행할 명령어

        Returns:
            실행된 프로세스의 PID
        """
        try:
            proc = subprocess.Popen(
                command,
                shell=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            self._bg_processes[proc.pid] = proc
            return f"PID:{proc.pid}"
        except Exception as e:
            return f"ERROR: {e}"

    def Kill(self, pid: int) -> str:
        """백그라운드 프로세스를 종료.

        Args:
            pid: 종료할 프로세스 PID

        Returns:
            결과 메시지
        """
        proc = self._bg_processes.pop(pid, None)
        if proc:
            try:
                proc.kill()
                return f"Killed PID:{pid}"
            except Exception as e:
                return f"ERROR: {e}"
        # bg_processes에 없으면 시스템에서 직접 종료 시도
        try:
            import os
            os.kill(pid, 9)
            return f"Killed PID:{pid}"
        except Exception as e:
            return f"ERROR: {e}"

    def ListBackground(self) -> str:
        """실행 중인 백그라운드 프로세스 목록.

        Returns:
            PID 목록 (alive 상태만)
        """
        alive = []
        dead = []
        for pid, proc in list(self._bg_processes.items()):
            if proc.poll() is None:
                alive.append(str(pid))
            else:
                dead.append(pid)
        for pid in dead:
            self._bg_processes.pop(pid, None)
        return ", ".join(alive) if alive else "(none)"
