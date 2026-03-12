"""Unified Device Manager — ADB + Serial 장치를 통합 관리."""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import re
from pathlib import Path
from typing import Optional

from .adb_service import ADBService

logger = logging.getLogger(__name__)

_AUX_DEVICES_FILE = Path(__file__).resolve().parent.parent.parent / "auxiliary_devices.json"


def _scan_serial_ports() -> list[dict]:
    from serial.tools import list_ports
    ports = []
    for p in list_ports.comports():
        ports.append({
            "port": p.device,
            "description": p.description,
            "hwid": p.hwid,
            "manufacturer": p.manufacturer or "",
            "vid": f"0x{p.vid:04X}" if p.vid else "",
            "pid": f"0x{p.pid:04X}" if p.pid else "",
        })
    return ports


def _validate_serial(port: str, baudrate: int) -> str:
    import serial
    s = serial.Serial(port, baudrate=baudrate, timeout=1)
    s.close()
    return f"OK: {port} @ {baudrate} baud"


def _send_serial(port: str, baudrate: int, data: str, read_timeout: float = 1.0) -> str:
    """Send data to a serial port and return the response."""
    import serial
    import time
    s = serial.Serial(port, baudrate=baudrate, timeout=read_timeout)
    try:
        s.write(data.encode())
        s.flush()
        time.sleep(read_timeout)
        response = b""
        while s.in_waiting:
            response += s.read(s.in_waiting)
        return response.decode(errors="replace")
    finally:
        s.close()


class ManagedDevice:
    """A device tracked by the manager (ADB or Serial)."""

    def __init__(
        self,
        id: str,
        type: str,  # "adb" | "serial"
        category: str,  # "primary" | "auxiliary"
        address: str,
        status: str = "connected",
        name: str = "",
        info: Optional[dict] = None,
    ):
        self.id = id
        self.type = type
        self.category = category
        self.address = address
        self.status = status
        self.name = name
        self.info = info or {}

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "category": self.category,
            "address": self.address,
            "status": self.status,
            "name": self.name,
            "info": self.info,
        }


