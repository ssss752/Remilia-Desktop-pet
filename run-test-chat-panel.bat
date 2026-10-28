@echo off
rem Test launcher: open the chat window with the AI settings panel and capture the window itself.
set "ELECTRON_RUN_AS_NODE="
set "PET_NO_MOVE=1"
set "PET_FORCE_STATE=idle"
set "PET_OPEN_CHAT=1"
set "PET_CHAT_PANEL=1"
set "PET_CHAT_SHOT=E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet\_tmp\chat-panel.png"
cd /d "E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet"
"node_modules\electron\dist\electron.exe" .
