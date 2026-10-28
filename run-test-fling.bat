@echo off
rem Verification launcher: drop her from ~420px and let gravity do the work.
rem This exercises the real physics path (impact -> drop/fall -> crouch hold),
rem not a hand-placed crouch pose.
rem Keep this file pure ASCII -- cmd decodes UTF-8 Chinese bytes as GBK and
rem swallows the following "set" lines (this bit us before).
set "ELECTRON_RUN_AS_NODE="
set "PET_ALLOW_MULTI=1"
set "PET_FORCE_STATE=__fling"
set "PET_SHOT=E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet\_tmp\fling.png"
set "PET_SHOT_DELAY=1500,1700,2300,3000,4200,5200,6200"
cd /d "E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet"
"node_modules\electron\dist\electron.exe" .
