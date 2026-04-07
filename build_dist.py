"""배포용 빌드 스크립트.

backend Python 코드를 Cython으로 .pyd 바이너리로 컴파일하고,
frontend를 빌드하고, server.py를 exe로 컴파일하여
배포 패키지를 생성합니다.

사전 요구사항:
  pip install cython pyinstaller
  Visual Studio Build Tools (Windows C 컴파일러)

사용법:
  python build_dist.py                    # 전체 빌드 + 패키징
  python build_dist.py --deploy           # 빌드 + 배포 repo에 commit & push
  python build_dist.py --deploy-only      # 빌드 없이 기존 dist를 push만
  python build_dist.py --backend          # 백엔드만 컴파일
  python build_dist.py --exe             # server.exe만 빌드
  python build_dist.py --init-deploy      # 배포 repo 최초 설정

배포 repo 설정:
  1. GitHub/GitLab에 배포용 private repo 생성
  2. python build_dist.py --init-deploy
  3. 배포 repo URL 입력
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent
DIST_DIR = PROJECT_ROOT / "dist" / "ReplayKit"
BUILD_DIR = PROJECT_ROOT / "build"

# backend에서 컴파일 제외할 파일
# - __init__.py: 패키지 마커
# - routers/*.py: FastAPI의 File/Form/Query 기본값이 Cython과 호환 불가
# - dependencies.py: FastAPI 의존성 주입
SKIP_COMPILE = {"__init__.py", "dependencies.py",
                "device.py", "scenario.py", "results.py", "settings.py",
                "monitor_client.py"}

# 배포에 포함할 루트 파일
INCLUDE_ROOT_FILES = [
    "requirements.txt",
    "setup.bat",
    "ReplayKit.bat",
    "server.py",
    "replaykit.ico",
]

# 배포에 포함할 추가 파일/폴더 (모듈 DLL 등)
INCLUDE_EXTRA = []

NPM_CMD = "npm.cmd" if sys.platform == "win32" else "npm"


def _run(cmd, cwd=None, check=True, timeout=180, live_output=False):
    print(f"  > {' '.join(str(c) for c in cmd)}")
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if live_output:
        proc = subprocess.Popen(
            cmd, cwd=str(cwd or PROJECT_ROOT), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            encoding="utf-8", errors="replace",
        )
        output_lines = []
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                print(f"    {line}")
                output_lines.append(line)
        proc.wait()
        result = subprocess.CompletedProcess(cmd, proc.returncode, "\n".join(output_lines), "")
        if check and result.returncode != 0:
            raise subprocess.CalledProcessError(result.returncode, cmd)
        return result
    return subprocess.run(
        cmd, cwd=str(cwd or PROJECT_ROOT), env=env,
        check=check, capture_output=True,
        encoding="utf-8", errors="replace", timeout=timeout,
    )


EMBED_PYTHON_VERSION = "3.10.11"
EMBED_PYTHON_URL = f"https://www.python.org/ftp/python/{EMBED_PYTHON_VERSION}/python-{EMBED_PYTHON_VERSION}-embed-amd64.zip"
GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"


def _prepare_embedded_python():
    """Embedded Python zip + get-pip.py + tkinter 를 dist에 준비."""
    import urllib.request

    embed_zip = DIST_DIR / f"python-{EMBED_PYTHON_VERSION}-embed-amd64.zip"
    get_pip = DIST_DIR / "get-pip.py"

    # Download embedded Python zip if not cached
    cache_dir = PROJECT_ROOT / "build" / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached_zip = cache_dir / embed_zip.name
    cached_pip = cache_dir / "get-pip.py"

    if not cached_zip.exists():
        print(f"  Downloading {EMBED_PYTHON_URL} ...")
        urllib.request.urlretrieve(EMBED_PYTHON_URL, str(cached_zip))
    shutil.copy2(str(cached_zip), str(embed_zip))
    print(f"  Embedded Python zip: {embed_zip.name}")

    if not cached_pip.exists():
        print(f"  Downloading get-pip.py ...")
        urllib.request.urlretrieve(GET_PIP_URL, str(cached_pip))
    shutil.copy2(str(cached_pip), str(get_pip))
    print(f"  get-pip.py ready")

    # Pre-extract + add tkinter (not included in embedded Python)
    _prepack_embedded_with_tkinter(cached_zip)


def _prepack_embedded_with_tkinter(embed_zip_path: Path):
    """Embedded Python을 미리 추출하고 tkinter를 추가하여 dist에 포함."""
    import zipfile

    python_dir = DIST_DIR / "python"
    if python_dir.exists():
        shutil.rmtree(str(python_dir))

    # Extract embedded Python
    print("  Extracting embedded Python...")
    with zipfile.ZipFile(str(embed_zip_path)) as zf:
        zf.extractall(str(python_dir))

    # Enable import site in ._pth (required for pip + Lib/)
    for pth in python_dir.glob("python*._pth"):
        lines = pth.read_text(encoding="utf-8").splitlines()
        new_lines = []
        for line in lines:
            if line.strip() == "#import site":
                new_lines.append("import site")
            else:
                new_lines.append(line)
        if "Lib" not in "\n".join(new_lines):
            new_lines.insert(1, "Lib")
            new_lines.insert(2, "Lib\\site-packages")
        pth.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
        print(f"  {pth.name} updated (import site + Lib)")

    # Copy tkinter from build machine's Python
    py_base = Path(sys.base_prefix)
    _copy_tkinter(py_base, python_dir)

    # Pre-install pip
    get_pip_file = DIST_DIR / "get-pip.py"
    if get_pip_file.exists():
        print("  Installing pip into embedded Python...")
        _run([str(python_dir / "python.exe"), str(get_pip_file),
              "--no-warn-script-location", "-q"],
             check=False, live_output=False)
        # Verify
        r = _run([str(python_dir / "python.exe"), "-m", "pip", "--version"],
                 check=False, live_output=False)
        if r.returncode == 0:
            print(f"  pip ready: {r.stdout.strip()}")
        else:
            print(f"  [Warning] pip install failed: {r.stderr[:200]}")

    # Pre-install packages from requirements.txt
    req_file = PROJECT_ROOT / "requirements.txt"
    if req_file.exists() and (python_dir / "python.exe").exists():
        print("  Installing packages from requirements.txt...")
        _run([str(python_dir / "python.exe"), "-m", "pip", "install",
              "-r", str(req_file), "-q", "--no-warn-script-location"],
             check=False, live_output=False)

    print(f"  Embedded Python ready: {python_dir}")


def _copy_tkinter(py_base: Path, embed_dir: Path):
    """빌드 머신의 Python에서 tkinter 관련 파일을 embedded Python에 복사."""
    lib_dir = embed_dir / "Lib"
    lib_dir.mkdir(exist_ok=True)

    # 1. tkinter package
    src_tkinter = py_base / "Lib" / "tkinter"
    if src_tkinter.is_dir():
        shutil.copytree(str(src_tkinter), str(lib_dir / "tkinter"))
        print(f"  tkinter package copied")

    # 2. _tkinter.pyd + tcl/tk DLLs
    dlls_src = py_base / "DLLs"
    for name in ["_tkinter.pyd", "tcl86t.dll", "tk86t.dll"]:
        src = dlls_src / name
        if not src.exists():
            src = py_base / name
        if src.exists():
            shutil.copy2(str(src), str(embed_dir / name))
            print(f"  {name} copied")

    # 3. tcl/ directory (Tcl/Tk scripts)
    src_tcl = py_base / "tcl"
    if src_tcl.is_dir():
        shutil.copytree(str(src_tcl), str(embed_dir / "tcl"))
        print(f"  tcl/ directory copied")


# ── 빌드 단계 ──

def step_compile_backend():
    """backend/**/*.py → .pyd 컴파일 (Cython)."""
    print("\n=== [1/4] Backend Python → .pyd 컴파일 ===")

    try:
        import Cython
        print(f"  Cython {Cython.__version__}")
    except ImportError:
        print("  ERROR: pip install cython 필요")
        return False

    py_files = []
    for root, dirs, files in os.walk(PROJECT_ROOT / "backend" / "app"):
        for f in files:
            if f.endswith(".py") and f not in SKIP_COMPILE:
                py_files.append(os.path.join(root, f))
    # server.py도 컴파일
    server_py = str(PROJECT_ROOT / "server.py")
    if os.path.exists(server_py):
        py_files.append(server_py)

    if not py_files:
        print("  컴파일할 파일 없음")
        return True

    print(f"  {len(py_files)}개 파일 컴파일 중...")

    setup_content = f"""
