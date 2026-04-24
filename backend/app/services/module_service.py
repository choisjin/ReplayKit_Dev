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
            if "host" in params:
                connect_type = "socket"
            elif "port" in params or "bps" in params:
                connect_type = "serial"
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
        {"name": "WoohyunBench", "label": "WoohyunBench", "connect_type": "socket",
         "connect_fields": [
             {"name": "udp_port", "label": "UDP Port", "type": "number", "default": "25000"},
             {"name": "signal_file", "label": "CAN FD 신호 정의 파일 (.xls/.xlsx/.CAN, 선택)", "type": "text", "default": ""},
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
        {"name": "DLTLogging", "label": "DLTLogging", "connect_type": "socket",
         "connect_fields": [
             {"name": "port", "label": "DLT Port", "type": "number", "default": "3490"},
         ]},
        {"name": "SerialLogging", "label": "SerialLogging", "connect_type": "serial",
         "connect_fields": []},
        {"name": "SmartBench", "label": "SmartBench", "connect_type": "socket",
         "connect_fields": [
             {"name": "port", "label": "TCP Port", "type": "number", "default": "5000"},
         ]},
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

    # SSHManager: 스트리밍 send_command 가상 함수 추가 (실제 클래스에는 없음)
    if module_name == "SSHManager":
        functions.append({
            "name": "send_command_stream",
            "params": [
                {"name": "command", "required": True},
            ],
        })

    # Android: ReplayKit 자체 ADBService를 통한 Send_adb_command 가상 함수 추가
    # (Android 모듈 자체의 adb_shell 등은 그대로 유지)
    if module_name == "Android":
        functions.append({
            "name": "Send_adb_command",
            "params": [
                {"name": "command", "required": True},
            ],
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
                  shared_serial_conn=None, ssh_credentials: Optional[dict] = None) -> Any:
    """Get or create a singleton instance of the module class.

    Args:
        shared_serial_conn: device_manager가 이미 열어둔 Serial 객체.
            전달되면 모듈의 Connect()를 호출하지 않고 _conn에 직접 주입.
        ssh_credentials: SSH 디바이스의 자격증명 {host, port, username, password, key_file_path}.
            전달되면 SSHManager 인스턴스에 instance.create_ssh_client()로 정식 연결.
    """
    # SSHManager는 디바이스별로 다른 자격증명을 가질 수 있으므로 매 호출마다 캐시 무효화
    # (SSHManager 내부 상태 때문에 create_ssh_client를 새로 호출해야 안정적)
    if module_name == "SSHManager":
        _instances.pop(module_name, None)
        _auto_connected.discard(module_name)
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

    # 기존 인스턴스가 연결 끊어진 경우 재생성
    if module_name in _instances:
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
            type_map = {"int": int, "float": float, "bool": bool, "str": str}
            for pname, p in sig.parameters.items():
                if pname == "self":
                    continue
                if pname in constructor_kwargs:
                    val = constructor_kwargs[pname]
                    # 타입 힌트에 맞게 캐스팅
                    ann = p.annotation
                    if ann is not inspect.Parameter.empty:
                        if isinstance(ann, str):
                            ann = type_map.get(ann, ann)
                        if ann in (int, float, str) and not isinstance(val, ann):
                            try:
                                val = ann(val)
                            except (ValueError, TypeError):
                                pass
                    ctor_args[pname] = val
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
                            # log_path 기본값: {프로젝트루트}/results/CANAT_Log
                            if "log_path" in init_args and not init_args["log_path"]:
                                default_log = Path(__file__).resolve().parent.parent.parent / "results" / "CANAT_Log"
                                default_log.mkdir(parents=True, exist_ok=True)
                                init_args["log_path"] = str(default_log)
                            result = init_fn(**init_args)
                            logger.info("Auto-called %s.init(%s) → %s", module_name, init_args, result)
                            _auto_connected.add(module_name)
                        except Exception as e:
                            logger.warning("Auto-init %s.init() failed: %s", module_name, e)
                _instances[module_name] = instance
        else:
            _instances[module_name] = cls()

    # SSHManager: 디바이스 자격증명으로 공식 create_ssh_client 호출 (매 호출마다)
    if module_name == "SSHManager" and ssh_credentials is not None:
        instance = _instances[module_name]
        host = ssh_credentials.get("host", "")
        username = ssh_credentials.get("username", "")
        password = ssh_credentials.get("password", "")
        key_file = ssh_credentials.get("key_file_path", "") or None
        try:
            if key_file:
                instance.create_ssh_client(host, username, password, key_file)
            else:
                instance.create_ssh_client(host, username, password)
            _auto_connected.add(module_name)
            logger.info("SSHManager.create_ssh_client(%s@%s) OK", username, host)
        except Exception as e:
            logger.error("SSHManager.create_ssh_client(%s@%s) failed: %s", username, host, e)
            raise

    return _instances[module_name]


def _execute_sync(module_name: str, function_name: str, args: dict,
                  constructor_kwargs: Optional[dict] = None,
                  shared_serial_conn=None, ssh_credentials: Optional[dict] = None,
                  adb_serial: Optional[str] = None) -> Any:
    """Execute a module function synchronously."""
    # Android.Send_adb_command — ReplayKit 자체 ADBService로 라우팅 (가상 함수)
    if module_name == "Android" and function_name == "Send_adb_command":
        if not adb_serial:
            raise RuntimeError("Send_adb_command requires an ADB device (adb_serial missing)")
        from .adb_service import ADBService
        from ..dependencies import adb_service as _adb
        command = args.get("command", "")
        if not command:
            return "(empty command)"
        # async 호출이지만 _execute_sync는 sync context (run_in_executor 안에서 호출됨)
        # → asyncio.run을 사용할 수 없음 (이미 이벤트 루프 중). loop.run_until_complete도 위험.
        # → ADBService 내부의 _run_device가 subprocess.run을 호출하는지 확인 필요.
        # 안전한 방법: 별도 이벤트 루프에서 비동기 실행
        import asyncio as _asyncio
        loop = _asyncio.new_event_loop()
        try:
            output = loop.run_until_complete(_adb.run_shell_command(command, serial=adb_serial))
        finally:
            loop.close()
        return output if output is not None else "(no output)"

    instance = _get_instance(module_name, constructor_kwargs, shared_serial_conn, ssh_credentials)

    # SSHManager.send_command 특수 처리: SSHManager가 UTF-8로 강제 디코딩하면서
    # Windows(CP949) 등 비-UTF8 출력이 깨지므로, paramiko를 직접 호출해서 raw bytes를
    # 다중 인코딩 fallback으로 처리한다.
    if module_name == "SSHManager" and function_name == "send_command":
        client = getattr(instance, "ssh_client", None)
        if client is None:
            raise RuntimeError("SSH client not connected")
        command = args.get("command", "")
        try:
            stdin, stdout, stderr = client.exec_command(command, timeout=60)
            out_bytes = stdout.read()
            err_bytes = stderr.read()
        except Exception as e:
            raise RuntimeError(f"SSH exec failed: {e}") from e
        combined = out_bytes + (b"\n" + err_bytes if err_bytes else b"")
        # 인코딩 fallback: utf-8 → cp949 → euc-kr → cp437 (Windows 기본)
        for enc in ("utf-8", "cp949", "euc-kr", "cp437"):
            try:
                return combined.decode(enc).strip() or "(no output)"
            except UnicodeDecodeError:
                continue
        return combined.decode(errors="replace").strip() or "(no output)"

    # SSHManager.send_command_stream 가상 함수: 실시간 스트리밍 (bg_task_store 사용)
    if module_name == "SSHManager" and function_name == "send_command_stream":
        client = getattr(instance, "ssh_client", None)
        if client is None:
            raise RuntimeError("SSH client not connected")
        command = args.get("command", "")
        from . import bg_task_store
        task_id = bg_task_store.create_streaming_task(command)

        def _stream_reader(cmd: str, tid: str, ssh_client):
            """백그라운드 스레드에서 paramiko 채널을 폴링하며 chunk를 bg task에 append.

            bg_task_store에 cancel_requested 플래그가 설정되면 즉시 채널을 닫고 종료한다.
            """
            import time as _time
            channel = None
            try:
                transport = ssh_client.get_transport()
                if transport is None or not transport.is_active():
                    bg_task_store.append_stderr(tid, "SSH transport not active")
                    bg_task_store.mark_done(tid, status="error", rc=1)
                    return
                channel = transport.open_session()
                channel.settimeout(0.0)
                channel.exec_command(cmd)
                out_buffer = bytearray()
                err_buffer = bytearray()

                def _decode_chunk(buf: bytearray) -> tuple[str, bytearray]:
                    """버퍼에서 가능한 만큼 디코딩하고 불완전한 뒷부분은 남김."""
                    if not buf:
                        return "", buf
                    for enc in ("utf-8", "cp949", "euc-kr", "cp437"):
                        try:
                            text = buf.decode(enc)
                            return text, bytearray()
                        except UnicodeDecodeError as e:
                            # 잘린 multibyte일 수 있으니 뒷부분 남김
                            if enc == "utf-8" and e.start > 0:
                                try:
                                    text = buf[:e.start].decode(enc)
                                    return text, bytearray(buf[e.start:])
                                except UnicodeDecodeError:
                                    continue
                            continue
                    return buf.decode(errors="replace"), bytearray()

                while True:
                    # 취소 요청 확인
                    if bg_task_store.is_cancel_requested(tid):
                        logger.info("SSH stream task %s cancel requested — closing channel", tid)
                        try:
                            channel.close()
                        except Exception:
                            pass
                        bg_task_store.append_stderr(tid, "\n[cancelled by user]")
                        bg_task_store.mark_done(tid, status="cancelled", rc=130)
                        return

                    if channel.recv_ready():
                        chunk = channel.recv(4096)
                        if chunk:
                            out_buffer.extend(chunk)
                            text, out_buffer = _decode_chunk(out_buffer)
                            if text:
                                bg_task_store.append_stdout(tid, text)
                    if channel.recv_stderr_ready():
                        chunk = channel.recv_stderr(4096)
                        if chunk:
                            err_buffer.extend(chunk)
                            text, err_buffer = _decode_chunk(err_buffer)
                            if text:
                                bg_task_store.append_stderr(tid, text)
                    if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
                        break
                    _time.sleep(0.05)

                # flush 잔여 버퍼
                if out_buffer:
                    text, _ = _decode_chunk(out_buffer)
                    if text:
                        bg_task_store.append_stdout(tid, text)
                if err_buffer:
                    text, _ = _decode_chunk(err_buffer)
                    if text:
                        bg_task_store.append_stderr(tid, text)

                rc = channel.recv_exit_status()
                try:
                    channel.close()
                except Exception:
                    pass
                bg_task_store.mark_done(tid, status="done", rc=rc)
            except Exception as e:
                logger.exception("SSH stream reader error for %s", tid)
                bg_task_store.append_stderr(tid, f"\n[stream error] {e}")
                try:
                    if channel is not None:
                        channel.close()
                except Exception:
                    pass
                bg_task_store.mark_done(tid, status="error", rc=1)

        import threading
        threading.Thread(
            target=_stream_reader,
            args=(command, task_id, client),
            daemon=True,
            name=f"ssh-stream-{task_id}",
        ).start()
        return f"[BG_TASK:{task_id}]"

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
                    ann = p.annotation
                    # from __future__ import annotations 환경에서는 문자열로 평가됨
                    type_map = {"int": int, "float": float, "bool": bool, "str": str}
                    if isinstance(ann, str):
                        ann = type_map.get(ann, ann)
                    if ann in (int, float, bool, str):
                        if ann is bool and isinstance(val, str):
                            val = val.lower() not in ("0", "false", "no", "")
                        else:
                            val = ann(val)
                except (ValueError, TypeError):
                    pass
            call_args[pname] = val
        elif p.default is inspect.Parameter.empty:
            raise ValueError(f"Missing required parameter: {pname}")

    # 런 폴더 활성 시 빈 경로 파라미터를 런 폴더 logs/로 리다이렉트
    # DLTLogging/SerialLogging은 자체 런 폴더 로직이 있으므로 제외
    if module_name not in ("DLTLogging", "SerialLogging"):
        _redirect_path_args_to_run_dir(call_args, module_name, function_name)

    result = func(**call_args)
    return result


# 경로성 파라미터 이름 패턴 (빈 값일 때만 런 폴더로 리다이렉트)
_PATH_PARAM_NAMES = {
    "save_path", "path_log", "path_dir_log",
    "mlp_ivi_file_path", "mlp_safe_file_path",
    "log_file", "file_path", "logfilepath",
    "csv_file",
}


def _redirect_path_args_to_run_dir(call_args: dict, module_name: str, function_name: str) -> None:
    """경로 파라미터가 빈 값이면 현재 런 폴더의 logs/ 하위로 리다이렉트."""
    from .playback_service import get_run_output_dir
    run_dir = get_run_output_dir()
    if not run_dir:
        return

    log_dir = run_dir / "logs"
    log_dir.mkdir(exist_ok=True)

    for param_name in _PATH_PARAM_NAMES:
        if param_name in call_args and not call_args[param_name]:
            # 빈 값 → 런 폴더 내 자동 경로 생성
            import time
            ts = time.strftime("%Y%m%d_%H%M%S")
            safe_mod = module_name.replace(" ", "_")
            safe_func = function_name.replace(" ", "_")

            if "dir" in param_name:
                # 디렉토리 경로
                target = log_dir / safe_mod
                target.mkdir(exist_ok=True)
                call_args[param_name] = str(target)
            else:
                # 파일 경로
                ext = ".log"
                if "csv" in param_name:
                    ext = ".csv"
                elif "image" in param_name:
                    ext = ".png"
                call_args[param_name] = str(log_dir / f"{safe_mod}_{safe_func}_{ts}{ext}")


DEFAULT_MODULE_TIMEOUT_S = 3600.0  # 1시간 — 플러그인이 retry 기반 장시간 작업을 할 수 있음
MODULE_TIMEOUT_BUFFER_S = 60.0     # 네트워크/초기화 오버헤드 여유


def _compute_module_timeout(args: dict, user_timeout: Optional[float]) -> float:
    """모듈 함수 실행의 유효 타임아웃 계산.

    우선순위:
    1. 호출자가 명시적으로 `user_timeout`을 넘기면 그 값 사용
    2. args에 `timeout` 키가 있으면 `timeout * max_retries * 1.5 + buffer`로 계산
       - 예: DLTLogging.ExpectFound(timeout=60, max_retries=5) → 60*5*1.5+60 = 510s
    3. 그 외에는 DEFAULT_MODULE_TIMEOUT_S 사용

    주의: 모든 플러그인이 동일한 key 네이밍을 쓰지 않을 수 있으므로 이건 힌트일 뿐.
    감지 실패 시에도 default가 충분히 크도록(10분) 잡아 정당한 작업을 끊지 않음.
    """
    if user_timeout is not None and user_timeout > 0:
        return float(user_timeout)
    if not isinstance(args, dict):
        return DEFAULT_MODULE_TIMEOUT_S
    t = args.get("timeout")
    if not isinstance(t, (int, float)) or t <= 0:
        return DEFAULT_MODULE_TIMEOUT_S
    retries = args.get("max_retries") or args.get("retries") or 1
    if not isinstance(retries, (int, float)) or retries <= 0:
        retries = 1
    computed = float(t) * float(retries) * 1.5 + MODULE_TIMEOUT_BUFFER_S
    # 추정치가 default보다 작으면 default가 우선 (너무 짧은 것 방지)
    return max(computed, DEFAULT_MODULE_TIMEOUT_S)


async def execute_module_function(
    module_name: str, function_name: str, args: dict,
    constructor_kwargs: Optional[dict] = None,
    shared_serial_conn=None, ssh_credentials: Optional[dict] = None,
    adb_serial: Optional[str] = None,
    timeout_s: Optional[float] = None,
) -> str:
    """Execute a module function asynchronously (runs in thread pool).

    timeout_s: 모듈 함수 실행 상한(초). None이면 args 힌트로 자동 계산.
    초과 시 TimeoutError 발생하여 playback이 좀비 상태에 빠지지 않음.
    단, run_in_executor는 cancel 시 백그라운드 스레드를 강제 종료할 수 없으므로
    hang된 스레드는 백그라운드에 남음(스레드풀 슬롯 1개 소모). 모듈 자체의 내부
    타임아웃과 이중 안전장치로 동작.
    """
    effective_timeout = _compute_module_timeout(args, timeout_s)
    loop = asyncio.get_event_loop()
    try:
        future = loop.run_in_executor(
            None,
            functools.partial(_execute_sync, module_name, function_name, args,
                              constructor_kwargs, shared_serial_conn, ssh_credentials,
                              adb_serial),
        )
        result = await asyncio.wait_for(future, timeout=effective_timeout)
        return str(result) if result is not None else "OK"
    except asyncio.TimeoutError:
        logger.error("Module execution timeout (%.1fs): %s.%s",
                     effective_timeout, module_name, function_name)
        raise TimeoutError(
            f"Module {module_name}.{function_name} exceeded {effective_timeout:.0f}s timeout"
        )
    except Exception as e:
        logger.error("Module execution error: %s.%s -> %s", module_name, function_name, e)
        raise


def reset_instance(module_name: str) -> None:
    """Remove cached instance (e.g. on device disconnect)."""
    _instances.pop(module_name, None)
    _auto_connected.discard(module_name)
