@echo off
rem Start the Remilia desktop pet. Double-click this file to launch.
set "ELECTRON_RUN_AS_NODE="
cd /d "E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet"
start "" "node_modules\electron\dist\electron.exe" .
