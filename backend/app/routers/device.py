"""Device management API routes."""

import base64
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

logger = logging.getLogger(__name__)

from ..dependencies import adb_service as adb, device_manager as dm
from ..services.adb_service import resolve_sf_display_id
from ..services.module_service import list_available_modules, get_module_functions, execute_module_function


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
        return {"port": dev.address, "bps": dev.info.get("baudrate", 115200)}
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
    type: str  # "adb" | "serial" | "module" | "hkmc6th" | "vision_camera"
    category: str = ""  # "primary" | "auxiliary" — auto-detected if empty
    address: str = ""  # COM port for serial, IP for socket/HKMC, etc.
    baudrate: Optional[int] = 115200
    port: Optional[int] = None  # TCP port for HKMC6th
    name: Optional[str] = ""
    device_id: Optional[str] = ""  # custom device ID/alias (e.g. "Android_1", "HKMC_1")
    module: Optional[str] = None  # lge.auto module name (e.g. "POWER", "CAN")
    connect_type: Optional[str] = None  # "serial" | "socket" | "can" | "none" | "vision_camera"
    extra_fields: Optional[dict] = None  # Additional module-specific fields


class DisconnectRequest(BaseModel):
    address: str


_last_full_refresh = 0.0


@router.get("/list")
async def list_devices():
    """List all managed devices, split by category."""
    import time
    global _last_full_refresh
    now = time.time()
    # ADB refresh는 30초마다만 (adb devices -l이 느림)
    if now - _last_full_refresh > 30:
        await dm.refresh_adb()
        _last_full_refresh = now
    # auxiliary는 빠른 상태 확인만 (네트워크 I/O 없음)
    await dm.refresh_auxiliary()
    return {
        "primary": [d.to_dict() for d in dm.list_primary()],
        "auxiliary": [d.to_dict() for d in dm.list_auxiliary()],
    }


@router.get("/scan")
async def scan_ports():
    """Scan all available connection targets: ADB + serial + HKMC (TCP) + UDP bench + VisionCamera."""
    import asyncio
    adb_task = adb.list_devices()
    serial_task = dm.scan_serial()
    hkmc_task = dm.scan_hkmc()
    bench_task = dm.scan_bench()
    vision_task = dm.scan_vision_cameras()
    adb_devices, serial_ports, hkmc_devices, bench_devices, vision_cameras = await asyncio.gather(
        adb_task, serial_task, hkmc_task, bench_task, vision_task
    )
    return {
        "adb_devices": [d.to_dict() for d in adb_devices],
        "serial_ports": serial_ports,
        "hkmc_devices": hkmc_devices,
        "bench_devices": bench_devices,
        "vision_cameras": vision_cameras,
    }


@router.post("/connect")
async def connect_device(req: ConnectRequest):
    """Connect to a device."""
    custom_id = req.device_id or ""
    if req.type == "adb":
        if ":" in req.address:
            # WiFi ADB — connect first
            await dm.adb.connect_device(req.address)
        dev = await dm.add_adb_device(req.address, device_id=custom_id, name=req.name or "")
        return {
            "result": f"Connected: {dev.name} (ID: {dev.id})",
            "primary": [d.to_dict() for d in dm.list_primary()],
            "auxiliary": [d.to_dict() for d in dm.list_auxiliary()],
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
                "primary": [d.to_dict() for d in dm.list_primary()],
                "auxiliary": [d.to_dict() for d in dm.list_auxiliary()],
            }
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))
    elif req.type == "hkmc6th":
        if not req.address or not req.port:
            raise HTTPException(status_code=400, detail="HKMC6th requires address (IP) and port (TCP port)")
        try:
            dev = await dm.add_hkmc6th_device(req.address, req.port, device_id=custom_id, name=req.name or "")
            return {
                "result": f"HKMC connected: {dev.name} (ID: {dev.id})",
                "primary": [d.to_dict() for d in dm.list_primary()],
                "auxiliary": [d.to_dict() for d in dm.list_auxiliary()],
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
            "primary": [d.to_dict() for d in dm.list_primary()],
            "auxiliary": [d.to_dict() for d in dm.list_auxiliary()],
        }
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
                "primary": [d.to_dict() for d in dm.list_primary()],
                "auxiliary": [d.to_dict() for d in dm.list_auxiliary()],
            }
        except Exception as e:
            logger.error("[VisionCamera] connect failed: %s", e, exc_info=True)
            raise HTTPException(status_code=400, detail=str(e))
    else:
        raise HTTPException(status_code=400, detail=f"Unknown type: {req.type}")


@router.post("/disconnect")
async def disconnect_device(req: DisconnectRequest):
    """Disconnect/remove a device."""
    result = await dm.remove_device(req.address)
    return {
        "result": result,
        "primary": [d.to_dict() for d in dm.list_primary()],
        "auxiliary": [d.to_dict() for d in dm.list_auxiliary()],
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

        if req.action in ("hkmc_touch", "hkmc_swipe", "hkmc_key"):
            if not dev or dev.type != "hkmc6th":
                raise HTTPException(status_code=400, detail=f"HKMC device {req.device_id} not found")
            hkmc = dm.get_hkmc_service(req.device_id)
            if not hkmc:
                raise HTTPException(status_code=400, detail=f"HKMC device {req.device_id} not connected")
            logger.info("[HKMC INPUT] device=%s action=%s params=%s connected=%s",
                        req.device_id, req.action, req.params, hkmc.is_connected)
            p = req.params
            screen_type = p.get("screen_type", "front_center")
            if req.action == "hkmc_touch":
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
        else:
            raise HTTPException(status_code=400, detail=f"Unknown action: {req.action}")

        return {"result": "ok"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/adb-restart")
async def restart_adb_server():
    """Kill and restart the ADB server to recover from 'connecting' state."""
    try:
        await adb.restart_server()
        return {"result": "ADB server restarted"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class UpdateDeviceRequest(BaseModel):
    device_id: str
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
                "primary": [d.to_dict() for d in dm.list_primary()],
                "auxiliary": [d.to_dict() for d in dm.list_auxiliary()],
            }

    return {
        "result": "updated",
        "device": dev.to_dict(),
        "primary": [d.to_dict() for d in dm.list_primary()],
        "auxiliary": [d.to_dict() for d in dm.list_auxiliary()],
    }


@router.get("/modules")
async def list_modules():
    """List available lge.auto modules."""
    return {"modules": list_available_modules()}


@router.get("/modules/{module_name}/functions")
async def module_functions(module_name: str):
    """List functions of a specific lge.auto module."""
    functions = get_module_functions(module_name)
    if not functions:
        raise HTTPException(status_code=404, detail=f"Module '{module_name}' not found or has no functions")
    return {"module": module_name, "functions": functions}


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
