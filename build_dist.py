"""배포용 빌드 스크립트.

backend Python 코드를 Cython으로 .pyd 바이너리로 컴파일하고,
frontend를 빌드하고, server.py를 exe로 컴파일하여
배포 패키지를 생성합니다.

사전 요구사항:
  pip install cython pyinstaller
  Visual Studio Build Tools (Windows C 컴파일러)

사용법:
  python build_dist.py           # 전체 빌드
  python build_dist.py --backend # 백엔드만 컴파일
  python build_dist.py --exe     # server.exe만 빌드
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent
DIST_DIR = PROJECT_ROOT / "dist" / "RecordingTest"
BUILD_DIR = PROJECT_ROOT / "build"

# 배포에 포함할 루트 레벨 파일/폴더
INCLUDE_ROOT_FILES = [
    "requirements.txt",
    "setup.bat",
]

# backend에서 컴파일 제외할 파일 (빈 __init__.py 등)
SKIP_COMPILE = {"__init__.py"}

# 배포에 포함하지 않을 폴더/파일
EXCLUDE_PATTERNS = {
    "__pycache__", ".git", ".gitignore", "node_modules",
    ".env", "build", "dist", "*.egg-info",
    "build_dist.py", "sync_and_run.bat",
}


def _run(cmd, cwd=None, check=True):
    """subprocess 실행."""
    print(f"  > {' '.join(cmd)}")
    return subprocess.run(
        cmd, cwd=cwd or str(PROJECT_ROOT),
        check=check, capture_output=True, text=True,
    )


def step_compile_backend():
    """backend/**/*.py → .pyd 컴파일 (Cython)."""
    print("\n=== [1/4] Backend Python → .pyd 컴파일 ===")

    try:
        import Cython
        print(f"  Cython {Cython.__version__}")
    except ImportError:
        print("  ERROR: Cython이 설치되어 있지 않습니다. pip install cython")
        return False

    # 컴파일할 .py 파일 수집
    py_files = []
    for root, dirs, files in os.walk(PROJECT_ROOT / "backend" / "app"):
        for f in files:
            if f.endswith(".py") and f not in SKIP_COMPILE:
                py_files.append(os.path.join(root, f))

    if not py_files:
        print("  컴파일할 파일이 없습니다")
        return True

    print(f"  {len(py_files)}개 파일 컴파일 중...")

    # setup.py를 동적으로 생성하여 cythonize
    setup_content = f"""
import os, sys
from setuptools import setup, Extension
from Cython.Build import cythonize

py_files = {py_files!r}

extensions = []
for py_file in py_files:
    # 모듈 이름 생성: backend/app/main.py → backend.app.main
    rel = os.path.relpath(py_file, r"{PROJECT_ROOT}")
    mod_name = rel.replace(os.sep, ".").replace("/", ".")[:-3]  # .py 제거
    extensions.append(Extension(mod_name, [py_file]))

