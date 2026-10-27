@echo off
rem Create the WSL distribution "nerd" and set nerd up in it, in one run.
rem A single file: download it alone from the repository and run it.
rem
rem   create_nerd_wsl.cmd [--location <folder>] [--repo <git url>] [--branch <name>]
rem
rem   --location  where the distribution's disk goes (default: WSL's own place)
rem   --repo, --branch  what to clone (default: the public nerd, main)
rem
rem Needs: Windows 10/11 with WSL2 (wsl --install --no-distribution, as
rem administrator, once), the NVIDIA driver on Windows (WSL2 gets the GPU and
rem CUDA from it; nothing NVIDIA is installed in the distribution but the
rem container toolkit), about 30 GB free for the distribution.
rem
rem What it does (each step is skipped when done, so running it again is safe):
rem  1. installs Debian as the distribution "nerd" (wsl --install Debian --name nerd);
rem  2. inside it, as root: /etc/wsl.conf with systemd on, no Windows programs
rem     (interop off) and no Windows PATH, hostname nerd, default user nerd;
rem     user nerd with sudo without a password (/etc/sudoers.d/nerd); git, ssh;
rem  3. restarts that distribution only (wsl --terminate nerd; never
rem     wsl --shutdown, which would stop every distribution);
rem  4. as nerd: a shallow clone into ~/nerd, an ssh key, then
rem     tools/install-prerequisites.sh --yes (Docker Engine, NVIDIA Container
rem     Toolkit), tools/check-prerequisites.sh and ./UP (builds the images,
rem     downloads the model: the first time takes a while).
rem Then run_nerd.cmd, which it puts next to itself, opens the agent.
setlocal EnableExtensions
set "NAME=nerd"
set "REPO=https://github.com/zhukilab/nerd.git"
set "BRANCH=main"
set "LOCATION="
set "SETUP="
rem Started by a double click: keep the window open at the end to be read.
set "PAUSE="
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && set "PAUSE=1"

:args
if "%~1"=="" goto args_done
if /i "%~1"=="--location" (
  if "%~2"=="" goto usage
  set "LOCATION=%~f2"
  shift & shift & goto args
)
if /i "%~1"=="--repo" (
  if "%~2"=="" goto usage
  set "REPO=%~2"
  shift & shift & goto args
)
if /i "%~1"=="--branch" (
  if "%~2"=="" goto usage
  set "BRANCH=%~2"
  shift & shift & goto args
)
goto usage
:args_done

where wsl >nul 2>&1 || (
  echo WSL is not installed. As administrator: wsl --install --no-distribution, reboot, then run this again.
  goto fail
)
wsl --version >nul 2>&1 || (
  echo This WSL is too old for named distributions. Run: wsl --update, then run this again.
  goto fail
)

rem The setup steps are the shell script at the end of this file.
set "SETUP=nerd-wsl-setup-%RANDOM%.sh"
set "START="
for /f "delims=:" %%a in ('findstr /n /b /c:":__NERD_SETUP__" "%~f0"') do set "START=%%a"
if not defined START ( echo The setup script is missing from %~nx0. & goto fail )
more +%START% "%~f0" > "%TEMP%\%SETUP%"

echo == 1. Debian as the WSL distribution "%NAME%"
wsl -d %NAME% --exec true >nul 2>&1
if not errorlevel 1 (
  echo    already there
) else (
  if defined LOCATION (
    wsl --install Debian --name %NAME% --location "%LOCATION%" --no-launch
  ) else (
    wsl --install Debian --name %NAME% --no-launch
  )
  wsl -d %NAME% --exec true >nul 2>&1
  if errorlevel 1 ( echo FAILED: the distribution "%NAME%" was not created. & goto fail )
)

echo == 2. The system: wsl.conf, user nerd, sudo, git
call :step root system || goto fail

echo == 3. Restart of "%NAME%" only, for wsl.conf
wsl --terminate %NAME%
call :step root systemd || (
  echo systemd does not run in "%NAME%" after its restart. WSL's kernel may need a restart
  echo of its own: wsl --shutdown -- it stops EVERY distribution, so it is left to you.
  echo Then run this again.
  goto fail
)

