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


# ── DLT 데몬 TCP 스캔 ──────────────────────────────────────────────

DLT_SCAN_PORTS = [3490]


async def _probe_dlt_host(
    ip: str, port: int, timeout: float, semaphore: asyncio.Semaphore
) -> dict | None:
    """단일 IP에 TCP 연결 시도로 DLT 데몬 탐지."""
    async with semaphore:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, port), timeout=timeout
            )
            # DLT 데몬은 연결 즉시 메시지를 보내므로 짧게 읽어 검증
            verified = False
            try:
                data = await asyncio.wait_for(reader.read(4), timeout=1.5)
                if len(data) >= 4:
                    # DLT Standard Header: version 1 = (htyp >> 5) & 0x07 == 1
                    htyp = data[0]
                    version = (htyp >> 5) & 0x07
                    verified = version == 1
                elif len(data) > 0:
                    # 데이터가 오면 DLT일 가능성 있음
                    verified = True
            except Exception:
                # 연결은 되지만 데이터가 없을 수도 있음 — 포트 열림만으로 후보 처리
                verified = True
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            if verified:
                return {"ip": ip, "port": port}
        except Exception:
            pass
    return None


async def _scan_dlt_tcp(
    ports: list[int] | None = None,
    connect_timeout: float = 0.3,
    max_concurrent: int = 100,
) -> list[dict]:
    """LAN 서브넷의 모든 IP에서 DLT 데몬(TCP 3490)을 탐지."""
    import ipaddress
    import ifaddr

    if ports is None:
        ports = DLT_SCAN_PORTS

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
            # 사내망(10.x) 제외 — DLT는 전용 네트워크에 있음
            if ip_str.startswith("10."):
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
        _probe_dlt_host(ip, port, connect_timeout, semaphore)
        for ip in candidate_ips
        for port in ports
    ]
    results = await asyncio.gather(*tasks)
    found = [r for r in results if r is not None]

    seen_ips: set[str] = set()
    deduped: list[dict] = []
    for r in found:
        if r["ip"] not in seen_ips:
            seen_ips.add(r["ip"])
            deduped.append(r)
            logger.info("DLT scan: found daemon at %s:%d", r["ip"], r["port"])

    return deduped


BENCH_UDP_SCAN_PORTS = [25000]
BENCH_UDP_PROBE = bytes([0x55, 0xAA, 100, 0, 0x20, 0x02, 0x00, 0x00])


def _probe_udp_bench_sync(ip: str, port: int, timeout: float) -> dict | None:
    """UDP 프로브 전송 후 0x55 0xAA 응답이면 verified."""
    import socket as _socket
    sock = None
    try:
        sock = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        sock.connect((ip, port))
        sock.sendto(BENCH_UDP_PROBE, (ip, port))
        sock.settimeout(timeout)
        data = sock.recv(16)
        sock.settimeout(None)
        if len(data) >= 2 and data[0] == 0x55 and data[1] == 0xAA:
            return {"ip": ip, "port": port, "verified": True}
    except Exception:
        pass
    finally:
        if sock:
            try:
                sock.close()
            except Exception:
                pass
    return None


def _get_arp_hosts() -> set[str]:
    """시스템 ARP 테이블에서 알려진 호스트 IP 수집."""
    import subprocess
    hosts: set[str] = set()
    try:
        result = subprocess.run("arp -a", capture_output=True, text=True,
                                shell=True, timeout=5)
        for line in result.stdout.splitlines():
            m = re.search(r"(\d+\.\d+\.\d+\.\d+)", line)
            if m:
                ip = m.group(1)
                if not ip.endswith(".255") and not ip.startswith("224.") and not ip.startswith("239."):
                    hosts.add(ip)
    except Exception:
        pass
    return hosts


