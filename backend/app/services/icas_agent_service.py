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


class ICASAgentService:
    """SSH 기반 ICAS HU 제어 서비스.

    HKMC6thService와 동일한 async API를 제공하여 playback_service가
    동일한 step 타입(hkmc_touch/hkmc_swipe/hkmc_key)을 그대로 디스패치할 수 있게 한다.
    """

    default_screen = "HU"

    def __init__(self, host: str, port: int = 22, device_id: str = "",
                 username: str = "root", password: str = "",
                 resolution: str = "1560x700",
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

        self._connected = False
        self.agent_version = "ICAS Agent"
        self._ssh_client = None  # paramiko.SSHClient (idle holder; 액션마다 재연결하는 ref 스타일 유지)
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
        """새 paramiko SSHClient 생성 및 연결. 사용 후 with로 close."""
        import paramiko
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(self.host, username=self.username, port=self.port,
                    password=self.password, timeout=10)
        return ssh

    def connect(self, timeout: float = 10.0) -> bool:
        """SSH 연결 가능성 확인만 수행 (ref RemoteController.create_ssh_client과 동일)."""
        try:
            ssh = self._new_ssh()
            ssh.close()
            self._connected = True
            logger.info("ICAS connected to %s:%d", self.host, self.port)
            return True
        except Exception as e:
            logger.error("ICAS connect failed %s:%d: %s", self.host, self.port, e)
            self._connected = False
            return False

    def disconnect(self) -> None:
        self._connected = False

    async def async_connect(self, timeout: float = 10.0) -> bool:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self.connect, timeout)

    async def async_disconnect(self) -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self.disconnect)

    # ------------------------------------------------------------------
    # Low-level helpers
    # ------------------------------------------------------------------
    def _ksend(self, data_bytes: str) -> None:
        """ksend 명령 1회 송신. data_bytes는 공백 구분 hex 문자열."""
        cmd = f'/lge/app_ro/bin/ksend -s {self.src_addr} -d {self.dst_addr} -b "{data_bytes}"'
        with self._new_ssh() as ssh:
            ssh.exec_command(cmd, timeout=10)

    def _ksend_many(self, data_list: list[str], interval_s: float = 0.1) -> None:
        """ksend 명령 여러 개를 단일 SSH 세션에서 순차 송신."""
        with self._new_ssh() as ssh:
            for data in data_list:
                cmd = f'/lge/app_ro/bin/ksend -s {self.src_addr} -d {self.dst_addr} -b "{data}"'
                ssh.exec_command(cmd, timeout=10)
                if interval_s > 0:
                    time.sleep(interval_s)

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
        """HU 스크린샷 캡처 — LayerManagerControl dump + SCP pull."""
        # MVP: HU만. IID/HUD는 향후 private server hop 경로로 확장.
        import tempfile
        import os
        from PIL import Image, ImageFile
        ImageFile.LOAD_TRUNCATED_IMAGES = True

        tmp_dir = tempfile.mkdtemp(prefix="icas_cap_")
        try:
            with self._new_ssh() as ssh:
                # 1) 디바이스에서 화면 덤프
                shel = ssh.invoke_shell()
                commands = [
                    "export XDG_RUNTIME_DIR=/run/platform/weston; "
                    "LayerManagerControl dump screen 0 to /tmp/screen1.png\r\n",
                    "export XDG_RUNTIME_DIR=/run/platform/weston; "
                    "LayerManagerControl dump screen 2 to /tmp/screen2.png\r\n",
                ]
                for c in commands:
                    shel.send(c)
                    time.sleep(0.3)
                time.sleep(1.5)  # 파일 생성 대기

                # 2) SCP pull
                try:
                    from scp import SCPClient
                except ImportError as e:
                    raise RuntimeError("scp module required: pip install scp") from e

                local_files: list[str] = []
                with SCPClient(ssh.get_transport()) as scp:
                    for remote, fname in (("/tmp/screen1.png", "screen1.png"),
                                          ("/tmp/screen2.png", "screen2.png")):
                        local = os.path.join(tmp_dir, fname)
                        try:
                            scp.get(remote, local)
                            if os.path.exists(local) and os.path.getsize(local) > 0:
                                local_files.append(local)
                        except Exception as e:
                            logger.debug("ICAS scp %s failed: %s", remote, e)

            if not local_files:
                raise RuntimeError("No screenshot captured")

            # 3) 여러 레이어가 있으면 alpha composite로 합성
            images = [Image.open(p).convert("RGBA") for p in local_files]
            base = images[0]
            for over in images[1:]:
                if over.size != base.size:
                    over = over.resize(base.size)
                base = Image.alpha_composite(base, over)

            # 4) 요청 포맷으로 변환
            buf = io.BytesIO()
            if fmt.lower() == "jpeg":
                base.convert("RGB").save(buf, format="JPEG", quality=85)
            else:
                base.save(buf, format="PNG")
            return buf.getvalue()
        finally:
            # 임시 파일 정리
            try:
                import shutil
                shutil.rmtree(tmp_dir, ignore_errors=True)
            except Exception:
                pass

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
        """HKMC6th.get_info()와 동형 — 현재는 HU만 보고, IID/HUD는 0x0."""
        return {
            "host": self.host,
            "port": self.port,
            "connected": self._connected,
            "agent_version": self.agent_version,
            "screens": {
                "HU":  {"width": self._res_x, "height": self._res_y},
                "IID": {"width": 0, "height": 0},
                "HUD": {"width": 0, "height": 0},
            },
        }
