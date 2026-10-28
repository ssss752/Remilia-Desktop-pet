@echo off
rem Verification launcher: force the edge-peek action and grab window frames.
set "ELECTRON_RUN_AS_NODE="
set "PET_FORCE_STATE=peek"
set "PET_SHOT=E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet\_tmp\peek.png"
set "PET_SHOT_DELAY=1600,2400,3400,4600"
cd /d "E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet"
"node_modules\electron\dist\electron.exe" .
