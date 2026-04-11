"""Device management API routes."""

import base64
import json as _json
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

logger = logging.getLogger(__name__)

from ..dependencies import adb_service as adb, device_manager as dm
from ..services.adb_service import resolve_sf_display_id
from ..services.module_service import list_available_modules, get_module_functions, execute_module_function


def _with_protected_flag(devices: list) -> list[dict]:
    """ManagedDevice 리스트를 dict로 직렬화하면서 protected 플래그를 주입."""
    result = []
    for d in devices:
        data = d.to_dict()
        data["protected"] = dm.is_protected_device(d.id)
        result.append(data)
    return result

# ── 스캔 설정 ──────────────────────────────────────────────
_SCAN_SETTINGS_FILE = Path(__file__).resolve().parent.parent.parent / "scan_settings.json"

_DEFAULT_SCAN_SETTINGS = {
    "builtin": {
        "adb":            {"enabled": True,  "module": ""},
        "serial":         {"enabled": True,  "module": "SerialLogging"},
        "hkmc":           {"enabled": True,  "module": ""},
        "dlt":            {"enabled": True,  "module": "DLTLogging"},
        "bench":          {"enabled": True,  "module": "CCIC_BENCH"},
        "vision_camera":  {"enabled": False, "module": "VisionCamera"},
        "ssh":            {"enabled": True,  "module": "SSHManager", "port": 22},
    },
    # type: "tcp" | "udp"
    # [{"label": "MLP", "type": "tcp", "port": 5001, "module": "MLP", "enabled": true}, ...]
    "custom": [],
}


