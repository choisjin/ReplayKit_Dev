"""Module introspection and execution service.

Supports both lge.auto modules and local plugins (backend/app/plugins/).
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import functools
import json
import logging
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Cache: module_name -> class instance
_instances: dict[str, Any] = {}

# Tracks modules that went through auto-connect successfully
_auto_connected: set[str] = set()

# Cache: module_name -> list of function info
_module_functions_cache: dict[str, list[dict]] = {}

# Plugins directory
_PLUGINS_DIR = Path(__file__).resolve().parent.parent / "plugins"

# Modules directory (DLL 등 모듈 런타임 파일)
_MODULES_DIR = Path(__file__).resolve().parent.parent / "modules"

# 모듈 가이드 JSON (함수/파라미터 설명)
_GUIDES_FILE = Path(__file__).resolve().parent / "module_guides.json"
_guides_cache: dict | None = None
_guides_mtime: float = 0


def _load_guides() -> dict:
    """가이드 JSON을 로드 (파일 변경 시 자동 리로드)."""
    global _guides_cache, _guides_mtime
    if not _GUIDES_FILE.is_file():
        return {}
    try:
        mtime = _GUIDES_FILE.stat().st_mtime
        if _guides_cache is None or mtime != _guides_mtime:
            with open(_GUIDES_FILE, "r", encoding="utf-8") as f:
                _guides_cache = json.load(f)
            _guides_mtime = mtime
            logger.info("Module guides loaded from %s", _GUIDES_FILE)
    except Exception as e:
        logger.warning("Failed to load module guides: %s", e)
        if _guides_cache is None:
            _guides_cache = {}
    return _guides_cache


def _load_plugin_from_file(py_file: Path):
    """Load a plugin module directly from file path (no package dependency)."""
    # .pyd: "CCIC_BENCH.cp310-win_amd64.pyd" → module_name "CCIC_BENCH"
    module_name = py_file.stem.split(".")[0] if py_file.suffix == ".pyd" else py_file.stem
    spec = importlib.util.spec_from_file_location(f"plugins.{module_name}", str(py_file))
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _list_plugin_modules() -> list[dict]:
    """Discover local plugins in the plugins directory."""
    plugins = []
    if not _PLUGINS_DIR.is_dir():
        return plugins
    seen = set()
    for py_file in list(_PLUGINS_DIR.glob("*.py")) + list(_PLUGINS_DIR.glob("*.pyd")):
        if py_file.name.startswith("_"):
            continue
        # .pyd: "CCIC_BENCH.cp310-win_amd64.pyd" → stem "CCIC_BENCH.cp310-win_amd64" → 첫 점 앞
        module_name = py_file.stem.split(".")[0] if py_file.suffix == ".pyd" else py_file.stem
        if module_name in seen:
            continue
        seen.add(module_name)
        try:
            mod = _load_plugin_from_file(py_file)
            if mod is None:
                continue
            cls = getattr(mod, module_name, None)
            if cls is None:
                continue
            # Determine connect_type from constructor signature
            sig = inspect.signature(cls.__init__)
            params = [p for p in sig.parameters if p != "self"]
            if "port" in params or "bps" in params:
                connect_type = "serial"
            elif "host" in params:
                connect_type = "socket"
            else:
                connect_type = "none"
            # Use a cleaner label: strip "Plugin" suffix if present
            label = module_name.replace("Plugin", "") if module_name.endswith("Plugin") else module_name
            plugins.append({
                "name": module_name,
                "label": label,
                "connect_type": connect_type,
                "connect_fields": [],
                "_source": "plugin",
            })
        except Exception as e:
            logger.warning("Cannot load plugin %s: %s", module_name, e)
    return plugins


def list_available_modules() -> list[dict]:
    """List all available modules (lge.auto + local plugins)."""
    # connect_params: fields required when adding a device with this module
    #   "serial" = needs COM port + baudrate (default connection type)
    #   "socket" = needs IP host address
    #   custom list = specific fields [{name, label, type, default?}]
    # connect_fields: extra fields shown in the UI when adding a device
    #   Each field: {name, label, type("text"|"number"|"select"), default?, options?[]}
    modules = [
        {"name": "POWER", "label": "POWER", "connect_type": "serial",
         "connect_fields": []},
        {"name": "RIDEN", "label": "RIDEN", "connect_type": "serial",
         "connect_fields": []},
        {"name": "CAN", "label": "CAN", "connect_type": "can",
         "connect_fields": [
             {"name": "interface", "label": "Interface", "type": "select", "default": "pcan",
              "options": ["pcan", "vector", "kvaser", "socketcan", "ixxat"]},
             {"name": "channel", "label": "Channel", "type": "text", "default": "PCAN_USBBUS1"},
             {"name": "bitrate", "label": "Bitrate", "type": "select", "default": "500000",
              "options": ["125000", "250000", "500000", "1000000"]},
             {"name": "fd", "label": "CAN FD", "type": "select", "default": "False",
              "options": ["True", "False"]},
         ]},
        {"name": "CANOE", "label": "CANOE", "connect_type": "none",
         "connect_fields": []},
        {"name": "CANAT", "label": "CANAT", "connect_type": "serial",
         "connect_fields": [
             {"name": "log_path", "label": "Log Path", "type": "text", "default": ""},
             {"name": "ch1_fd", "label": "CH1 CAN FD", "type": "select", "default": "True",
              "options": ["True", "False"]},
             {"name": "ch2_fd", "label": "CH2 CAN FD", "type": "select", "default": "False",
              "options": ["True", "False"]},
         ]},
        {"name": "BENCH", "label": "BENCH", "connect_type": "socket",
         "connect_fields": []},
        {"name": "CCIC_BENCH", "label": "CCIC_BENCH", "connect_type": "socket",
         "connect_fields": [
             {"name": "udp_port", "label": "UDP Port", "type": "number", "default": "25000"},
         ]},
        {"name": "IVIQEBenchIOClient", "label": "IVIQEBenchIOClient", "connect_type": "serial",
         "connect_fields": []},
        {"name": "SP25Bench", "label": "SP25Bench", "connect_type": "serial",
         "connect_fields": []},
        {"name": "Uart", "label": "Uart", "connect_type": "serial",
         "connect_fields": []},
        {"name": "Ignition", "label": "Ignition", "connect_type": "serial",
         "connect_fields": []},
        {"name": "KeysightPower", "label": "KeysightPower", "connect_type": "socket",
         "connect_fields": []},
        {"name": "SSHManager", "label": "SSHManager", "connect_type": "socket",
         "connect_fields": []},
        {"name": "AudioLibrary", "label": "AudioLibrary", "connect_type": "none",
         "connect_fields": []},
        {"name": "ImageProcessing", "label": "ImageProcessing", "connect_type": "none",
         "connect_fields": []},
        {"name": "DLTLogging", "label": "DLTLogging", "connect_type": "none",
         "connect_fields": []},
        {"name": "DLTViewer", "label": "DLTViewer", "connect_type": "socket",
         "connect_fields": [
             {"name": "port", "label": "DLT Port", "type": "number", "default": "3490"},
             {"name": "project_file", "label": "프로젝트 파일 (.dlp)", "type": "text", "default": ""},
         ]},
        {"name": "MLP", "label": "MLP", "connect_type": "none",
         "connect_fields": []},
        {"name": "PCANClient", "label": "PCANClient", "connect_type": "none",
         "connect_fields": []},
        {"name": "TigrisCheck", "label": "TigrisCheck", "connect_type": "none",
         "connect_fields": []},
        {"name": "Trace", "label": "Trace", "connect_type": "none",
         "connect_fields": []},
        {"name": "COMMON_WINDOWS", "label": "COMMON_WINDOWS", "connect_type": "none",
         "connect_fields": []},
        {"name": "Android", "label": "Android", "connect_type": "none",
         "connect_fields": []},
        {"name": "VisionCamera", "label": "VisionCamera", "connect_type": "vision_camera",
         "connect_fields": [
             {"name": "mac", "label": "MAC Address", "type": "text", "default": ""},
             {"name": "model", "label": "Model", "type": "text", "default": "exo264CGE"},
             {"name": "serial", "label": "Serial Number", "type": "text", "default": ""},
             {"name": "ip", "label": "IP Address", "type": "text", "default": ""},
             {"name": "subnetmask", "label": "Subnet Mask", "type": "text", "default": "255.255.0.0"},
         ]},
    ]
    available = []
    for m in modules:
        try:
            __import__(f"lge.auto.{m['name']}", fromlist=[m["name"]])
            m["_source"] = "lge.auto"
            available.append(m)
        except Exception:
            # lge.auto에 없으면 플러그인 폴백
            if (_PLUGINS_DIR / f"{m['name']}.py").is_file():
                m["_source"] = "plugin"
                available.append(m)

    # 아직 등록되지 않은 추가 플러그인
    listed_names = {m["name"] for m in available}
    for p in _list_plugin_modules():
        if p["name"] not in listed_names:
            available.append(p)
    return available


def _ensure_module_deps(module_name: str, module_dir: Path) -> None:
    """모듈이 필요로 하는 DLL 등을 modules/ 폴더에서 모듈 위치로 복사."""
    import shutil
    if not _MODULES_DIR.is_dir():
        return
    # module_name에 매칭되는 DLL 파일 복사 (예: CANAT → CANatTransportProcDll.dll)
    for dll in _MODULES_DIR.glob("*.dll"):
        dest = module_dir / dll.name
        if not dest.exists():
            shutil.copy2(str(dll), str(dest))
            logger.info("Copied %s → %s", dll.name, dest)


def _import_module_class(module_name: str):
    """Import and return the class for a given module name (lge.auto or plugin)."""
    # Try local plugin first (file-based loading to avoid package path issues)
    # .py 우선, 없으면 .pyd (배포 환경)
    py_file = _PLUGINS_DIR / f"{module_name}.py"
    if not py_file.is_file():
        pyd_files = list(_PLUGINS_DIR.glob(f"{module_name}.*.pyd"))
        if pyd_files:
            py_file = pyd_files[0]
    if py_file.is_file():
        try:
            _ensure_module_deps(module_name, _PLUGINS_DIR)
            mod = _load_plugin_from_file(py_file)
            if mod is not None:
                cls = getattr(mod, module_name, None)
                if cls is not None:
                    return cls
        except Exception as e:
            logger.warning("Cannot load plugin %s from file: %s", module_name, e)

    # Try lge.auto
    try:
        mod = __import__(f"lge.auto.{module_name}", fromlist=[module_name])
        # lge.auto 모듈 위치에 DLL 등 의존 파일 복사
        mod_dir = Path(mod.__file__).parent if hasattr(mod, "__file__") else None
        if mod_dir:
            _ensure_module_deps(module_name, mod_dir)
        cls = getattr(mod, module_name, None)
        if cls is not None:
            return cls
    except Exception as e:
        logger.warning("Cannot import module %s: %s", module_name, e)
    return None


def get_module_functions(module_name: str) -> list[dict]:
    """Get all public callable methods of a module's main class."""
    if module_name in _module_functions_cache:
        return _module_functions_cache[module_name]

    cls = _import_module_class(module_name)
    if cls is None:
        return []

    functions = []
    for name in sorted(dir(cls)):
        if name.startswith("_"):
            continue
        attr = getattr(cls, name, None)
        if not callable(attr):
            continue
        try:
            sig = inspect.signature(attr)
        except (ValueError, TypeError):
            continue

        params = []
        for pname, p in sig.parameters.items():
            if pname == "self":
                continue
            param_info: dict[str, Any] = {"name": pname, "required": True}
            if p.default is not inspect.Parameter.empty:
                param_info["required"] = False
                param_info["default"] = repr(p.default)
            params.append(param_info)

        functions.append({
            "name": name,
            "params": params,
        })

    # 가이드 데이터 병합
    guides = _load_guides()
    mod_guide = guides.get(module_name, {})
    func_guides = mod_guide.get("functions", {})
    mod_description = mod_guide.get("_description", "")

    for fn in functions:
        fg = func_guides.get(fn["name"], {})
        fn["description"] = fg.get("description", "")
        param_guides = fg.get("params", {})
        for p in fn["params"]:
            p["description"] = param_guides.get(p["name"], "")

    _module_functions_cache[module_name] = functions
    return functions


