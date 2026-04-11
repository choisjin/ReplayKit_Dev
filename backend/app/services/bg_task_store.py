"""백그라운드 CMD 태스크 저장소.

CMD 모듈의 RunCapture/CheckCapture가 시작한 백그라운드 명령의 결과를
시간차 폴링으로 회수하기 위한 공용 저장소.

- start_task(command, expected=None, match_mode='contains'): 태스크 시작, task_id 반환
- get_task(task_id): 태스크 상태 조회
- cleanup_task(task_id): 완료된 태스크 제거
"""

from __future__ import annotations

import logging
import subprocess
import sys
import threading
from typing import Optional

logger = logging.getLogger(__name__)

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

# 태스크 저장소: task_id -> {status, stdout, stderr, rc, cmd, expected, match_mode}
_bg_tasks: dict[str, dict] = {}
_bg_task_counter = 0
_lock = threading.Lock()


def start_task(command: str, expected: Optional[str] = None, match_mode: str = "contains") -> str:
    """백그라운드로 CMD 실행, task_id 반환.

    expected가 주어지면 완료 후 비교를 수행 (Check 계열).
    """
    global _bg_task_counter
    with _lock:
        _bg_task_counter += 1
        task_id = f"bg_{_bg_task_counter}"
        _bg_tasks[task_id] = {
            "status": "running",
            "stdout": "",
            "stderr": "",
            "rc": None,
            "cmd": command,
            "expected": expected,
            "match_mode": match_mode,
        }

    def _run():
        try:
            proc = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                timeout=300,
                creationflags=_NO_WINDOW,
            )
            stdout = ""
            stderr = ""
            for enc in ("utf-8", "cp949", "euc-kr"):
                try:
                    stdout = proc.stdout.decode(enc)
                    stderr = proc.stderr.decode(enc)
                    break
                except (UnicodeDecodeError, LookupError):
                    continue
            else:
                stdout = proc.stdout.decode(errors="replace")
                stderr = proc.stderr.decode(errors="replace")
            with _lock:
                _bg_tasks[task_id].update({
                    "status": "done",
                    "stdout": stdout,
                    "stderr": stderr,
                    "rc": proc.returncode,
                })
        except subprocess.TimeoutExpired:
            with _lock:
                _bg_tasks[task_id].update({
                    "status": "timeout",
                    "stdout": "",
                    "stderr": "Timeout (300s)",
                    "rc": 1,
                })
        except Exception as e:
            logger.exception("bg task %s failed", task_id)
            with _lock:
                _bg_tasks[task_id].update({
                    "status": "error",
                    "stdout": "",
                    "stderr": str(e),
                    "rc": 1,
                })

    threading.Thread(target=_run, daemon=True, name=f"bg-cmd-{task_id}").start()
    return task_id


def create_streaming_task(command: str) -> str:
    """외부(e.g. SSH)에서 실시간으로 stdout을 append할 수 있는 빈 태스크를 생성.

    호출 측(예: SSH paramiko 리더)은 append_stdout / mark_done 으로 상태를 갱신한다.
    """
    global _bg_task_counter
    with _lock:
        _bg_task_counter += 1
        task_id = f"bg_{_bg_task_counter}"
        _bg_tasks[task_id] = {
            "status": "running",
            "stdout": "",
            "stderr": "",
            "rc": None,
            "cmd": command,
            "expected": None,
            "match_mode": "contains",
        }
    return task_id


def append_stdout(task_id: str, chunk: str) -> None:
    """스트리밍 태스크의 stdout에 chunk를 추가."""
    with _lock:
        task = _bg_tasks.get(task_id)
        if task is not None:
            task["stdout"] = task["stdout"] + chunk


def append_stderr(task_id: str, chunk: str) -> None:
    """스트리밍 태스크의 stderr에 chunk를 추가."""
    with _lock:
        task = _bg_tasks.get(task_id)
        if task is not None:
            task["stderr"] = task["stderr"] + chunk


def mark_done(task_id: str, status: str = "done", rc: Optional[int] = 0) -> None:
    """스트리밍 태스크를 완료 상태로 변경."""
    with _lock:
        task = _bg_tasks.get(task_id)
        if task is not None:
            task["status"] = status
            task["rc"] = rc


def get_task(task_id: str) -> Optional[dict]:
    """태스크 상태 조회. 존재하지 않으면 None."""
    with _lock:
        task = _bg_tasks.get(task_id)
        if task is None:
            return None
        # copy to avoid concurrent mutation during JSON serialization
        return dict(task)


def cleanup_task(task_id: str) -> None:
    """완료된 태스크 제거."""
    with _lock:
        _bg_tasks.pop(task_id, None)