def _load_scan_settings() -> dict:
    if _SCAN_SETTINGS_FILE.exists():
        try:
            return _json.loads(_SCAN_SETTINGS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return dict(_DEFAULT_SCAN_SETTINGS)


def _save_scan_settings(settings: dict) -> None:
    _SCAN_SETTINGS_FILE.write_text(_json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")


def _parse_adb_display_id(screen_type: str | None) -> int | None:
    """screen_type 문자열에서 ADB display_id 추출. '0', '2' 등 숫자 또는 None."""
    if screen_type is None:
        return None
    try:
        return int(screen_type)
    except (ValueError, TypeError):
        return None

router = APIRouter(prefix="/api/device", tags=["device"])


def _build_constructor_kwargs(dev) -> dict | None:
    """Build constructor kwargs from device info for module instantiation."""
    if not dev:
        return None
    connect_type = dev.info.get("connect_type", "serial" if dev.type == "serial" else "none")
    if connect_type == "serial":
        kwargs = {"port": dev.address, "bps": dev.info.get("baudrate", 115200)}
        # connect_fields의 추가 필드도 포함 (e.g. CANAT의 log_path, ch1_fd 등)
        for k, v in dev.info.items():
            if k not in ("module", "connect_type", "baudrate"):
                kwargs[k] = v
        return kwargs
    elif connect_type == "socket":
        kwargs = {"host": dev.address}
        # 추가 필드 전달 (예: udp_port) — 생성자 시그니처 매칭으로 필터링됨
        for k, v in dev.info.items():
            if k not in ("module", "connect_type"):
                kwargs[k] = v
        return kwargs
    elif connect_type == "can":
        # CAN modules store extra fields in device info
        return {k: v for k, v in dev.info.items() if k not in ("module", "connect_type")}
    elif connect_type == "vision_camera":
        # VisionCamera: MAC, model, serial, ip, subnetmask
        return {k: v for k, v in dev.info.items() if k not in ("module", "connect_type")}
    return None


class ConnectRequest(BaseModel):
    type: str  # "adb" | "serial" | "module" | "hkmc6th" | "vision_camera" | "ssh"
    category: str = ""  # "primary" | "auxiliary" — auto-detected if empty
    address: str = ""  # COM port for serial, IP for socket/HKMC/SSH, etc.
    baudrate: Optional[int] = 115200
    port: Optional[int] = None  # TCP port for HKMC6th / SSH (default 22)
    name: Optional[str] = ""
    device_id: Optional[str] = ""  # custom device ID/alias (e.g. "Android_1", "HKMC_1")
    module: Optional[str] = None  # lge.auto module name (e.g. "POWER", "CAN")
    connect_type: Optional[str] = None  # "serial" | "socket" | "can" | "none" | "vision_camera" | "ssh"
    extra_fields: Optional[dict] = None  # Additional module-specific fields (SSH: username, password, key_file_path)
    device_model: Optional[str] = None  # 장비 모델 (GVM, ccNC, Phone 등) — 하드키 매칭용


class DisconnectRequest(BaseModel):
    address: str


_last_full_refresh = 0.0


@router.get("/list")
async def list_devices():
    """List all managed devices, split by category."""
    import time
    global _last_full_refresh
    now = time.time()
    # ADB refresh는 10초마다 (재연결 루프와 별도로 UI 표시용)
    if now - _last_full_refresh > 10:
        await dm.refresh_adb()
        _last_full_refresh = now
    # auxiliary는 빠른 상태 확인만 (네트워크 I/O 없음)
    await dm.refresh_auxiliary()
    return {
        "primary": _with_protected_flag(dm.list_primary()),
        "auxiliary": _with_protected_flag(dm.list_auxiliary()),
    }


@router.get("/scan-settings")
async def get_scan_settings():
    """현재 스캔 설정 조회."""
    return _load_scan_settings()


@router.post("/scan-settings")
async def save_scan_settings(request: Request):
    """스캔 설정 저장."""
    body = await request.json()
    _save_scan_settings(body)
    return {"status": "ok"}


@router.get("/scan")
async def scan_ports():
    """Scan available connection targets — 스캔 설정에 따라 활성화된 항목만 실행."""
    import asyncio
    from ..services.device_manager import scan_tcp_port

    settings = _load_scan_settings()
    builtin = settings.get("builtin", {})
    custom = settings.get("custom", [])

    def _enabled(key: str) -> bool:
        v = builtin.get(key, {})
        if isinstance(v, dict):
            return v.get("enabled", True)
        return bool(v)  # 레거시 호환 (단순 bool)

    tasks: dict[str, asyncio.Task] = {}

    if _enabled("adb"):
        tasks["adb_devices"] = asyncio.ensure_future(adb.list_devices())
    if _enabled("serial"):
        tasks["serial_ports"] = asyncio.ensure_future(dm.scan_serial())
    if _enabled("hkmc"):
        tasks["hkmc_devices"] = asyncio.ensure_future(dm.scan_hkmc())
    if _enabled("bench"):
        tasks["bench_devices"] = asyncio.ensure_future(dm.scan_bench())
    if _enabled("vision_camera"):
        tasks["vision_cameras"] = asyncio.ensure_future(dm.scan_vision_cameras())
    if _enabled("dlt"):
        tasks["dlt_devices"] = asyncio.ensure_future(dm.scan_dlt())
    if _enabled("smartbench"):
        tasks["smartbench_devices"] = asyncio.ensure_future(dm.scan_smartbench())
    if _enabled("ssh"):
        ssh_entry = builtin.get("ssh", {}) if isinstance(builtin.get("ssh"), dict) else {}
        ssh_port = int(ssh_entry.get("port", 22))
        tasks["ssh_hosts"] = asyncio.ensure_future(dm.scan_ssh(ssh_port))

    # 커스텀 TCP/UDP 포트 스캔
    custom_tasks: list[tuple[str, asyncio.Task]] = []
    for entry in custom:
        if entry.get("enabled") and entry.get("port"):
            label = entry.get("label", f"{entry.get('type','tcp').upper()}:{entry['port']}")
            proto = entry.get("type", "tcp")
            port = int(entry["port"])
            if proto == "udp":
                custom_tasks.append((label, asyncio.ensure_future(dm.scan_udp_port(port))))
            else:
                custom_tasks.append((label, asyncio.ensure_future(scan_tcp_port(port))))

    # 모든 태스크 병렬 실행
    all_keys = list(tasks.keys())
    all_futures = list(tasks.values())
    for label, fut in custom_tasks:
        all_keys.append(f"custom_{label}")
        all_futures.append(fut)

    results = await asyncio.gather(*all_futures, return_exceptions=True)

    response: dict = {
        "adb_devices": [],
        "serial_ports": [],
        "hkmc_devices": [],
        "bench_devices": [],
        "vision_cameras": [],
        "dlt_devices": [],
        "smartbench_devices": [],
        "ssh_hosts": [],
        "custom_results": [],
    }
    for key, result in zip(all_keys, results):
        if isinstance(result, Exception):
            logger.warning("Scan %s failed: %s", key, result)
            continue
        if key == "adb_devices":
            response["adb_devices"] = [d.to_dict() for d in result]
        elif key.startswith("custom_"):
            label = key[len("custom_"):]
            response["custom_results"].append({"label": label, "hosts": result})
        else:
            response[key] = result

    return response


@router.get("/local-interfaces")
async def get_local_interfaces():
    """PC의 네트워크 인터페이스 목록 반환."""
    interfaces = []
    try:
        import ifaddr
        for adapter in ifaddr.get_adapters():
            for ip in adapter.ips:
                if ip.is_IPv4 and not str(ip.ip).startswith("127."):
                    interfaces.append({
                        "name": adapter.nice_name,
                        "ip": str(ip.ip),
                        "prefix": ip.network_prefix,
                    })
    except ImportError:
        import socket
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            addr = info[4][0]
            if not addr.startswith("127."):
                interfaces.append({"name": "", "ip": addr, "prefix": 24})
    return {"interfaces": interfaces}


class ForceIPRequest(BaseModel):
    mac: str
    ip: str
    subnet: str = "255.255.255.0"
    gateway: str = "0.0.0.0"


@router.post("/vision-force-ip")
async def vision_force_ip(req: ForceIPRequest):
    """VisionCamera ForceIP — 카메라 IP를 강제 변경."""
    result = await dm.force_ip_camera(req.mac, req.ip, req.subnet, req.gateway)
    if "OK" in result:
        return {"result": result}
    raise HTTPException(status_code=400, detail=result)


@router.post("/connect")
async def connect_device(req: ConnectRequest):
    """Connect to a device."""
    custom_id = req.device_id or ""
    if req.type == "adb":
        if ":" in req.address:
            # WiFi ADB — connect first
            await dm.adb.connect_device(req.address)
        dev = await dm.add_adb_device(req.address, device_id=custom_id, name=req.name or "", device_model=req.device_model or "")
        return {
            "result": f"Connected: {dev.name} (ID: {dev.id})",
            "primary": _with_protected_flag(dm.list_primary()),
            "auxiliary": _with_protected_flag(dm.list_auxiliary()),
        }
    elif req.type == "serial":
        category = req.category or "auxiliary"
        try:
            dev = await dm.add_serial_device(req.address, req.baudrate or 115200, req.name or "", category, device_id=custom_id)
            if req.module:
                dev.info["module"] = req.module
                dev.info["connect_type"] = req.connect_type or "serial"
                dm._save_auxiliary_devices()
            return {
                "result": f"Serial {req.address} added (ID: {dev.id})",
                "primary": _with_protected_flag(dm.list_primary()),
                "auxiliary": _with_protected_flag(dm.list_auxiliary()),
            }
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))
    elif req.type == "hkmc6th":
        if not req.address or not req.port:
            raise HTTPException(status_code=400, detail="HKMC6th requires address (IP) and port (TCP port)")
        try:
            dev = await dm.add_hkmc6th_device(req.address, req.port, device_id=custom_id, name=req.name or "", device_model=req.device_model or "")
            return {
                "result": f"HKMC connected: {dev.name} (ID: {dev.id})",
                "primary": _with_protected_flag(dm.list_primary()),
                "auxiliary": _with_protected_flag(dm.list_auxiliary()),
            }
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))
    elif req.type == "module":
        category = req.category or "auxiliary"
        dev = await dm.add_module_device(
            address=req.address,
            module=req.module or "",
            connect_type=req.connect_type or "none",
            name=req.name or "",
            extra_fields=req.extra_fields,
            device_id=custom_id,
        )
        return {
            "result": f"Module device {req.module} added (ID: {dev.id})",
            "primary": _with_protected_flag(dm.list_primary()),
            "auxiliary": _with_protected_flag(dm.list_auxiliary()),
        }
    elif req.type == "ssh":
        ef = req.extra_fields or {}
        username = ef.get("username", "")
        password = ef.get("password", "")
        key_file_path = ef.get("key_file_path", "")
        if not req.address:
            raise HTTPException(status_code=400, detail="SSH requires address (host)")
        if not username:
            raise HTTPException(status_code=400, detail="SSH requires username")
        if not password and not key_file_path:
            raise HTTPException(status_code=400, detail="SSH requires password or key_file_path")
        category = req.category or "auxiliary"
        try:
            dev = await dm.add_ssh_device(
                host=req.address,
                port=int(req.port or 22),
                username=username,
                password=password,
                category=category,
                name=req.name or "",
                device_id=custom_id,
                key_file_path=key_file_path,
            )
            return {
                "result": f"SSH connected: {dev.name} (ID: {dev.id})",
                "primary": _with_protected_flag(dm.list_primary()),
                "auxiliary": _with_protected_flag(dm.list_auxiliary()),
            }
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))

    elif req.type == "vision_camera":
        ef = req.extra_fields or {}
        mac = ef.get("mac", "")
        logger.info("[VisionCamera] connect request: mac=%s address=%s extra_fields=%s", mac, req.address, ef)
        if not mac:
            raise HTTPException(status_code=400, detail="VisionCamera requires MAC address")
        try:
            dev = await dm.add_vision_camera_device(
                mac=mac,
                model=ef.get("model", ""),
                serial=ef.get("serial", ""),
                ip=req.address or ef.get("ip", ""),
                subnetmask=ef.get("subnetmask", "255.255.0.0"),
                device_id=custom_id,
                name=req.name or "",
            )
            return {
                "result": f"VisionCamera connected: {dev.name} (ID: {dev.id})",
                "primary": _with_protected_flag(dm.list_primary()),
                "auxiliary": _with_protected_flag(dm.list_auxiliary()),
            }
        except Exception as e:
            logger.error("[VisionCamera] connect failed: %s", e, exc_info=True)
            raise HTTPException(status_code=400, detail=str(e))
    else:
        raise HTTPException(status_code=400, detail=f"Unknown type: {req.type}")


