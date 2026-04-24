"""Unified Device Manager — ADB + Serial 장치를 통합 관리."""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import re
import socket
import sys
from pathlib import Path
from typing import Optional

from .adb_service import ADBService
from .hkmc6th_service import HKMC6thService
from .isap_agent_service import ISAPAgentService
from .icas_agent_service import ICASAgentService
from .ssh_service import SSHConnection

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


def _collect_local_subnets_192() -> tuple[set[str], list]:
    """로컬 192.168.* 서브넷만 수집 (IDS 오탐 방지를 위한 스캔 대상 제한).

    /20보다 큰(즉 prefix < 20) 대규모 네트워크는 제외.

    Returns:
        (local_ips_set, subnet_list) — 자기 자신 IP 집합과 IPv4Network 목록
    """
    import ipaddress
    import ifaddr

    local_ips: set[str] = {"127.0.0.1"}
    subnets: list = []
    for adapter in ifaddr.get_adapters():
        for ip_info in adapter.ips:
            if not isinstance(ip_info.ip, str):
                continue
            ip_str = ip_info.ip
            prefix = ip_info.network_prefix
            if ip_str.startswith("127.") or ip_str.startswith("169.254."):
                continue
            # 192.168.* 대역만 허용 — 10.x, 172.16-31.x 등은 스캔 제외
            if not ip_str.startswith("192.168."):
                continue
            local_ips.add(ip_str)
            try:
                net = ipaddress.IPv4Network(f"{ip_str}/{prefix}", strict=False)
                if net.prefixlen >= 20:
                    subnets.append(net)
            except ValueError:
                pass
    # 중복 서브넷 제거
    unique = list({str(s): s for s in subnets}.values())
    return local_ips, unique


def _collect_candidate_ips_192() -> set[str]:
    """192.168.* 대역에 속한 후보 IP 집합 반환 (자기 자신 제외)."""
    local_ips, subnets = _collect_local_subnets_192()
    candidate_ips: set[str] = set()
    for subnet in subnets:
        for host in subnet.hosts():
            ip_str = str(host)
            if ip_str not in local_ips:
                candidate_ips.add(ip_str)
    return candidate_ips
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
    """LAN 서브넷의 모든 IP에 TCP 연결을 시도하여 HKMC 에이전트를 탐지한다.
    스캔 범위는 192.168.* 로 제한한다.
    """
    if not ports:
        logger.info("HKMC scan skipped: no ports configured")
        return []

    candidate_ips = _collect_candidate_ips_192()
    if not candidate_ips:
        return []

    semaphore = asyncio.Semaphore(max_concurrent)
    tasks = [
        _probe_hkmc_host(ip, port, connect_timeout, semaphore)
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
            logger.info("HKMC TCP scan: found device at %s:%d", r["ip"], r["port"])

    return deduped


# ── 범용 TCP 포트 스캔 ──────────────────────────────────────────────

async def _probe_tcp_port(
    ip: str, port: int, timeout: float, semaphore: asyncio.Semaphore
) -> dict | None:
    """단일 IP:Port에 TCP 연결 시도."""
    async with semaphore:
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, port), timeout=timeout
            )
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return {"ip": ip, "port": port}
        except Exception:
            pass
    return None


async def scan_tcp_port(
    port: int,
    connect_timeout: float = 0.3,
    max_concurrent: int = 100,
) -> list[dict]:
    """LAN 서브넷(192.168.*)에서 특정 TCP 포트가 열린 호스트를 탐지."""
    candidate_ips = _collect_candidate_ips_192()
    if not candidate_ips:
        return []

    semaphore = asyncio.Semaphore(max_concurrent)
    tasks = [_probe_tcp_port(ip, port, connect_timeout, semaphore) for ip in candidate_ips]
    results = await asyncio.gather(*tasks)
    found = [r for r in results if r is not None]
    logger.info("TCP port %d scan: found %d hosts", port, len(found))
    return found


# ── 범용 UDP 포트 스캔 ──────────────────────────────────────────────

async def _probe_udp_port(
    ip: str, port: int, timeout: float, semaphore: asyncio.Semaphore
) -> dict | None:
    """단일 IP:Port에 UDP 프로브 전송 후 응답 확인."""
    async with semaphore:
        try:
            loop = asyncio.get_event_loop()
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.settimeout(timeout)
            sock.setblocking(False)
            # 빈 패킷 전송 후 응답 대기
            await loop.sock_sendto(sock, b"\x00", (ip, port))
            try:
                data = await asyncio.wait_for(
                    loop.sock_recv(sock, 1024), timeout=timeout
                )
                sock.close()
                if data:
                    return {"ip": ip, "port": port}
            except (asyncio.TimeoutError, Exception):
                sock.close()
        except Exception:
            pass
    return None


async def _scan_udp_port(
    port: int,
    connect_timeout: float = 0.5,
    max_concurrent: int = 100,
) -> list[dict]:
    """LAN 서브넷(192.168.*)에서 특정 UDP 포트에 응답하는 호스트를 탐지."""
    candidate_ips = _collect_candidate_ips_192()
    if not candidate_ips:
        return []

    semaphore = asyncio.Semaphore(max_concurrent)
    tasks = [_probe_udp_port(ip, port, connect_timeout, semaphore) for ip in candidate_ips]
    results = await asyncio.gather(*tasks)
    found = [r for r in results if r is not None]
    logger.info("UDP port %d scan: found %d hosts", port, len(found))
    return found


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
    """LAN 서브넷(192.168.*)에서 DLT 데몬을 탐지."""
    if not ports:
        logger.info("DLT scan skipped: no ports configured")
        return []

    candidate_ips = _collect_candidate_ips_192()
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


# ── SmartBench 자동 탐지 ──
# 설정(scan_settings.builtin.smartbench)의 host/port를 기반으로 TCP 프로브.
SMARTBENCH_HOST = "192.167.0.5"
SMARTBENCH_PORT = 8000


async def _scan_smartbench(host: str | None = None, port: int | None = None) -> list[dict]:
    """SmartBench 장비 탐지 — 설정된 host/port로 TCP 연결 프로브.

    과거에는 로컬 PC에 특정 IP(192.167.0.4)가 붙어 있을 때만 동작했으나,
    이제 호스트/포트가 스캔 설정으로 구성되므로 해당 프리체크는 제거됨.
    연결 실패 시 2초 timeout 후 빈 리스트 반환.
    """
    target_host = (host or SMARTBENCH_HOST).strip()
    target_port = int(port) if port else SMARTBENCH_PORT

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None, _probe_smartbench_sync, target_host, target_port, 2.0,
    )
    if result:
        logger.info("SmartBench scan: found %s:%d", target_host, target_port)
        return [result]
    logger.debug("SmartBench scan: %s:%d not reachable", target_host, target_port)
    return []


