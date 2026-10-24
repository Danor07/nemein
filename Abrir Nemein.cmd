@echo off
if exist "%~dp0src-tauri\target\release\nemein.exe" (
 start "" "%~dp0src-tauri\target\release\nemein.exe"
) else if exist "%~dp0src-tauri\target\github-release\release\nemein.exe" (
 start "" "%~dp0src-tauri\target\github-release\release\nemein.exe"
) else (
 echo Primero compila Nemein con npm run desktop:build.
 pause
)
