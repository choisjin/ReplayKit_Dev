"""SSH connection service — paramiko 기반의 thread-safe SSH 클라이언트 래퍼.

DeviceManager가 SSH 디바이스의 연결 lifecycle을 관리하기 위해 사용한다.
연결 객체는 디바이스에 묶여 있으며, SSHManager 모듈 호출 시 공유된다.
"""

from __future__ import annotations

import logging
import socket
import threading
from typing import Optional

import paramiko

logger = logging.getLogger(__name__)


class SSHConnection:
    """단일 SSH 세션을 thread-safe하게 관리.

    한 인스턴스는 하나의 디바이스(host+port+user)에 매핑된다.
    여러 워커 스레드가 동시에 명령을 실행할 수 있도록 lock을 사용한다.
    """

    def __init__(self, host: str, port: int, username: str, password: str,
                 key_file_path: Optional[str] = None, timeout: float = 10.0):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.key_file_path = key_file_path
        self.timeout = timeout
        self._client: Optional[paramiko.SSHClient] = None
        self._lock = threading.Lock()

    def connect(self) -> None:
        """SSH 세션 수립. 이미 연결되어 있으면 no-op."""
        with self._lock:
            if self._client is not None and self._is_alive_unlocked():
                return
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            connect_kwargs = {
                "hostname": self.host,
                "port": self.port,
                "username": self.username,
                "timeout": self.timeout,
                "allow_agent": False,
                "look_for_keys": False,
            }
            if self.key_file_path:
                connect_kwargs["key_filename"] = self.key_file_path
            else:
                connect_kwargs["password"] = self.password
            try:
                client.connect(**connect_kwargs)
            except Exception:
                try:
                    client.close()
                except Exception:
                    pass
                raise
            self._client = client
            logger.info("SSH connected: %s@%s:%d", self.username, self.host, self.port)

    def disconnect(self) -> None:
        """SSH 세션 종료."""
        with self._lock:
            if self._client is not None:
                try:
                    self._client.close()
                except Exception as e:
                    logger.warning("SSH close error %s@%s: %s", self.username, self.host, e)
                self._client = None
                logger.info("SSH disconnected: %s@%s:%d", self.username, self.host, self.port)

    def _is_alive_unlocked(self) -> bool:
        if self._client is None:
            return False
        transport = self._client.get_transport()
        if transport is None or not transport.is_active():
            return False
        try:
            transport.send_ignore()
            return True
        except (EOFError, OSError, socket.error):
            return False

    def is_alive(self) -> bool:
        """연결이 살아있는지 확인."""
        with self._lock:
            return self._is_alive_unlocked()

    def get_client(self) -> Optional[paramiko.SSHClient]:
        """내부 paramiko 클라이언트를 반환 (SSHManager 모듈에 주입용).

        호출 측은 None 체크 필수. 연결이 끊어졌을 수 있으므로 사용 전 is_alive() 확인 권장.
        """
        with self._lock:
            return self._client

    def exec_command(self, command: str, timeout: float = 30.0) -> tuple[str, str, int]:
        """명령 실행 후 (stdout, stderr, exit_code) 반환.

        Raises:
            RuntimeError: 연결이 없거나 실행 실패 시.
        """
        with self._lock:
            if self._client is None or not self._is_alive_unlocked():
                raise RuntimeError(f"SSH not connected: {self.username}@{self.host}")
            try:
                stdin, stdout, stderr = self._client.exec_command(command, timeout=timeout)
                exit_code = stdout.channel.recv_exit_status()
                out = stdout.read().decode("utf-8", errors="replace")
                err = stderr.read().decode("utf-8", errors="replace")
                return out, err, exit_code
            except Exception as e:
                raise RuntimeError(f"SSH exec failed: {e}") from e
