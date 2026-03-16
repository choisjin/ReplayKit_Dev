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
from .hkmc6th_service import HKMC6thService

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


HKMC_SCAN_PORTS = [6655, 5000]
HKMC_HANDSHAKE_VALUES = {
    bytes.fromhex("6161000000035e002185fd6f6f"),
    bytes.fromhex("6161000000035e0000df856f6f"),
}


async def _probe_hkmc_host(
    ip: str, port: int, timeout: float, semaphore: asyncio.Semaphore
) -> dict | None:
    """단일 IP에 TCP 연결 시도 + HKMC 핸드셰이크 검증."""
    async with semaphore:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, port), timeout=timeout
            )
            try:
                data = await asyncio.wait_for(reader.read(13), timeout=2.0)
                verified = data in HKMC_HANDSHAKE_VALUES
            except Exception:
                verified = False
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            if verified:
                return {"ip": ip, "port": port}
            return None
        except (asyncio.TimeoutError, OSError, ConnectionRefusedError):
            return None


async def _scan_hkmc_tcp(
    ports: list[int] | None = None,
    connect_timeout: float = 0.3,
    max_concurrent: int = 100,
) -> list[dict]:
    """LAN 서브넷의 모든 IP에 TCP 연결을 시도하여 HKMC 에이전트를 탐지한다."""
    import ipaddress
    import ifaddr

    if ports is None:
        ports = HKMC_SCAN_PORTS

    # 로컬 IP 수집
    local_ips: set[str] = {"127.0.0.1"}
    subnets: list[ipaddress.IPv4Network] = []

    for adapter in ifaddr.get_adapters():
        for ip_info in adapter.ips:
            if not isinstance(ip_info.ip, str):  # IPv6 튜플 제외
                continue
            ip_str = ip_info.ip
            prefix = ip_info.network_prefix
            if ip_str.startswith("127.") or ip_str.startswith("169.254."):
                continue
            local_ips.add(ip_str)
            try:
                net = ipaddress.IPv4Network(f"{ip_str}/{prefix}", strict=False)
                # /20보다 큰 서브넷은 제외 (대규모 스캔 방지)
                if net.prefixlen >= 20:
                    subnets.append(net)
            except ValueError:
                pass

    # 서브넷 중복 제거
    unique = list({str(s): s for s in subnets}.values())

    # 후보 IP 생성
    candidate_ips: set[str] = set()
    for subnet in unique:
        for host in subnet.hosts():
            ip_str = str(host)
            if ip_str not in local_ips:
                candidate_ips.add(ip_str)

    if not candidate_ips:
        return []

    # 모든 후보 IP × 모든 포트에 대해 병렬 프로브
    semaphore = asyncio.Semaphore(max_concurrent)
    tasks = [
        _probe_hkmc_host(ip, port, connect_timeout, semaphore)
        for ip in candidate_ips
        for port in ports
    ]
    results = await asyncio.gather(*tasks)
    found = [r for r in results if r is not None]

    # 같은 IP가 여러 포트에서 발견될 경우 첫 번째만 유지
    seen_ips: set[str] = set()
    deduped: list[dict] = []
    for r in found:
        if r["ip"] not in seen_ips:
            seen_ips.add(r["ip"])
            deduped.append(r)
            logger.info("HKMC TCP scan: found device at %s:%d", r["ip"], r["port"])

    return deduped


async def _probe_tcp_open(
    ip: str, port: int, timeout: float, semaphore: asyncio.Semaphore
) -> dict | None:
    """단일 IP:port에 TCP 연결이 열리는지만 확인 (핸드셰이크 없음)."""
    async with semaphore:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, port), timeout=timeout
            )
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return {"ip": ip, "port": port}
        except (asyncio.TimeoutError, OSError, ConnectionRefusedError):
            return None


async def _scan_tcp_generic(
    ports: list[int],
    connect_timeout: float = 0.3,
    max_concurrent: int = 100,
) -> list[dict]:
    """LAN 서브넷에서 지정 TCP 포트가 열린 호스트를 탐색한다."""
    import ipaddress
    import ifaddr

    if not ports:
        return []

    # 로컬 IP 수집
    local_ips: set[str] = {"127.0.0.1"}
    subnets: list[ipaddress.IPv4Network] = []

    for adapter in ifaddr.get_adapters():
        for ip_info in adapter.ips:
            if not isinstance(ip_info.ip, str):
                continue
            ip_str = ip_info.ip
            prefix = ip_info.network_prefix
            if ip_str.startswith("127.") or ip_str.startswith("169.254."):
                continue
            local_ips.add(ip_str)
            try:
                net = ipaddress.IPv4Network(f"{ip_str}/{prefix}", strict=False)
                if net.prefixlen >= 20:
                    subnets.append(net)
            except ValueError:
                pass

    unique = list({str(s): s for s in subnets}.values())

    candidate_ips: set[str] = set()
    for subnet in unique:
        for host in subnet.hosts():
            ip_str = str(host)
            if ip_str not in local_ips:
                candidate_ips.add(ip_str)

    if not candidate_ips:
        return []

    semaphore = asyncio.Semaphore(max_concurrent)
    tasks = [
        _probe_tcp_open(ip, port, connect_timeout, semaphore)
        for ip in candidate_ips
        for port in ports
    ]
    results = await asyncio.gather(*tasks)
    found = [r for r in results if r is not None]

    # IP+port 별 중복 제거
    seen: set[str] = set()
    deduped: list[dict] = []
    for r in found:
        key = f"{r['ip']}:{r['port']}"
        if key not in seen:
            seen.add(key)
            deduped.append(r)
            logger.info("TCP scan: found open port at %s:%d", r["ip"], r["port"])

    return deduped


