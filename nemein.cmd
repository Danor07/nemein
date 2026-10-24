@echo off
"%~dp0desktop-resources\runtime\node.exe" "%~dp0src\cli.js" %*
exit /b %errorlevel%
