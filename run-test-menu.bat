@echo off
rem Test launcher: idle pose, no window movement, auto-open the right-click menu.
set "ELECTRON_RUN_AS_NODE="
set "PET_NO_MOVE=1"
set "PET_FORCE_STATE=idle"
set "PET_TEST_MENU=1"
cd /d "E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet"
"node_modules\electron\dist\electron.exe" .
