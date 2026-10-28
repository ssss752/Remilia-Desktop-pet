@echo off
rem Verification launcher: idle pose + let her speak, and capture the bubble window itself.
rem NOTE: keep this file pure ASCII. cmd.exe reads .bat with the system ANSI code page
rem (GBK here), so UTF-8 Chinese text corrupts the parser and swallows the following
rem "set" lines - the env vars silently never reach Electron.
set "ELECTRON_RUN_AS_NODE="
set "PET_FORCE_STATE=idle"
set "PET_BUBBLE_SHOT=E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet\_tmp\bubble-self.png"
cd /d "E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet"
"node_modules\electron\dist\electron.exe" .
