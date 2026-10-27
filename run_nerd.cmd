@echo off
rem Open nerd's agent: in the WSL distribution "nerd" (create_nerd_wsl.cmd makes
rem it), as user nerd, start nerd if it is not up (./UP) and log in to the agent's
rem terminal (Pi in tmux, over ssh to the agent's container).
rem
rem   run_nerd.cmd           the agent
rem   run_nerd.cmd --shell   a shell in the distribution instead, in ~/nerd
rem
rem Detach from the agent with Ctrl-b d: it keeps working while this window
rem stays open. WSL stops a distribution a few seconds after its last window
rem closes, and the agent with it; run_nerd.cmd again brings it back.
setlocal EnableExtensions
set "NAME=nerd"
wsl -d %NAME% --exec true >nul 2>&1 || (
  echo There is no WSL distribution "%NAME%": run create_nerd_wsl.cmd first.
  pause
  exit /b 1
)
if /i "%~1"=="--shell" (
  wsl -d %NAME% -u nerd --cd ~ --exec bash -c "cd ~/nerd 2>/dev/null; exec bash -l"
  exit /b %errorlevel%
)
if not "%~1"=="" ( echo usage: %~nx0 [--shell] & exit /b 2 )
wsl -d %NAME% -u nerd --cd ~ --exec bash -lc "if cd ~/nerd && { ./STATUS >/dev/null 2>&1 || ./UP; }; then ssh -t -p 2222 -o StrictHostKeyChecking=accept-new nerd@localhost; echo; read -r -p 'Detached. The agent works while this window is open; Enter closes it (the agent stops a few seconds later). ' _; else echo; read -r -p 'nerd did not start (see above). Enter closes this window. ' _; fi"
exit /b 0
