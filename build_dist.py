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
                "device.py", "scenario.py", "results.py", "settings.py"}

# 배포에 포함할 루트 파일
INCLUDE_ROOT_FILES = [
    "requirements.txt",
    "setup.bat",
    "server.py",
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
    result = _run([NPM_CMD, "run", "build"], cwd=PROJECT_ROOT / "frontend", check=False)
    if result.returncode != 0:
        print(f"  빌드 에러:\n{result.stderr[:500]}")
        return False
    print("  빌드 완료")
    return True


def step_build_exe():
    """server.py → ReplayKit.exe."""
    print("\n=== [3/4] server.py → exe 컴파일 ===")
    exe_dest = DIST_DIR / "ReplayKit.exe"
    result = _run([
        sys.executable, "-m", "PyInstaller",
        "--onefile", "--noconsole",
        "--name", "ReplayKit",
        "--distpath", str(DIST_DIR),
        "--workpath", str(BUILD_DIR / "pyinstaller"),
        "--specpath", str(BUILD_DIR),
        str(PROJECT_ROOT / "server.py"),
    ], check=False, live_output=True)
    if result.returncode != 0:
        print(f"  PyInstaller 에러:\n{result.stderr[:500]}")
        return False
    if exe_dest.exists():
        print(f"  exe 빌드 완료: {exe_dest}")
    return True


def step_package():
    """배포 패키지 조립 (dist/ReplayKit/)."""
    print("\n=== [4/4] 배포 패키지 생성 ===")

    # 기존 내용 정리 (.git, exe, whl, msi 등 보존)
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    _preserve_names = {".git", ".gitignore", ".gitattributes", "ReplayKit.exe"}
    _preserve_exts = {".whl", ".msi", ".exe"}
    for item in list(DIST_DIR.iterdir()):
        if item.name in _preserve_names or item.suffix in _preserve_exts:
            continue
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()

    # ── backend 복사 (.pyd만, .py 소스 제외) ──
    print("  backend 복사 중 (.pyd + 설정 파일)...")
    src_backend = PROJECT_ROOT / "backend"
    dst_backend = DIST_DIR / "backend"

    for root, dirs, files in os.walk(src_backend):
        dirs[:] = [d for d in dirs if d not in ("__pycache__", "scenarios", "results", "screenshots")]
        rel_root = Path(root).relative_to(src_backend)
        dst_root = dst_backend / rel_root
        dst_root.mkdir(parents=True, exist_ok=True)

        for f in files:
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
        src = PROJECT_ROOT / f
        if src.exists():
            shutil.copy2(str(src), str(DIST_DIR / f))

    for f in INCLUDE_EXTRA:
        src = PROJECT_ROOT / f
        if src.exists():
            shutil.copy2(str(src), str(DIST_DIR / f))

    # ── 빈 디렉토리 (사용자 데이터) ──
    for d in ["backend/scenarios", "backend/results", "backend/screenshots",
              "backend/app/plugins", "Results/Video"]:
        (DIST_DIR / d).mkdir(parents=True, exist_ok=True)

    # ── .gitignore (배포 repo용) ──
    dist_gitignore = DIST_DIR / ".gitignore"
    dist_gitignore.write_text("""venv/
__pycache__/
*.pyc
*.exe
backend/screenshots/
backend/results/
backend/scenarios/
backend/auxiliary_devices.json
backend/settings.json
Results/
DLL_DEBUG/
.env
""", encoding="utf-8")

    # 통계
    total = sum(1 for _ in DIST_DIR.rglob("*") if _.is_file())
    pyd_count = sum(1 for _ in DIST_DIR.rglob("*.pyd"))
    py_count = sum(1 for _ in DIST_DIR.rglob("*.py"))
    print(f"\n  패키지 완료: {DIST_DIR}")
    print(f"  총 {total}개 파일 (.pyd: {pyd_count}, .py: {py_count} — __init__ + server + plugins만)")
    return True


# ── 배포 repo 관리 ──

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
    result = _run(["git", "push", "-u", "origin", "main"], cwd=DIST_DIR, check=False)
    if result.returncode != 0:
        # 최초 push 시 main 브랜치가 없을 수 있음
        _run(["git", "branch", "-M", "main"], cwd=DIST_DIR, check=False)
        result = _run(["git", "push", "-u", "origin", "main"], cwd=DIST_DIR, check=False)
        if result.returncode != 0:
            print(f"  push 실패:\n{result.stderr[:300]}")
            return False

    print("  push 완료")
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

    if "--exe" in args:
        step_build_exe()
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

    # exe는 사용자 PC에서 setup.bat이 빌드 (배포에서는 server.py 포함)
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
