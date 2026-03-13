@echo off
chcp 65001 >nul
echo ============================================
echo   Recording Test - 초기 환경 설정
echo ============================================
echo.

cd /d "%~dp0"

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
python -m pip install --upgrade pip
pip install -r requirements.txt
if exist "lge.auto-*.whl" (
    for %%f in (lge.auto-*.whl) do pip install "%%f"
    echo       lge.auto 설치 완료
) else (
    echo       [주의] lge.auto .whl 파일이 없습니다. 수동으로 복사해주세요.
)
call deactivate

:: Node.js 확인 및 자동 설치
echo [3/5] Node.js 확인 중...
where npm.cmd >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo       Node.js가 설치되어 있지 않습니다. 자동 설치합니다...
    echo.

    :: winget으로 설치 시도
    where winget >nul 2>&1
    if %ERRORLEVEL% equ 0 (
        echo       winget으로 Node.js LTS 설치 중...
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        if %ERRORLEVEL% equ 0 (
            echo       Node.js 설치 완료
            echo       [중요] 환경변수 반영을 위해 이 창을 닫고 setup.bat를 다시 실행해주세요.
            pause
            exit /b 0
        ) else (
            echo       winget 설치 실패
        )
    )

    :: winget 실패 시 직접 다운로드
    echo       직접 다운로드로 Node.js 설치 중...
    set "NODE_MSI=%TEMP%\node_lts_setup.msi"
    powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi' -OutFile '%NODE_MSI%'" 2>nul
    if exist "%NODE_MSI%" (
        echo       Node.js MSI 다운로드 완료. 설치 실행 중...
        msiexec /i "%NODE_MSI%" /passive /norestart
        del "%NODE_MSI%" 2>nul
        echo       Node.js 설치 완료
        echo       [중요] 환경변수 반영을 위해 이 창을 닫고 setup.bat를 다시 실행해주세요.
        pause
        exit /b 0
    ) else (
        echo       [실패] Node.js 자동 설치에 실패했습니다.
        echo       https://nodejs.org 에서 LTS 버전을 수동 설치 후 다시 실행해주세요.
        goto :skip_npm
    )
) else (
    for /f "tokens=*" %%v in ('node --version 2^>nul') do echo       Node.js %%v 감지됨
)

:: Node 패키지 설치
echo [4/5] Frontend 패키지 설치 중...
cd frontend
call npm install
cd ..
echo       npm install 완료

:skip_npm

echo.
echo [5/5] 설정 완료!
echo ============================================
echo   수동 복사 필요 파일 (Git 미포함):
echo     - lge.auto-*.whl  (없으면 위 경고 참고)
echo     - CANatTransportProcDll.dll
echo     - server.exe
echo ============================================
pause
