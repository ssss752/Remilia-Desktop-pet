@echo off
rem Control experiment: same as run-test-say but WITHOUT setIgnoreMouseEvents on the
rem bubble window, to see whether WS_EX_LAYERED is what stops it from being composited.
set "ELECTRON_RUN_AS_NODE="
set "PET_FORCE_STATE=idle"
set "PET_BUBBLE_NO_IGNORE=1"
set "PET_BUBBLE_SHOT=E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet\_tmp\bubble-self-ni.png"
cd /d "E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet"
"node_modules\electron\dist\electron.exe" .
