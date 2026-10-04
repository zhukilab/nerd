#!/bin/sh
# browse <url> [--click TEXT] [--fill FIELD=VALUE] [--press KEY] [--wait MS]
#        [--shot FILE.png] [--width PX] [--text CHARS]
# Opens the page in headless Chromium like a user and prints HTTP status,
# Content-Type, requests, console errors, uncaught exceptions, failed requests
# and the visible text. Details: /opt/nerd/agent/src/browse.ts.
export PLAYWRIGHT_BROWSERS_PATH=/opt/nerd/browsers
exec /opt/node/bin/node /opt/nerd/agent/src/browse.ts "$@"
