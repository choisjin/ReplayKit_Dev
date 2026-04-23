"""ICAS Agent Service — SSH 기반 VW ICAS HU 제어.

References/RemoteController.py, Control_Lib.py 를 바탕으로 HKMC6thService와
동일한 async API 계약을 제공한다.

지원 범위 (MVP):
  - Touch: tap / swipe / long_press / repeat_tap
  - Hardkey: VOLUME_UP, VOLUME_DOWN, MUTE, PTT, HOME, POWER (6개)
  - Screenshot: HU (LayerManagerControl dump + SCP pull)
  - Screen type: HU (향후 IID/HUD 확장 예정)

좌표 인코딩 (RemoteController.excutecmdTouch* 동일):
  x' = round(x / X_MULT), y' = round(y / Y_MULT)
  X_MULT = int(res_x / 1023) + 1, Y_MULT = int(res_y / 1023) + 1
  param1 = 0xFF & ((x' >> 6) + 0x10)
  param2 = ((x' >> 2 & 0xF) << 4) + ((x' << 2) & 0xC) + int(y' / 255)
  param3 = 0xFF & (y' % 255)
  end byte: 0xFD(press) / 0xFE(drag) / 0xFF(release)
"""

from __future__ import annotations

import asyncio
import io
import logging
import threading
import time
from typing import Optional

logger = logging.getLogger(__name__)

# ── 하드키 서브 커맨드 (HKMC6thService API 호환용 — 내부적으로 press/release 구분) ──
SHORT_KEY = 0x43
LONG_KEY = 0x44
PRESS_KEY = 0x41
RELEASE_KEY = 0x42


# ── ICAS 하드키 테이블 ──
# class: "short" (13B 프레임) / "long" (15B 프레임)
# key: KEY_CODE 바이트 (ksend 프레임의 키 위치)
ICAS_KEYS: dict[str, dict] = {
    "VOLUME_UP":   {"class": "short", "key": 0x10},
    "VOLUME_DOWN": {"class": "short", "key": 0x11},
    "MUTE":        {"class": "short", "key": 0x20},
    "HOME":        {"class": "long",  "key": 0x66},
    "POWER":       {"class": "long",  "key": 0x38},
}


def _encode_touch_xy(x: int, y: int, x_mult: int, y_mult: int) -> tuple[int, int, int]:
    """Touch 좌표를 ksend param1/param2/param3 바이트로 인코딩."""
    x2 = int(round(float(x) / max(1, x_mult)))
    y2 = int(round(float(y) / max(1, y_mult)))
    y_layer = int(y2 / 255)
    param1 = 0xFF & ((x2 >> 6) + 0x10)
    param2 = ((x2 >> 2 & 0xF) << 4) + ((x2 << 2) & 0xC) + y_layer
    param3 = 0xFF & (y2 % 255)
    return param1, param2, param3


def _encode_image(pil_image, fmt: str) -> bytes:
    """PIL Image → PNG/JPEG 바이트."""
    buf = io.BytesIO()
    if (fmt or "png").lower() == "jpeg":
        pil_image.convert("RGB").save(buf, format="JPEG", quality=85)
    else:
        pil_image.save(buf, format="PNG")
    return buf.getvalue()


def _rm_tree(path: str) -> None:
    try:
        import shutil
        shutil.rmtree(path, ignore_errors=True)
    except Exception:
        pass