def _is_connected(instance) -> bool:
    """Check if a module instance appears to have a live connection."""
    # VisionCamera: IsConnected() 메서드
    if hasattr(instance, "IsConnected") and callable(getattr(instance, "IsConnected")):
        try:
            return instance.IsConnected()
        except Exception:
            return False
    # Serial: check _conn attribute (e.g. IVIQEBenchIOClient)
    if hasattr(instance, "_conn"):
        conn = getattr(instance, "_conn", None)
        if conn is None:
            return False
        is_open = getattr(conn, "is_open", None) or getattr(conn, "isOpen", None)
        if callable(is_open):
            return is_open()
        if isinstance(is_open, bool):
            return is_open
        return True
    # DLL-based: check hdll attribute (e.g. CANAT)
    if hasattr(instance, "hdll"):
        return getattr(instance, "hdll", None) is not None
    # Socket: check _socket or sock attribute
    sock = getattr(instance, "_socket", None) or getattr(instance, "sock", None)
    if sock is not None:
        return True
    if hasattr(instance, "_socket") or hasattr(instance, "sock"):
        return False
    return True  # no known indicator → assume OK


def _get_instance(module_name: str, constructor_kwargs: Optional[dict] = None,
                  shared_serial_conn=None) -> Any:
    """Get or create a singleton instance of the module class.

    Args:
        shared_serial_conn: device_manager가 이미 열어둔 Serial 객체.
            전달되면 모듈의 Connect()를 호출하지 않고 _conn에 직접 주입.
    """
    # host/port가 변경된 경우 기존 인스턴스 무효화
    if module_name in _instances and constructor_kwargs:
        existing = _instances[module_name]
        # port 변경 감지
        existing_port = getattr(existing, "_port", None)
        new_port = constructor_kwargs.get("port")
        if new_port and existing_port and str(new_port) != str(existing_port):
            logger.info("Port changed for %s (%s → %s), recreating instance",
                        module_name, existing_port, new_port)
            _instances.pop(module_name, None)
        # host 변경 감지
        existing_host = getattr(existing, "_host", None) or getattr(existing, "host", None)
        new_host = constructor_kwargs.get("host")
        if new_host and existing_host and new_host != existing_host:
            logger.info("Host changed for %s (%s → %s), recreating instance",
                        module_name, existing_host, new_host)
            _instances.pop(module_name, None)

    # 기존 인스턴스가 연결 끊어진 경우에만 재생성 (auto-connect된 모듈만 검사)
    if module_name in _instances and module_name in _auto_connected:
        if not _is_connected(_instances[module_name]):
            logger.info("Connection lost for %s, recreating instance", module_name)
            _instances.pop(module_name, None)
            _auto_connected.discard(module_name)

    if module_name not in _instances:
        cls = _import_module_class(module_name)
        if cls is None:
            raise ValueError(f"Module '{module_name}' not found")
        # Try to pass constructor kwargs (e.g. port, bps) if the class needs them
        if constructor_kwargs:
            sig = inspect.signature(cls.__init__)
            ctor_args = {}
            for pname, p in sig.parameters.items():
                if pname == "self":
                    continue
                if pname in constructor_kwargs:
                    ctor_args[pname] = constructor_kwargs[pname]
            if ctor_args:
                instance = cls(**ctor_args)
                if shared_serial_conn and hasattr(instance, "_conn"):
                    # device_manager가 이미 열어둔 시리얼 연결 주입
                    instance._conn = shared_serial_conn
                    _auto_connected.add(module_name)
                    logger.info("Injected shared serial conn into %s (_conn)", module_name)
                else:
                    # Serial modules (e.g. IVIQEBenchIOClient): constructor sets port/bps
                    # but doesn't open the connection — call Connect() afterward
                    for method_name in ("Connect", "connect"):
                        connect_fn = getattr(instance, method_name, None)
                        if callable(connect_fn):
                            try:
                                sig = inspect.signature(connect_fn)
                                # Only call if it takes no args (besides self)
                                non_self = [p for p in sig.parameters if p != "self"]
                                if len(non_self) == 0:
                                    result = connect_fn()
                                    logger.info("Auto-called %s.%s() → %s", module_name, method_name, result)
                                    if isinstance(result, str) and result.upper() in ("ERROR", "FAIL", "FAILED"):
                                        logger.warning("Auto-connect %s.%s() returned %s", module_name, method_name, result)
                                    else:
                                        _auto_connected.add(module_name)
                            except Exception as e:
                                logger.warning("Auto-connect %s.%s() failed: %s", module_name, method_name, e)
                            break
                _instances[module_name] = instance
                # 연결 실패한 인스턴스는 다음 호출 시 재생성되도록 auto_connected에 등록
                if module_name not in _auto_connected and _is_connected(instance):
                    _auto_connected.add(module_name)
            else:
                # Constructor doesn't accept the provided kwargs (e.g. BENCH, CANAT)
                # Create instance normally, then try auto-connect/init
                instance = cls()
                connected = False
                if "host" in constructor_kwargs:
                    # Socket-based modules: auto-call connect method
                    for method_name in ("socket_connect", "connect", "Connect"):
                        connect_fn = getattr(instance, method_name, None)
                        if callable(connect_fn):
                            connect_fn(constructor_kwargs["host"])
                            connected = True
                            break
                # init() 메서드가 있는 모듈 (e.g. CANAT): constructor_kwargs에서 매핑
                if not connected:
                    init_fn = getattr(instance, "init", None)
                    if callable(init_fn):
                        try:
                            init_sig = inspect.signature(init_fn)
                            init_args = {}
                            # comport ← port 매핑
                            kwarg_aliases = {"comport": "port", "port": "port"}
                            for pname, p in init_sig.parameters.items():
                                if pname == "self":
                                    continue
                                if pname in constructor_kwargs:
                                    init_args[pname] = constructor_kwargs[pname]
                                elif pname in kwarg_aliases and kwarg_aliases[pname] in constructor_kwargs:
                                    init_args[pname] = constructor_kwargs[kwarg_aliases[pname]]
                                elif p.default is not inspect.Parameter.empty:
                                    pass  # 기본값 사용
                                else:
                                    # 필수 인자 없으면 빈 문자열로 채움
                                    init_args[pname] = ""
                            result = init_fn(**init_args)
                            logger.info("Auto-called %s.init(%s) → %s", module_name, init_args, result)
                            _auto_connected.add(module_name)
                        except Exception as e:
                            logger.warning("Auto-init %s.init() failed: %s", module_name, e)
                _instances[module_name] = instance
        else:
            _instances[module_name] = cls()
    return _instances[module_name]