@router.post("/disconnect")
async def disconnect_device(req: DisconnectRequest):
    """Disconnect/remove a device."""
    if dm.is_protected_device(req.address):
        raise HTTPException(
            status_code=403,
            detail=f"Device '{req.address}' is a protected system default and cannot be removed",
        )
    try:
        result = await dm.remove_device(req.address)
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return {
        "result": result,
        "primary": _with_protected_flag(dm.list_primary()),
        "auxiliary": _with_protected_flag(dm.list_auxiliary()),
    }


class DisconnectOneRequest(BaseModel):
    device_id: str

@router.post("/disconnect-one")
async def disconnect_one_device(req: DisconnectOneRequest):
    """연결만 끊기 (등록 유지)."""
    result = await dm.disconnect_device_by_id(req.device_id)
    return {
        "result": result,
        "primary": _with_protected_flag(dm.list_primary()),
        "auxiliary": _with_protected_flag(dm.list_auxiliary()),
    }


@router.get("/info/{device_id}")
async def get_device_info(device_id: str):
    """Get device information."""
    dev = dm.get_device(device_id)
    if not dev:
        raise HTTPException(status_code=404, detail=f"Device {device_id} not found")
    if dev.type == "adb":
        try:
            return await adb.get_device_info(dev.address)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    elif dev.type == "hkmc6th":
        hkmc = dm.get_hkmc_service(device_id)
        info = dev.to_dict()
        if hkmc:
            info["hkmc_info"] = hkmc.get_info()
        return info
    else:
        return dev.to_dict()