import os
from setuptools import setup, Extension
from Cython.Build import cythonize

if __name__ == '__main__':
    py_files = {py_files!r}
    extensions = []
    for py_file in py_files:
        rel = os.path.relpath(py_file, r"{PROJECT_ROOT}")
        mod_name = rel.replace(os.sep, ".").replace("/", ".")[:-3]
        extensions.append(Extension(mod_name, [py_file]))

    setup(
        ext_modules=cythonize(
            extensions,
            compiler_directives={{'language_level': 3}},
            nthreads=0,
        ),
        script_args=["build_ext", "--inplace"],
    )
"""
    setup_file = PROJECT_ROOT / "_cython_setup.py"
    setup_file.write_text(setup_content, encoding="utf-8")
    try:
        result = _run([sys.executable, str(setup_file)], check=False, live_output=True)
        if result.returncode != 0:
            print("  컴파일 실패")
            return False
        print("  컴파일 완료")
        return True
    finally:
        setup_file.unlink(missing_ok=True)


def step_build_frontend():
    """frontend npm build."""
    print("\n=== [2/4] Frontend 빌드 ===")
    print("  npm install...")
    _run([NPM_CMD, "install"], cwd=PROJECT_ROOT / "frontend", check=False)
    result = _run([NPM_CMD, "run", "build"], cwd=PROJECT_ROOT / "frontend", check=False)
    if result.returncode != 0:
        print(f"  빌드 에러:\n{result.stderr[:500]}")
        return False
    print("  빌드 완료")
    return True


def step_build_exe():
    """(Deprecated) PyInstaller exe 빌드는 더 이상 사용하지 않음.
    ReplayKit.bat 런처가 venv/pythonw.exe를 직접 실행합니다."""
    print("\n=== [3/3] exe build skipped (using ReplayKit.bat launcher) ===")
    return True


def step_package():
    """배포 패키지 조립 (dist/ReplayKit/)."""
    print("\n=== [3/3] 배포 패키지 생성 ===")

    # 기존 내용 정리 (.git, whl, msi 등 보존)
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    # 빌드가 새로 생성하는 항목만 삭제, 수동 배치 파일은 보존
    _preserve_names = {".git", ".gitignore", ".gitattributes", "git_remote.txt",
                       "scan_settings.json"}
    _preserve_exts = {".whl", ".msi", ".exe", ".zip"}
    # 빌드가 관리하는 디렉토리만 삭제 대상 (tools, DltViewerSDK 등 수동 배치 폴더 보존)
    _rebuild_dirs = {"backend", "frontend", "docs", "python"}
    for item in list(DIST_DIR.iterdir()):
        if item.name in _preserve_names or item.suffix in _preserve_exts:
            continue
        if item.is_dir():
            if item.name in _rebuild_dirs:
                shutil.rmtree(item)
            # 그 외 디렉토리는 보존 (Results, 사용자 데이터 등)
        else:
            # 빌드가 재생성하는 파일만 삭제
            if item.suffix in {".py", ".bat", ".ico", ".txt"} and item.name != "git_remote.txt":
                item.unlink()

    # ── backend 복사 (.pyd만, .py 소스 제외) ──
    print("  backend 복사 중 (.pyd + 설정 파일)...")
    src_backend = PROJECT_ROOT / "backend"
    dst_backend = DIST_DIR / "backend"

    # 배포에서 제외할 런타임 데이터 파일
    _skip_files = {"auxiliary_devices.json", "settings.json"}

    for root, dirs, files in os.walk(src_backend):
        dirs[:] = [d for d in dirs if d not in ("__pycache__", "scenarios", "results", "screenshots")]
        rel_root = Path(root).relative_to(src_backend)
        dst_root = dst_backend / rel_root
        dst_root.mkdir(parents=True, exist_ok=True)

        for f in files:
            if f in _skip_files:
                continue
            src_file = Path(root) / f
            dst_file = dst_root / f

            if f.endswith(".py"):
                if f == "__init__.py":
                    dst_file.write_text("", encoding="utf-8")
                    continue
                # 컴파일 제외 파일은 .py 원본 복사 + 기존 .pyd 삭제
                if f in SKIP_COMPILE:
                    shutil.copy2(str(src_file), str(dst_file))
                    # 이전 빌드의 .pyd가 남아있으면 삭제 (Python이 .pyd를 우선 로딩하므로)
                    stem = f[:-3]  # e.g. "results"
                    for old_pyd in dst_root.glob(f"{stem}.*.pyd"):
                        old_pyd.unlink()
                # 나머지 .py는 복사하지 않음 (.pyd가 대체)
                continue
            elif f.endswith(".pyd"):
                shutil.copy2(str(src_file), str(dst_file))
            elif f.endswith(".c"):
                continue  # Cython 중간 파일 건너뜀
            else:
                shutil.copy2(str(src_file), str(dst_file))

    (dst_backend / "__init__.py").touch()

    # plugins 폴더는 .py 포함 (사용자 플러그인)
    plugins_src = src_backend / "app" / "plugins"
    plugins_dst = dst_backend / "app" / "plugins"
    if plugins_src.is_dir():
        plugins_dst.mkdir(parents=True, exist_ok=True)
        for f in plugins_src.iterdir():
            if f.is_file():
                shutil.copy2(str(f), str(plugins_dst / f.name))

    # ── frontend/dist 복사 ──
    print("  frontend 복사 중...")
    src_fe_dist = PROJECT_ROOT / "frontend" / "dist"
    dst_fe = DIST_DIR / "frontend" / "dist"
    if src_fe_dist.exists():
        shutil.copytree(str(src_fe_dist), str(dst_fe))

    # ── 루트 파일 ──
    print("  루트 파일 복사 중...")
    for f in INCLUDE_ROOT_FILES:
        if f == "server.py":
            continue  # server.py는 별도 처리
        src = PROJECT_ROOT / f
        if src.exists():
            shutil.copy2(str(src), str(DIST_DIR / f))

    # ── server.py → .pyd + 얇은 런처 ──
    server_pyd = list(PROJECT_ROOT.glob("server.cp*.pyd"))
    if server_pyd:
        pyd_filename = server_pyd[0].name  # e.g. server.cp310-win_amd64.pyd
        # .pyd를 원래 이름 그대로 복사 (PyInit_server 유지)
        shutil.copy2(str(server_pyd[0]), str(DIST_DIR / pyd_filename))
        # 런처: importlib로 .pyd를 직접 로드 (server.py와 이름 충돌 회피)
        launcher_code = f"""import os, sys, importlib.util
