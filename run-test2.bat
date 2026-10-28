@echo off
rem Test launcher: idle pose, window movement allowed (drag / flight verification).
set "ELECTRON_RUN_AS_NODE="
set "PET_FORCE_STATE=idle"
cd /d "E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet"
"node_modules\electron\dist\electron.exe" .