def _execute_sync(module_name: str, function_name: str, args: dict,
                  constructor_kwargs: Optional[dict] = None,
                  shared_serial_conn=None) -> Any:
    """Execute a module function synchronously."""
    instance = _get_instance(module_name, constructor_kwargs, shared_serial_conn)
    func = getattr(instance, function_name, None)
    if func is None:
        raise ValueError(f"Function '{function_name}' not found in {module_name}")

    # Build call args from the function signature
    sig = inspect.signature(func)
    call_args = {}
    for pname, p in sig.parameters.items():
        if pname in args:
            val = args[pname]
            # Try to cast to the expected type based on annotation
            if p.annotation is not inspect.Parameter.empty:
                try:
                    if p.annotation in (int, float, bool, str):
                        val = p.annotation(val)
                except (ValueError, TypeError):
                    pass
            call_args[pname] = val
        elif p.default is inspect.Parameter.empty:
            raise ValueError(f"Missing required parameter: {pname}")

    result = func(**call_args)
    return result


async def execute_module_function(
    module_name: str, function_name: str, args: dict,
    constructor_kwargs: Optional[dict] = None,
    shared_serial_conn=None,
) -> str:
    """Execute a module function asynchronously (runs in thread pool)."""
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None,
            functools.partial(_execute_sync, module_name, function_name, args,
                              constructor_kwargs, shared_serial_conn),
        )
        return str(result) if result is not None else "OK"
    except Exception as e:
        logger.error("Module execution error: %s.%s -> %s", module_name, function_name, e)
        raise


def reset_instance(module_name: str) -> None:
    """Remove cached instance (e.g. on device disconnect)."""
    _instances.pop(module_name, None)
    _auto_connected.discard(module_name)
