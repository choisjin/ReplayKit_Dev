@echo off
chcp 65001 >nul
echo ============================================
echo   ReplayKit - 초기 환경 설정
echo ============================================
echo.

cd /d "%~dp0"

:: 프로덕션 모드 판별 (frontend/dist 존재 여부)
set "PRODUCTION=0"
if exist "frontend\dist\index.html" (
    if not exist "frontend\package.json" set "PRODUCTION=1"
)

:: Python venv 생성
echo [1/5] Python 가상환경 생성 중...
if not exist "venv" (
    py -3.10 -m venv venv
    echo       venv 생성 완료
) else (
    echo       venv 이미 존재함 - 건너뜀
)

:: pip 패키지 설치
echo [2/5] Python 패키지 설치 중...
call venv\Scripts\activate.bat
python -m pip install --upgrade pip -q
pip install -r requirements.txt -q
if exist "lge.auto-*.whl" (
    for %%f in (lge.auto-*.whl) do pip install "%%f"
    echo       lge.auto 설치 완료
) else (
    echo       [참고] lge.auto .whl 파일이 없습니다.
)

:: Node.js (개발 모드에서만 필요)
if "%PRODUCTION%"=="1" (
    echo [3/5] 프로덕션 모드 - Node.js 건너뜀
    goto :skip_npm
)

echo [3/5] Node.js 확인 중...
where npm.cmd >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo       Node.js가 설치되어 있지 않습니다.
    if exist "node-*.msi" (
        echo       동봉된 Node.js MSI로 설치합니다...
        for %%f in (node-*.msi) do msiexec /i "%%f" /passive /norestart
        echo       Node.js 설치 완료
        echo       [중요] 환경변수 반영을 위해 이 창을 닫고 setup.bat를 다시 실행해주세요.
        pause
        exit /b 0
    )
    echo       https://nodejs.org 에서 LTS 버전을 수동 설치해주세요.
    goto :skip_npm
) else (
    for /f "tokens=*" %%v in ('node --version 2^>nul') do echo       Node.js %%v 감지됨
)

echo [4/5] Frontend 패키지 설치 중...
cd frontend
call npm install
cd ..
echo       npm install 완료

:skip_npm

:: ReplayKit.exe 빌드 (프로덕션 모드에서만)
if "%PRODUCTION%"=="1" (
    if not exist "ReplayKit.exe" (
        echo [5/5] ReplayKit.exe 빌드 중...
        pip install pyinstaller -q
        pyinstaller --onefile --noconsole --name ReplayKit server.py --distpath . --workpath build\pyinstaller --specpath build 2>nul
        if exist "ReplayKit.exe" (
            echo       ReplayKit.exe 빌드 완료
        ) else (
            echo       [경고] exe 빌드 실패 - python server.py로 실행하세요
        )
        if exist "build" rd /s /q build
        if exist "ReplayKit.spec" del ReplayKit.spec
    ) else (
        echo [5/5] ReplayKit.exe 이미 존재함 - 건너뜀
    )
) else (
    echo [5/5] 개발 모드 - exe 빌드 건너뜀
)

call deactivate

echo.
echo ============================================
echo   설정 완료!
if "%PRODUCTION%"=="1" (
    echo   ReplayKit.exe를 실행하세요.
) else (
    echo   python server.py로 실행하세요.
)
echo ============================================
pause
