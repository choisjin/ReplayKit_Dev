"""ADB Service — Android Debug Bridge 연결 관리 및 명령 실행."""

from __future__ import annotations

import asyncio
import functools
import logging
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

ADB_PATH = os.environ.get("ADB_PATH", "adb")


def resolve_sf_display_id(dev_info: dict | None, logical_id: int | None) -> str | None:
    """logical display ID → SurfaceFlinger display ID 변환.

    dev_info: ManagedDevice.info dict (displays 리스트 포함).
    SF display ID를 찾지 못하면 logical_id를 문자열로 폴백 반환.
    멀티 디스플레이에서 logical_id=None이면 display 0의 sf_id 반환.
    """
    if not dev_info:
        return None
    displays = dev_info.get("displays", [])
    is_multi = len(displays) > 1
    # logical_id가 None이고 멀티 디스플레이면 display 0 사용
    if logical_id is None:
        if is_multi and displays:
            return displays[0].get("sf_id")
        return None
    for d in displays:
        if d.get("id") == logical_id:
            sf_id = d.get("sf_id")
            if sf_id is not None:
                return sf_id
    # SF display ID를 찾지 못한 경우 logical ID를 직접 사용 (display 0 제외)
    if logical_id and logical_id != 0:
        logger.warning("SF display ID not found for logical_id=%d, using logical ID as fallback", logical_id)
        return str(logical_id)
    return None


_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def _run_sync(cmd: str, timeout: int = 10) -> tuple[str, str, int]:
    """Run a command synchronously and return (stdout, stderr, returncode)."""
    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            timeout=timeout,
            creationflags=_NO_WINDOW,
        )
        return (
            proc.stdout.decode(errors="replace"),
            proc.stderr.decode(errors="replace"),
            proc.returncode,
        )
    except subprocess.TimeoutExpired:
        return ("", f"Command timed out after {timeout}s: {cmd}", 1)


def _run_sync_bytes(cmd: str, timeout: int = 10) -> tuple[bytes, str, int]:
    """Run a command synchronously and return raw stdout bytes."""
    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            timeout=timeout,
            creationflags=_NO_WINDOW,
        )
        return (
            proc.stdout,
            proc.stderr.decode(errors="replace"),
            proc.returncode,
        )
    except subprocess.TimeoutExpired:
        return (b"", f"Command timed out after {timeout}s: {cmd}", 1)


class ADBDevice:
    """Represents a single connected ADB device."""

    def __init__(self, serial: str, status: str, model: str = ""):
        self.serial = serial
        self.status = status
        self.model = model

    def to_dict(self) -> dict:
        return {
            "serial": self.serial,
            "status": self.status,
            "model": self.model,
        }