class DeviceManager:
    """Manages all connected devices (ADB + Serial)."""

    def __init__(self, adb: ADBService):
        self.adb = adb
        self._devices: dict[str, ManagedDevice] = {}
        self._load_auxiliary_devices()

    def _load_auxiliary_devices(self) -> None:
        """Load saved auxiliary devices from disk."""
        if not _AUX_DEVICES_FILE.exists():
            return
        try:
            data = json.loads(_AUX_DEVICES_FILE.read_text(encoding="utf-8"))
            for d in data:
                dev = ManagedDevice(
                    id=d["id"],
                    type=d["type"],
                    category=d.get("category", "primary" if d["type"] == "adb" else "auxiliary"),
                    address=d["address"],
                    status="unknown",
                    name=d.get("name", d["id"]),
                    info=d.get("info", {}),
                )
                self._devices[dev.id] = dev
            logger.info("Loaded %d auxiliary devices from %s", len(data), _AUX_DEVICES_FILE)
        except Exception as e:
            logger.warning("Failed to load auxiliary devices: %s", e)

    def _generate_device_id(self, dev_type: str, module_name: str = "") -> str:
        """Auto-generate a device ID like Android_1, Serial_1, POWER_1, etc."""
        if dev_type == "adb":
            prefix = "Android"
        elif dev_type == "serial":
            prefix = "Serial"
        elif dev_type == "module" and module_name:
            prefix = module_name
        else:
            prefix = "Device"
        # Find the highest existing number for this prefix
        pattern = re.compile(rf"^{re.escape(prefix)}_(\d+)$", re.IGNORECASE)
        max_num = 0
        for existing_id in self._devices:
            m = pattern.match(existing_id)
            if m:
                max_num = max(max_num, int(m.group(1)))
        return f"{prefix}_{max_num + 1}"

    def _save_auxiliary_devices(self) -> None:
        """Persist all manually registered devices (auxiliary + ADB with custom IDs) to disk."""
        aux = [d.to_dict() for d in self._devices.values() if d.category == "auxiliary" or d.type == "adb"]
        try:
            _AUX_DEVICES_FILE.write_text(json.dumps(aux, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            logger.warning("Failed to save auxiliary devices: %s", e)

    async def refresh_adb(self) -> None:
        """Sync ADB device statuses — only update already-registered ADB devices."""
        adb_devices = await self.adb.list_devices()
        adb_status_map = {d.serial: d for d in adb_devices}

        for k, v in self._devices.items():
            if v.type != "adb":
                continue
            # Check by address (actual ADB serial) instead of device id (may be alias)
            adb_serial = v.address
            if adb_serial in adb_status_map:
                d = adb_status_map[adb_serial]
                v.status = d.status
                if d.status == "device":
                    try:
                        info = await self.adb.get_device_info(d.serial)
                        if not v.name or v.name == v.address:
                            v.name = info.get("model", v.name)
                        v.info = info
                    except Exception:
                        pass
            else:
                v.status = "offline"

    async def add_adb_device(self, serial: str, device_id: str = "", name: str = "") -> ManagedDevice:
        """Manually register an ADB device with a custom device ID."""
        final_id = device_id or self._generate_device_id("adb")
        display_name = name or serial

        # Try to get device info
        info = {}
        try:
            adb_devices = await self.adb.list_devices()
            found = next((d for d in adb_devices if d.serial == serial), None)
            if found and found.status == "device":
                info = await self.adb.get_device_info(serial)
                if not name:
                    display_name = info.get("model", serial)
        except Exception:
            pass

        dev = ManagedDevice(
            id=final_id,
            type="adb",
            category="primary",
            address=serial,
            status="connected",
            name=display_name,
            info=info,
        )
        self._devices[final_id] = dev
        self._save_auxiliary_devices()  # persist all non-adb + adb with custom IDs
        return dev

    async def refresh_auxiliary(self) -> None:
        """Check connectivity of auxiliary devices and update their status."""
        loop = asyncio.get_event_loop()
        available_ports = {p["port"] for p in await loop.run_in_executor(None, _scan_serial_ports)}

        for dev in self._devices.values():
            if dev.category != "auxiliary":
                continue
            ct = dev.info.get("connect_type", "serial" if dev.type == "serial" else "none")
            if dev.type == "serial" or ct == "serial":
                # Check if COM port exists in system
                port = dev.address
                dev.status = "connected" if port in available_ports else "disconnected"
            elif ct == "socket":
                # Quick TCP connection check
                import socket
                host = dev.address
                port_num = dev.info.get("port", 0)
                if host and port_num:
                    try:
                        def _check_socket():
                            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                            s.settimeout(1)
                            try:
                                s.connect((host, int(port_num)))
                                s.close()
                                return True
                            except Exception:
                                s.close()
                                return False
                        ok = await loop.run_in_executor(None, _check_socket)
                        dev.status = "connected" if ok else "disconnected"
                    except Exception:
                        dev.status = "disconnected"
                # If no port info, leave status as-is
            # For 'none', 'can', etc. — we can't check, leave status as-is

    async def scan_serial(self) -> list[dict]:
        """Scan available serial ports."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _scan_serial_ports)

    async def add_serial_device(self, port: str, baudrate: int = 115200, name: str = "", category: str = "auxiliary", device_id: str = "") -> ManagedDevice:
        """Add a serial device to the managed list."""
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(None, functools.partial(_validate_serial, port, baudrate))
        except Exception as e:
            raise RuntimeError(f"Cannot open {port}: {e}")

        final_id = device_id or self._generate_device_id("serial")
        dev = ManagedDevice(
            id=final_id,
            type="serial",
            category=category,
            address=port,
            status="connected",
            name=name or final_id,
            info={"baudrate": baudrate},
        )
        self._devices[final_id] = dev
        self._save_auxiliary_devices()
        return dev

    async def add_module_device(self, address: str, module: str, connect_type: str = "none",
                               name: str = "", extra_fields: dict | None = None, device_id: str = "") -> ManagedDevice:
        """Add a module-only device (socket, CAN, no-connection, etc.)."""
        final_id = device_id or self._generate_device_id("module", module)
        display_name = name or (f"{module} ({address})" if address else module)
        info: dict = {"module": module, "connect_type": connect_type}
        if extra_fields:
            info.update(extra_fields)
        dev = ManagedDevice(
            id=final_id,
            type="module",
            category="auxiliary",
            address=address,
            status="connected",
            name=display_name,
            info=info,
        )
        self._devices[final_id] = dev
        self._save_auxiliary_devices()
        return dev

    async def add_adb_wifi(self, address: str) -> ManagedDevice:
        """Connect ADB over WiFi and add to managed list."""
        result = await self.adb.connect_device(address)
        await self.refresh_adb()
        if address in self._devices:
            return self._devices[address]
        # Might be connected with different format
        dev = ManagedDevice(
            id=address,
            type="adb",
            category="primary",
            address=address,
            status="connected",
            name=address,
            info={"connect_result": result.strip()},
        )
        self._devices[address] = dev
        return dev

    async def remove_device(self, device_id: str) -> str:
        """Remove a device from managed list."""
        dev = self.get_device(device_id)
        if not dev:
            return f"Device {device_id} not found"

        if dev.type == "adb" and ":" in dev.address:
            result = await self.adb.disconnect_device(dev.address)
        else:
            result = f"Removed {dev.id}"

        self._devices.pop(dev.id, None)
        self._save_auxiliary_devices()
        return result

    def list_all(self) -> list[ManagedDevice]:
        """List all managed devices."""
        return list(self._devices.values())

    def list_primary(self) -> list[ManagedDevice]:
        """List primary devices (screen-controllable: ADB, Linux, etc.)."""
        return [d for d in self._devices.values() if d.category == "primary"]

    def list_auxiliary(self) -> list[ManagedDevice]:
        """List auxiliary devices (serial, USB, etc.)."""
        return [d for d in self._devices.values() if d.category == "auxiliary"]

    def get_device(self, device_id: str) -> Optional[ManagedDevice]:
        """Look up device by id first, then by address as fallback."""
        dev = self._devices.get(device_id)
        if dev:
            return dev
        # Fallback: search by address (real serial/port)
        for d in self._devices.values():
            if d.address == device_id:
                return d
        return None

    async def send_serial_command(self, device_id: str, data: str, read_timeout: float = 1.0) -> str:
        """Send a command to a serial device and return the response."""
        dev = self.get_device(device_id)
        if not dev or dev.type != "serial":
            raise ValueError(f"Serial device {device_id} not found")
        baudrate = dev.info.get("baudrate", 115200)
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, functools.partial(_send_serial, dev.address, baudrate, data, read_timeout)
        )