class ICASAgentService:
    """SSH 기반 ICAS HU 제어 서비스.

    HKMC6thService와 동일한 async API를 제공하여 playback_service가
    동일한 step 타입(hkmc_touch/hkmc_swipe/hkmc_key)을 그대로 디스패치할 수 있게 한다.
    """

    default_screen = "HU"

    def __init__(self, host: str, port: int = 22, device_id: str = "",
                 username: str = "root", password: str = "",
                 resolution: str = "1560x700",
                 private_server_ip: str = "192.168.0.2",
                 private_server_password: str = "",
                 iid_display: str = "10",
                 hud_display: str = "11",
                 key_overrides: Optional[dict[str, dict]] = None):
        self.host = host
        self.port = int(port)
        self.device_id = device_id or f"ICAS_{host}"
        self.username = username
        self.password = password or ""
        self._resolution = resolution.upper()
        self._parse_resolution()
        # market 분기: 기본 GP(KR). ref 코드 기준 GP는 "57"/"43", 그 외 "0x200...000"/"0x80...000"
        # 단일 디폴트로 GP 채택. 필요 시 set_addr()로 변경.
        self.src_addr = "57"
        self.dst_addr = "43"

        # IID/HUD 캡처용 private server (ref: RemoteController.PRIVATE_SERVER_*)
        # 사용자가 config에서 ip/password/display 번호를 override 가능.
        self.private_server_ip = private_server_ip
        self.private_server_password = private_server_password
        self.iid_display = str(iid_display or "10")
        self.hud_display = str(hud_display or "11")

        self._connected = False
        self.agent_version = "ICAS Agent"
        # 공유 SSH 세션 — 액션마다 재연결하지 않고 keep-alive로 재사용하여 인증 오버헤드(80ms/call) 제거.
        # 터치/하드키/스크린샷 등 모든 액션이 동일 클라이언트를 공유하므로 _ssh_lock으로 직렬화.
        self._ssh_client = None
        self._ssh_shell = None  # 장수명 invoke_shell 채널 — ksend 등 fire-and-forget 명령용
        self._ssh_lock = threading.RLock()
        self._ssh_keepalive_interval = 30  # seconds; transport.set_keepalive로 TCP idle 방지
        self._key_overrides: dict[str, dict] = dict(key_overrides or {})

    # ------------------------------------------------------------------
    # Basic accessors
    # ------------------------------------------------------------------
    def _parse_resolution(self) -> None:
        try:
            rx, ry = self._resolution.upper().split("X")
            self._res_x = int(rx)
            self._res_y = int(ry)
        except Exception:
            self._res_x, self._res_y = 1560, 700
        self._x_mult = int(self._res_x / 1023) + 1
        self._y_mult = int(self._res_y / 1023) + 1

    @property
    def resolution(self) -> str:
        return self._resolution

    @resolution.setter
    def resolution(self, value: str) -> None:
        self._resolution = value.upper()
        self._parse_resolution()

    @property
    def is_connected(self) -> bool:
        return self._connected

    def set_addr(self, src: str, dst: str) -> None:
        """src/dst ksend 주소 변경 (EU/NAR/CN/GP 분기)."""
        self.src_addr = src
        self.dst_addr = dst

    # ------------------------------------------------------------------
    # Connection (SSH check)
    # ------------------------------------------------------------------
    def _new_ssh(self):
        """새 paramiko SSHClient 생성 및 연결 (IID/HUD hop 등 일회성 용도).

        공유 세션이 필요한 경우는 `_get_shared_ssh()`를 사용할 것.
        """
        import paramiko
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(self.host, username=self.username, port=self.port,
                    password=self.password, timeout=10)
        return ssh

    def _is_ssh_alive(self, ssh) -> bool:
        """paramiko SSHClient의 transport 활성 여부 체크."""
        if ssh is None:
            return False
        try:
            t = ssh.get_transport()
            return bool(t and t.is_active() and t.is_authenticated())
        except Exception:
            return False

    def _get_shared_ssh(self):
        """공유 SSH 세션 반환 — 끊어졌으면 재연결.

        락 안에서 호출해야 함. 최초 호출 시 새로 연결하고,
        transport가 dead면 닫고 재생성. keep-alive를 설정해 일정 주기마다 NO-OP 프레임을 보내
        방화벽/NAT TCP idle timeout으로 끊어지는 것을 방지.
        """
        if self._is_ssh_alive(self._ssh_client):
            return self._ssh_client
        # 죽은 세션 정리
        if self._ssh_client is not None:
            try:
                self._ssh_client.close()
            except Exception:
                pass
            self._ssh_client = None
        # 공유 shell도 dead SSH와 함께 폐기
        if self._ssh_shell is not None:
            try:
                self._ssh_shell.close()
            except Exception:
                pass
            self._ssh_shell = None
        # 새 연결
        ssh = self._new_ssh()
        try:
            t = ssh.get_transport()
            if t is not None:
                t.set_keepalive(self._ssh_keepalive_interval)
        except Exception:
            pass
        self._ssh_client = ssh
        return ssh

    def _get_shared_shell(self):
        """공유 interactive shell 채널 반환 — 죽었으면 새로 오픈하고 초기 배너를 드레인.

        ksend 등 fire-and-forget 명령은 exec_command(채널 당 open_session=sshd MaxSessions 소모)
        대신 단일 shell 채널에 `shell.send(cmd + "\\n")` 으로 보낸다.
        레퍼런스 구현과 동일한 패턴이며, sshd 세션 한도를 소모하지 않아 장기간 안정.
        """
        ssh = self._get_shared_ssh()
        if self._ssh_shell is not None:
            try:
                if not self._ssh_shell.closed:
                    return self._ssh_shell
            except Exception:
                pass
            # 죽은 shell 정리
            try:
                self._ssh_shell.close()
            except Exception:
                pass
            self._ssh_shell = None
        # 새 shell 오픈 + 초기 배너/프롬프트 드레인
        shell = ssh.invoke_shell()
        shell.settimeout(0.5)
        # 초기 프롬프트가 나올 때까지 최대 1s 드레인
        deadline = time.time() + 1.0
        while time.time() < deadline:
            try:
                if shell.recv_ready():
                    shell.recv(65536)
                else:
                    time.sleep(0.05)
            except Exception:
                break
        self._ssh_shell = shell
        return shell

    def _drain_shell(self, shell, max_bytes: int = 65536) -> bytes:
        """공유 shell의 수신 버퍼를 non-blocking으로 비움 (pipe 백프레셔 방지)."""
        buf = b""
        try:
            while shell.recv_ready() and len(buf) < max_bytes:
                chunk = shell.recv(4096)
                if not chunk:
                    break
                buf += chunk
        except Exception:
            pass
        return buf

    def _shell_run(self, commands: list[str], post_sleep_s: float = 0.02) -> None:
        """공유 shell 채널로 명령 여러 개 송신 + drain. transport/shell dead면 1회 리셋 재시도.

        각 명령 후 짧은 post_sleep로 서버가 명령을 소비할 시간을 준 뒤 drain으로 출력을 정리.
        ksend는 수 ms 안에 끝나므로 20ms 기본값으로 충분.
        """
        def _do(shell) -> None:
            for c in commands:
                shell.send(c + "\n")
                if post_sleep_s > 0:
                    time.sleep(post_sleep_s)
                self._drain_shell(shell)

        with self._ssh_lock:
            try:
                shell = self._get_shared_shell()
                _do(shell)
                return
            except Exception as e:
                logger.warning("ICAS shared shell exec failed, retrying: %s", e)
                # shell 리셋 → 다시 시도 (transport가 살아있으면 재사용, 죽었으면 재연결)
                if self._ssh_shell is not None:
                    try:
                        self._ssh_shell.close()
                    except Exception:
                        pass
                    self._ssh_shell = None
            shell = self._get_shared_shell()
            _do(shell)

    def connect(self, timeout: float = 10.0) -> bool:
        """공유 SSH 세션을 확보하여 연결 상태를 확인 + 유지."""
        try:
            with self._ssh_lock:
                self._get_shared_ssh()  # 끊어져 있으면 새로 연결
            self._connected = True
            logger.info("ICAS connected to %s:%d", self.host, self.port)
            return True
        except Exception as e:
            logger.error("ICAS connect failed %s:%d: %s", self.host, self.port, e)
            self._connected = False
            return False

    def disconnect(self) -> None:
        self._connected = False
        with self._ssh_lock:
            if self._ssh_shell is not None:
                try:
                    self._ssh_shell.close()
                except Exception:
                    pass
                self._ssh_shell = None
            if self._ssh_client is not None:
                try:
                    self._ssh_client.close()
                except Exception:
                    pass
                self._ssh_client = None

    async def async_connect(self, timeout: float = 10.0) -> bool:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self.connect, timeout)

    async def async_disconnect(self) -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self.disconnect)

    # ------------------------------------------------------------------
    # Low-level helpers
    # ------------------------------------------------------------------
    def _exec_on_shared(self, commands: list[str], interval_s: float = 0.0,
                        per_cmd_timeout: float = 5.0) -> None:
        """공유 SSH 세션에서 exec_command들을 순차 실행.

        각 명령은 exit_status를 기다려 채널을 즉시 해제함 (sshd MaxSessions=10 한도 보호).
        ksend는 즉시 반환되므로 wait 비용이 무시할 수준. transport 에러 시 세션 리셋 후 1회 재시도.
        """
        def _run_one(ssh, c: str) -> None:
            stdin, stdout, stderr = ssh.exec_command(c, timeout=per_cmd_timeout)
            try:
                stdin.close()
            except Exception:
                pass
            # exit_status 대기 → 채널 즉시 클로즈 (sshd 세션 누수 방지)
            try:
                stdout.channel.settimeout(per_cmd_timeout)
                stdout.channel.recv_exit_status()
            except Exception:
                pass
            finally:
                for f in (stdout, stderr):
                    try:
                        f.close()
                    except Exception:
                        pass

        def _run_all(ssh, cmd_list: list[str]) -> None:
            for i, c in enumerate(cmd_list):
                _run_one(ssh, c)
                if interval_s > 0 and i < len(cmd_list) - 1:
                    time.sleep(interval_s)

        with self._ssh_lock:
            try:
                ssh = self._get_shared_ssh()
                _run_all(ssh, commands)
                return
            except Exception as e:
                # transport 끊김/EOF/채널 한도 초과 등 → 세션 리셋 후 1회 재시도
                logger.warning("ICAS shared SSH exec failed, retrying: %s", e)
                if self._ssh_client is not None:
                    try:
                        self._ssh_client.close()
                    except Exception:
                        pass
                    self._ssh_client = None
            ssh = self._get_shared_ssh()
            _run_all(ssh, commands)

    def _ksend(self, data_bytes: str) -> None:
        """ksend 명령 1회 송신 — 공유 shell 채널 사용 (레퍼런스 구현 동일 패턴)."""
        cmd = f'/lge/app_ro/bin/ksend -s {self.src_addr} -d {self.dst_addr} -b "{data_bytes}"'
        self._shell_run([cmd])

    def _ksend_many(self, data_list: list[str], interval_s: float = 0.1) -> None:
        """ksend 명령 여러 개를 공유 shell 채널에서 순차 송신."""
        cmds = [
            f'/lge/app_ro/bin/ksend -s {self.src_addr} -d {self.dst_addr} -b "{data}"'
            for data in data_list
        ]
        # 각 cmd 사이 간격은 shell_run의 post_sleep_s로 들어감 — interval_s 우선
        self._shell_run(cmds, post_sleep_s=max(0.02, interval_s))

    # ------------------------------------------------------------------
    # Touch (press/drag/release) — ref RemoteController.excutecmdTouch*
    # ------------------------------------------------------------------
    def _touch_frame(self, x: int, y: int, end_byte: int) -> str:
        p1, p2, p3 = _encode_touch_xy(int(x), int(y), self._x_mult, self._y_mult)
        return (
            f"0x83 0x50 0x20 0x0b 0x00 0x00 0x00 0x00 0x00 0xa0 0x01 0x11 "
            f"0x{p1:02x} 0x{p2:02x} 0x{p3:02x} 0x{end_byte:02x}"
        )

    def _touch_press(self, x: int, y: int) -> None:
        self._ksend(self._touch_frame(x, y, 0xFD))

    def _touch_drag(self, x: int, y: int) -> None:
        self._ksend(self._touch_frame(x, y, 0xFE))

    def _touch_release(self, x: int, y: int) -> None:
        self._ksend(self._touch_frame(x, y, 0xFF))

    def tap(self, x: int, y: int, screen_type: str = "HU",
            dp: float = 0.2, dr: float = 0.0) -> None:
        """단일 탭. press → (dp초 대기) → release."""
        self._touch_press(x, y)
        if dp > 0:
            time.sleep(dp)
        self._touch_release(x, y)
        if dr > 0:
            time.sleep(dr)

    def long_press(self, x: int, y: int, duration_ms: int = 3000,
                   screen_type: str = "HU") -> None:
        self._touch_press(x, y)
        time.sleep(duration_ms / 1000.0)
        self._touch_release(x, y)

    def swipe(self, x1: int, y1: int, x2: int, y2: int,
              screen_type: str = "HU", duration_ms: int = 300) -> None:
        """press(x1,y1) → drag(보간) → release(x2,y2)."""
        # 보간 스텝 수: duration 기반 (각 스텝 ~20ms 목표, 최소 3 최대 20)
        target_interval_ms = 20
        steps = max(3, min(20, max(1, duration_ms // target_interval_ms)))
        dx = (x2 - x1) / steps
        dy = (y2 - y1) / steps

        # 동일 SSH 세션으로 일괄 송신 — 오버헤드 최소화
        frames: list[str] = []
        frames.append(self._touch_frame(x1, y1, 0xFD))  # press
        for i in range(1, steps):
            ix = int(round(x1 + dx * i))
            iy = int(round(y1 + dy * i))
            frames.append(self._touch_frame(ix, iy, 0xFE))  # drag
        frames.append(self._touch_frame(x2, y2, 0xFF))  # release

        # 간격은 duration_ms에 맞춰 분배
        interval_s = max(0.01, (duration_ms / 1000.0) / max(1, len(frames) - 1))
        self._ksend_many(frames, interval_s=interval_s)

    def repeat_tap(self, x: int, y: int, count: int = 5,
                   interval_ms: int = 100, screen_type: str = "HU") -> None:
        for i in range(count):
            self.tap(x, y, screen_type, dp=0.05, dr=0.0)
            if i < count - 1 and interval_ms > 0:
                time.sleep(interval_ms / 1000.0)

    # ------------------------------------------------------------------
    # Hardkey
    # ------------------------------------------------------------------
    def _hkey_short_frame(self, key_code: int, state: int) -> str:
        """Short 클래스(Volume/Mute/PTT) — 13 bytes."""
        return (
            f"0x83 0x50 0x10 0x0A 0x00 0x00 0x05 0xBF 0x00 "
            f"0x{key_code:02X} 0x{state:02X} 0x00 0x00"
        )

    def _hkey_long_frame(self, key_code: int, state: int) -> str:
        """Long 클래스(Home/Power) — 15 bytes.
        state=0x01 / 0x00 에 따라 tail(0x10 / 0xD9) 변경 (ref 코드 관찰값)."""
        tail = 0x10 if state else 0xD9
        return (
            f"0x83 0x50 0x20 0x0B 0x17 0xF8 0xF1 0x73 0x00 0x30 "
            f"0x{key_code:02X} 0x{state:02X} 0x{tail:02X} 0x00 0x00"
        )

    def resolve_key(self, key_name: str) -> Optional[dict]:
        """키 스펙 반환 (override 병합)."""
        base = ICAS_KEYS.get(key_name)
        if not base:
            return None
        merged = dict(base)
        ov = self._key_overrides.get(key_name) or {}
        for k in ("class", "key"):
            if k in ov:
                merged[k] = ov[k]
        return merged

    def set_key_overrides(self, overrides: Optional[dict[str, dict]]) -> None:
        self._key_overrides = dict(overrides or {})

    def get_key_overrides(self) -> dict[str, dict]:
        return dict(self._key_overrides)

    def send_key_by_name(self, key_name: str, sub_cmd: int = SHORT_KEY,
                         screen_type: Optional[str] = None,
                         direction: Optional[int] = None) -> None:
        """이름 기반 하드키 송신. sub_cmd는 HKMC6th API 호환용(SHORT/LONG).

        ICAS는 press→release 시퀀스가 기본. LONG은 press→대기→release 패턴으로 처리.
        """
        info = self.resolve_key(key_name)
        if not info:
            raise ValueError(f"Unknown ICAS key: {key_name}")
        key_code = int(info["key"])
        klass = info.get("class", "short")

        # press
        press = (self._hkey_short_frame(key_code, 0x01) if klass == "short"
                 else self._hkey_long_frame(key_code, 0x01))
        release = (self._hkey_short_frame(key_code, 0x00) if klass == "short"
                   else self._hkey_long_frame(key_code, 0x00))

        hold_s = 1.0 if sub_cmd == LONG_KEY else 0.1
        self._ksend_many([press], interval_s=0)
        time.sleep(hold_s)
        self._ksend_many([release], interval_s=0)

    def send_key(self, cmd: int, sub_cmd: int, key_data: int,
                 monitor: int = 0x00, direction: Optional[int] = None) -> None:
        """HKMC 호환용 raw send_key. key_data를 KEY_CODE로 해석해 single press/release 수행.

        ICAS는 cmd 분류가 하나라, 별도 분기 없이 short 프레임을 기본으로 사용.
        long class가 필요하면 key_data 범위로 자동 판별 (POWER=0x38, HOME=0x66).
        """
        klass = "long" if key_data in (0x38, 0x66) else "short"
        press = (self._hkey_short_frame(key_data, 0x01) if klass == "short"
                 else self._hkey_long_frame(key_data, 0x01))
        release = (self._hkey_short_frame(key_data, 0x00) if klass == "short"
                   else self._hkey_long_frame(key_data, 0x00))
        hold_s = 1.0 if sub_cmd == LONG_KEY else 0.1
        self._ksend_many([press], interval_s=0)
        time.sleep(hold_s)
        self._ksend_many([release], interval_s=0)

    # ------------------------------------------------------------------
    # Screenshot (HU only in MVP)
    # ------------------------------------------------------------------
    def screencap_bytes(self, screen_type: str = "HU",
                        fmt: str = "png", timeout: float = 15.0) -> bytes:
        """스크린샷 캡처. screen_type: HU | IID | HUD."""
        st = (screen_type or "HU").upper()
        if st == "IID":
            return self._screencap_iid_hud(self.iid_display, fmt=fmt)
        if st == "HUD":
            return self._screencap_iid_hud(self.hud_display, fmt=fmt)
        return self._screencap_hu(fmt=fmt)

    # ------------------------------------------------------------------
    # HU screenshot — LayerManagerControl dump + SCP pull + composite
    # ------------------------------------------------------------------
    def _screencap_hu(self, fmt: str = "png") -> bytes:
        import tempfile
        import os
        from PIL import Image, ImageFile
        ImageFile.LOAD_TRUNCATED_IMAGES = True

        try:
            from scp import SCPClient
        except ImportError as e:
            raise RuntimeError("scp module required: pip install scp") from e

        tmp_dir = tempfile.mkdtemp(prefix="icas_cap_")
        try:
            # 공유 SSH 세션에서 dump + SCP pull 을 일괄 수행 (매 프레임마다 재인증 방지).
            # transport 오류 시 1회 재연결 후 재시도.
            def _do_capture(ssh) -> list[str]:
                # LayerManagerControl은 exec_command(비대화형)로도 동일 효과. 환경변수 포함 단일 라인으로 호출.
                dump_cmds = [
                    "export XDG_RUNTIME_DIR=/run/platform/weston && "
                    "LayerManagerControl dump screen 0 to /tmp/screen1.png",
                    "export XDG_RUNTIME_DIR=/run/platform/weston && "
                    "LayerManagerControl dump screen 2 to /tmp/screen2.png",
                ]
                for c in dump_cmds:
                    stdin, stdout, stderr = ssh.exec_command(c, timeout=10)
                    try:
                        stdin.close()
                    except Exception:
                        pass
                    # 덤프 완료 대기 — exit status로 동기화 (sleep 기반 race 제거) + 채널 즉시 해제
                    try:
                        stdout.channel.settimeout(10)
                        stdout.channel.recv_exit_status()
                    except Exception:
                        pass
                    finally:
                        for f in (stdout, stderr):
                            try:
                                f.close()
                            except Exception:
                                pass
                files: list[str] = []
                with SCPClient(ssh.get_transport()) as scp:
                    for remote, fname in (("/tmp/screen1.png", "screen1.png"),
                                          ("/tmp/screen2.png", "screen2.png")):
                        local = os.path.join(tmp_dir, fname)
                        try:
                            scp.get(remote, local)
                            if os.path.exists(local) and os.path.getsize(local) > 0:
                                files.append(local)
                        except Exception as ee:
                            logger.debug("ICAS HU scp %s failed: %s", remote, ee)
                return files

            local_files: list[str] = []
            with self._ssh_lock:
                try:
                    ssh = self._get_shared_ssh()
                    local_files = _do_capture(ssh)
                except Exception as e:
                    logger.warning("ICAS HU capture failed on shared SSH, retrying: %s", e)
                    if self._ssh_client is not None:
                        try:
                            self._ssh_client.close()
                        except Exception:
                            pass
                        self._ssh_client = None
                    ssh = self._get_shared_ssh()
                    local_files = _do_capture(ssh)

            if not local_files:
                raise RuntimeError("No HU screenshot captured")

            images = [Image.open(p).convert("RGBA") for p in local_files]
            base = images[0]
            for over in images[1:]:
                if over.size != base.size:
                    over = over.resize(base.size)
                base = Image.alpha_composite(base, over)
            return _encode_image(base, fmt)
        finally:
            _rm_tree(tmp_dir)

    # ------------------------------------------------------------------
    # IID/HUD screenshot — HU로 SSH → private server로 ssh hop → screenshot
    # ------------------------------------------------------------------
    def _screencap_iid_hud(self, display_number: str, fmt: str = "png") -> bytes:
        """ref RemoteController.IID_get_capture_path 이식.

        1) HU에 SSH로 2개 세션 연결 (하나는 private_server로 hop, 하나는 SCP 전용)
        2) hop 세션에서 `screenshot -display=N` 실행 → private server의 /tmp/screenshot.bmp 생성
        3) hop 세션에서 scp로 HU의 /tmp/screenshot.bmp로 가져옴
        4) SCP 세션으로 로컬에 pull
        5) BMP → PNG/JPEG 변환
        """
        import tempfile
        import os
        from PIL import Image, ImageFile
        ImageFile.LOAD_TRUNCATED_IMAGES = True

        if not self.private_server_ip:
            raise RuntimeError("ICAS IID/HUD capture: private_server_ip not configured")

        try:
            from scp import SCPClient
        except ImportError as e:
            raise RuntimeError("scp module required: pip install scp") from e

        tmp_dir = tempfile.mkdtemp(prefix="icas_iid_")
        try:
            # hop_ssh: private_server로 ssh hop용 (interactive shell이라 공유 불가 — 매회 새로 생성)
            # HU → local SCP pull은 공유 세션 재사용하여 매 프레임 재인증 제거
            import paramiko
            hop_ssh = paramiko.SSHClient()
            hop_ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            hop_ssh.connect(self.host, username=self.username, port=self.port,
                            password=self.password, timeout=10)
            try:
                hop_shel = hop_ssh.invoke_shell()
                hop_shel.settimeout(1.0)
                # 초기 HU 프롬프트 드레인
                self._drain_until(hop_shel, want=None, max_wait_s=1.5)

                ps_host = self.private_server_ip
                is_ipv6 = ":" in ps_host and "." not in ps_host

                # 1) HU → private_server ssh hop
                ssh_cmd = (
                    f'ssh -o "StrictHostKeyChecking=no" '
                    f'-o "UserKnownHostsFile=/dev/null" root@{ps_host}'
                )
                hop_shel.send(ssh_cmd + "\n")
                buf = self._drain_until(hop_shel, want=("password:", "Password:", "yes/no", "$", "#"),
                                        max_wait_s=8.0)
                if "yes/no" in buf:
                    hop_shel.send("yes\n")
                    buf = self._drain_until(hop_shel, want=("password:", "Password:"), max_wait_s=5.0)
                if "password" in buf.lower():
                    hop_shel.send((self.private_server_password or "") + "\n")
                    # 로그인 완료까지 프롬프트 대기
                    self._drain_until(hop_shel, want=("$", "#"), max_wait_s=6.0)

                # 2) private_server에서 screenshot 실행 — 파일이 생길 때까지 대기
                hop_shel.send("cd /tmp\n")
                self._drain_until(hop_shel, want=("$", "#"), max_wait_s=2.0)
                hop_shel.send(f"screenshot -display={display_number}\n")
                # 완료 마커: ls로 파일 크기 확인될 때까지 폴링
                self._wait_for_remote_file(hop_shel, "/tmp/screenshot.bmp", max_wait_s=8.0)

                # 3) private_server → HU로 scp (private_server는 password 프롬프트 나옴)
                hop_shel.send("exit\n")
                self._drain_until(hop_shel, want=("$", "#"), max_wait_s=3.0)

                if is_ipv6:
                    scp_cmd = (
                        f'scp -o "StrictHostKeyChecking=no" '
                        f'-o "UserKnownHostsFile=/dev/null" '
                        f'root@[{ps_host}]:/tmp/screenshot.bmp /tmp/'
                    )
                else:
                    scp_cmd = (
                        f'scp -o "StrictHostKeyChecking=no" '
                        f'-o "UserKnownHostsFile=/dev/null" '
                        f'root@{ps_host}:/tmp/screenshot.bmp /tmp/'
                    )
                hop_shel.send(scp_cmd + "\n")
                buf = self._drain_until(hop_shel, want=("password:", "Password:", "yes/no", "$", "#", "100%"),
                                        max_wait_s=8.0)
                # yes/no 프롬프트 → 응답 후 password 프롬프트로 이어짐
                if "yes/no" in buf:
                    hop_shel.send("yes\n")
                    buf = self._drain_until(hop_shel, want=("password:", "Password:", "$", "#"),
                                            max_wait_s=5.0)
                if "password" in buf.lower():
                    hop_shel.send((self.private_server_password or "") + "\n")
                    # 전송 완료까지 프롬프트 대기
                    self._drain_until(hop_shel, want=("$", "#"), max_wait_s=10.0)
                # HU 에서 파일 생겼는지 확인 (scp 완료 여부 검증)
                self._wait_for_remote_file(hop_shel, "/tmp/screenshot.bmp", max_wait_s=8.0)

                # 3) local로 SCP pull + HU에서 정리 — 공유 SSH로 처리
                local_bmp = os.path.join(tmp_dir, "screenshot.bmp")

                def _do_pull(ssh) -> None:
                    with SCPClient(ssh.get_transport()) as scp:
                        scp.get("/tmp/screenshot.bmp", local_bmp)
                    # rm 채널도 exit_status 대기 + close (sshd 세션 누수 방지)
                    try:
                        stdin, stdout, stderr = ssh.exec_command("rm -f /tmp/screenshot.bmp", timeout=5)
                        try:
                            stdin.close()
                        except Exception:
                            pass
                        try:
                            stdout.channel.settimeout(5)
                            stdout.channel.recv_exit_status()
                        except Exception:
                            pass
                        for f in (stdout, stderr):
                            try:
                                f.close()
                            except Exception:
                                pass
                    except Exception:
                        pass

                with self._ssh_lock:
                    try:
                        shared = self._get_shared_ssh()
                        _do_pull(shared)
                    except Exception as e:
                        logger.warning("ICAS IID/HUD pull via shared SSH failed, retrying: %s", e)
                        if self._ssh_client is not None:
                            try:
                                self._ssh_client.close()
                            except Exception:
                                pass
                            self._ssh_client = None
                        shared = self._get_shared_ssh()
                        _do_pull(shared)

                if not os.path.exists(local_bmp) or os.path.getsize(local_bmp) == 0:
                    raise RuntimeError("IID/HUD screenshot transfer failed")

                img = Image.open(local_bmp).convert("RGBA")
                return _encode_image(img, fmt)
            finally:
                try:
                    hop_ssh.close()
                except Exception:
                    pass
        finally:
            _rm_tree(tmp_dir)

    @staticmethod
    def _drain_until(shel, want: Optional[tuple[str, ...]] = None,
                     max_wait_s: float = 5.0, poll_s: float = 0.1) -> str:
        """shell의 수신 버퍼를 누적하면서 want 문자열 중 하나가 나올 때까지 대기.

        want가 None이면 수신이 조용해질 때(quiet period 0.3s)까지만 읽고 리턴.
        리턴값: 누적된 문자열 (마지막 4KB 정도). 타임아웃이어도 누적된 버퍼 반환.
        """
        deadline = time.time() + max_wait_s
        last_data = time.time()
        buf = ""
        while time.time() < deadline:
            got_chunk = False
            try:
                if shel.recv_ready():
                    chunk = shel.recv(65536)
                    if chunk:
                        buf += chunk.decode("utf-8", errors="replace")
                        got_chunk = True
                        last_data = time.time()
            except Exception:
                break
            # want 매칭 체크 — 최근 2KB 만 보면 충분
            if want:
                tail = buf[-2048:]
                for w in want:
                    if w in tail:
                        return buf
            else:
                # quiet period 기반 종료
                if not got_chunk and (time.time() - last_data) > 0.3:
                    return buf
            if not got_chunk:
                time.sleep(poll_s)
        return buf

    @classmethod
    def _wait_for_remote_file(cls, shel, path: str, max_wait_s: float = 8.0) -> bool:
        """원격 shell에서 `ls -la path`를 폴링해서 파일 존재 + size>0 을 확인."""
        deadline = time.time() + max_wait_s
        marker = "__ICAS_FILE_OK__"
        while time.time() < deadline:
            shel.send(f'if [ -s "{path}" ]; then echo {marker}; fi\n')
            buf = cls._drain_until(shel, want=(marker, "$", "#"), max_wait_s=1.5)
            if marker in buf:
                return True
            time.sleep(0.3)
        return False

    @staticmethod
    def _shell_send_recv(shel, data: str, delay: float = 0.3) -> Optional[str]:
        """paramiko invoke_shell에 문자열 1회 송신 후 수신 버퍼를 반환 (ref ssh_send/iid_send)."""
        try:
            shel.send(data + "\r\n")
        except Exception as e:
            logger.debug("ICAS shell send failed: %s", e)
            return None
        time.sleep(delay)
        if shel.recv_ready():
            try:
                return shel.recv(65536).decode("utf-8", errors="replace")
            except Exception:
                return None
        return None

    async def async_screencap_bytes(self, screen_type: str = "HU",
                                    fmt: str = "png", timeout: float = 15.0) -> bytes:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, self.screencap_bytes, screen_type, fmt, timeout
        )

    # ------------------------------------------------------------------
    # Async wrappers (HKMC6th API 호환)
    # ------------------------------------------------------------------
    async def async_tap(self, x: int, y: int, screen_type: str = "HU") -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self.tap, x, y, screen_type)

    async def async_long_press(self, x: int, y: int, duration_ms: int = 3000,
                               screen_type: str = "HU") -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self.long_press, x, y, duration_ms, screen_type)

    async def async_swipe(self, x1: int, y1: int, x2: int, y2: int,
                          screen_type: str = "HU", duration_ms: int = 300) -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None, self.swipe, x1, y1, x2, y2, screen_type, duration_ms
        )

    async def async_repeat_tap(self, x: int, y: int, count: int = 5,
                               interval_ms: int = 100, screen_type: str = "HU") -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None, self.repeat_tap, x, y, count, interval_ms, screen_type
        )

    async def async_send_key_by_name(self, key_name: str, sub_cmd: int = SHORT_KEY,
                                     screen_type: Optional[str] = None,
                                     direction: Optional[int] = None) -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None, self.send_key_by_name, key_name, sub_cmd, screen_type, direction
        )

    async def async_send_key(self, cmd: int, sub_cmd: int, key_data: int,
                             monitor: int = 0x00,
                             direction: Optional[int] = None) -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None, self.send_key, cmd, sub_cmd, key_data, monitor, direction
        )

    # ------------------------------------------------------------------
    # Meta
    # ------------------------------------------------------------------
    def get_info(self) -> dict:
        """HKMC6th.get_info()와 동형. IID/HUD 해상도는 캡처 시 실제 BMP 크기로 확정되므로
        초기값은 HU 해상도 기반으로 추정 (최초 캡처 전 프레임 렌더링용 기본치).
        """
        return {
            "host": self.host,
            "port": self.port,
            "connected": self._connected,
            "agent_version": self.agent_version,
            "screens": {
                "HU":  {"width": self._res_x, "height": self._res_y},
                "IID": {"width": self._res_x, "height": self._res_y},
                "HUD": {"width": self._res_x, "height": self._res_y},
            },
        }