def _validate_serial(port: str, baudrate: int) -> str:
    import serial
    s = serial.Serial(port, baudrate=baudrate, timeout=1)
    s.close()
    return f"OK: {port} @ {baudrate} baud"


def _send_serial_persistent(conn, data: str, read_timeout: float = 1.0) -> str:
    """Send data on an already-open serial connection and return the response."""
    import time
    # Drain any leftover data before sending
    if conn.in_waiting:
        conn.read(conn.in_waiting)
    # Ensure newline terminator for Arduino readStringUntil('\n')
    if not data.endswith("\n"):
        data += "\n"
    conn.write(data.encode())
    conn.flush()
    time.sleep(read_timeout)
    response = b""
    while conn.in_waiting:
        response += conn.read(conn.in_waiting)
    # Strip null bytes from response
    return response.replace(b"\x00", b"").decode(errors="replace").strip()


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
        self._serial_conns: dict[str, "serial.Serial"] = {}  # device_id -> open serial connection
        self._hkmc_conns: dict[str, HKMC6thService] = {}  # device_id -> HKMC6thService
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
        """Auto-generate a device ID like Android_1, Serial_1, HKMC_1, POWER_1, etc."""
        if dev_type == "adb":
            prefix = "Android"
        elif dev_type == "serial":
            prefix = "Serial"
        elif dev_type == "hkmc6th":
            prefix = "HKMC"
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
        """Persist all manually registered devices (auxiliary + ADB + HKMC) to disk."""
        aux = [d.to_dict() for d in self._devices.values() if d.category == "auxiliary" or d.type in ("adb", "hkmc6th")]
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

    async def add_hkmc6th_device(self, host: str, port: int, device_id: str = "", name: str = "") -> ManagedDevice:
        """Connect to an HKMC 6th gen IVI device over TCP and register it."""
        final_id = device_id or self._generate_device_id("hkmc6th")
        display_name = name or f"HKMC ({host}:{port})"

        svc = HKMC6thService(host, port, device_id=final_id)
        ok = await svc.async_connect()
        if not ok:
            raise RuntimeError(f"Cannot connect to HKMC agent at {host}:{port}")

        info = svc.get_info()
        dev = ManagedDevice(
            id=final_id,
            type="hkmc6th",
            category="primary",
            address=host,
            status="connected",
            name=display_name,
            info={"port": port, "agent_version": svc.agent_version, "screens": info["screens"]},
        )
        self._devices[final_id] = dev
        self._hkmc_conns[final_id] = svc
        self._save_auxiliary_devices()
        return dev

    def get_hkmc_service(self, device_id: str) -> Optional[HKMC6thService]:
        """Get HKMC6thService instance for a device. Returns None if not found."""
        svc = self._hkmc_conns.get(device_id)
        if svc:
            return svc
        # Fallback: device_map이 address로 해석된 경우, address로 디바이스를 찾아 ID로 재조회
        dev = self.get_device(device_id)
        if dev and dev.type == "hkmc6th":
            return self._hkmc_conns.get(dev.id)
        return None

    async def refresh_auxiliary(self) -> None:
        """Check connectivity of auxiliary/HKMC devices and update their status."""
        loop = asyncio.get_event_loop()
        available_ports = {p["port"] for p in await loop.run_in_executor(None, _scan_serial_ports)}

        for dev in self._devices.values():
            # Check HKMC primary devices
            if dev.type == "hkmc6th":
                hkmc = self._hkmc_conns.get(dev.id)
                dev.status = "connected" if (hkmc and hkmc.is_connected) else "disconnected"
                continue
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

    async def scan_hkmc(self) -> list[dict]:
        """TCP 포트 스캔으로 LAN 상의 HKMC 디바이스 탐지."""
        return await _scan_hkmc_tcp()

    async def scan_tcp(self, ports: list[int] | None = None) -> list[dict]:
        """LAN에서 지정 TCP 포트가 열린 호스트를 탐색 (보조디바이스용)."""
        if ports is None:
            # socket 타입 모듈의 scan_ports에서 수집
            from .module_service import list_available_modules
            port_set: set[int] = set()
            for m in list_available_modules():
                if m.get("connect_type") == "socket" and m.get("scan_ports"):
                    port_set.update(m["scan_ports"])
            ports = list(port_set)
        return await _scan_tcp_generic(ports)

    async def add_serial_device(self, port: str, baudrate: int = 115200, name: str = "", category: str = "auxiliary", device_id: str = "") -> ManagedDevice:
        """Add a serial device and open a persistent connection."""
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

        # Open persistent connection (validates port + keeps it open)
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(None, self._get_serial_conn, final_id)
        except Exception as e:
            # Remove device if connection fails
            self._devices.pop(final_id, None)
            self._save_auxiliary_devices()
            raise RuntimeError(f"Cannot open {port}: {e}")

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

        self._close_serial_conn(dev.id)
        # Close HKMC connection if applicable
        hkmc = self._hkmc_conns.pop(dev.id, None)
        if hkmc:
            hkmc.disconnect()
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

    def _get_serial_conn(self, device_id: str):
        """Get or create a persistent serial connection (no DTR reset on reuse)."""
        import serial as pyserial
        dev = self.get_device(device_id)
        if not dev:
            raise ValueError(f"Device {device_id} not found")
        conn = self._serial_conns.get(device_id)
        if conn and conn.is_open:
            return conn
        port = dev.address
        baudrate = dev.info.get("baudrate", 115200)
        conn = pyserial.Serial(port, baudrate=baudrate, timeout=1)
        self._serial_conns[device_id] = conn
        # Wait for Arduino bootloader + setup() to finish
        import time
        time.sleep(3)
        # Drain all startup garbage (null bytes, boot messages, etc.)
        conn.reset_input_buffer()
        conn.reset_output_buffer()
        logger.info("Serial port opened and drained: %s (%s @ %d)", device_id, port, baudrate)
        return conn

    def _close_serial_conn(self, device_id: str) -> None:
        """Close a persistent serial connection."""
        conn = self._serial_conns.pop(device_id, None)
        if conn and conn.is_open:
            conn.close()

    async def open_all_serial_connections(self) -> None:
        """Open persistent serial/HKMC connections for all registered devices."""
        loop = asyncio.get_event_loop()
        for dev in self._devices.values():
            if dev.type == "serial":
                try:
                    await loop.run_in_executor(None, self._get_serial_conn, dev.id)
                    dev.status = "connected"
                    logger.info("Serial connection opened: %s (%s)", dev.id, dev.address)
                except Exception as e:
                    dev.status = "disconnected"
                    logger.warning("Failed to open serial %s (%s): %s", dev.id, dev.address, e)
            elif dev.type == "hkmc6th":
                port = dev.info.get("port", 0)
                if not port:
                    continue
                try:
                    svc = HKMC6thService(dev.address, port, device_id=dev.id)
                    ok = await svc.async_connect()
                    if ok:
                        self._hkmc_conns[dev.id] = svc
                        dev.status = "connected"
                        dev.info["agent_version"] = svc.agent_version
                        dev.info["screens"] = svc.get_info()["screens"]
                        logger.info("HKMC connection opened: %s (%s:%d)", dev.id, dev.address, port)
                    else:
                        dev.status = "disconnected"
                except Exception as e:
                    dev.status = "disconnected"
                    logger.warning("Failed to open HKMC %s (%s:%d): %s", dev.id, dev.address, port, e)

    def close_all_serial_connections(self) -> None:
        """Close all persistent serial/HKMC connections (called on shutdown)."""
        for device_id in list(self._serial_conns.keys()):
            self._close_serial_conn(device_id)
            logger.info("Serial connection closed: %s", device_id)
        for device_id, hkmc in list(self._hkmc_conns.items()):
            hkmc.disconnect()
            logger.info("HKMC connection closed: %s", device_id)
        self._hkmc_conns.clear()

    async def send_serial_command(self, device_id: str, data: str, read_timeout: float = 1.0) -> str:
        """Send a command to a serial device and return the response."""
        dev = self.get_device(device_id)
        if not dev or dev.type != "serial":
            raise ValueError(f"Serial device {device_id} not found")
        loop = asyncio.get_event_loop()
        conn = await loop.run_in_executor(None, self._get_serial_conn, device_id)
        logger.info("Serial send [%s] port=%s open=%s data=%r", device_id, dev.address, conn.is_open, data)
        result = await loop.run_in_executor(
            None, functools.partial(_send_serial_persistent, conn, data, read_timeout)
        )
        logger.info("Serial recv [%s] response=%r", device_id, result)
        return result