class InputRequest(BaseModel):
    device_id: str
    action: str  # "tap" | "swipe" | "input_text" | "key_event" | "adb_command" | "serial_command" | "module_command" | "hkmc_touch" | "hkmc_swipe" | "hkmc_key"
    params: dict


@router.post("/input")
async def device_input(req: InputRequest):
    """Execute an input action directly on a device (without recording)."""
    dev = dm.get_device(req.device_id)

    try:
        if req.action == "module_command":
            module_name = req.params.get("module", "")
            func_name = req.params.get("function", "")
            func_args = req.params.get("args", {})
            if not module_name or not func_name:
                raise HTTPException(status_code=400, detail="module and function are required")
            # Pass device connection info as constructor kwargs
            ctor_kwargs = _build_constructor_kwargs(dev) if dev else None
            shared_conn = dm.get_serial_conn(req.device_id) if dev else None
            response = await execute_module_function(module_name, func_name, func_args, ctor_kwargs, shared_conn)
            return {"result": "ok", "response": response}

        if req.action == "serial_command":
            if not dev or dev.type != "serial":
                raise HTTPException(status_code=404, detail=f"Serial device {req.device_id} not found")
            response = await dm.send_serial_command(
                req.device_id, req.params.get("data", ""), req.params.get("read_timeout", 1.0)
            )
            return {"result": "ok", "response": response}

        if req.action in ("hkmc_touch", "hkmc_swipe", "hkmc_key", "repeat_tap") and dev and dev.type == "hkmc6th":
            hkmc = dm.get_hkmc_service(req.device_id)
            if not hkmc:
                raise HTTPException(status_code=400, detail=f"HKMC device {req.device_id} not connected")
            logger.info("[HKMC INPUT] device=%s action=%s params=%s connected=%s",
                        req.device_id, req.action, req.params, hkmc.is_connected)
            p = req.params
            screen_type = p.get("screen_type", "front_center")
            if req.action == "repeat_tap":
                await hkmc.async_repeat_tap(p["x"], p["y"], int(p.get("count", 5)),
                                            int(p.get("interval_ms", 100)), screen_type)
            elif req.action == "hkmc_touch":
                await hkmc.async_tap(p["x"], p["y"], screen_type)
                logger.info("[HKMC INPUT] tap sent: x=%s y=%s screen=%s", p["x"], p["y"], screen_type)
            elif req.action == "hkmc_swipe":
                await hkmc.async_swipe(p["x1"], p["y1"], p["x2"], p["y2"], screen_type)
                logger.info("[HKMC INPUT] swipe sent")
            elif req.action == "hkmc_key":
                key_name = p.get("key_name")
                if key_name:
                    await hkmc.async_send_key_by_name(
                        key_name, p.get("sub_cmd", 0x43), p.get("monitor", 0x00), p.get("direction")
                    )
                    logger.info("[HKMC INPUT] key sent: %s", key_name)
                else:
                    await hkmc.async_send_key(
                        p["cmd"], p["sub_cmd"], p["key_data"], p.get("monitor", 0x00), p.get("direction")
                    )
            return {"result": "ok"}

        # ADB actions — allow even if device is not in managed list (race with refresh)
        if dev and dev.type not in ("adb", None):
            raise HTTPException(status_code=400, detail=f"Action '{req.action}' requires an ADB device")

        # Resolve alias to real ADB serial address
        adb_serial = dev.address if dev else req.device_id
        display_id = _parse_adb_display_id(req.params.get("screen_type"))

        p = req.params
        if req.action == "tap":
            await adb.tap(p["x"], p["y"], serial=adb_serial, display_id=display_id)
        elif req.action == "repeat_tap":
            await adb.repeat_tap(p["x"], p["y"], int(p.get("count", 5)), int(p.get("interval_ms", 100)),
                                 serial=adb_serial, display_id=display_id)
        elif req.action == "long_press":
            await adb.long_press(p["x"], p["y"], p.get("duration_ms", 1000), serial=adb_serial, display_id=display_id)
        elif req.action == "swipe":
            await adb.swipe(p["x1"], p["y1"], p["x2"], p["y2"], p.get("duration_ms", 300), serial=adb_serial, display_id=display_id)
        elif req.action == "input_text":
            await adb.input_text(p["text"], serial=adb_serial, display_id=display_id)
        elif req.action == "key_event":
            await adb.key_event(p["keycode"], serial=adb_serial, display_id=display_id)
        elif req.action == "adb_command":
            await adb.run_shell_command(p["command"], serial=adb_serial)
        elif req.action == "multi_touch":
            fingers = p.get("fingers", [])
            if not fingers:
                raise HTTPException(status_code=400, detail="fingers array required")
            # 탭 vs 스와이프 판별: 시작점과 끝점이 같으면 탭
            is_tap = all(f.get("x1") == f.get("x2") and f.get("y1") == f.get("y2") for f in fingers)
            if is_tap:
                points = [{"x": f["x1"], "y": f["y1"]} for f in fingers]
                await adb.multi_finger_tap(points, serial=adb_serial, display_id=display_id)
            else:
                await adb.multi_finger_swipe(fingers, p.get("duration_ms", 500), serial=adb_serial, display_id=display_id)
        else:
            raise HTTPException(status_code=400, detail=f"Unknown action: {req.action}")

        return {"result": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("device_input error: action=%s device=%s error=%s", req.action, req.device_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/adb-restart")
async def restart_adb_server():
    """Kill and restart the ADB server to recover from 'connecting' state."""
    try:
        await adb.restart_server()
        return {"result": "ADB server restarted"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class ConnectRegisteredRequest(BaseModel):
    device_ids: list[str] = []  # 빈 리스트면 전체 연결


@router.post("/connect-registered")
async def connect_registered_devices(req: ConnectRegisteredRequest):
    """등록된 디바이스를 연결. device_ids가 비어있으면 전체 연결."""
    all_devices = dm.list_all()
    if req.device_ids:
        targets = [d for d in all_devices if d.id in req.device_ids]
    else:
        targets = all_devices

    results = []
    for dev in targets:
        msg = await dm.connect_device_by_id(dev.id)
        results.append({"device_id": dev.id, "message": msg})
        logger.info("connect-registered: %s", msg)

    return {
        "results": results,
        "primary": _with_protected_flag(dm.list_primary()),
        "auxiliary": _with_protected_flag(dm.list_auxiliary()),
    }


class ReorderDevicesRequest(BaseModel):
    prefix: str
    ordered_ids: list[str]


@router.post("/reorder")
async def reorder_devices(req: ReorderDevicesRequest):
    """그룹 내 디바이스 순서 변경 (ID 번호 재할당)."""
    try:
        dm.reorder_devices(req.prefix, req.ordered_ids)
        return {
            "primary": _with_protected_flag(dm.list_primary()),
            "auxiliary": _with_protected_flag(dm.list_auxiliary()),
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class UpdateDeviceRequest(BaseModel):
    device_id: str
    new_device_id: Optional[str] = None
    name: Optional[str] = None
    address: Optional[str] = None
    baudrate: Optional[int] = None
    module: Optional[str] = None
    connect_type: Optional[str] = None
    extra_fields: Optional[dict] = None


@router.post("/update")
async def update_device(req: UpdateDeviceRequest):
    """Update an existing device's info."""
    dev = dm.get_device(req.device_id)
    if not dev:
        raise HTTPException(status_code=404, detail=f"Device {req.device_id} not found")

    # 시스템 기본 디바이스(Common 등)는 수정 금지
    if dm.is_protected_device(req.device_id):
        raise HTTPException(
            status_code=403,
            detail=f"Device '{req.device_id}' is a protected system default and cannot be modified",
        )

    # ID 변경
    if req.new_device_id and req.new_device_id != req.device_id:
        new_id = req.new_device_id.strip()
        existing = dm.get_device(new_id)
        if existing:
            # 기존 디바이스와 ID 교체(swap)
            dm.swap_device_ids(req.device_id, new_id)
        else:
            dm.rename_device(req.device_id, new_id)
        dev = dm.get_device(new_id)
        if not dev:
            raise HTTPException(status_code=500, detail="Device rename failed")

    need_serial_reconnect = False
    if req.name is not None:
        dev.name = req.name
    if req.address is not None:
        if req.address != dev.address:
            need_serial_reconnect = True
        dev.address = req.address
    if req.baudrate is not None:
        if req.baudrate != dev.info.get("baudrate"):
            need_serial_reconnect = True
        dev.info["baudrate"] = req.baudrate
    if req.module is not None:
        dev.info["module"] = req.module
        # Reset cached module instance when module changes
        from ..services.module_service import reset_instance
        reset_instance(req.module)
    if req.connect_type is not None:
        dev.info["connect_type"] = req.connect_type
    if req.extra_fields is not None:
        for k, v in req.extra_fields.items():
            dev.info[k] = v
        # Reset cached module instance when connection params change
        module_name = dev.info.get("module")
        if module_name:
            from ..services.module_service import reset_instance
            reset_instance(module_name)

    # Persist changes if auxiliary device
    if dev.category == "auxiliary":
        dm._save_auxiliary_devices()

    # Reopen serial connection if address or baudrate changed
    if need_serial_reconnect and dev.type == "serial":
        dm._close_serial_conn(req.device_id)
        try:
            import asyncio
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, dm._get_serial_conn, req.device_id)
        except Exception as e:
            dev.status = "disconnected"
            return {
                "result": f"updated (reconnect failed: {e})",
                "device": dev.to_dict(),
                "primary": _with_protected_flag(dm.list_primary()),
                "auxiliary": _with_protected_flag(dm.list_auxiliary()),
            }

    return {
        "result": "updated",
        "device": dev.to_dict(),
        "primary": _with_protected_flag(dm.list_primary()),
        "auxiliary": _with_protected_flag(dm.list_auxiliary()),
    }


@router.get("/modules")
async def list_modules():
    """List available lge.auto modules."""
    return {"modules": list_available_modules()}


@router.get("/modules/{module_name}/functions")
async def module_functions(module_name: str):
    """List functions of a specific lge.auto module."""
    from ..services.module_service import _load_guides
    functions = get_module_functions(module_name)
    if not functions:
        raise HTTPException(status_code=404, detail=f"Module '{module_name}' not found or has no functions")
    guides = _load_guides()
    mod_guide = guides.get(module_name, {})
    return {"module": module_name, "functions": functions, "module_description": mod_guide.get("_description", "")}


class DltViewerRequest(BaseModel):
    project_file: str = ""
    log_file: str = ""


# DLT Viewer GUI 전용 싱글톤 (디바이스 연결 없이 GUI만 관리)
_dlt_viewer_instance = None

def _get_dlt_viewer():
    global _dlt_viewer_instance
    if _dlt_viewer_instance is None:
        from ..plugins.DLTViewer import DLTViewer
        _dlt_viewer_instance = DLTViewer()
    return _dlt_viewer_instance


@router.post("/dlt-viewer/launch")
async def launch_dlt_viewer(req: DltViewerRequest):
    """DLT Viewer GUI 실행 (디바이스 연결 불필요)."""
    viewer = _get_dlt_viewer()
    result = viewer.LaunchViewer(req.project_file, req.log_file)
    if result.startswith("ERROR"):
        raise HTTPException(status_code=400, detail=result)
    return {"result": result}


@router.post("/dlt-viewer/close")
async def close_dlt_viewer():
    """DLT Viewer GUI 종료."""
    viewer = _get_dlt_viewer()
    result = viewer.CloseViewer()
    return {"result": result}


@router.get("/hkmc-keys")
async def list_hkmc_keys():
    """List all available HKMC hardware key names."""
    from ..services.hkmc6th_service import HKMC_KEYS, SHORT_KEY, LONG_KEY, PRESS_KEY, RELEASE_KEY, DIAL_ACTION
    keys = []
    for name, info in HKMC_KEYS.items():
        group = name.split("_")[0]  # MKBD, CCP, RRC, SWRC, MIRROR
        keys.append({
            "name": name,
            "group": group,
            "is_dial": info.get("dial", False),
        })
    return {
        "keys": keys,
        "sub_commands": {
            "SHORT_KEY": SHORT_KEY,
            "LONG_KEY": LONG_KEY,
            "PRESS_KEY": PRESS_KEY,
            "RELEASE_KEY": RELEASE_KEY,
            "DIAL_ACTION": DIAL_ACTION,
        },
    }


@router.get("/screenshot/{device_id}")
async def get_screenshot(device_id: str, fmt: str = "jpeg", screen_type: str = "front_center"):
    """Capture and return a screenshot for a specific primary device."""
    dev = dm.get_device(device_id)
    try:
        if dev and dev.type == "hkmc6th":
            hkmc = dm.get_hkmc_service(device_id)
            if not hkmc:
                raise HTTPException(status_code=400, detail=f"HKMC device {device_id} not connected")
            w, h = hkmc.get_screen_size(screen_type)
            logger.debug("[HKMC SCREENSHOT] device=%s screen=%s size=%dx%d connected=%s",
                         device_id, screen_type, w, h, hkmc.is_connected)
            img_bytes = await hkmc.async_screencap_bytes(screen_type=screen_type, fmt=fmt)
            b64 = base64.b64encode(img_bytes).decode("ascii")
            return {"image": b64, "format": fmt}
        elif dev and dev.type == "vision_camera":
            cam = dm.get_vision_camera(device_id)
            if not cam:
                raise HTTPException(status_code=400, detail=f"VisionCamera {device_id} not connected")
            import asyncio
            loop = asyncio.get_event_loop()
            img_bytes = await loop.run_in_executor(None, cam.CaptureBytes, fmt)
            b64 = base64.b64encode(img_bytes).decode("ascii")
            return {"image": b64, "format": fmt}
        elif dev and dev.type not in ("adb",):
            raise HTTPException(status_code=400, detail="Screenshot only available for ADB, HKMC, or VisionCamera devices")
        else:
            # ADB device
            adb_serial = dev.address if dev else device_id
            display_id = _parse_adb_display_id(screen_type)
            sf_did = resolve_sf_display_id(dev.info if dev else None, display_id)
            img_bytes = await adb.screencap_bytes(serial=adb_serial, fmt=fmt, sf_display_id=sf_did)
            b64 = base64.b64encode(img_bytes).decode("ascii")
            return {"image": b64, "format": fmt}
    except HTTPException:
        raise
    except Exception:
        # Transient ADB/HKMC capture failure — return empty image so the
        # browser doesn't log a 500 error on every polling cycle.
        return {"image": "", "format": fmt}