setup(
    ext_modules=cythonize(
        extensions,
        compiler_directives={{'language_level': 3}},
        nthreads=os.cpu_count() or 4,
    ),
    script_args=["build_ext", "--inplace"],
)
"""
    setup_file = PROJECT_ROOT / "_cython_setup.py"
    setup_file.write_text(setup_content, encoding="utf-8")

    try:
        result = _run([sys.executable, str(setup_file)], check=False)
        if result.returncode != 0:
            print(f"  컴파일 에러:\n{result.stderr[:500]}")
            return False
        print("  컴파일 완료")
        return True
    finally:
        setup_file.unlink(missing_ok=True)


def step_build_frontend():
    """frontend npm build."""
    print("\n=== [2/4] Frontend 빌드 ===")
    npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"
    result = _run([npm_cmd, "run", "build"], cwd=str(PROJECT_ROOT / "frontend"), check=False)
    if result.returncode != 0:
        print(f"  빌드 에러:\n{result.stderr[:500]}")
        return False
    print("  빌드 완료")
    return True


def step_build_exe():
    """server.py → server.exe (PyInstaller)."""
    print("\n=== [3/4] server.py → exe 컴파일 ===")
    result = _run([
        sys.executable, "-m", "PyInstaller",
        "--onefile", "--noconsole",
        "--name", "RecordingServer",
        "--distpath", str(DIST_DIR),
        "--workpath", str(BUILD_DIR / "pyinstaller"),
        "--specpath", str(BUILD_DIR),
        str(PROJECT_ROOT / "server.py"),
    ], check=False)
    if result.returncode != 0:
        print(f"  PyInstaller 에러:\n{result.stderr[:500]}")
        return False
    print("  exe 빌드 완료")
    return True


def step_package():
    """배포 패키지 조립."""
    print("\n=== [4/4] 배포 패키지 생성 ===")

    if DIST_DIR.exists():
        # exe는 이미 있을 수 있으니 backend/frontend만 정리
        for d in ["backend", "frontend"]:
            target = DIST_DIR / d
            if target.exists():
                shutil.rmtree(target)
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    # backend 복사 (.pyd만, .py 소스 제외)
    print("  backend 복사 중 (.pyd + 필수 파일)...")
    src_backend = PROJECT_ROOT / "backend"
    dst_backend = DIST_DIR / "backend"

    for root, dirs, files in os.walk(src_backend):
        # __pycache__ 제외
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        rel_root = Path(root).relative_to(src_backend)
        dst_root = dst_backend / rel_root
        dst_root.mkdir(parents=True, exist_ok=True)

        for f in files:
            src_file = Path(root) / f
            dst_file = dst_root / f

            # .py 파일: __init__.py만 복사 (빈 파일로), 나머지는 .pyd가 대체
            if f.endswith(".py"):
                if f == "__init__.py":
                    dst_file.write_text("", encoding="utf-8")
                # .pyd가 있으면 .py는 건너뜀
                continue
            # .pyd 파일 복사
            elif f.endswith(".pyd"):
                shutil.copy2(str(src_file), str(dst_file))
            # .c 파일 건너뜀 (Cython 중간 파일)
            elif f.endswith(".c"):
                continue
            # 기타 파일 (json, txt 등) 복사
            else:
                shutil.copy2(str(src_file), str(dst_file))

    # backend/__init__.py 보장
    (dst_backend / "__init__.py").touch()

    # frontend/dist 복사
    print("  frontend 복사 중 (빌드 결과)...")
    src_fe_dist = PROJECT_ROOT / "frontend" / "dist"
    dst_fe = DIST_DIR / "frontend" / "dist"
    if src_fe_dist.exists():
        if dst_fe.exists():
            shutil.rmtree(dst_fe)
        shutil.copytree(str(src_fe_dist), str(dst_fe))

    # frontend/package.json + node_modules는 dev 서버용이므로 배포에 불필요
    # 대신 빌드된 정적 파일을 백엔드가 서빙

    # 루트 파일 복사
    print("  루트 파일 복사 중...")
    for f in INCLUDE_ROOT_FILES:
        src = PROJECT_ROOT / f
        if src.exists():
            shutil.copy2(str(src), str(DIST_DIR / f))

    # 빈 디렉토리 생성 (사용자 데이터 영역)
    for d in ["backend/scenarios", "backend/results", "backend/screenshots",
              "backend/app/plugins", "Results/Video"]:
        (DIST_DIR / d).mkdir(parents=True, exist_ok=True)

    # venv는 포함하지 않음 — setup.bat으로 현장에서 생성
    print(f"\n  배포 패키지 생성 완료: {DIST_DIR}")

    # 파일 수 카운트
    total = sum(1 for _ in DIST_DIR.rglob("*") if _.is_file())
    pyd_count = sum(1 for _ in DIST_DIR.rglob("*.pyd"))
    print(f"  총 {total}개 파일 (컴파일된 .pyd: {pyd_count}개)")
    return True


def clean():
    """빌드 중간 파일 정리."""
    print("\n=== 정리 ===")
    # Cython 중간 파일 (.c) 삭제
    for c_file in (PROJECT_ROOT / "backend").rglob("*.c"):
        c_file.unlink()
        print(f"  삭제: {c_file.relative_to(PROJECT_ROOT)}")
    # build 폴더
    if BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)
        print(f"  삭제: build/")
    # _cython_setup.py
    f = PROJECT_ROOT / "_cython_setup.py"
    if f.exists():
        f.unlink()


def main():
    args = set(sys.argv[1:])

    if "--clean" in args:
        clean()
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
    print("  Recording Test — 배포 빌드")
    print("=" * 50)

    ok = step_compile_backend()
    if not ok:
        print("\n빌드 중단: backend 컴파일 실패")
        return

    ok = step_build_frontend()
    if not ok:
        print("\n빌드 중단: frontend 빌드 실패")
        return

    ok = step_build_exe()
    if not ok:
        print("\n경고: exe 빌드 실패 — server.py를 직접 사용하세요")

    step_package()
    clean()

    print("\n" + "=" * 50)
    print("  빌드 완료!")
    print(f"  배포 폴더: {DIST_DIR}")
    print("=" * 50)


if __name__ == "__main__":
    main()
