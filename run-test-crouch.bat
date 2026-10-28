@echo off
rem Verification launcher: force the landing-crouch state and grab a frame series.
rem Force fires at 1400ms and the crouch holds ~2200ms, so the rise-back-up
rem happens around 3.6s -- the series must extend past that to prove it works.
rem PET_PROFILE isolates this run's state/log from the instance the user is
rem running, PET_ALLOW_MULTI skips the single-instance lock.
rem Keep this file pure ASCII -- cmd decodes UTF-8 Chinese bytes as GBK and
rem swallows the following "set" lines (this bit us before).
set "ELECTRON_RUN_AS_NODE="
set "PET_ALLOW_MULTI=1"
set "PET_PROFILE=remilia-verify"
set "PET_FORCE_STATE=crouch"
set "PET_SHOT=E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet\_tmp\crouch.png"
set "PET_SHOT_DELAY=1700,2000,2600,3400,3800,4200,5000"
cd /d "E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet"
"node_modules\electron\dist\electron.exe" .