class ADBService:
    """Manages ADB connections and command execution."""

    def __init__(self):
        self._active_serial: Optional[str] = None
        self._touch_device_cache: dict[str, tuple[str, int, int]] = {}  # serial → (dev_path, max_x, max_y)
        self._display_size_cache: dict[str, tuple[int, int]] = {}  # serial → (width, height)
        self._sendevent_mode: dict[str, str] = {}  # serial → "direct" | "su" | "none"

    # ------------------------------------------------------------------
    # Device management
    # ------------------------------------------------------------------

    async def list_devices(self) -> list[ADBDevice]:
        """List connected ADB devices."""
        output = await self._run("devices -l")
        devices: list[ADBDevice] = []
        for line in output.strip().splitlines()[1:]:
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            serial = parts[0]
            status = parts[1]
            model_match = re.search(r"model:(\S+)", line)
            model = model_match.group(1) if model_match else ""
            devices.append(ADBDevice(serial=serial, status=status, model=model))
        return devices

    async def restart_server(self) -> None:
        """Kill and restart the ADB server to recover stuck devices."""
        logger.info("Restarting ADB server (kill-server && start-server)")
        await self._run("kill-server")
        await self._run("start-server")
        logger.info("ADB server restarted")

    async def connect_device(self, address: str) -> str:
        """Connect to a device via 'adb connect <address>'."""
        return await self._run(f"connect {address}")

    async def disconnect_device(self, address: str) -> str:
        """Disconnect a device via 'adb disconnect <address>'."""
        return await self._run(f"disconnect {address}")

    async def get_active_device(self) -> Optional[str]:
        """Return the currently selected device serial."""
        return self._active_serial

    async def set_active_device(self, serial: str) -> bool:
        """Set the active device by serial number."""
        devices = await self.list_devices()
        serials = [d.serial for d in devices]
        if serial not in serials:
            return False
        self._active_serial = serial
        return True

    async def get_device_info(self, serial: Optional[str] = None) -> dict:
        """Get device properties."""
        s = serial or self._active_serial
        if not s:
            raise ValueError("No device selected")
        model = await self._run_device(s, "shell getprop ro.product.model")
        brand = await self._run_device(s, "shell getprop ro.product.brand")
        android_ver = await self._run_device(s, "shell getprop ro.build.version.release")
        resolution = await self._run_device(s, "shell wm size")
        # "Override size"가 있으면 스크린샷/터치가 이 해상도 기준이므로 우선 사용
        # 없으면 "Physical size" 사용
        override_match = re.search(r"Override size:\s*(\d+)x(\d+)", resolution)
        physical_match = re.search(r"Physical size:\s*(\d+)x(\d+)", resolution)
        res_match = override_match or physical_match
        width, height = (int(res_match.group(1)), int(res_match.group(2))) if res_match else (0, 0)
        # 디스플레이 목록 조회
        displays = await self.list_displays(s)
        # 멀티 디스플레이: 첫 번째 디스플레이의 해상도를 기본 해상도로 사용
        if displays and displays[0].get("width") and displays[0].get("height"):
            width = displays[0]["width"]
            height = displays[0]["height"]
        return {
            "serial": s,
            "model": model.strip(),
            "brand": brand.strip(),
            "android_version": android_ver.strip(),
            "resolution": {"width": width, "height": height},
            "displays": displays,
        }

    async def list_displays(self, serial: Optional[str] = None) -> list[dict]:
        """디바이스의 디스플레이 목록 조회 (SurfaceFlinger display ID 포함)."""
        s = serial or self._active_serial
        if not s:
            return []
        disp_output = await self._run_device(s, "shell dumpsys display")

        displays: list[dict] = []
        seen_sf_ids: set[str] = set()

        # 1) mViewports에서 논리 크기 추출 (logicalFrame = 실제 터치/screencap 좌표계)
        # deviceWidth/Height는 물리 해상도이므로 Override와 다를 수 있음
        viewport_map: dict[str, dict] = {}  # uniqueId → {width, height}
        for line in disp_output.split("\n"):
            if "DisplayViewport{" not in line:
                continue
            for vp_m in re.finditer(
                r"DisplayViewport\{[^}]*uniqueId='local:(\d+)'[^}]*logicalFrame=Rect\(\d+,\s*\d+\s*-\s*(\d+),\s*(\d+)\)",
                line
            ):
                viewport_map[vp_m.group(1)] = {
                    "width": int(vp_m.group(2)),
                    "height": int(vp_m.group(3)),
                }

        # 2) DisplayDeviceInfo 라인에서 SF ID, 해상도, 이름 추출
        for line in disp_output.split("\n"):
            if "DisplayDeviceInfo" not in line or 'uniqueId="local:' not in line:
                continue
            sf_m = re.search(r'uniqueId="local:(\d+)"', line)
            if not sf_m or sf_m.group(1) in seen_sf_ids:
                continue
            sf_id = sf_m.group(1)
            seen_sf_ids.add(sf_id)

            res_m = re.search(r"(\d{3,5})\s*x\s*(\d{3,5})", line)
            name_m = re.search(r"DeviceProductInfo\{name=(\S+?)[,}]", line)

            # 물리 해상도 (회전 전)
            phys_w = int(res_m.group(1)) if res_m else 0
            phys_h = int(res_m.group(2)) if res_m else 0
            name = name_m.group(1) if name_m else f"Display {len(displays)}"

            # viewport에서 논리 크기(회전 적용) 가져오기, 없으면 물리 크기 사용
            vp = viewport_map.get(sf_id)
            w = vp["width"] if vp else phys_w
            h = vp["height"] if vp else phys_h

            displays.append({
                "id": len(displays),
                "sf_id": sf_id,
                "name": name,
                "width": w,
                "height": h,
            })

        # 파싱 실패 시 기본 디스플레이
        if not displays:
            displays.append({"id": 0, "sf_id": None, "name": "Default"})

        return displays

    # ------------------------------------------------------------------
    # Input commands
    # ------------------------------------------------------------------

    def _display_flag(self, display_id: Optional[int]) -> str:
        """display_id가 지정된 경우 -d 플래그 반환 (멀티 디스플레이에서 display 0도 명시)."""
        if display_id is not None:
            return f"-d {display_id} "
        return ""

    async def tap(self, x: int, y: int, serial: Optional[str] = None, display_id: Optional[int] = None) -> str:
        s = serial or self._active_serial
        if not s:
            raise ValueError("No device selected")
        dflag = self._display_flag(display_id)
        return await self._run_device(s, f"shell input {dflag}tap {x} {y}")

    async def swipe(
        self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 300,
        serial: Optional[str] = None, display_id: Optional[int] = None,
    ) -> str:
        s = serial or self._active_serial
        if not s:
            raise ValueError("No device selected")
        dflag = self._display_flag(display_id)
        return await self._run_device(s, f"shell input {dflag}swipe {x1} {y1} {x2} {y2} {duration_ms}")

    # ------------------------------------------------------------------
    # 멀티터치 (sendevent 기반)
    # ------------------------------------------------------------------

    async def _find_touch_device(self, serial: str) -> tuple[str, int, int] | None:
        """터치 입력 디바이스 경로와 좌표 범위 검출. 결과 캐시.
        Returns (dev_path, max_x, max_y) or None.
        """
        if serial in self._touch_device_cache:
            return self._touch_device_cache[serial]

        output = await self._run_device(serial, "shell getevent -lp")
        current_device: str | None = None
        devices: dict[str, dict[str, int]] = {}

        for line in output.splitlines():
            m = re.match(r"add device \d+:\s+(.+)", line)
            if m:
                current_device = m.group(1).strip()
                continue
            if not current_device:
                continue
            if "ABS_MT_POSITION_X" in line:
                m2 = re.search(r"max\s+(\d+)", line)
                if m2:
                    devices.setdefault(current_device, {})["max_x"] = int(m2.group(1))
            elif "ABS_MT_POSITION_Y" in line:
                m2 = re.search(r"max\s+(\d+)", line)
                if m2:
                    devices.setdefault(current_device, {})["max_y"] = int(m2.group(1))

        for path, info in devices.items():
            mx, my = info.get("max_x", 0), info.get("max_y", 0)
            if mx > 0 and my > 0:
                result = (path, mx, my)
                self._touch_device_cache[serial] = result
                logger.info("Touch device: %s max=(%d,%d)", path, mx, my)
                return result
        return None

    async def _get_display_size(self, serial: str) -> tuple[int, int]:
        """디스플레이 논리 해상도 (wm size 기준). 결과 캐시."""
        if serial in self._display_size_cache:
            return self._display_size_cache[serial]
        raw = await self._run_device(serial, "shell wm size")
        override = re.search(r"Override size:\s*(\d+)x(\d+)", raw)
        physical = re.search(r"Physical size:\s*(\d+)x(\d+)", raw)
        m = override or physical
        if m:
            result = (int(m.group(1)), int(m.group(2)))
            self._display_size_cache[serial] = result
            return result
        return 0, 0

    async def multi_finger_swipe(
        self, fingers: list[dict], duration_ms: int = 500,
        serial: Optional[str] = None, display_id: Optional[int] = None,
    ) -> str:
        """sendevent 기반 멀티핑거 스와이프 (진짜 멀티터치).

        fingers: [{"x1": .., "y1": .., "x2": .., "y2": ..}, ...]
        """
        s = serial or self._active_serial
        if not s:
            raise ValueError("No device selected")
        return await self._sendevent_multitouch(fingers, duration_ms, s)

    async def multi_finger_tap(
        self, points: list[dict], serial: Optional[str] = None, display_id: Optional[int] = None,
    ) -> str:
        """sendevent 기반 멀티핑거 탭.

        points: [{"x": .., "y": ..}, ...]
        """
        s = serial or self._active_serial
        if not s:
            raise ValueError("No device selected")
        fingers = [{"x1": p["x"], "y1": p["y"], "x2": p["x"], "y2": p["y"]} for p in points]
        return await self._sendevent_multitouch(fingers, 50, s)

    async def _sendevent_multitouch(
        self, fingers: list[dict], duration_ms: int, serial: str,
    ) -> str:
        """멀티터치 제스처 실행. 우선순위:
        1) sendevent direct (shell이 /dev/input 쓰기 가능한 경우)
        2) sendevent + su 0 (root 사용)
        3) parallel input swipe fallback (진짜 멀티터치 아님)
        """
        cached = self._sendevent_mode.get(serial)

        # 캐시된 모드 사용
        if cached == "direct":
            return await self._sendevent_raw(fingers, duration_ms, serial, su=False)
        if cached == "su":
            return await self._sendevent_raw(fingers, duration_ms, serial, su=True)
        if cached == "none":
            return await self._parallel_input_swipe(fingers, duration_ms, serial)

        # 최초 시도: direct → su 0 → fallback (권한 테스트 후 캐시)
        touch = await self._find_touch_device(serial)
        if touch:
            loop = asyncio.get_event_loop()
            dev = touch[0]
            # 1) direct 권한 테스트
            test_cmd = f'{ADB_PATH} -s {serial} shell "sendevent {dev} 0 0 0"'
            _, test_err, test_rc = await loop.run_in_executor(None, functools.partial(_run_sync, test_cmd, 3))
            if test_rc == 0 and "Permission denied" not in test_err:
                self._sendevent_mode[serial] = "direct"
                logger.info("multitouch mode: sendevent direct (device %s)", serial)
                return await self._sendevent_raw(fingers, duration_ms, serial, su=False)

            # 2) su 0 권한 테스트
            test_su = f'{ADB_PATH} -s {serial} shell "su 0 sendevent {dev} 0 0 0"'
            _, test_err, test_rc = await loop.run_in_executor(None, functools.partial(_run_sync, test_su, 3))
            if test_rc == 0 and "not found" not in test_err and "Permission denied" not in test_err:
                self._sendevent_mode[serial] = "su"
                logger.info("multitouch mode: sendevent su (device %s)", serial)
                return await self._sendevent_raw(fingers, duration_ms, serial, su=True)

        # 3) Fallback
        logger.warning("multitouch: no method available (device %s), using parallel input", serial)
        self._sendevent_mode[serial] = "none"
        return await self._parallel_input_swipe(fingers, duration_ms, serial)

    # ---- sendevent 기반 (커널 레벨) ----

    def _build_sendevent_cmd(
        self, fingers: list[dict], duration_ms: int, serial: str,
        touch: tuple[str, int, int],
        display_size: tuple[int, int] = (0, 0),
    ) -> str:
        """sendevent 명령 시퀀스 문자열 생성."""
        dev, max_x, max_y = touch
        # 디스플레이 좌표(Override 기준) → 터치 디바이스 좌표로 변환
        dw, dh = display_size if display_size[0] > 0 else (max_x + 1, max_y + 1)

        def sx(x: float) -> int:
            return max(0, min(max_x, int(x * max_x / dw)))
        def sy(y: float) -> int:
            return max(0, min(max_y, int(y * max_y / dh)))

        steps = 20
        cmds: list[str] = []
        SE = f"sendevent {dev}"

        # BTN_TOUCH down
        cmds.append(f"{SE} 1 330 1")

        for i, f in enumerate(fingers):
            cmds += [
                f"{SE} 3 47 {i}", f"{SE} 3 57 {i}",
                f"{SE} 3 53 {sx(f['x1'])}", f"{SE} 3 54 {sy(f['y1'])}",
                f"{SE} 3 48 5",
            ]
        cmds.append(f"{SE} 0 0 0")

        sleep_s = max(0.01, duration_ms / 1000 / steps)
        for step in range(1, steps + 1):
            t = step / steps
            cmds.append(f"sleep {sleep_s:.3f}")
            for i, f in enumerate(fingers):
                ix = f["x1"] + (f["x2"] - f["x1"]) * t
                iy = f["y1"] + (f["y2"] - f["y1"]) * t
                cmds += [f"{SE} 3 47 {i}", f"{SE} 3 53 {sx(ix)}", f"{SE} 3 54 {sy(iy)}"]
            cmds.append(f"{SE} 0 0 0")

        # 릴리즈 전 대기 — 앱이 최종 위치를 인식할 시간 확보
        cmds.append("sleep 0.05")
        for i in range(len(fingers)):
            cmds += [f"{SE} 3 47 {i}", f"{SE} 3 57 -1"]
        # BTN_TOUCH up
        cmds.append(f"{SE} 1 330 0")
        cmds.append(f"{SE} 0 0 0")

        return "\n".join(cmds)

    _MT_SCRIPT_REMOTE = "/data/local/tmp/_mt.sh"

    async def _sendevent_raw(
        self, fingers: list[dict], duration_ms: int, serial: str, su: bool = False,
    ) -> str:
        touch = await self._find_touch_device(serial)
        if not touch:
            return ""
        display_size = await self._get_display_size(serial)
        script = self._build_sendevent_cmd(fingers, duration_ms, serial, touch, display_size)
        loop = asyncio.get_event_loop()
        timeout = max(15, duration_ms // 1000 + 10)

        # 스크립트를 디바이스에 push하고 실행 (인라인보다 안정적, 프로세스 오버헤드 없음)
        import tempfile
        with tempfile.NamedTemporaryFile(mode="w", suffix=".sh", delete=False, newline="\n") as f:
            f.write(script)
            local_path = f.name
        try:
            push_cmd = f'{ADB_PATH} -s {serial} push "{local_path}" {self._MT_SCRIPT_REMOTE}'
            await loop.run_in_executor(None, functools.partial(_run_sync, push_cmd, 5))

            if su:
                adb_cmd = f'{ADB_PATH} -s {serial} shell "su 0 sh {self._MT_SCRIPT_REMOTE}"'
            else:
                adb_cmd = f'{ADB_PATH} -s {serial} shell "sh {self._MT_SCRIPT_REMOTE}"'
            stdout, stderr, rc = await loop.run_in_executor(None, functools.partial(_run_sync, adb_cmd, timeout))
            if rc != 0:
                logger.error("sendevent failed: %s", stderr.strip())
            return stdout
        finally:
            Path(local_path).unlink(missing_ok=True)

    async def _parallel_input_swipe(
        self, fingers: list[dict], duration_ms: int, serial: str,
    ) -> str:
        """Fallback: parallel input swipe (진짜 멀티터치 아님)."""
        is_tap = all(f.get("x1") == f.get("x2") and f.get("y1") == f.get("y2") for f in fingers)
        if is_tap:
            cmds = [f"input tap {f['x1']} {f['y1']}" for f in fingers]
        else:
            cmds = [f"input swipe {f['x1']} {f['y1']} {f['x2']} {f['y2']} {duration_ms}" for f in fingers]
        parallel = " & ".join(cmds) + " & wait"
        return await self._run_device(serial, f'shell "{parallel}"')

    async def long_press(self, x: int, y: int, duration_ms: int = 1000,
                         serial: Optional[str] = None, display_id: Optional[int] = None) -> str:
        s = serial or self._active_serial
        if not s:
            raise ValueError("No device selected")
        dflag = self._display_flag(display_id)
        return await self._run_device(s, f"shell input {dflag}swipe {x} {y} {x} {y} {duration_ms}")

    async def input_text(self, text: str, serial: Optional[str] = None, display_id: Optional[int] = None) -> str:
        s = serial or self._active_serial
        if not s:
            raise ValueError("No device selected")
        escaped = text.replace(" ", "%s").replace("&", "\\&").replace("<", "\\<").replace(">", "\\>")
        dflag = self._display_flag(display_id)
        return await self._run_device(s, f'shell input {dflag}text "{escaped}"')

    async def key_event(self, keycode: str, serial: Optional[str] = None, display_id: Optional[int] = None) -> str:
        s = serial or self._active_serial
        if not s:
            raise ValueError("No device selected")
        dflag = self._display_flag(display_id)
        return await self._run_device(s, f"shell input {dflag}keyevent {keycode}")

    async def run_shell_command(self, command: str, serial: Optional[str] = None) -> str:
        """Run an arbitrary adb command on the device."""
        s = serial or self._active_serial
        if not s:
            raise ValueError("No device selected")
        return await self._run_device(s, command)

    # ------------------------------------------------------------------
    # Screenshot
    # ------------------------------------------------------------------

    async def screencap(self, save_path: str, serial: Optional[str] = None,
                        display_id: Optional[int] = None,
                        sf_display_id: Optional[str] = None) -> str:
        """Capture a screenshot and save as PNG.

        sf_display_id: SurfaceFlinger display ID (긴 숫자). 제공 시 -d 플래그로 사용.
        """
        s = serial or self._active_serial
        if not s:
            raise ValueError("No device selected")
        Path(save_path).parent.mkdir(parents=True, exist_ok=True)
        dflag = f"-d {sf_display_id} " if sf_display_id else ""
        loop = asyncio.get_event_loop()
        # 먼저 exec-out 시도 (빠름)
        cmd = f'{ADB_PATH} -s {s} exec-out screencap {dflag}-p > "{save_path}"'
        stdout, stderr, rc = await loop.run_in_executor(None, functools.partial(_run_sync, cmd))
        # 깨진 PNG 확인 → 파일 경유 폴백
        try:
            with open(save_path, "rb") as f:
                header = f.read(4)
            if header != b'\x89PNG':
                raise ValueError("corrupted")
        except Exception:
            logger.debug("exec-out screencap corrupted, falling back to file method")
            remote_path = "/data/local/tmp/_rk_screencap.png"
            cmd_save = f"{ADB_PATH} -s {s} shell screencap {dflag}-p {remote_path}"
            await loop.run_in_executor(None, functools.partial(_run_sync, cmd_save))
            cmd_pull = f'{ADB_PATH} -s {s} pull {remote_path} "{save_path}"'
            _, stderr2, rc2 = await loop.run_in_executor(None, functools.partial(_run_sync, cmd_pull))
            if rc2 != 0:
                logger.error("screencap pull error: %s", stderr2)
        return save_path

    async def screencap_bytes(self, serial: Optional[str] = None, fmt: str = "png",
                              display_id: Optional[int] = None,
                              sf_display_id: Optional[str] = None) -> bytes:
        """Capture a screenshot and return image bytes (png or jpeg).

        sf_display_id: SurfaceFlinger display ID (긴 숫자). 제공 시 -d 플래그로 사용.
        """
        s = serial or self._active_serial
        if not s:
            raise ValueError("No device selected")
        dflag = f"-d {sf_display_id} " if sf_display_id else ""

        # 먼저 exec-out (빠름) 시도
        cmd = f"{ADB_PATH} -s {s} exec-out screencap {dflag}-p"
        loop = asyncio.get_event_loop()
        stdout, stderr, rc = await loop.run_in_executor(None, functools.partial(_run_sync_bytes, cmd))

        # exec-out 실패 또는 깨진 PNG → 파일 경유 폴백 (멀티 디스플레이에서 안정적)
        if rc != 0 or (stdout and len(stdout) > 0 and stdout[:4] != b'\x89PNG'):
            logger.debug("exec-out screencap failed or corrupted, falling back to file method")
            remote_path = "/data/local/tmp/_rk_screencap.png"
            cmd_save = f"{ADB_PATH} -s {s} shell screencap {dflag}-p {remote_path}"
            _, stderr2, rc2 = await loop.run_in_executor(None, functools.partial(_run_sync, cmd_save))
            if rc2 == 0:
                cmd_cat = f"{ADB_PATH} -s {s} exec-out cat {remote_path}"
                stdout, _, _ = await loop.run_in_executor(None, functools.partial(_run_sync_bytes, cmd_cat))
            else:
                raise RuntimeError(f"screencap failed: {stderr2}")

        if fmt == "jpeg" and stdout:
            import cv2
            import numpy as np
            arr = np.frombuffer(stdout, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is not None:
                _, jpeg = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 70])
                return jpeg.tobytes()
        return stdout

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _run(self, args: str) -> str:
        cmd = f"{ADB_PATH} {args}"
        logger.debug("ADB cmd: %s", cmd)
        loop = asyncio.get_event_loop()
        stdout, stderr, rc = await loop.run_in_executor(None, functools.partial(_run_sync, cmd))
        if rc != 0:
            logger.error("ADB error: %s", stderr)
        return stdout

    async def _run_device(self, serial: str, args: str) -> str:
        cmd = f"{ADB_PATH} -s {serial} {args}"
        logger.debug("ADB cmd: %s", cmd)
        loop = asyncio.get_event_loop()
        stdout, stderr, rc = await loop.run_in_executor(None, functools.partial(_run_sync, cmd))
        if rc != 0:
            logger.error("ADB error (device %s): %s", serial, stderr)
        return stdout
