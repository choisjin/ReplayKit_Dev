"""ADB Service — Android Debug Bridge 연결 관리 및 명령 실행."""

from __future__ import annotations

import asyncio
import functools
import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

ADB_PATH = os.environ.get("ADB_PATH", "adb")


def _run_sync(cmd: str, timeout: int = 10) -> tuple[str, str, int]:
    """Run a command synchronously and return (stdout, stderr, returncode)."""
    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            timeout=timeout,
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
        # parse resolution e.g. "Physical size: 1080x1920"
        res_match = re.search(r"(\d+)x(\d+)", resolution)
        width, height = (int(res_match.group(1)), int(res_match.group(2))) if res_match else (0, 0)
        # 디스플레이 목록 조회
        displays = await self.list_displays(s)
        return {
            "serial": s,
            "model": model.strip(),
            "brand": brand.strip(),
            "android_version": android_ver.strip(),
            "resolution": {"width": width, "height": height},
            "displays": displays,
        }

    async def list_displays(self, serial: Optional[str] = None) -> list[dict]:
        """디바이스의 디스플레이 목록 조회."""
        s = serial or self._active_serial
        if not s:
            return []
        output = await self._run_device(s, "shell dumpsys SurfaceFlinger --display-id")
        displays: list[dict] = []
        # 기본 디스플레이(0)는 항상 포함
        displays.append({"id": 0, "name": "Default"})
        # dumpsys display로 추가 디스플레이 탐색
        disp_output = await self._run_device(s, "shell dumpsys display")
        seen_ids = {0}
        for m in re.finditer(r"mDisplayId=(\d+)", disp_output):
            did = int(m.group(1))
            if did not in seen_ids:
                seen_ids.add(did)
                displays.append({"id": did, "name": f"Display {did}"})
        return displays

    # ------------------------------------------------------------------
    # Input commands
    # ------------------------------------------------------------------

    def _display_flag(self, display_id: Optional[int]) -> str:
        """display_id가 0이 아닌 경우 --display-id 플래그 반환."""
        if display_id is not None and display_id != 0:
            return f"--display-id {display_id} "
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

    async def screencap(self, save_path: str, serial: Optional[str] = None, display_id: Optional[int] = None) -> str:
        """Capture a screenshot and save as PNG."""
        s = serial or self._active_serial
        if not s:
            raise ValueError("No device selected")
        Path(save_path).parent.mkdir(parents=True, exist_ok=True)
        dflag = f"--display-id {display_id} " if display_id else ""
        cmd = f'{ADB_PATH} -s {s} exec-out screencap {dflag}-p > "{save_path}"'
        loop = asyncio.get_event_loop()
        stdout, stderr, rc = await loop.run_in_executor(None, functools.partial(_run_sync, cmd))
        if rc != 0:
            logger.error("screencap save error: %s", stderr)
        return save_path

    async def screencap_bytes(self, serial: Optional[str] = None, fmt: str = "png", display_id: Optional[int] = None) -> bytes:
        """Capture a screenshot and return image bytes (png or jpeg)."""
        s = serial or self._active_serial
        if not s:
            raise ValueError("No device selected")
        dflag = f"--display-id {display_id} " if display_id else ""
        cmd = f"{ADB_PATH} -s {s} exec-out screencap {dflag}-p"
        loop = asyncio.get_event_loop()
        stdout, stderr, rc = await loop.run_in_executor(None, functools.partial(_run_sync_bytes, cmd))
        if rc != 0:
            raise RuntimeError(f"screencap failed: {stderr}")
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