_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _dir)
_spec = importlib.util.spec_from_file_location("server", os.path.join(_dir, "{pyd_filename}"))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
_mod.main()
"""
        # server.py + _launcher.py 둘 다 생성 (구버전 .bat 호환)
        (DIST_DIR / "server.py").write_text(launcher_code, encoding="utf-8")
        (DIST_DIR / "_launcher.py").write_text(launcher_code, encoding="utf-8")
        print(f"  {pyd_filename} + server.py + _launcher.py (launcher)")
    else:
        # .pyd 없으면 원본 복사 (컴파일 실패 시 폴백)
        src = PROJECT_ROOT / "server.py"
        if src.exists():
            shutil.copy2(str(src), str(DIST_DIR / "server.py"))
            print("  server.py 원본 복사 (pyd 없음)")

    for f in INCLUDE_EXTRA:
        src = PROJECT_ROOT / f
        if src.exists():
            shutil.copy2(str(src), str(DIST_DIR / f))

    # ── DLT Viewer SDK 복사 (소스에 있으면 복사, 배포 폴더에 이미 있으면 유지) ──
    src_dlt = PROJECT_ROOT / "DltViewerSDK_21.1.3_ver"
    dst_dlt = DIST_DIR / "DltViewerSDK_21.1.3_ver"
    if src_dlt.is_dir():
        if dst_dlt.exists():
            shutil.rmtree(str(dst_dlt))
        shutil.copytree(str(src_dlt), str(dst_dlt))
        print(f"  DltViewerSDK 복사 완료 (소스에서)")
    elif dst_dlt.is_dir():
        print(f"  DltViewerSDK 유지 (배포 폴더에 이미 존재)")
    else:
        print(f"  [Note] DltViewerSDK not found")

    # ── tools (ffmpeg 등) 복사 (소스에 있으면 머지, 배포 폴더에 이미 있으면 유지) ──
    src_tools = PROJECT_ROOT / "tools"
    dst_tools = DIST_DIR / "tools"
    if src_tools.is_dir():
        # 소스 tools → 배포 tools로 머지 (기존 파일 보존, 새 파일 추가/덮어쓰기)
        dst_tools.mkdir(parents=True, exist_ok=True)
        for item in src_tools.rglob("*"):
            if item.is_file():
                rel = item.relative_to(src_tools)
                target = dst_tools / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(item), str(target))
        print(f"  tools 머지 완료 (소스에서)")
    elif dst_tools.is_dir():
        print(f"  tools 유지 (배포 폴더에 이미 존재)")
    else:
        print(f"  [Note] tools/ not found")

    # ── Git installer 복사 ──
    git_installers = list(PROJECT_ROOT.glob("Git-*.exe"))
    if git_installers:
        for gi in git_installers:
            shutil.copy2(str(gi), str(DIST_DIR / gi.name))
        print(f"  Git installer 복사: {[g.name for g in git_installers]}")
    else:
        print(f"  [Note] Git installer not found - skipped")

    # ── docs 복사 ──
    src_docs = PROJECT_ROOT / "docs"
    dst_docs = DIST_DIR / "docs"
    if src_docs.is_dir():
        if dst_docs.exists():
            shutil.rmtree(str(dst_docs))
        shutil.copytree(str(src_docs), str(dst_docs))
        print(f"  docs 복사 완료")

    # ── Embedded Python ──
    _prepare_embedded_python()

    # ── 빈 디렉토리 (사용자 데이터) ──
    for d in ["backend/scenarios", "backend/results", "backend/screenshots",
              "backend/app/plugins", "Results/Video"]:
        (DIST_DIR / d).mkdir(parents=True, exist_ok=True)

    # ── .gitignore (배포 repo용) ──
    dist_gitignore = DIST_DIR / ".gitignore"
    dist_gitignore.write_text("""# 런타임 생성 (setup.bat이 생성/관리)
