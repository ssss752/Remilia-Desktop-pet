@echo off
rem Test launcher: toggle the Windows login item and quit. Value in %1: on | off | query
set "ELECTRON_RUN_AS_NODE="
set "PET_LOGIN_TEST=%1"
set "PET_NO_MOVE=1"
cd /d "E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet"
"node_modules\electron\dist\electron.exe" .