async def _ping_host(ip: str) -> str | None:
    """단일 호스트 ping (Windows)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ping", "-n", "1", "-w", "500", ip,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        rc = await asyncio.wait_for(proc.wait(), timeout=2.0)
        return ip if rc == 0 else None
    except Exception:
        return None


async def _scan_network_hosts(
    max_concurrent: int = 50,
) -> list[dict]:
    """LAN 서브넷의 활성 호스트 탐지 (ARP + ping + UDP 프로브)."""
    import ipaddress
    import ifaddr

    ports = BENCH_UDP_SCAN_PORTS

    # 로컬 IP 수집 & 서브넷 탐지
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
                # 벤치 전용 네트워크만 대상 (192.168.x.x)
                # 10.x.x.x (사내), 172.16-31.x.x (기업) 등 대규모 네트워크 제외
                if net.prefixlen >= 20 and ip_str.startswith("192.168."):
                    subnets.append(net)
            except ValueError:
                pass

    unique = list({str(s): s for s in subnets}.values())
    logger.info("Network scan: %d subnets: %s", len(unique), [str(s) for s in unique])

    # 서브넷별 후보 IP
    candidate_ips: set[str] = set()
    for subnet in unique:
        for host in subnet.hosts():
            ip_str = str(host)
            if ip_str not in local_ips:
                candidate_ips.add(ip_str)

    if not candidate_ips:
        return []

    # 1단계: ARP 테이블에서 이미 알려진 호스트
    loop = asyncio.get_event_loop()
    arp_hosts = await loop.run_in_executor(None, _get_arp_hosts)
    subnet_arp = candidate_ips & arp_hosts
    logger.info("Network scan: ARP table has %d hosts on target subnets", len(subnet_arp))

    # 2단계: ARP에 없는 IP는 ping 스윕 (병렬)
    ping_targets = candidate_ips - arp_hosts
    semaphore = asyncio.Semaphore(max_concurrent)

    async def _ping_with_sem(ip: str):
        async with semaphore:
            return await _ping_host(ip)

    if ping_targets:
        logger.info("Network scan: pinging %d additional IPs...", len(ping_targets))
        ping_results = await asyncio.gather(*[_ping_with_sem(ip) for ip in ping_targets])
        ping_alive = {ip for ip in ping_results if ip is not None}
    else:
        ping_alive = set()

    # 3단계: 활성 호스트에 UDP 프로브
    all_alive = subnet_arp | ping_alive
    logger.info("Network scan: %d alive hosts, running UDP probe...", len(all_alive))

    udp_sem = asyncio.Semaphore(max_concurrent)

    async def _udp_with_sem(ip: str, port: int):
        async with udp_sem:
            return await loop.run_in_executor(
                None, _probe_udp_bench_sync, ip, port, 2.0
            )

    udp_results = await asyncio.gather(*[
        _udp_with_sem(ip, port)
        for ip in all_alive
        for port in ports
    ])
    udp_verified: dict[str, dict] = {}
    for r in udp_results:
        if r is not None:
            udp_verified[r["ip"]] = r

    # 결과 조합: verified + unverified 호스트
    results: list[dict] = []
    seen: set[str] = set()
    for ip in sorted(all_alive):
        if ip in seen:
            continue
        seen.add(ip)
        if ip in udp_verified:
            results.append(udp_verified[ip])
            logger.info("Network scan: %s:%d (UDP verified)", ip, udp_verified[ip]["port"])
        else:
            results.append({"ip": ip, "port": ports[0], "verified": False})
            logger.info("Network scan: %s (reachable, unverified)", ip)

    logger.info("Network scan: completed, %d hosts (%d verified)",
                len(results), len(udp_verified))
    return results


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
        self._hkmc_reconnect_attempts: dict[str, int] = {}  # device_id -> 연속 재연결 실패 횟수
        self._adb_reconnect_attempts: dict[str, int] = {}  # device_id -> 연속 재연결 실패 횟수
        self._vision_cams: dict[str, object] = {}  # device_id -> VisionCamera instance
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
        elif dev_type == "vision_camera":
            prefix = "VisionCam"
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
        aux = [d.to_dict() for d in self._devices.values() if d.category == "auxiliary" or d.type in ("adb", "hkmc6th", "vision_camera")]
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
        # 화면 해상도 조회 (프론트엔드 좌표 매핑에 필요)
        scr_w, scr_h = svc.get_screen_size("front_center")
        dev = ManagedDevice(
            id=final_id,
            type="hkmc6th",
            category="primary",
            address=host,
            status="connected",
            name=display_name,
            info={
                "port": port,
                "agent_version": svc.agent_version,
                "screens": info["screens"],
                "resolution": {"width": scr_w, "height": scr_h},
            },
        )
        self._devices[final_id] = dev
        self._hkmc_conns[final_id] = svc
        self._hkmc_reconnect_attempts.pop(final_id, None)
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

    async def add_vision_camera_device(self, mac: str, model: str = "", serial: str = "",
                                       ip: str = "", subnetmask: str = "255.255.0.0",
                                       device_id: str = "", name: str = "") -> ManagedDevice:
        """비전 카메라를 주 디바이스로 연결 및 등록."""
        final_id = device_id or self._generate_device_id("vision_camera")
        display_name = name or f"VisionCam ({mac})"

        from ..plugins.VisionCamera import VisionCamera
        cam = VisionCamera(mac=mac, model=model, serial=serial, ip=ip, subnetmask=subnetmask)
        loop = asyncio.get_event_loop()
        try:
            result = await asyncio.wait_for(
                loop.run_in_executor(None, cam.Connect),
                timeout=30.0,
            )
        except asyncio.TimeoutError:
            raise RuntimeError("VisionCamera connect timeout (30s) — 카메라가 네트워크에 연결되어 있는지 확인하세요")
        except Exception as e:
            raise RuntimeError(f"VisionCamera connect failed: {e}")

        dev = ManagedDevice(
            id=final_id,
            type="vision_camera",
            category="primary",
            address=ip or mac,
            status="connected",
            name=display_name,
            info={
                "mac": mac,
                "model": model,
                "serial_number": serial,
                "ip": ip,
                "subnetmask": subnetmask,
            },
        )
        self._devices[final_id] = dev
        self._vision_cams[final_id] = cam
        self._save_auxiliary_devices()
        return dev

    def get_vision_camera(self, device_id: str):
        """Get VisionCamera instance for a device. Returns None if not found."""
        cam = self._vision_cams.get(device_id)
        if cam:
            return cam
        dev = self.get_device(device_id)
        if dev and dev.type == "vision_camera":
            return self._vision_cams.get(dev.id)
        return None

    async def refresh_auxiliary(self) -> None:
        """빠른 상태 확인만 수행 (네트워크 I/O 없음). 재연결은 백그라운드에서."""
        for dev in self._devices.values():
            if dev.type == "hkmc6th":
                hkmc = self._hkmc_conns.get(dev.id)
                if hkmc and hkmc.is_connected:
                    dev.status = "connected"
                elif dev.status != "reconnecting":
                    dev.status = "disconnected"
                continue
            if dev.type == "vision_camera":
                cam = self._vision_cams.get(dev.id)
                if cam and cam.IsConnected():
                    dev.status = "connected"
                else:
                    dev.status = "disconnected"
                continue
            if dev.category != "auxiliary":
                continue
            # Serial/Module: 기존 상태 유지 (별도 프로브 없음)

    # 최대 연속 재연결 실패 횟수 — 초과 시 "error" 상태로 전환
    HKMC_MAX_RECONNECT_ATTEMPTS = 12  # 5초 × 12 = 60초간 실패하면 error
    ADB_MAX_RECONNECT_ATTEMPTS = 12   # 5초 × 12 = 60초간 실패하면 error

    async def reconnect_disconnected(self) -> None:
        """끊어진 디바이스 재연결 시도 (백그라운드 태스크용, 5초 간격 호출)."""
        # ADB 상태 일괄 갱신 (adb devices -l 1회 호출)
        try:
            adb_devices = await self.adb.list_devices()
            adb_status_map = {d.serial: d for d in adb_devices}
        except Exception:
            adb_status_map = {}

        for dev in list(self._devices.values()):
            # ── ADB 디바이스 재연결 ──
            if dev.type == "adb":
                adb_serial = dev.address
                adb_dev = adb_status_map.get(adb_serial)
                current_adb_status = adb_dev.status if adb_dev else "offline"

                if current_adb_status == "device":
                    # 정상 연결 — 카운터 리셋
                    self._adb_reconnect_attempts.pop(dev.id, None)
                    dev.status = "connected" if dev.status != "device" else dev.status
                    dev.status = "device"
                    continue

                # error 상태면 재시도 안 함
                if dev.status == "error":
                    continue

                attempts = self._adb_reconnect_attempts.get(dev.id, 0)
                if attempts >= self.ADB_MAX_RECONNECT_ATTEMPTS:
                    dev.status = "error"
                    logger.warning("ADB reconnect give up after %d attempts: %s", attempts, dev.id)
                    continue

                dev.status = "reconnecting"
                try:
                    if ":" in adb_serial:
                        # WiFi ADB — adb connect 재시도
                        await self.adb.connect_device(adb_serial)
                    else:
                        # USB ADB — adb reconnect (USB 재인식 유도)
                        await self.adb._run(f"reconnect {adb_serial}")

                    # 재연결 후 상태 확인
                    check = await self.adb.list_devices()
                    found = next((d for d in check if d.serial == adb_serial), None)
                    if found and found.status == "device":
                        self._adb_reconnect_attempts.pop(dev.id, None)
                        dev.status = "device"
                        logger.info("ADB auto-reconnect success: %s (after %d attempts)", dev.id, attempts)
                    else:
                        self._adb_reconnect_attempts[dev.id] = attempts + 1
                        dev.status = current_adb_status  # connecting/offline 등 원래 상태 유지
                except Exception as e:
                    self._adb_reconnect_attempts[dev.id] = attempts + 1
                    dev.status = "offline"
                    logger.debug("ADB auto-reconnect failed (%d/%d): %s: %s",
                                 attempts + 1, self.ADB_MAX_RECONNECT_ATTEMPTS, dev.id, e)
                continue

            if dev.type == "hkmc6th":
                hkmc = self._hkmc_conns.get(dev.id)
                if hkmc and hkmc.is_connected:
                    # 연결 정상 — 실패 카운터 리셋
                    self._hkmc_reconnect_attempts.pop(dev.id, None)
                    if dev.status != "connected":
                        dev.status = "connected"
                    continue
                port = dev.info.get("port", 0)
                if not port:
                    continue
                # error 상태면 재시도 안 함 (사용자가 수동으로 재연결해야)
                if dev.status == "error":
                    continue
                attempts = self._hkmc_reconnect_attempts.get(dev.id, 0)
                if attempts >= self.HKMC_MAX_RECONNECT_ATTEMPTS:
                    dev.status = "error"
                    logger.warning("HKMC reconnect give up after %d attempts: %s", attempts, dev.id)
                    continue
                dev.status = "reconnecting"
                try:
                    if hkmc:
                        hkmc.disconnect()
                    svc = HKMC6thService(dev.address, port, device_id=dev.id)
                    ok = await svc.async_connect()
                    if ok:
                        self._hkmc_conns[dev.id] = svc
                        self._hkmc_reconnect_attempts.pop(dev.id, None)
                        dev.status = "connected"
                        dev.info["agent_version"] = svc.agent_version
                        dev.info["screens"] = svc.get_info()["screens"]
                        logger.info("HKMC auto-reconnect success: %s (after %d attempts)", dev.id, attempts)
                    else:
                        self._hkmc_reconnect_attempts[dev.id] = attempts + 1
                        dev.status = "disconnected"
                except Exception as e:
                    self._hkmc_reconnect_attempts[dev.id] = attempts + 1
                    dev.status = "disconnected"
                    logger.debug("HKMC auto-reconnect failed (%d/%d): %s: %s",
                                 attempts + 1, self.HKMC_MAX_RECONNECT_ATTEMPTS, dev.id, e)

    def reset_reconnect_attempts(self, device_id: str) -> None:
        """수동 재연결 시 실패 카운터 리셋 (error 상태에서 복구 가능하게)."""
        self._hkmc_reconnect_attempts.pop(device_id, None)
        self._adb_reconnect_attempts.pop(device_id, None)
        dev = self._devices.get(device_id)
        if dev and dev.status == "error":
            dev.status = "disconnected"

    async def scan_serial(self) -> list[dict]:
        """Scan available serial ports."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _scan_serial_ports)

    async def scan_hkmc(self) -> list[dict]:
        """TCP 포트 스캔으로 LAN 상의 HKMC 디바이스 탐지."""
        return await _scan_hkmc_tcp()

    async def scan_bench(self) -> list[dict]:
        """LAN에서 네트워크 호스트 탐색 (ARP + ping + UDP 프로브)."""
        return await _scan_network_hosts()

    async def scan_dlt(self) -> list[dict]:
        """TCP 포트 스캔으로 LAN 상의 DLT 데몬 탐지."""
        return await _scan_dlt_tcp()

    async def scan_vision_cameras(self) -> list[dict]:
        """GigE Vision 카메라 스캔 (Harvester 기반)."""
        loop = asyncio.get_event_loop()
        try:
            from ..plugins.VisionCameraClient import scan_vision_cameras
            return await loop.run_in_executor(None, scan_vision_cameras)
        except Exception as e:
            logger.debug("VisionCamera scan failed: %s", e)
            return []

    async def force_ip_camera(self, mac: str, ip: str, subnet: str, gateway: str) -> str:
        """GigE Vision 카메라 ForceIP (vmbpy 기반)."""
        loop = asyncio.get_event_loop()
        try:
            from ..plugins.VisionCameraClient import force_ip_camera
            return await loop.run_in_executor(None, force_ip_camera, mac, ip, subnet, gateway)
        except Exception as e:
            return f"ForceIP error: {e}"

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
            status="unknown",
            name=display_name,
            info=info,
        )
        self._devices[final_id] = dev
        self._save_auxiliary_devices()

        # 즉시 모듈 인스턴스 생성 + 연결 시도
        try:
            from .module_service import _get_instance, _is_connected
            from ..routers.device import _build_constructor_kwargs
            ctor_kwargs = _build_constructor_kwargs(dev)
            loop = asyncio.get_event_loop()
            instance = await loop.run_in_executor(None, _get_instance, module, ctor_kwargs)
            dev.status = "connected" if _is_connected(instance) else "disconnected"
        except Exception as e:
            dev.status = "disconnected"
            logger.warning("Module %s init failed on add: %s", module, e)

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
        # Close VisionCamera connection if applicable
        cam = self._vision_cams.pop(dev.id, None)
        if cam:
            try:
                cam.Disconnect()
            except Exception:
                pass
        # 모듈 인스턴스 캐시 제거
        module_name = dev.info.get("module")
        if module_name:
            from .module_service import reset_instance
            reset_instance(module_name)
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
        # Wait for Arduino bootloader + setup() to finish
        import time
        time.sleep(3)
        try:
            # Drain all startup garbage (null bytes, boot messages, etc.)
            conn.reset_input_buffer()
            conn.reset_output_buffer()
        except Exception as e:
            conn.close()
            raise RuntimeError(f"Serial drain failed for {port}: {e}")
        self._serial_conns[device_id] = conn
        logger.info("Serial port opened and drained: %s (%s @ %d)", device_id, port, baudrate)
        return conn

    def get_serial_conn(self, device_id: str):
        """Get an existing open serial connection for a device (by id or address)."""
        # 1) device_id로 직접 검색
        conn = self._serial_conns.get(device_id)
        if conn and conn.is_open:
            return conn
        # 2) device_id가 address(COM포트)인 경우 — 해당 address를 가진 디바이스의 연결 검색
        for did, dev in self._devices.items():
            if dev.address == device_id and did in self._serial_conns:
                conn = self._serial_conns[did]
                if conn and conn.is_open:
                    return conn
        return None

    def _close_serial_conn(self, device_id: str) -> None:
        """Close a persistent serial connection."""
        conn = self._serial_conns.pop(device_id, None)
        if conn and conn.is_open:
            conn.close()

    async def open_all_serial_connections(self) -> None:
        """Open persistent serial/HKMC/module connections for all registered devices."""
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
            elif dev.type == "module":
                # 모듈 디바이스: 서버 시작 시 인스턴스 생성 + 연결 시도
                module_name = dev.info.get("module", "")
                if not module_name:
                    continue
                try:
                    from .module_service import _get_instance, _is_connected
                    from ..routers.device import _build_constructor_kwargs
                    ctor_kwargs = _build_constructor_kwargs(dev)
                    # device_manager가 이미 같은 포트로 열어둔 시리얼 연결이 있으면 전달
                    shared_conn = self.get_serial_conn(dev.id)
                    instance = await loop.run_in_executor(
                        None, functools.partial(_get_instance, module_name, ctor_kwargs, shared_conn),
                    )
                    if _is_connected(instance):
                        dev.status = "connected"
                        logger.info("Module connection opened: %s (%s on %s)", dev.id, module_name, dev.address)
                    else:
                        dev.status = "disconnected"
                        logger.warning("Module instance created but not connected: %s (%s)", dev.id, module_name)
                except Exception as e:
                    dev.status = "disconnected"
                    logger.warning("Failed to init module %s (%s): %s", dev.id, module_name, e)
            elif dev.type == "vision_camera":
                mac = dev.info.get("mac", "")
                if not mac:
                    continue
                try:
                    from ..plugins.VisionCamera import VisionCamera
                    cam = VisionCamera(
                        mac=mac,
                        model=dev.info.get("model", ""),
                        serial=dev.info.get("serial_number", ""),
                        ip=dev.info.get("ip", ""),
                        subnetmask=dev.info.get("subnetmask", "255.255.0.0"),
                    )
                    result = await loop.run_in_executor(None, cam.Connect)
                    self._vision_cams[dev.id] = cam
                    dev.status = "connected"
                    logger.info("VisionCamera connection opened: %s (%s)", dev.id, mac)
                except Exception as e:
                    dev.status = "disconnected"
                    logger.warning("Failed to open VisionCamera %s (%s): %s", dev.id, mac, e)

    async def connect_device_by_id(self, device_id: str) -> str:
        """등록된 디바이스 1개를 연결. 결과 메시지 반환."""
        dev = self._devices.get(device_id)
        if not dev:
            return f"Device {device_id} not found"
        loop = asyncio.get_event_loop()

        if dev.type == "serial":
            try:
                await loop.run_in_executor(None, self._get_serial_conn, dev.id)
                dev.status = "connected"
                return f"Serial connected: {dev.id} ({dev.address})"
            except Exception as e:
                dev.status = "disconnected"
                return f"Serial connect failed: {dev.id} — {e}"

        elif dev.type == "hkmc6th":
            port = dev.info.get("port", 0)
            if not port:
                return f"HKMC {dev.id}: no port configured"
            try:
                from .hkmc6th_service import HKMC6thService
                svc = HKMC6thService(dev.address, port, device_id=dev.id)
                ok = await svc.async_connect()
                if ok:
                    self._hkmc_conns[dev.id] = svc
                    dev.status = "connected"
                    dev.info["agent_version"] = svc.agent_version
                    dev.info["screens"] = svc.get_info()["screens"]
                    return f"HKMC connected: {dev.id} ({dev.address}:{port})"
                else:
                    dev.status = "disconnected"
                    return f"HKMC connect failed: {dev.id}"
            except Exception as e:
                dev.status = "disconnected"
                return f"HKMC connect failed: {dev.id} — {e}"

        elif dev.type == "module":
            module_name = dev.info.get("module", "")
            if not module_name:
                return f"Module {dev.id}: no module configured"
            try:
                from .module_service import _get_instance, _is_connected
                from ..routers.device import _build_constructor_kwargs
                ctor_kwargs = _build_constructor_kwargs(dev)
                shared_conn = self.get_serial_conn(dev.id)
                instance = await loop.run_in_executor(
                    None, functools.partial(_get_instance, module_name, ctor_kwargs, shared_conn),
                )
                if _is_connected(instance):
                    dev.status = "connected"
                    return f"Module connected: {dev.id} ({module_name})"
                else:
                    dev.status = "disconnected"
                    return f"Module not connected: {dev.id} ({module_name})"
            except Exception as e:
                dev.status = "disconnected"
                return f"Module connect failed: {dev.id} — {e}"

        elif dev.type == "vision_camera":
            mac = dev.info.get("mac", "")
            if not mac:
                return f"VisionCamera {dev.id}: no MAC configured"
            try:
                from ..plugins.VisionCamera import VisionCamera
                cam = VisionCamera(
                    mac=mac,
                    model=dev.info.get("model", ""),
                    serial=dev.info.get("serial_number", ""),
                    ip=dev.info.get("ip", ""),
                    subnetmask=dev.info.get("subnetmask", "255.255.0.0"),
                )
                await loop.run_in_executor(None, cam.Connect)
                self._vision_cams[dev.id] = cam
                dev.status = "connected"
                return f"VisionCamera connected: {dev.id} ({mac})"
            except Exception as e:
                dev.status = "disconnected"
                return f"VisionCamera connect failed: {dev.id} — {e}"

        elif dev.type == "adb":
            # ADB는 reconnect_disconnected 루프에서 자동 관리됨
            try:
                if ":" in dev.address:
                    await self.adb.connect_device(dev.address)
                devs = await self.adb.list_devices()
                found = next((d for d in devs if d.serial == dev.address), None)
                if found and found.status == "device":
                    dev.status = "device"
                    self._adb_reconnect_attempts.pop(dev.id, None)
                    return f"ADB connected: {dev.id} ({dev.address})"
                else:
                    dev.status = found.status if found else "offline"
                    return f"ADB not ready: {dev.id} ({dev.status})"
            except Exception as e:
                dev.status = "offline"
                return f"ADB connect failed: {dev.id} — {e}"

        return f"Unknown device type: {dev.type}"

    def close_all_serial_connections(self) -> None:
        """Close all persistent serial/HKMC/VisionCamera connections (called on shutdown)."""
        for device_id in list(self._serial_conns.keys()):
            self._close_serial_conn(device_id)
            logger.info("Serial connection closed: %s", device_id)
        for device_id, hkmc in list(self._hkmc_conns.items()):
            hkmc.disconnect()
            logger.info("HKMC connection closed: %s", device_id)
        self._hkmc_conns.clear()
        for device_id, cam in list(self._vision_cams.items()):
            try:
                cam.Disconnect()
            except Exception:
                pass
            logger.info("VisionCamera connection closed: %s", device_id)
        self._vision_cams.clear()

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