venv/
python/
__pycache__/
*.pyc
*.c

# 인스톨러 전용 (Inno Setup 패키징 대상, git 불필요)
*.exe
*.msi
*.zip
*.whl
get-pip.py
DltViewerSDK_21.1.3_ver/
tools/

# 사용자 데이터
backend/screenshots/
backend/results/
backend/scenarios/
backend/auxiliary_devices.json
backend/settings.json
Results/

# 기타
DLL_DEBUG/
.env
unins*
""", encoding="utf-8")

    # ── 배포 repo URL 기록 (설치 후 git init용) ──
    remote_url = _get_deploy_remote()
    git_remote_file = DIST_DIR / "git_remote.txt"
    if remote_url:
        git_remote_file.write_text(remote_url, encoding="utf-8")
        print(f"  git_remote.txt: {remote_url}")
    elif git_remote_file.exists():
        git_remote_file.unlink()

    # 통계
    total = sum(1 for _ in DIST_DIR.rglob("*") if _.is_file())
    pyd_count = sum(1 for _ in DIST_DIR.rglob("*.pyd"))
    py_count = sum(1 for _ in DIST_DIR.rglob("*.py"))
    print(f"\n  패키지 완료: {DIST_DIR}")
    print(f"  총 {total}개 파일 (.pyd: {pyd_count}, .py: {py_count} — __init__ + server + plugins만)")
    return True


# ── 배포 repo 관리 ──

def _get_deploy_remote() -> str:
    """dist/.git/config에서 origin URL을 읽어온다."""
    try:
        r = _run(["git", "remote", "get-url", "origin"], cwd=DIST_DIR, check=False)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def init_deploy():
    """배포 repo 최초 설정."""
    print("\n=== 배포 repo 초기화 ===")
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    if (DIST_DIR / ".git").exists():
        print(f"  이미 git repo 존재: {DIST_DIR}")
        return

    url = input("  배포 repo URL 입력 (예: https://github.com/user/recording-test-dist.git): ").strip()
    if not url:
        print("  취소됨")
        return

    _run(["git", "init"], cwd=DIST_DIR)
    _run(["git", "remote", "add", "origin", url], cwd=DIST_DIR)
    print(f"  배포 repo 설정 완료: {url}")
    print(f"  빌드 후 --deploy 로 push 하세요")


def deploy(commit_msg=None):
    """배포 repo에 commit + push."""
    print("\n=== 배포 repo push ===")
    if not (DIST_DIR / ".git").exists():
        print("  ERROR: 배포 repo 미설정. --init-deploy 먼저 실행하세요")
        return False

    if not commit_msg:
        # 개발 repo의 최신 커밋 메시지 가져오기
        try:
            r = _run(["git", "log", "-1", "--format=%s"], check=False)
            dev_msg = r.stdout.strip()
        except Exception:
            dev_msg = ""
        commit_msg = dev_msg or "Update build"

    _run(["git", "add", "-A"], cwd=DIST_DIR)

    # 변경사항 확인
    r = _run(["git", "status", "--porcelain"], cwd=DIST_DIR, check=False)
    if not r.stdout.strip():
        print("  변경사항 없음 — push 건너뜀")
        return True

    _run(["git", "commit", "-m", commit_msg], cwd=DIST_DIR, check=False)

    # 등록된 모든 remote에 push
    r_remotes = _run(["git", "remote"], cwd=DIST_DIR, check=False)
    remotes = [name.strip() for name in r_remotes.stdout.strip().splitlines() if name.strip()]
    if not remotes:
        remotes = ["origin"]

    all_ok = True
    for remote in remotes:
        print(f"  push → {remote} ...", end=" ")
        result = _run(["git", "push", "-u", remote, "main"], cwd=DIST_DIR, check=False)
        if result.returncode != 0:
            _run(["git", "branch", "-M", "main"], cwd=DIST_DIR, check=False)
            result = _run(["git", "push", "-u", remote, "main"], cwd=DIST_DIR, check=False)
            if result.returncode != 0:
                print(f"실패: {result.stderr[:200]}")
                all_ok = False
                continue
        print("완료")

    if not all_ok:
        return False
    return True


# ── 정리 ──

def clean():
    """빌드 중간 파일 정리 (.pyd, .c, build/)."""
    print("\n=== 정리 ===")
    count = 0
    for pattern in ("*.c", "*.pyd"):
        for f in (PROJECT_ROOT / "backend").rglob(pattern):
            f.unlink()
            count += 1
    # 루트의 server.*.pyd, server.c도 삭제
    for pattern in ("server.*.pyd", "server.c"):
        for f in PROJECT_ROOT.glob(pattern):
            f.unlink()
            count += 1
    if BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)
    for f in [PROJECT_ROOT / "_cython_setup.py"]:
        if f.exists():
            f.unlink()
    print(f"  개발 폴더 빌드 산출물 {count}개 삭제 완료")


# ── 메인 ──

def main():
    args = set(sys.argv[1:])

    if "--clean" in args:
        clean()
        return

    if "--init-deploy" in args:
        init_deploy()
        return

    if "--deploy-only" in args:
        deploy()
        return

    if "--backend" in args:
        step_compile_backend()
        clean()
        return

    # 전체 빌드
    print("=" * 50)
    print("  ReplayKit — 배포 빌드")
    print("=" * 50)

    ok = step_compile_backend()
    if not ok:
        print("\n빌드 중단: backend 컴파일 실패")
        return

    ok = step_build_frontend()
    if not ok:
        print("\n빌드 중단: frontend 빌드 실패")
        return

    step_package()
    clean()

    print("\n" + "=" * 50)
    print("  빌드 완료!")
    print(f"  배포 폴더: {DIST_DIR}")
    print("=" * 50)

    if "--deploy" in args:
        deploy()


if __name__ == "__main__":
    main()
