"""Module introspection and execution service.

Supports both lge.auto modules and local plugins (backend/app/plugins/).
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import functools
import logging
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Cache: module_name -> class instance
_instances: dict[str, Any] = {}

# Cache: module_name -> list of function info
_module_functions_cache: dict[str, list[dict]] = {}

# Plugins directory
_PLUGINS_DIR = Path(__file__).resolve().parent.parent / "plugins"


def _load_plugin_from_file(py_file: Path):
    """Load a plugin module directly from file path (no package dependency)."""
    module_name = py_file.stem
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
    for py_file in _PLUGINS_DIR.glob("*.py"):
        if py_file.name.startswith("_"):
            continue
        module_name = py_file.stem
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
         "connect_fields": []},
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


def _import_module_class(module_name: str):
    """Import and return the class for a given module name (lge.auto or plugin)."""
    # Try local plugin first (file-based loading to avoid package path issues)
    py_file = _PLUGINS_DIR / f"{module_name}.py"
    if py_file.is_file():
        try:
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

    _module_functions_cache[module_name] = functions
    return functions


def _get_instance(module_name: str, constructor_kwargs: Optional[dict] = None) -> Any:
    """Get or create a singleton instance of the module class."""
    # host/port가 변경된 경우 기존 인스턴스 무효화
    if module_name in _instances and constructor_kwargs:
        existing = _instances[module_name]
        existing_host = getattr(existing, "_host", None) or getattr(existing, "host", None)
        new_host = constructor_kwargs.get("host")
        if new_host and existing_host and new_host != existing_host:
            logger.info("Host changed for %s (%s → %s), recreating instance",
                        module_name, existing_host, new_host)
            _instances.pop(module_name, None)
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
                                connect_fn()
                                logger.info("Auto-called %s.%s()", module_name, method_name)
                        except Exception as e:
                            logger.warning("Auto-connect %s.%s() failed: %s", module_name, method_name, e)
                        break
                _instances[module_name] = instance
            else:
                # Constructor doesn't accept the provided kwargs (e.g. BENCH)
                # Create instance normally, then try auto-connect if host is provided
                instance = cls()
                if "host" in constructor_kwargs:
                    # Socket-based modules: auto-call connect method
                    for method_name in ("socket_connect", "connect", "Connect"):
                        connect_fn = getattr(instance, method_name, None)
                        if callable(connect_fn):
                            connect_fn(constructor_kwargs["host"])
                            break
                _instances[module_name] = instance
        else:
            _instances[module_name] = cls()
    return _instances[module_name]


def _execute_sync(module_name: str, function_name: str, args: dict,
                  constructor_kwargs: Optional[dict] = None) -> Any:
    """Execute a module function synchronously."""
    instance = _get_instance(module_name, constructor_kwargs)
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
) -> str:
    """Execute a module function asynchronously (runs in thread pool)."""
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None,
            functools.partial(_execute_sync, module_name, function_name, args,
                              constructor_kwargs),
        )
        return str(result) if result is not None else "OK"
    except Exception as e:
        logger.error("Module execution error: %s.%s -> %s", module_name, function_name, e)
        raise


def reset_instance(module_name: str) -> None:
    """Remove cached instance (e.g. on device disconnect)."""
    _instances.pop(module_name, None)
