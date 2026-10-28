@echo off
rem Diagnostic launcher: idle pose, no movement, synthetic click injected from main process.
set "ELECTRON_RUN_AS_NODE="
set "PET_NO_MOVE=1"
set "PET_FORCE_STATE=idle"
set "PET_SYNTH_CLICK=1"
cd /d "E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet"
"node_modules\electron\dist\electron.exe" .
