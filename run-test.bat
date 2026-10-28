@echo off
rem Test launcher: stable idle pose, no window movement (input diagnostics).
set "ELECTRON_RUN_AS_NODE="
set "PET_NO_MOVE=1"
set "PET_FORCE_STATE=idle"
cd /d "E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet"
"node_modules\electron\dist\electron.exe" .
