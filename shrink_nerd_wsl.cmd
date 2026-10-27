@echo off
rem Give disk space back from the WSL distribution "nerd" (create_nerd_wsl.cmd
rem makes it): what further work does not need goes, then the distribution's
rem disk file (ext4.vhdx) is compacted so that Windows gets the space back.
rem
rem   shrink_nerd_wsl.cmd [--name <distribution>]
rem
rem What goes, inside the distribution: docker's build cache (the next
rem ./UP --build takes longer: it builds those layers again), images no tag
rem points to, apt's package cache. What stays: the model, the workspace, the
rem conversations, the images nerd runs. Then fstrim marks the freed blocks.
rem
rem It stops that distribution only (wsl --terminate; nerd's containers stop
rem with it, run_nerd.cmd starts them again) and compacts its disk with WSL's
rem own wsl --manage <distribution> --compact. An older WSL has no --compact:
rem then diskpart, as administrator and only while no other distribution runs
rem (otherwise wsl --update, and run this again).
setlocal EnableExtensions
set "NAME=nerd"
set "SELFNAME=%~nx0"
set "CL=%cmdcmdline:"=%"
set "PAUSE="
if /i not "%CL: /c =%"=="%CL%" set "PAUSE=1"
set "RC=1"
set "DP="

:args
if "%~1"=="" goto args_done
if /i "%~1"=="--name" if not "%~2"=="" ( set "NAME=%~2" & shift & shift & goto args )
echo usage: %SELFNAME% [--name ^<distribution^>]
set "RC=2"
goto out
:args_done

rem wsl.exe fails with negative codes, which "if errorlevel 1" misses: test with ||.
wsl -d %NAME% --exec true >nul 2>&1 || ( echo There is no WSL distribution "%NAME%". & goto out )

rem The disk file, from WSL's registry entry for the distribution.
set "VHD="
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "$d = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' | Get-ItemProperty | Where-Object DistributionName -eq '%NAME%' | Select-Object -First 1; if ($d) { Join-Path ($d.BasePath -replace '^\\\\\?\\','') $(if ($d.VhdFileName) { $d.VhdFileName } else { 'ext4.vhdx' }) }"`) do set "VHD=%%v"
if not defined VHD ( echo Cannot find the disk of "%NAME%" in WSL's registry. & goto out )
if not exist "%VHD%" ( echo The disk of "%NAME%" is not where WSL says: %VHD% & goto out )
call :size "%VHD%" BEFORE
echo == "%NAME%": its disk %VHD% is %BEFORE% GB

echo == 1. Inside: docker's build cache, untagged images, apt's cache; fstrim
rem No double quote inside the bash program: it would end cmd's quoted string.
wsl -d %NAME% -u root --exec bash -c "echo '   used before:' $(df -h --output=used / | tail -1); if command -v docker >/dev/null; then docker builder prune -af | tail -1 | sed 's/^/   build cache: /'; docker image prune -f | tail -1 | sed 's/^/   untagged images: /'; fi; apt-get clean; fstrim -v / | sed 's/^/   /'; echo '   used after:' $(df -h --output=used / | tail -1)" || ( echo FAILED inside "%NAME%". & goto out )

echo == 2. Stopping "%NAME%" only
wsl --terminate %NAME%

echo == 3. Compacting the disk
rem WSL's own compaction (a recent WSL) gets the disk even while WSL runs
rem another distribution; diskpart, for an older WSL, only when none runs.
wsl --manage %NAME% --compact && goto compacted
echo    wsl --manage --compact did not work here: trying diskpart
net session >nul 2>&1 || (
  echo    diskpart needs an administrator: run this file again as administrator
  echo    ^(right-click it, Run as administrator^), or update WSL: wsl --update.
  echo    Done so far: the clean-up inside.
  set "RC=0"
  goto out
)
set "DP=%TEMP%\nerd-shrink-%RANDOM%.txt"
> "%DP%" (
  echo select vdisk file="%VHD%"
  echo attach vdisk readonly
  echo compact vdisk
  echo detach vdisk
)
rem WSL lets go of the disk a moment after the distribution stops.
ping -n 6 127.0.0.1 >nul
diskpart /s "%DP%" | findstr /i /c:"percent" /c:"error" /c:"successfully compacted"
:compacted
call :size "%VHD%" AFTER
echo    %BEFORE% GB -^> %AFTER% GB
set "RC=0"

:out
if defined DP if exist "%DP%" del "%DP%"
echo.
if "%RC%"=="0" echo Done. run_nerd.cmd starts nerd again.
if defined PAUSE pause
exit /b %RC%

rem The size of file %1 in GB, into variable %2.
:size
for /f "usebackq delims=" %%s in (`powershell -NoProfile -Command "[math]::Round((Get-Item -LiteralPath '%~1').Length / 1GB, 1)"`) do set "%2=%%s"
exit /b 0
