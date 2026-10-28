@echo off
rem Verification launcher: force the wing-flight action and grab frames while she climbs.
set "ELECTRON_RUN_AS_NODE="
set "PET_FORCE_STATE=float"
set "PET_SHOT=E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet\_tmp\fly.png"
set "PET_SHOT_DELAY=2200,2450,2700,2950,3200"
cd /d "E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet"
"node_modules\electron\dist\electron.exe" .
