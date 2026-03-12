@echo off
chcp 65001 >nul
echo ============================================
echo   Recording Test - 동기화 및 실행
echo ============================================
echo.

cd /d "%~dp0"

:: Git pull
echo [1/3] 최신 코드 가져오는 중...
git pull origin main
if errorlevel 1 (
    echo       [오류] git pull 실패. 충돌을 확인해주세요.
    pause
    exit /b 1
)
echo.

:: 의존성 업데이트 (변경 시에만)
echo [2/3] 의존성 확인 중...
call venv\Scripts\activate.bat
pip install -r requirements.txt -q
cd frontend
call npm install --silent
cd ..
echo       의존성 업데이트 완료
echo.

:: 서버 관리 GUI 시작
echo [3/3] 서버 관리 GUI 시작 중...
echo ============================================
python server.py
