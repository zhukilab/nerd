# Headless Chromium for the acceptance check (criteria 7, 8, 9, 13).
# Build context: the acceptance/ directory.
ARG PW=1.63.0
FROM mcr.microsoft.com/playwright:v${PW}-noble
ARG PW
WORKDIR /acc
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright@${PW}
COPY lib/ lib/
COPY browser/browse.mjs browser/
