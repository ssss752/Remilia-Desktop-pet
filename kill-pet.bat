@echo off
rem Kill leftover desktop-pet electron processes started by earlier verification
rem runs. WorkBuddy itself runs as WorkBuddy.exe, so this cannot touch it.
taskkill /F /IM electron.exe >nul 2>&1
exit /b 0
