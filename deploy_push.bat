@echo off
:: deploy_push.bat — 개인 깃에서 pull 후 회사 배포 repo에 push
cd /d "%~dp0\dist\ReplayKit"

echo === 개인 깃에서 최신 빌드 pull ===
git pull origin main
if %ERRORLEVEL% neq 0 (
    echo [ERROR] pull 실패
    pause
    exit /b 1
)

echo.
echo === 회사 배포 repo에 push ===
git push deploy main
if %ERRORLEVEL% neq 0 (
    echo [ERROR] push 실패 — VPN 연결을 확인하세요
    pause
    exit /b 1
)

echo.
echo === 완료 ===
pause