def _probe_smartbench_sync(ip: str, port: int, timeout: float) -> dict | None:
    """SmartBench 프로브 — TCP 연결 후 CONNECT 핸드셰이크까지 검증.

    단순 TCP 포트 listen 만으로는 다른 장비도 오탐되므로, SmartBench 플러그인이
    사용하는 프로토콜 `CONNECT\\n` → `CONNECTED` 응답을 확인한 경우에만 발견으로 처리.
    이후 플러그인 연결에 영향이 없도록 `DISCONNECT\\n`로 정리 후 소켓 종료.
    """
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect((ip, port))
        # 핸드셰이크
        sock.settimeout(timeout)
        sock.sendall(b"CONNECT\n")
        rc = sock.recv(1024).decode("utf-8", errors="replace").replace("\n", "").replace(" ", "").strip()
        if rc != "CONNECTED":
            logger.debug("SmartBench probe: unexpected handshake response %r at %s:%d", rc, ip, port)
            return None
        # 깨끗한 종료 — 다음 연결에 영향 없도록
        try:
            sock.sendall(b"DISCONNECT\n")
            sock.settimeout(0.5)
            sock.recv(1024)
        except Exception:
            pass
        return {
            "ip": ip,
            "port": port,
            "label": "SmartBench",
            "module": "SmartBench",
        }
    except Exception as e:
        logger.debug("SmartBench probe %s:%d failed: %s", ip, port, e)
        return None
    finally:
        if sock:
            try:
                sock.close()
            except Exception:
                pass


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
        _nw = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        result = subprocess.run("arp -a", capture_output=True, text=True,
                                shell=True, timeout=5, creationflags=_nw)
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
    ports: list[int] | None = None,
    max_concurrent: int = 50,
) -> list[dict]:
    """LAN 서브넷(192.168.*)의 활성 호스트 탐지 (ARP + ping + UDP 프로브)."""
    if not ports:
        logger.info("Bench scan skipped: no ports configured")
        return []

    local_ips, subnets = _collect_local_subnets_192()
    logger.info("Network scan: %d subnets: %s", len(subnets), [str(s) for s in subnets])

    candidate_ips: set[str] = set()
    for subnet in subnets:
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
        self._isap_conns: dict[str, ISAPAgentService] = {}  # device_id -> ISAPAgentService
        self._isap_reconnect_attempts: dict[str, int] = {}
        self._icas_conns: dict[str, ICASAgentService] = {}  # device_id -> ICASAgentService
        self._icas_reconnect_attempts: dict[str, int] = {}
        self._adb_reconnect_attempts: dict[str, int] = {}  # device_id -> 연속 재연결 실패 횟수
        # 디바이스별 재연결 락: playback의 _ensure_device_connected와 백그라운드 monitor 루프가
        # 같은 디바이스를 동시에 재연결하지 못하도록 직렬화. race condition 제거용.
        self._reconnect_locks: dict[str, asyncio.Lock] = {}
        self._vision_cams: dict[str, object] = {}  # device_id -> VisionCamera instance
        self._webcam_devs: dict[str, object] = {}  # device_id -> WebcamDevice instance
        self._ssh_conns: dict[str, SSHConnection] = {}  # device_id -> SSHConnection
        self._ever_connected: set[str] = set()  # 사용자가 명시적으로 연결한 디바이스만 자동 재연결
        self._load_auxiliary_devices()
        self._ensure_default_common_device()

    # 기본 Common 디바이스 ID — 삭제/수정 금지
    DEFAULT_COMMON_DEVICE_ID = "Common"

    def _ensure_default_common_device(self) -> None:
        """Common(CMD) 디바이스를 기본값으로 등록 + 상태를 항상 connected로 고정."""
        existing = self._devices.get(self.DEFAULT_COMMON_DEVICE_ID)
        if existing and existing.info.get("module") == "CMD":
            # 이미 등록되어 있으면 status만 강제 원상 복구 (연결 불필요)
            existing.status = "connected"
            existing.type = "module"
            existing.category = "auxiliary"
            return
        dev = ManagedDevice(
            id=self.DEFAULT_COMMON_DEVICE_ID,
            type="module",
            category="auxiliary",
            address="",
            status="connected",  # 연결 불필요한 모듈이므로 바로 사용 가능
            name="Common",
            info={"module": "CMD", "connect_type": "none"},
        )
        self._devices[self.DEFAULT_COMMON_DEVICE_ID] = dev
        self._save_auxiliary_devices()
        logger.info("Registered default 'Common' device (CMD module)")

    def is_protected_device(self, device_id: str) -> bool:
        """삭제/수정이 금지된 시스템 기본 디바이스인지 여부."""
        return device_id == self.DEFAULT_COMMON_DEVICE_ID

    def _load_auxiliary_devices(self) -> None:
        """Load saved auxiliary devices from disk.

        레거시 자동 마이그레이션:
          - type "hkmc6th" → "hkmc_agent"
          - info.module "CCIC_BENCH" → "WoohyunBench"
        """
        if not _AUX_DEVICES_FILE.exists():
            return
        try:
            data = json.loads(_AUX_DEVICES_FILE.read_text(encoding="utf-8"))
            migrated = False
            for d in data:
                dev_type = d.get("type", "")
                if dev_type == "hkmc6th":
                    dev_type = "hkmc_agent"
                    d["type"] = dev_type
                    migrated = True
                info = d.get("info") or {}
                if isinstance(info, dict) and info.get("module") == "CCIC_BENCH":
                    info["module"] = "WoohyunBench"
                    d["info"] = info
                    migrated = True
                dev = ManagedDevice(
                    id=d["id"],
                    type=dev_type,
                    category=d.get("category", "primary" if dev_type == "adb" else "auxiliary"),
                    address=d["address"],
                    status="unknown",
                    name=d.get("name", d["id"]),
                    info=d.get("info", {}),
                )
                self._devices[dev.id] = dev
            logger.info("Loaded %d auxiliary devices from %s", len(data), _AUX_DEVICES_FILE)
            if migrated:
                # 마이그레이션된 경우 즉시 디스크에 반영
                self._save_auxiliary_devices()
        except Exception as e:
            logger.warning("Failed to load auxiliary devices: %s", e)

    def _generate_device_id(self, dev_type: str, module_name: str = "", device_model: str = "") -> str:
        """Auto-generate a device ID like Connected_Wide_1, GVM_1, HKMC_1, POWER_1, etc."""
        if device_model:
            prefix = device_model.replace(" ", "_")
        elif module_name:
            prefix = module_name
        elif dev_type == "adb":
            prefix = "Android"
        elif dev_type == "serial":
            prefix = "Serial"
        elif dev_type == "hkmc_agent":
            prefix = "HKMC"
        elif dev_type == "isap_agent":
            prefix = "iSAP"
        elif dev_type == "icas_agent":
            prefix = "ICAS"
        elif dev_type == "vision_camera":
            prefix = "VisionCam"
        elif dev_type == "webcam":
            prefix = "Webcam"
        elif dev_type == "ssh":
            prefix = "SSH"
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
        """Persist all manually registered devices (auxiliary + ADB + HKMC + SSH) to disk."""
        aux = [
            d.to_dict()
            for d in self._devices.values()
            if d.category == "auxiliary" or d.type in ("adb", "hkmc_agent", "isap_agent", "icas_agent", "vision_camera", "webcam", "ssh")
        ]
        try:
            _AUX_DEVICES_FILE.write_text(json.dumps(aux, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            logger.warning("Failed to save auxiliary devices: %s", e)

    async def refresh_adb(self) -> None:
        """Sync ADB device statuses — only update already-registered ADB devices."""
        # 등록된 ADB 디바이스가 없으면 ADB 호출 안 함
        has_adb = any(v.type == "adb" and v.id in self._ever_connected
                      for v in self._devices.values())
        if not has_adb:
            return
        adb_devices = await self.adb.list_devices()
        adb_status_map = {d.serial: d for d in adb_devices}

        for k, v in list(self._devices.items()):
            if v.type != "adb":
                continue
            # 사용자가 연결 끊기한 디바이스는 자동 상태 갱신 안 함
            if v.id not in self._ever_connected:
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

    async def add_adb_device(self, serial: str, device_id: str = "", name: str = "", device_model: str = "") -> ManagedDevice:
        """ADB 디바이스 등록만 (연결은 connect_device_by_id로 별도 수행)."""
        final_id = device_id or self._generate_device_id("adb", device_model=device_model)
        display_name = name or serial

        # 디바이스 정보만 조회 (연결 시도 아님)
        info = {}
        try:
            adb_devices = await self.adb.list_devices()
            found = next((d for d in adb_devices if d.serial == serial), None)
            if found:
                if found.status == "device":
                    info = await self.adb.get_device_info(serial)
                if not name:
                    display_name = info.get("model", serial) if info else serial
        except Exception:
            pass

        if device_model:
            info["device_model"] = device_model
        dev = ManagedDevice(
            id=final_id,
            type="adb",
            category="primary",
            address=serial,
            status="disconnected",
            name=display_name,
            info=info,
        )
        self._devices[final_id] = dev
        self._save_auxiliary_devices()
        return dev

    async def add_hkmc6th_device(self, host: str, port: int, device_id: str = "", name: str = "", device_model: str = "") -> ManagedDevice:
        """HKMC 디바이스 등록만 (연결은 connect_device_by_id로 별도 수행)."""
        final_id = device_id or self._generate_device_id("hkmc_agent", device_model=device_model)
        display_name = name or f"HKMC ({host}:{port})"
        info: dict = {"port": port}
        if device_model:
            info["device_model"] = device_model

        dev = ManagedDevice(
            id=final_id,
            type="hkmc_agent",
            category="primary",
            address=host,
            status="disconnected",
            name=display_name,
            info=info,
        )
        self._devices[final_id] = dev
        self._save_auxiliary_devices()
        return dev

    def get_hkmc_service(self, device_id: str) -> Optional[HKMC6thService]:
        """Get HKMC6thService instance for a device. Returns None if not found."""
        svc = self._hkmc_conns.get(device_id)
        if svc:
            return svc
        # Fallback: device_map이 address로 해석된 경우, address로 디바이스를 찾아 ID로 재조회
        dev = self.get_device(device_id)
        if dev and dev.type == "hkmc_agent":
            return self._hkmc_conns.get(dev.id)
        return None

    async def add_isap_agent_device(self, host: str, port: int, device_id: str = "",
                                    name: str = "", device_model: str = "") -> ManagedDevice:
        """iSAP Agent 디바이스 등록만 (연결은 connect_device_by_id로 별도 수행)."""
        final_id = device_id or self._generate_device_id("isap_agent", device_model=device_model)
        display_name = name or f"iSAP ({host}:{port})"
        info: dict = {"port": port}
        if device_model:
            info["device_model"] = device_model

        dev = ManagedDevice(
            id=final_id,
            type="isap_agent",
            category="primary",
            address=host,
            status="disconnected",
            name=display_name,
            info=info,
        )
        self._devices[final_id] = dev
        self._save_auxiliary_devices()
        return dev

    def get_isap_service(self, device_id: str) -> Optional[ISAPAgentService]:
        """Get ISAPAgentService instance for a device. Returns None if not found."""
        svc = self._isap_conns.get(device_id)
        if svc:
            return svc
        dev = self.get_device(device_id)
        if dev and dev.type == "isap_agent":
            return self._isap_conns.get(dev.id)
        return None

    async def add_icas_agent_device(self, host: str, port: int = 22, device_id: str = "",
                                    name: str = "", device_model: str = "",
                                    username: str = "root", password: str = "",
                                    resolution: str = "1560x700",
                                    private_server_ip: str = "",
                                    private_server_password: str = "",
                                    iid_display: str = "10",
                                    hud_display: str = "11",
                                    market: str = "") -> ManagedDevice:
        """ICAS Agent 디바이스 등록만 (연결은 connect_device_by_id로 별도 수행).

        market이 비어있으면 device_model에서 추론 (EU/NAR/CN/GP). 추론 실패 시 "EU" 기본.
        """
        final_id = device_id or self._generate_device_id("icas_agent", device_model=device_model)
        display_name = name or f"ICAS ({host}:{port})"
        # "WxH" 문자열을 dict으로 파싱 (프론트엔드 deviceRes 호환). 파싱 실패 시 기본값.
        try:
            rw_s, rh_s = str(resolution).upper().split("X")
            res_dict = {"width": int(rw_s), "height": int(rh_s)}
        except Exception:
            res_dict = {"width": 1560, "height": 700}

        # market 추론: 명시 > device_model 키워드 매칭 > EU 기본
        resolved_market = (market or "").strip().upper()
        if not resolved_market and device_model:
            dm_upper = device_model.upper()
            for m in ("EU", "NAR", "CN", "GP"):
                if m in dm_upper:
                    resolved_market = m
                    break
        if not resolved_market:
            resolved_market = "EU"

        info: dict = {
            "port": int(port),
            "username": username,
            "password": password,
            "resolution": res_dict,         # dict form — HKMC/iSAP/ADB와 동일한 스키마
            "resolution_str": str(resolution),  # ICAS 서비스 생성자용 원본 문자열
            "private_server_ip": private_server_ip,  # 빈 문자열이면 market 기본값 사용
            "private_server_password": private_server_password,
            "iid_display": str(iid_display),
            "hud_display": str(hud_display),
            "market": resolved_market,
        }
        if device_model:
            info["device_model"] = device_model

        dev = ManagedDevice(
            id=final_id,
            type="icas_agent",
            category="primary",
            address=host,
            status="disconnected",
            name=display_name,
            info=info,
        )
        self._devices[final_id] = dev
        self._save_auxiliary_devices()
        return dev

    def get_icas_service(self, device_id: str) -> Optional[ICASAgentService]:
        """Get ICASAgentService instance for a device. Returns None if not found."""
        svc = self._icas_conns.get(device_id)
        if svc:
            return svc
        dev = self.get_device(device_id)
        if dev and dev.type == "icas_agent":
            return self._icas_conns.get(dev.id)
        return None

    async def add_vision_camera_device(self, mac: str, model: str = "", serial: str = "",
                                       ip: str = "", subnetmask: str = "255.255.0.0",
                                       device_id: str = "", name: str = "") -> ManagedDevice:
        """비전 카메라 등록만 (연결은 connect_device_by_id로 별도 수행)."""
        final_id = device_id or self._generate_device_id("vision_camera")
        display_name = name or f"VisionCam ({mac})"

        dev = ManagedDevice(
            id=final_id,
            type="vision_camera",
            category="primary",
            address=ip or mac,
            status="disconnected",
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

    async def add_webcam_device(self, device_index: int, width: int = 640, height: int = 480,
                                device_id: str = "", name: str = "") -> ManagedDevice:
        """웹캠 디바이스 등록만 (연결은 connect_device_by_id로 별도 수행)."""
        final_id = device_id or self._generate_device_id("webcam")
        display_name = name or f"Webcam {device_index}"

        dev = ManagedDevice(
            id=final_id,
            type="webcam",
            category="primary",
            address=f"webcam:{device_index}",
            status="disconnected",
            name=display_name,
            info={
                "device_index": int(device_index),
                "width": int(width) if width else 0,
                "height": int(height) if height else 0,
            },
        )
        self._devices[final_id] = dev
        self._save_auxiliary_devices()
        return dev

    def get_webcam_device(self, device_id: str):
        """Get WebcamDevice instance. Returns None if not found."""
        cam = self._webcam_devs.get(device_id)
        if cam:
            return cam
        dev = self.get_device(device_id)
        if dev and dev.type == "webcam":
            return self._webcam_devs.get(dev.id)
        return None

    async def refresh_auxiliary(self) -> None:
        """빠른 상태 확인만 수행 (네트워크 I/O 없음). 재연결은 백그라운드에서."""
        # Serial/Module(COM 포트 기반) 디바이스의 물리적 연결 여부를 확인하기 위해
        # 현재 시스템의 COM 포트 목록을 한 번만 스캔 (USB 제거 감지용)
        available_com_ports: Optional[set[str]] = None
        needs_com_scan = any(
            (d.type in ("serial", "module"))
            and d.id in self._ever_connected
            and isinstance(d.address, str)
            and d.address.upper().startswith("COM")
            for d in self._devices.values()
        )
        if needs_com_scan:
            loop = asyncio.get_event_loop()
            try:
                def _list_com_ports() -> set[str]:
                    from serial.tools import list_ports
                    return {p.device for p in list_ports.comports()}
                available_com_ports = await loop.run_in_executor(None, _list_com_ports)
            except Exception as e:
                logger.debug("COM port scan failed: %s", e)
                available_com_ports = None

        for dev in self._devices.values():
            # 사용자가 연결 끊기한 디바이스는 자동 상태 갱신 안 함
            if dev.id not in self._ever_connected:
                continue
            if dev.type == "hkmc_agent":
                hkmc = self._hkmc_conns.get(dev.id)
                if hkmc and hkmc.is_connected:
                    dev.status = "connected"
                elif dev.status != "reconnecting":
                    dev.status = "disconnected"
                continue
            if dev.type == "isap_agent":
                isap = self._isap_conns.get(dev.id)
                if isap and isap.is_connected:
                    dev.status = "connected"
                elif dev.status != "reconnecting":
                    dev.status = "disconnected"
                continue
            if dev.type == "icas_agent":
                icas = self._icas_conns.get(dev.id)
                if icas and icas.is_connected:
                    dev.status = "connected"
                elif dev.status != "reconnecting":
                    dev.status = "disconnected"
                continue
            if dev.type == "webcam":
                cam = self._webcam_devs.get(dev.id)
                if cam and cam.IsConnected():
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
            if dev.type == "ssh":
                conn = self._ssh_conns.get(dev.id)
                if conn and conn.is_alive():
                    dev.status = "connected"
                else:
                    dev.status = "disconnected"
                continue
            if dev.category != "auxiliary":
                continue
            # Serial/Module: COM 포트가 시스템에서 사라진 경우(USB 제거 등) disconnected로 전환
            if dev.type in ("serial", "module"):
                if available_com_ports is None:
                    continue  # 스캔 실패 시 기존 상태 유지
                address = dev.address
                if not (isinstance(address, str) and address.upper().startswith("COM")):
                    continue  # COM 포트 기반이 아닌 모듈(네트워크 모듈 등)은 제외
                if address not in available_com_ports:
                    if dev.status not in ("disconnected", "reconnecting"):
                        logger.info(
                            "Serial/Module %s: COM port %s no longer available, marking disconnected",
                            dev.id, address,
                        )
                        # 스테일 시리얼 핸들 정리 (USB 제거 후에도 is_open이 True로 남는 경우 대비)
                        try:
                            self._close_serial_conn(dev.id)
                        except Exception as e:
                            logger.debug("Close stale serial conn %s failed: %s", dev.id, e)
                        # 모듈 싱글톤도 정리해 재연결 시 새 인스턴스를 만들도록 유도
                        module_name = dev.info.get("module", "")
                        if module_name:
                            try:
                                from .module_service import _instances, _auto_connected
                                _instances.pop(module_name, None)
                                _auto_connected.discard(module_name)
                            except Exception as e:
                                logger.debug("Clear module instance %s failed: %s", module_name, e)
                    dev.status = "disconnected"

    # 최대 연속 재연결 실패 횟수 — 초과 시 "error" 상태로 전환
    HKMC_MAX_RECONNECT_ATTEMPTS = 12  # 5초 × 12 = 60초간 실패하면 error
    ISAP_MAX_RECONNECT_ATTEMPTS = 12
    ADB_MAX_RECONNECT_ATTEMPTS = 12   # 5초 × 12 = 60초간 실패하면 error

    async def reconnect_disconnected(self, passive: bool = False) -> None:
        """끊어진 디바이스 재연결 시도 (백그라운드 태스크용, 5초 간격 호출).

        Args:
            passive: True이면 상태 확인만 수행 (adb devices 조회).
                     reconnect/connect 등 파괴적 명령은 실행하지 않음.
                     디바이스가 스스로 복귀하면 상태를 갱신하여 재생에서 사용 가능.
        """
        # 등록된 디바이스 중 연결된 적 있는 것만 대상
        targets = [d for d in list(self._devices.values()) if d.id in self._ever_connected]
        if not targets:
            return

        # ADB 디바이스가 있을 때만 ADB 호출
        has_adb = any(d.type == "adb" for d in targets)
        adb_status_map: dict = {}
        if has_adb:
            try:
                adb_devices = await self.adb.list_devices()
                adb_status_map = {d.serial: d for d in adb_devices}
            except Exception:
                pass

        for dev in list(self._devices.values()):
            # 사용자가 명시적으로 연결한 적 없는 디바이스는 자동 재연결 안 함
            if dev.id not in self._ever_connected:
                continue
            # ── ADB 디바이스 재연결 ──
            if dev.type == "adb":
                adb_serial = dev.address
                adb_dev = adb_status_map.get(adb_serial)
                current_adb_status = adb_dev.status if adb_dev else "offline"

                if current_adb_status == "device":
                    # 정상 연결 — 카운터 리셋 + 상태 갱신
                    was_offline = dev.status != "device"
                    if was_offline:
                        logger.info("ADB device back online: %s", dev.id)
                        # 재연결 시 이전 streamer 세션은 끊겼을 것 → 재생성
                        try:
                            await self.adb.close_streamer(dev.address)
                            await self.adb.ensure_streamer(dev.address)
                        except Exception as se:
                            logger.debug("ADB streamer restart on reconnect %s: %s", dev.id, se)
                    self._adb_reconnect_attempts.pop(dev.id, None)
                    dev.status = "device"
                    continue

                # passive 모드: 상태 갱신만 하고 reconnect 명령 실행 안 함
                if passive:
                    if current_adb_status != dev.status and dev.status not in ("error",):
                        dev.status = current_adb_status or "offline"
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
                        await self.adb._run(f"-s {adb_serial} reconnect")

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

            if dev.type == "hkmc_agent":
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
                # 재연결 락: playback의 _ensure_device_connected와 race 방지
                lock = self.get_reconnect_lock(dev.id)
                if lock.locked():
                    # 다른 경로(주로 playback)가 이미 재연결 중 — 스킵하고 다음 주기에 확인
                    continue
                async with lock:
                    # 락 획득 후 재검사: playback이 이미 성공시켰을 수 있음
                    hkmc = self._hkmc_conns.get(dev.id)
                    if hkmc and hkmc.is_connected:
                        self._hkmc_reconnect_attempts.pop(dev.id, None)
                        if dev.status != "connected":
                            dev.status = "connected"
                        continue
                    dev.status = "reconnecting"
                    try:
                        if hkmc:
                            hkmc.disconnect()
                        svc = HKMC6thService(dev.address, port, device_id=dev.id,
                                         key_overrides=dev.info.get("hkmc_keys"))
                        ok = await svc.async_connect()
                        if ok:
                            self._hkmc_conns[dev.id] = svc
                            self._hkmc_reconnect_attempts.pop(dev.id, None)
                            dev.status = "connected"
                            dev.info["agent_version"] = svc.agent_version
                            dev.info["screens"] = svc.get_info()["screens"]
                            dev.info["resolution"] = dev.info["screens"].get("front_center", {"width": 1920, "height": 720})
                            logger.info("HKMC auto-reconnect success: %s (after %d attempts)", dev.id, attempts)
                        else:
                            self._hkmc_reconnect_attempts[dev.id] = attempts + 1
                            dev.status = "disconnected"
                    except Exception as e:
                        self._hkmc_reconnect_attempts[dev.id] = attempts + 1
                        dev.status = "disconnected"
                        logger.debug("HKMC auto-reconnect failed (%d/%d): %s: %s",
                                     attempts + 1, self.HKMC_MAX_RECONNECT_ATTEMPTS, dev.id, e)

            if dev.type == "isap_agent":
                isap = self._isap_conns.get(dev.id)
                if isap and isap.is_connected:
                    self._isap_reconnect_attempts.pop(dev.id, None)
                    if dev.status != "connected":
                        dev.status = "connected"
                    continue
                port = dev.info.get("port", 0)
                if not port:
                    continue
                if dev.status == "error":
                    continue
                attempts = self._isap_reconnect_attempts.get(dev.id, 0)
                if attempts >= self.ISAP_MAX_RECONNECT_ATTEMPTS:
                    dev.status = "error"
                    logger.warning("iSAP reconnect give up after %d attempts: %s", attempts, dev.id)
                    continue
                lock = self.get_reconnect_lock(dev.id)
                if lock.locked():
                    continue
                async with lock:
                    isap = self._isap_conns.get(dev.id)
                    if isap and isap.is_connected:
                        self._isap_reconnect_attempts.pop(dev.id, None)
                        if dev.status != "connected":
                            dev.status = "connected"
                        continue
                    dev.status = "reconnecting"
                    try:
                        if isap:
                            isap.disconnect()
                        svc = ISAPAgentService(dev.address, port, device_id=dev.id,
                                       key_overrides=dev.info.get("isap_keys"))
                        ok = await svc.async_connect()
                        if ok:
                            self._isap_conns[dev.id] = svc
                            self._isap_reconnect_attempts.pop(dev.id, None)
                            dev.status = "connected"
                            dev.info["agent_version"] = svc.agent_version
                            dev.info["screens"] = svc.get_info()["screens"]
                            dev.info["resolution"] = dev.info["screens"].get(
                                svc.default_screen, {"width": 1920, "height": 720}
                            )
                            logger.info("iSAP auto-reconnect success: %s", dev.id)
                        else:
                            self._isap_reconnect_attempts[dev.id] = attempts + 1
                            dev.status = "disconnected"
                    except Exception as e:
                        self._isap_reconnect_attempts[dev.id] = attempts + 1
                        dev.status = "disconnected"
                        logger.debug("iSAP auto-reconnect failed (%d/%d): %s: %s",
                                     attempts + 1, self.ISAP_MAX_RECONNECT_ATTEMPTS, dev.id, e)

    def reset_reconnect_attempts(self, device_id: str) -> None:
        """수동 재연결 시 실패 카운터 리셋 (error 상태에서 복구 가능하게)."""
        self._hkmc_reconnect_attempts.pop(device_id, None)
        self._isap_reconnect_attempts.pop(device_id, None)
        self._adb_reconnect_attempts.pop(device_id, None)
        dev = self._devices.get(device_id)
        if dev and dev.status == "error":
            dev.status = "disconnected"

    def get_reconnect_lock(self, device_id: str) -> asyncio.Lock:
        """디바이스별 재연결 락 획득 (lazy 생성).

        playback._ensure_device_connected와 monitor 루프의 재연결 블록이
        동일 디바이스에 대해 동시에 실행되지 않도록 직렬화.
        """
        lock = self._reconnect_locks.get(device_id)
        if lock is None:
            lock = asyncio.Lock()
            self._reconnect_locks[device_id] = lock
        return lock

    async def scan_serial(self) -> list[dict]:
        """Scan available serial ports."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _scan_serial_ports)

    def _com_port_exists(self, address: str) -> bool:
        """지정 COM 포트가 시스템에 물리적으로 존재하는지 확인.
        COM 주소가 아니면 True를 반환해 기존 로직 흐름 유지.
        DLL 기반 모듈(CANAT 등)은 포트가 없어도 조용히 초기화되므로 이 가드로 차단.
        """
        if not isinstance(address, str) or not address.upper().startswith("COM"):
            return True
        try:
            from serial.tools import list_ports
            return any(p.device == address for p in list_ports.comports())
        except Exception as e:
            logger.debug("COM port existence check failed for %s: %s", address, e)
            return True  # 스캔 실패 시 기존 연결 시도 흐름 유지

    async def scan_hkmc(self, ports: list[int] | None = None) -> list[dict]:
        """TCP 포트 스캔으로 LAN(192.168.*) 상의 HKMC 디바이스 탐지.
        ports가 비어있으면 스캔하지 않음.
        """
        return await _scan_hkmc_tcp(ports=ports)

    async def scan_bench(self, ports: list[int] | None = None) -> list[dict]:
        """LAN(192.168.*)에서 네트워크 호스트 탐색 (ARP + ping + UDP 프로브)."""
        return await _scan_network_hosts(ports=ports)

    async def scan_smartbench(self, host: str | None = None, port: int | None = None) -> list[dict]:
        """SmartBench 장비 탐지. host/port 미지정 시 기본값(192.167.0.5:8000) 사용."""
        return await _scan_smartbench(host=host, port=port)

    async def scan_dlt(self, ports: list[int] | None = None) -> list[dict]:
        """TCP 포트 스캔으로 LAN(192.168.*) 상의 DLT 데몬 탐지."""
        return await _scan_dlt_tcp(ports=ports)

    async def scan_isap(self, ports: list[int] | None = None) -> list[dict]:
        """TCP 포트 스캔으로 LAN(192.168.*) 상의 iSAP Agent 탐지.
        단순 TCP open 체크 (iSAP은 핸드셰이크를 푸시하지 않는 경우가 있어 검증 생략).
        """
        if not ports:
            logger.info("iSAP scan skipped: no ports configured")
            return []
        candidate_ips = _collect_candidate_ips_192()
        if not candidate_ips:
            return []
        import asyncio as _a
        semaphore = _a.Semaphore(100)
        tasks = [
            _probe_tcp_port(ip, port, 0.3, semaphore)
            for ip in candidate_ips
            for port in ports
        ]
        results = await _a.gather(*tasks)
        found = [r for r in results if r is not None]
        seen: set[str] = set()
        deduped: list[dict] = []
        for r in found:
            if r["ip"] not in seen:
                seen.add(r["ip"])
                deduped.append(r)
                logger.info("iSAP scan: found open port at %s:%d", r["ip"], r["port"])
        return deduped

    async def scan_ssh(self, port: int = 22) -> list[dict]:
        """TCP 포트 스캔으로 LAN 상의 SSH 호스트 탐지."""
        return await scan_tcp_port(port)

    async def scan_icas(self, port: int = 22) -> list[dict]:
        """LAN 상의 ICAS 후보 호스트 탐지 (SSH 포트 기반 단순 탐지)."""
        return await scan_tcp_port(port)

    async def scan_udp_port(self, port: int) -> list[dict]:
        """LAN에서 특정 UDP 포트 응답 호스트 탐지."""
        return await _scan_udp_port(port)

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
        """시리얼 디바이스 등록만 (연결은 connect_device_by_id로 별도 수행)."""
        final_id = device_id or self._generate_device_id("serial")
        dev = ManagedDevice(
            id=final_id,
            type="serial",
            category=category,
            address=port,
            status="disconnected",
            name=name or final_id,
            info={"baudrate": baudrate},
        )
        self._devices[final_id] = dev
        self._save_auxiliary_devices()
        return dev

    async def add_ssh_device(self, host: str, port: int, username: str, password: str,
                             category: str = "auxiliary", name: str = "", device_id: str = "",
                             key_file_path: str = "") -> ManagedDevice:
        """SSH 디바이스 등록 + 즉시 인증 시도. 실패 시 RuntimeError.

        Args:
            host: SSH 호스트 (IP 또는 hostname)
            port: SSH 포트 (보통 22)
            username, password: 자격증명
            category: "primary" | "auxiliary"
            name: 표시 이름 (없으면 자동 생성)
            device_id: 사용자 지정 ID (없으면 자동 생성)
            key_file_path: SSH 키 파일 경로 (선택)
        """
        final_id = device_id or self._generate_device_id("ssh")
        display_name = name or f"{username}@{host}"

        # 1. 먼저 SSH 연결 시도 (실패 시 디바이스 등록 안 함)
        loop = asyncio.get_event_loop()
        ssh_conn = SSHConnection(host=host, port=port, username=username,
                                 password=password, key_file_path=key_file_path or None)
        try:
            await loop.run_in_executor(None, ssh_conn.connect)
        except Exception as e:
            raise RuntimeError(f"SSH connect failed: {e}") from e

        info = {
            "host": host,
            "port": port,
            "username": username,
            "password": password,  # 평문 저장 (auxiliary_devices.json)
            "key_file_path": key_file_path,
            "module": "SSHManager",  # 모듈 스텝 추가에서 자동으로 SSHManager 함수 사용
            "connect_type": "ssh",
        }
        dev = ManagedDevice(
            id=final_id,
            type="ssh",
            category=category,
            address=host,
            status="connected",
            name=display_name,
            info=info,
        )
        self._devices[final_id] = dev
        self._ssh_conns[final_id] = ssh_conn
        self._ever_connected.add(final_id)
        self._save_auxiliary_devices()
        logger.info("SSH device added: %s (%s@%s:%d)", final_id, username, host, port)
        return dev

    def get_ssh_conn(self, device_id: str) -> Optional[SSHConnection]:
        """등록된 SSH 디바이스의 SSHConnection 반환. 없으면 None."""
        return self._ssh_conns.get(device_id)

    def _close_ssh_conn(self, device_id: str) -> None:
        """SSH 연결 종료 + 캐시에서 제거."""
        conn = self._ssh_conns.pop(device_id, None)
        if conn:
            try:
                conn.disconnect()
            except Exception as e:
                logger.warning("SSH disconnect error %s: %s", device_id, e)

    async def add_module_device(self, address: str, module: str, connect_type: str = "none",
                               name: str = "", extra_fields: dict | None = None, device_id: str = "") -> ManagedDevice:
        """모듈 디바이스 등록만 (연결은 connect_device_by_id로 별도 수행)."""
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
            status="disconnected",
            name=display_name,
            info=info,
        )
        self._devices[final_id] = dev
        self._save_auxiliary_devices()

        return dev

    async def add_adb_wifi(self, address: str) -> ManagedDevice:
        """ADB WiFi 디바이스 등록만 (연결은 connect_device_by_id로 별도 수행)."""
        if address in self._devices:
            return self._devices[address]
        dev = ManagedDevice(
            id=address,
            type="adb",
            category="primary",
            address=address,
            status="disconnected",
            name=address,
            info={},
        )
        self._devices[address] = dev
        self._save_auxiliary_devices()
        return dev

    def swap_device_ids(self, id_a: str, id_b: str) -> None:
        """두 디바이스의 ID를 서로 교체합니다."""
        if self.is_protected_device(id_a) or self.is_protected_device(id_b):
            raise ValueError("Protected system device cannot be renamed or swapped")
        dev_a = self._devices.pop(id_a, None)
        dev_b = self._devices.pop(id_b, None)
        if not dev_a or not dev_b:
            raise ValueError(f"Device {id_a} or {id_b} not found")
        dev_a.id = id_b
        dev_b.id = id_a
        self._devices[id_b] = dev_a
        self._devices[id_a] = dev_b
        # 연결 객체도 교체
        for store in (self._serial_conns, self._hkmc_conns, self._isap_conns, self._vision_cams, self._webcam_devs):
            a_val = store.pop(id_a, None)
            b_val = store.pop(id_b, None)
            if a_val is not None:
                store[id_b] = a_val
            if b_val is not None:
                store[id_a] = b_val
        self._save_auxiliary_devices()
        logger.info("Device IDs swapped: %s <-> %s", id_a, id_b)

    def rename_device(self, old_id: str, new_id: str) -> None:
        """디바이스 ID를 변경합니다."""
        if self.is_protected_device(old_id):
            raise ValueError(f"Device '{old_id}' is a protected system default and cannot be renamed")
        dev = self._devices.pop(old_id, None)
        if not dev:
            raise ValueError(f"Device {old_id} not found")
        dev.id = new_id
        self._devices[new_id] = dev
        # 시리얼 연결도 이관
        if old_id in self._serial_conns:
            self._serial_conns[new_id] = self._serial_conns.pop(old_id)
        if old_id in self._hkmc_conns:
            self._hkmc_conns[new_id] = self._hkmc_conns.pop(old_id)
        if old_id in self._isap_conns:
            self._isap_conns[new_id] = self._isap_conns.pop(old_id)
        if old_id in self._vision_cams:
            self._vision_cams[new_id] = self._vision_cams.pop(old_id)
        if old_id in self._webcam_devs:
            self._webcam_devs[new_id] = self._webcam_devs.pop(old_id)
        if old_id in self._ever_connected:
            self._ever_connected.discard(old_id)
            self._ever_connected.add(new_id)
        self._save_auxiliary_devices()
        logger.info("Device renamed: %s → %s", old_id, new_id)

    def reorder_devices(self, prefix: str, ordered_ids: list[str]) -> None:
        """그룹 내 디바이스 순서를 변경하고 ID 번호를 재할당합니다.
        예: prefix="Android", ordered_ids=["Android_2","Android_1"]
        → Android_2→Android_1, Android_1→Android_2
        """
        # 1) 유효성 검증
        for did in ordered_ids:
            if did not in self._devices:
                raise ValueError(f"Device {did} not found")

        # 2) 새 ID 매핑 생성
        remap: dict[str, str] = {}  # old_id → new_id
        for idx, old_id in enumerate(ordered_ids, 1):
            new_id = f"{prefix}_{idx}"
            if old_id != new_id:
                remap[old_id] = new_id

        if not remap:
            return  # 변경 없음

        # 3) 충돌 방지: 임시 ID로 이동
        temp_map: dict[str, str] = {}  # temp_id → new_id
        stores = (self._serial_conns, self._hkmc_conns, self._isap_conns, self._vision_cams, self._webcam_devs)
        for old_id, new_id in remap.items():
            temp_id = f"__reorder_{old_id}__"
            dev = self._devices.pop(old_id)
            dev.id = temp_id
            self._devices[temp_id] = dev
            temp_map[temp_id] = new_id
            for store in stores:
                if old_id in store:
                    store[temp_id] = store.pop(old_id)
            if old_id in self._ever_connected:
                self._ever_connected.discard(old_id)
                self._ever_connected.add(temp_id)

        # 4) 최종 ID 적용
        for temp_id, new_id in temp_map.items():
            dev = self._devices.pop(temp_id)
            dev.id = new_id
            self._devices[new_id] = dev
            for store in stores:
                if temp_id in store:
                    store[new_id] = store.pop(temp_id)
            if temp_id in self._ever_connected:
                self._ever_connected.discard(temp_id)
                self._ever_connected.add(new_id)

        self._save_auxiliary_devices()
        logger.info("Devices reordered [%s]: %s", prefix, remap)

    async def remove_device(self, device_id: str) -> str:
        """Remove a device from managed list."""
        dev = self.get_device(device_id)
        if not dev:
            return f"Device {device_id} not found"

        if self.is_protected_device(dev.id):
            raise ValueError(f"Device '{dev.id}' is a protected system default and cannot be removed")

        # 장기 screencap 세션 정리 (ADB 디바이스 제거 시)
        if dev.type == "adb":
            try:
                await self.adb.close_streamer(dev.address)
            except Exception as se:
                logger.debug("ADB streamer close on remove failed for %s: %s", dev.id, se)

        if dev.type == "adb" and ":" in dev.address:
            result = await self.adb.disconnect_device(dev.address)
        else:
            result = f"Removed {dev.id}"

        self._close_serial_conn(dev.id)
        # Close HKMC connection if applicable
        hkmc = self._hkmc_conns.pop(dev.id, None)
        if hkmc:
            hkmc.disconnect()
        # Close iSAP Agent connection if applicable
        isap = self._isap_conns.pop(dev.id, None)
        if isap:
            isap.disconnect()
        # Close VisionCamera connection if applicable
        cam = self._vision_cams.pop(dev.id, None)
        if cam:
            try:
                cam.Disconnect()
            except Exception:
                pass
        # Close Webcam device connection if applicable
        wcam = self._webcam_devs.pop(dev.id, None)
        if wcam:
            try:
                wcam.Disconnect()
            except Exception:
                pass
        # Close SSH connection if applicable
        self._close_ssh_conn(dev.id)
        # 모듈 인스턴스 캐시 제거
        module_name = dev.info.get("module")
        if module_name:
            from .module_service import reset_instance
            reset_instance(module_name)
        self._devices.pop(dev.id, None)
        self._ever_connected.discard(dev.id)
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
        for dev in list(self._devices.values()):
            if dev.type == "serial":
                try:
                    await loop.run_in_executor(None, self._get_serial_conn, dev.id)
                    dev.status = "connected"
                    logger.info("Serial connection opened: %s (%s)", dev.id, dev.address)
                except Exception as e:
                    dev.status = "disconnected"
                    logger.warning("Failed to open serial %s (%s): %s", dev.id, dev.address, e)
            elif dev.type == "hkmc_agent":
                port = dev.info.get("port", 0)
                if not port:
                    continue
                try:
                    svc = HKMC6thService(dev.address, port, device_id=dev.id,
                                         key_overrides=dev.info.get("hkmc_keys"))
                    ok = await svc.async_connect()
                    if ok:
                        self._hkmc_conns[dev.id] = svc
                        dev.status = "connected"
                        dev.info["agent_version"] = svc.agent_version
                        dev.info["screens"] = svc.get_info()["screens"]
                        dev.info["resolution"] = dev.info["screens"].get("front_center", {"width": 1920, "height": 720})
                        logger.info("HKMC connection opened: %s (%s:%d)", dev.id, dev.address, port)
                    else:
                        dev.status = "disconnected"
                except Exception as e:
                    dev.status = "disconnected"
                    logger.warning("Failed to open HKMC %s (%s:%d): %s", dev.id, dev.address, port, e)
            elif dev.type == "isap_agent":
                port = dev.info.get("port", 0)
                if not port:
                    continue
                try:
                    svc = ISAPAgentService(dev.address, port, device_id=dev.id,
                                       key_overrides=dev.info.get("isap_keys"))
                    ok = await svc.async_connect()
                    if ok:
                        self._isap_conns[dev.id] = svc
                        dev.status = "connected"
                        dev.info["agent_version"] = svc.agent_version
                        dev.info["screens"] = svc.get_info()["screens"]
                        dev.info["resolution"] = dev.info["screens"].get(
                            svc.default_screen, {"width": 1920, "height": 720}
                        )
                        logger.info("iSAP connection opened: %s (%s:%d)", dev.id, dev.address, port)
                    else:
                        dev.status = "disconnected"
                except Exception as e:
                    dev.status = "disconnected"
                    logger.warning("Failed to open iSAP %s (%s:%d): %s", dev.id, dev.address, port, e)
            elif dev.type == "module":
                # 모듈 디바이스: 서버 시작 시 인스턴스 생성 + 연결 시도
                module_name = dev.info.get("module", "")
                if not module_name:
                    continue
                # 시리얼 기반 모듈: COM 포트 존재 여부 선검증 (DLL 모듈 오탐 차단)
                if dev.info.get("connect_type") == "serial":
                    if not await loop.run_in_executor(None, self._com_port_exists, dev.address):
                        dev.status = "disconnected"
                        logger.warning("Module %s skipped: COM port %s not present", dev.id, dev.address)
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
            elif dev.type == "webcam":
                try:
                    from ..plugins.WebcamDevice import WebcamDevice
                    cam = WebcamDevice(
                        device_index=int(dev.info.get("device_index", 0)),
                        width=int(dev.info.get("width", 0)),
                        height=int(dev.info.get("height", 0)),
                    )
                    await loop.run_in_executor(None, cam.Connect)
                    self._webcam_devs[dev.id] = cam
                    dev.status = "connected"
                    logger.info("Webcam connection opened: %s (index=%s)", dev.id, dev.info.get("device_index"))
                except Exception as e:
                    dev.status = "disconnected"
                    logger.warning("Failed to open Webcam %s: %s", dev.id, e)

    async def connect_device_by_id(self, device_id: str) -> str:
        """등록된 디바이스 1개를 연결. 결과 메시지 반환."""
        dev = self._devices.get(device_id)
        if not dev:
            return f"Device {device_id} not found"
        loop = asyncio.get_event_loop()

        def _mark_connected():
            self._ever_connected.add(device_id)

        if dev.type == "serial":
            module_name = dev.info.get("module", "")

            # COM 포트 존재 여부 선검증 — DLL 기반 모듈(CANAT 등)은 포트가 없어도
            # init()이 조용히 성공하고 hdll이 설정되므로 _is_connected가 오탐하는 문제 차단
            if not await loop.run_in_executor(None, self._com_port_exists, dev.address):
                dev.status = "disconnected"
                logger.info("Serial connect skipped: %s — COM port %s not present", dev.id, dev.address)
                return f"Serial connect failed: {dev.id} — COM port {dev.address} not available"

            # DLL 기반 모듈(CANAT 등)은 자체적으로 COM 포트를 관리하므로
            # pyserial로 포트를 열면 충돌 발생 — 모듈 init만 수행
            if module_name:
                try:
                    from .module_service import _get_instance, _is_connected
                    from ..routers.device import _build_constructor_kwargs
                    ctor_kwargs = _build_constructor_kwargs(dev)
                    instance = await loop.run_in_executor(
                        None, functools.partial(_get_instance, module_name, ctor_kwargs, None),
                    )
                    if _is_connected(instance):
                        dev.status = "connected"
                        _mark_connected()
                        return f"Module connected: {dev.id} ({dev.address}) + {module_name} init OK"
                    else:
                        # DLL이 없는 모듈은 shared_serial_conn 방식으로 폴백
                        try:
                            await loop.run_in_executor(None, self._get_serial_conn, dev.id)
                            shared_conn = self.get_serial_conn(dev.id)
                            instance = await loop.run_in_executor(
                                None, functools.partial(_get_instance, module_name, ctor_kwargs, shared_conn),
                            )
                            dev.status = "connected"
                            _mark_connected()
                            return f"Serial connected: {dev.id} ({dev.address}) + {module_name}"
                        except Exception as e2:
                            dev.status = "disconnected"
                            return f"Module connect failed: {dev.id} — {e2}"
                except Exception as e:
                    logger.warning("Module init failed for %s on %s: %s", module_name, dev.id, e)
                    dev.status = "disconnected"
                    return f"Module connect failed: {dev.id} ({module_name}) — {e}"

            # 순수 시리얼 디바이스 (모듈 없음)
            try:
                await loop.run_in_executor(None, self._get_serial_conn, dev.id)
                dev.status = "connected"
                _mark_connected()
                return f"Serial connected: {dev.id} ({dev.address})"
            except Exception as e:
                dev.status = "disconnected"
                return f"Serial connect failed: {dev.id} — {e}"

        elif dev.type == "hkmc_agent":
            port = dev.info.get("port", 0)
            if not port:
                return f"HKMC {dev.id}: no port configured"
            try:
                from .hkmc6th_service import HKMC6thService
                svc = HKMC6thService(dev.address, port, device_id=dev.id,
                                         key_overrides=dev.info.get("hkmc_keys"))
                ok = await svc.async_connect()
                if ok:
                    self._hkmc_conns[dev.id] = svc
                    dev.status = "connected"
                    _mark_connected()
                    dev.info["agent_version"] = svc.agent_version
                    dev.info["screens"] = svc.get_info()["screens"]
                    dev.info["resolution"] = dev.info["screens"].get("front_center", {"width": 1920, "height": 720})
                    return f"HKMC connected: {dev.id} ({dev.address}:{port})"
                else:
                    dev.status = "disconnected"
                    return f"HKMC connect failed: {dev.id}"
            except Exception as e:
                dev.status = "disconnected"
                return f"HKMC connect failed: {dev.id} — {e}"

        elif dev.type == "isap_agent":
            port = dev.info.get("port", 0)
            if not port:
                return f"iSAP {dev.id}: no port configured"
            try:
                svc = ISAPAgentService(dev.address, port, device_id=dev.id,
                                       key_overrides=dev.info.get("isap_keys"))
                ok = await svc.async_connect()
                if ok:
                    self._isap_conns[dev.id] = svc
                    dev.status = "connected"
                    _mark_connected()
                    dev.info["agent_version"] = svc.agent_version
                    dev.info["screens"] = svc.get_info()["screens"]
                    dev.info["resolution"] = dev.info["screens"].get(
                        svc.default_screen, {"width": 1920, "height": 720}
                    )
                    return f"iSAP connected: {dev.id} ({dev.address}:{port})"
                else:
                    dev.status = "disconnected"
                    return f"iSAP connect failed: {dev.id}"
            except Exception as e:
                dev.status = "disconnected"
                return f"iSAP connect failed: {dev.id} — {e}"

        elif dev.type == "icas_agent":
            port = int(dev.info.get("port", 22) or 22)
            username = dev.info.get("username", "root") or "root"
            password = dev.info.get("password", "") or ""
            # resolution_str(원본 "WxH") 우선, 없으면 resolution(dict) → "WxH" 복원, 모두 없으면 기본값
            res_str = dev.info.get("resolution_str")
            if not res_str:
                res_val = dev.info.get("resolution")
                if isinstance(res_val, dict) and "width" in res_val and "height" in res_val:
                    res_str = f"{res_val['width']}x{res_val['height']}"
                elif isinstance(res_val, str):
                    res_str = res_val
                else:
                    res_str = "1560x700"
            # market 추론: info.market > device_model 키워드 > EU 기본
            market = (dev.info.get("market") or "").strip().upper()
            if not market:
                dm_val = (dev.info.get("device_model") or "").upper()
                for _m in ("EU", "NAR", "CN", "GP"):
                    if _m in dm_val:
                        market = _m
                        break
            if not market:
                market = "EU"
            dev.info["market"] = market  # 정규화 후 저장

            # 레거시 private_server_ip 치환: EU/NAR/CN인데 IPv4 "192.168.0.2"로 남아있는 경우
            # (이전 버전 기본값) → 빈 값으로 바꿔 market 기본(IPv6)을 쓰게 함
            private_ip = dev.info.get("private_server_ip", "") or ""
            if market in ("EU", "NAR", "CN") and private_ip == "192.168.0.2":
                private_ip = ""
                dev.info["private_server_ip"] = ""
            try:
                svc = ICASAgentService(
                    dev.address, port=port, device_id=dev.id,
                    username=username, password=password, resolution=res_str,
                    # private_server_ip는 빈 문자열이면 market 기본값 사용
                    private_server_ip=private_ip,
                    private_server_password=dev.info.get("private_server_password", "") or "",
                    iid_display=dev.info.get("iid_display", "10") or "10",
                    hud_display=dev.info.get("hud_display", "11") or "11",
                    market=market,
                    key_overrides=dev.info.get("icas_keys"),
                )
                ok = await svc.async_connect()
                if ok:
                    self._icas_conns[dev.id] = svc
                    dev.status = "connected"
                    _mark_connected()
                    dev.info["agent_version"] = svc.agent_version
                    dev.info["screens"] = svc.get_info()["screens"]
                    # 프론트엔드용 dict 정규화 (HKMC/iSAP와 동일 스키마)
                    dev.info["resolution"] = dev.info["screens"].get(
                        svc.default_screen, {"width": 1560, "height": 700}
                    )
                    dev.info["resolution_str"] = res_str
                    return f"ICAS connected: {dev.id} ({dev.address}:{port})"
                else:
                    dev.status = "disconnected"
                    return f"ICAS connect failed: {dev.id}"
            except Exception as e:
                dev.status = "disconnected"
                return f"ICAS connect failed: {dev.id} — {e}"

        elif dev.type == "module":
            module_name = dev.info.get("module", "")
            if not module_name:
                return f"Module {dev.id}: no module configured"
            # 시리얼 기반 모듈: COM 포트 존재 여부 선검증 (DLL 모듈 오탐 차단)
            if dev.info.get("connect_type") == "serial":
                if not await loop.run_in_executor(None, self._com_port_exists, dev.address):
                    dev.status = "disconnected"
                    logger.info("Module connect skipped: %s — COM port %s not present", dev.id, dev.address)
                    return f"Module connect failed: {dev.id} — COM port {dev.address} not available"
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
                    _mark_connected()
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
                _mark_connected()
                return f"VisionCamera connected: {dev.id} ({mac})"
            except Exception as e:
                dev.status = "disconnected"
                return f"VisionCamera connect failed: {dev.id} — {e}"

        elif dev.type == "webcam":
            try:
                # 기존 연결 정리
                old = self._webcam_devs.pop(dev.id, None)
                if old:
                    try:
                        await loop.run_in_executor(None, old.Disconnect)
                    except Exception:
                        pass
                # 녹화용 싱글톤이 같은 인덱스를 열고 있으면 자동 해제 (하드웨어 경합 방지)
                try:
                    target_index = int(dev.info.get("device_index", 0))
                    from .webcam_service import get_webcam_service
                    wsvc = get_webcam_service()
                    if wsvc.is_open() and getattr(wsvc, "_device_index", None) == target_index:
                        logger.info("Closing recording webcam singleton (index=%d) — device being registered as primary", target_index)
                        await loop.run_in_executor(None, wsvc.close)
                except Exception as _e:
                    logger.debug("Failed to close recording singleton pre-connect: %s", _e)
                from ..plugins.WebcamDevice import WebcamDevice
                cam = WebcamDevice(
                    device_index=int(dev.info.get("device_index", 0)),
                    width=int(dev.info.get("width", 0)),
                    height=int(dev.info.get("height", 0)),
                )
                await loop.run_in_executor(None, cam.Connect)
                self._webcam_devs[dev.id] = cam
                info = cam.GetInfo()
                dev.info["width"] = info.get("width", dev.info.get("width", 0))
                dev.info["height"] = info.get("height", dev.info.get("height", 0))
                dev.info["resolution"] = {
                    "width": info.get("width", 0),
                    "height": info.get("height", 0),
                }
                dev.status = "connected"
                _mark_connected()
                return f"Webcam connected: {dev.id} (index={dev.info.get('device_index')})"
            except Exception as e:
                dev.status = "disconnected"
                return f"Webcam connect failed: {dev.id} — {e}"

        elif dev.type == "ssh":
            host = dev.info.get("host", dev.address)
            port = int(dev.info.get("port", 22))
            username = dev.info.get("username", "")
            password = dev.info.get("password", "")
            key_file_path = dev.info.get("key_file_path", "") or None
            try:
                # 기존 연결 닫고 새로 생성
                self._close_ssh_conn(dev.id)
                conn = SSHConnection(host=host, port=port, username=username,
                                     password=password, key_file_path=key_file_path)
                await loop.run_in_executor(None, conn.connect)
                self._ssh_conns[dev.id] = conn
                dev.status = "connected"
                _mark_connected()
                return f"SSH connected: {dev.id} ({username}@{host}:{port})"
            except Exception as e:
                dev.status = "disconnected"
                return f"SSH connect failed: {dev.id} — {e}"

        elif dev.type == "adb":
            try:
                # WiFi: adb connect, USB: adb reconnect
                if ":" in dev.address:
                    await self.adb.connect_device(dev.address)
                else:
                    # USB 디바이스: reconnect 시도 (connecting 상태 해결)
                    try:
                        await self.adb._run(f"-s {dev.address} reconnect")
                    except Exception:
                        pass

                # 연결 확인 (최대 3회 재시도)
                for attempt in range(3):
                    devs = await self.adb.list_devices()
                    found = next((d for d in devs if d.serial == dev.address), None)
                    if found and found.status == "device":
                        dev.status = "device"
                        _mark_connected()
                        self._adb_reconnect_attempts.pop(dev.id, None)
                        # 화면 미러링용 장기 adb shell 세션 선제 시작 (프레임당 spawn 회피)
                        try:
                            await self.adb.ensure_streamer(dev.address)
                        except Exception as se:
                            logger.debug("ADB streamer pre-start failed for %s: %s", dev.id, se)
                        return f"ADB connected: {dev.id} ({dev.address})"
                    if attempt < 2:
                        await asyncio.sleep(1)

                dev.status = found.status if found else "offline"
                return f"ADB not ready: {dev.id} ({dev.status})"
            except Exception as e:
                dev.status = "offline"
                return f"ADB connect failed: {dev.id} — {e}"

        return f"Unknown device type: {dev.type}"

    async def disconnect_device_by_id(self, device_id: str) -> str:
        """등록된 디바이스 1개의 연결만 끊기 (등록은 유지). 결과 메시지 반환."""
        dev = self._devices.get(device_id)
        if not dev:
            return f"Device {device_id} not found"

        # 시스템 기본 디바이스(Common 등)는 항상 연결 상태 유지
        if self.is_protected_device(device_id):
            return f"Device '{device_id}' is a protected system default (no-op)"

        self._ever_connected.discard(device_id)

        if dev.type == "serial" or dev.type == "module":
            self._close_serial_conn(device_id)
            dev.status = "disconnected"
            return f"Disconnected: {dev.id}"

        elif dev.type == "hkmc_agent":
            svc = self._hkmc_conns.pop(device_id, None)
            if svc:
                try:
                    svc.disconnect()
                except Exception:
                    pass
            dev.status = "disconnected"
            return f"Disconnected: {dev.id}"

        elif dev.type == "isap_agent":
            svc = self._isap_conns.pop(device_id, None)
            if svc:
                try:
                    svc.disconnect()
                except Exception:
                    pass
            dev.status = "disconnected"
            return f"Disconnected: {dev.id}"

        elif dev.type == "icas_agent":
            svc = self._icas_conns.pop(device_id, None)
            if svc:
                try:
                    svc.disconnect()
                except Exception:
                    pass
            dev.status = "disconnected"
            return f"Disconnected: {dev.id}"

        elif dev.type == "vision_camera":
            cam = self._vision_cams.pop(device_id, None)
            if cam:
                try:
                    cam.Disconnect()
                except Exception:
                    pass
            dev.status = "disconnected"
            return f"Disconnected: {dev.id}"

        elif dev.type == "webcam":
            cam = self._webcam_devs.pop(device_id, None)
            if cam:
                try:
                    cam.Disconnect()
                except Exception:
                    pass
            dev.status = "disconnected"
            return f"Disconnected: {dev.id}"

        elif dev.type == "ssh":
            self._close_ssh_conn(device_id)
            dev.status = "disconnected"
            return f"Disconnected: {dev.id}"

        elif dev.type == "adb":
            # 장기 화면 streamer 세션 먼저 닫기
            try:
                await self.adb.close_streamer(dev.address)
            except Exception as se:
                logger.debug("ADB streamer close failed for %s: %s", dev.id, se)
            if ":" in dev.address:
                try:
                    await self.adb._run(f"disconnect {dev.address}")
                except Exception:
                    pass
            dev.status = "disconnected"
            return f"Disconnected: {dev.id}"

        dev.status = "disconnected"
        return f"Disconnected: {dev.id}"

    def close_all_serial_connections(self) -> None:
        """Close all persistent serial/HKMC/VisionCamera/SSH connections (called on shutdown)."""
        for device_id in list(self._serial_conns.keys()):
            self._close_serial_conn(device_id)
            logger.info("Serial connection closed: %s", device_id)
        for device_id, hkmc in list(self._hkmc_conns.items()):
            hkmc.disconnect()
            logger.info("HKMC connection closed: %s", device_id)
        self._hkmc_conns.clear()
        for device_id, isap in list(self._isap_conns.items()):
            isap.disconnect()
            logger.info("iSAP connection closed: %s", device_id)
        self._isap_conns.clear()
        for device_id in list(self._ssh_conns.keys()):
            self._close_ssh_conn(device_id)
            logger.info("SSH connection closed: %s", device_id)
        for device_id, cam in list(self._vision_cams.items()):
            try:
                cam.Disconnect()
            except Exception:
                pass
            logger.info("VisionCamera connection closed: %s", device_id)
        self._vision_cams.clear()
        for device_id, cam in list(self._webcam_devs.items()):
            try:
                cam.Disconnect()
            except Exception:
                pass
            logger.info("Webcam connection closed: %s", device_id)
        self._webcam_devs.clear()

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