echo == 4. nerd: the clone, the prerequisites, ./UP
call :step nerd clone || goto fail
rem Its last line is the check, which in this same session does not see the
rem docker group yet; the check below, in a new session, is the one that counts.
call :step nerd prereq
call :step nerd check || (
  echo Fix what the table says is MISSING, then run this again.
  goto fail
)
call :step nerd up || goto fail

echo.
rem run_nerd.cmd next to this file, from the clone (as committed, CRLF).
if not exist "%~dp0run_nerd.cmd" wsl -d %NAME% -u nerd --exec bash -c "cat ~/nerd/run_nerd.cmd" > "%~dp0run_nerd.cmd"
echo Done. Start working: "%~dp0run_nerd.cmd" (it starts nerd if needed and opens the agent).
set "RC=0"
goto out

:fail
set "RC=1"
goto out

:usage
echo usage: %~nx0 [--location ^<folder^>] [--repo ^<git url^>] [--branch ^<name^>]
set "RC=2"

:out
if defined SETUP if exist "%TEMP%\%SETUP%" del "%TEMP%\%SETUP%"
if defined PAUSE pause
exit /b %RC%

rem One step of the setup script, as the given user, in the distribution.
:step
wsl -d %NAME% -u %1 --cd "%TEMP%" --exec bash -c "sed 's/\r$//' '%SETUP%' | bash -s -- %2 '%REPO%' '%BRANCH%'"
exit /b %errorlevel%

:__NERD_SETUP__
# The setup inside the distribution, one step per call: <step> <repo> <branch>.
# Run by create_nerd_wsl.cmd (as root for system/systemd, as nerd for the rest).
set -uo pipefail
step=$1 repo=$2 branch=$3
case "$step" in
system)
  # WSL reads wsl.conf when the distribution starts: the restart comes next.
  cat > /etc/wsl.conf <<'CONF'
# Written by nerd's create_nerd_wsl.cmd.
[boot]
systemd = true

[interop]
enabled = false
appendWindowsPath = false

[network]
hostname = nerd

[user]
default = nerd
CONF
  # The user is made here, not by Debian's first-start dialog.
  if [ -f /etc/wsl-distribution.conf ]; then sed -i 's/^\([[:space:]]*command[[:space:]]*=\)/# \1/' /etc/wsl-distribution.conf; fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q && apt-get install -y -q sudo git ca-certificates curl openssh-client || exit 1
  id nerd >/dev/null 2>&1 || useradd -m -s /bin/bash nerd || exit 1
  echo 'nerd ALL = (ALL:ALL) NOPASSWD: SETENV: ALL' > /etc/sudoers.d/nerd.new
  chmod 0440 /etc/sudoers.d/nerd.new
  visudo -cqf /etc/sudoers.d/nerd.new && mv /etc/sudoers.d/nerd.new /etc/sudoers.d/nerd || exit 1
  echo "   wsl.conf written, user nerd with sudo, git and ssh installed"
  ;;
systemd)
  [ -d /run/systemd/system ] && echo "   systemd runs; hostname $(hostname)"
  ;;
clone)
  cd ~ || exit 1
  if [ -d nerd/.git ]; then
    echo "   ~/nerd is there: git pull"
    git -C nerd pull -q --ff-only || exit 1
  else
    git clone -q --depth 1 -b "$branch" "$repo" nerd || exit 1
    echo "   cloned $repo ($branch) into ~/nerd"
  fi
  [ -f ~/.ssh/id_ed25519 ] || { ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/id_ed25519 -C "nerd@$(hostname)" && echo "   ssh key made: ~/.ssh/id_ed25519 (run_nerd.cmd logs in with it)"; }
  ;;
prereq)
  cd ~/nerd && tools/install-prerequisites.sh --yes
  ;;
check)
  cd ~/nerd && tools/check-prerequisites.sh
  ;;
up)
  cd ~/nerd && ./UP
  ;;
*)
  echo "unknown step $step" >&2; exit 2
  ;;
esac
