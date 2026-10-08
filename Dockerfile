# nerd in two containers from one Dockerfile, two targets:
#   server  llama-server from PrismML's llama.cpp fork with CUDA, and Bonsai 2
#           (downloaded into the models volume on first start). The GPU is here.
#   agent   the agent (Pi), sshd and tmux for the conversation, a headless
#           browser, the tools for small projects. No CUDA, no GPU: it talks to
#           the server over HTTP (NERD_BASE_URL). The default target.
# ./UP builds both and runs them side by side (docs/ARCHITECTURE.md, "Why two
# containers"); on macOS the server runs on the Mac instead (docs/MACOS.md) and
# only the agent image is built.
#
# Build args pick the GPU, not the model (server only):
#   CUDA_ARCH     compute capability without the dot: 86 (RTX 30xx), 89 (RTX
#                 40xx), 121 (GB10, DGX Spark), or several separated by ';'.
#                 The fork's CMake turns 12X into 12Xa (Blackwell-specific code)
#   CUDA_VERSION  CUDA toolkit/runtime, 12.4.1; Blackwell needs 12.8 (sm_120)
#                 or 12.9 (sm_121), and the host driver must support the version
# The CPU architecture is the build machine's (or docker build --platform):
# every stage's base image and the Node tarball exist for amd64 and arm64.
# The model variant (q1 | q2) is chosen at run time: NERD_MODEL_VARIANT.
# Tested: x86_64 + sm_86 + CUDA 12.4.1, and aarch64 + sm_121 + CUDA 13.0.1.
#
#   docker build -t nerd:agent .
#   docker build -t nerd:server-sm86 --target server .                    # RTX 30xx
#   docker build -t nerd:server-sm89 --target server --build-arg CUDA_ARCH=89 .
#   docker build -t nerd:server-sm121 --target server --build-arg CUDA_ARCH=121 \
#       --build-arg CUDA_VERSION=13.0.1 .                                 # GB10, aarch64
#
# Stock llama.cpp must not be substituted: it rejects Bonsai 2's PTQ1_0/PQ2_0,
# or loads them silently and produces garbage. The fork's tag is pinned
# (tools/llama-host.sh builds the same tag on a Mac, reading it from here).

ARG CUDA_VERSION=12.4.1
# The server's Ubuntu is the one NVIDIA publishes CUDA images for; the agent's
# side (node, searxng, agent) is the current Ubuntu: on 22.04 its fd 8.3.1 did
# not know the --no-require-git that Pi's find passes, and every find failed
# (ticket 054).
ARG CUDA_UBUNTU_VERSION=22.04
ARG UBUNTU_VERSION=26.04

FROM nvidia/cuda:${CUDA_VERSION}-devel-ubuntu${CUDA_UBUNTU_VERSION} AS llama
ARG CUDA_ARCH=86
ARG LLAMA_REPO=https://github.com/PrismML-Eng/llama.cpp
ARG LLAMA_REF=prism-b10743-adfffbe
RUN apt-get update && apt-get install -y --no-install-recommends \
        git cmake ninja-build build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 -b "${LLAMA_REF}" "${LLAMA_REPO}" /src
# Static llama/ggml libraries: one binary that needs only the CUDA runtime
# libraries of the final image. GGML_NATIVE=OFF so the CPU code does not depend
# on the build machine's CPU.
RUN cmake -S /src -B /src/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCH}" \
        -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF -DLLAMA_CURL=OFF \
        -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
 && cmake --build /src/build -j "$(nproc)" --target llama-server \
 && install -D /src/build/bin/llama-server /out/llama-server \
 && git -C /src rev-parse HEAD > /out/llama-ref

# --- server ------------------------------------------------------------------
FROM nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu${CUDA_UBUNTU_VERSION} AS server
# curl for the model download and /health, tini as PID 1.
RUN apt-get update && apt-get install -y --no-install-recommends \
        tini libgomp1 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=llama /out/llama-server /opt/llama/llama-server
COPY --from=llama /out/llama-ref /opt/llama/REF
COPY container/entrypoint.sh container/model.sh /opt/nerd/
# Every library llama-server needs must be in the image, except the driver's
# libcuda, which the NVIDIA container runtime mounts at run time.
RUN ! ldd /opt/llama/llama-server | grep 'not found' | grep -v 'libcuda\.so'
# uid 1000 as in the agent image: the models volume of earlier versions is
# owned by it.
RUN useradd -m -u 1000 -s /bin/bash nerd \
 && mkdir -p /models /logs && chown nerd:nerd /models /logs
# 0.0.0.0: the agent is another container. ./UP publishes no port for it; with
# a shared network namespace (NERD_NETWORK=container:...) it passes 127.0.0.1.
ENV PATH=/opt/llama:$PATH NERD_MODEL_VARIANT=q1 NERD_HOST=0.0.0.0 LANG=C.UTF-8
USER nerd
VOLUME ["/models"]
EXPOSE 8080
ENTRYPOINT ["tini", "-g", "--", "/opt/nerd/entrypoint.sh"]
CMD ["serve"]

# --- agent -------------------------------------------------------------------
FROM ubuntu:${UBUNTU_VERSION} AS node
ARG NODE_VERSION=24.21.0
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates xz-utils \
 && rm -rf /var/lib/apt/lists/*
# The official binary tarball, checked against the release's SHASUMS256.txt.
RUN set -eu; \
    case "$(uname -m)" in x86_64) a=x64 ;; aarch64) a=arm64 ;; *) echo "no node for $(uname -m)"; exit 1 ;; esac; \
    f="node-v${NODE_VERSION}-linux-$a.tar.xz"; \
    cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/$f"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " $f\$" | sha256sum -c -; \
    mkdir -p /opt/node; tar -xJf "$f" -C /opt/node --strip-components=1; rm "$f"

# SearXNG for the agent's web_search (ticket 041; operator's permission to
# install it, 2026-10-04): a metasearch engine that runs in the agent's
# container on loopback and needs no cloud account or key. Source at a pinned
# commit, its Python requirements (pinned by SearXNG) in a venv; the agent
# image runs it with the same Ubuntu's python3 (SearXNG imports tomllib, 3.11+)
# and its built-in server: one user, so no uWSGI/granian.
FROM ubuntu:${UBUNTU_VERSION} AS searxng
ARG SEARXNG_REPO=https://github.com/searxng/searxng
ARG SEARXNG_REF=44b98e61024e27f625c69dfa27d47a79a4acfd50
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    git init -q /opt/searxng/src; cd /opt/searxng/src; \
    git fetch -q --depth 1 "${SEARXNG_REPO}" "${SEARXNG_REF}"; git checkout -q FETCH_HEAD; \
    git rev-parse HEAD > /opt/searxng/REF; rm -rf .git docs tests client; \
    python3 -m venv /opt/searxng/venv; \
    /opt/searxng/venv/bin/pip install -q --no-cache-dir -U pip; \
    /opt/searxng/venv/bin/pip install -q --no-cache-dir -r requirements.txt

# Linters the harness runs after every edit (process ticket 051): single
# binaries from their releases, pinned, each checked against its sha256.
FROM ubuntu:${UBUNTU_VERSION} AS linters
ARG TARGETARCH
ARG RUFF_VERSION=0.16.10
ARG RUFF_SHA_amd64=9567ff1201e2fb3da31ff04c35587d768c66d6cb42dfa84de474e2bfe360b608
ARG RUFF_SHA_arm64=dc0d74de837ef0a7bcc62ce98c48a622b075d057161f13b958be2934becd55a6
ARG BIOME_VERSION=2.5.15
ARG BIOME_SHA_amd64=5d867a0b2ccea1755b7e508b01d836a8c64e31a1e4d11ec24b43b6b4eec8b3b6
ARG BIOME_SHA_arm64=a56bcd73ddbfdb0f57a82bb67b7ea698eed4027aff602b95aa18fafe919d59e0
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; mkdir -p /out; cd /tmp; \
    case "${TARGETARCH}" in \
      amd64) t=x86_64-unknown-linux-gnu b=x64 rs=${RUFF_SHA_amd64} bs=${BIOME_SHA_amd64} ;; \
      arm64) t=aarch64-unknown-linux-gnu b=arm64 rs=${RUFF_SHA_arm64} bs=${BIOME_SHA_arm64} ;; \
      *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o ruff.tgz "https://github.com/astral-sh/ruff/releases/download/${RUFF_VERSION}/ruff-$t.tar.gz"; \
    echo "$rs  ruff.tgz" | sha256sum -c -; \
    tar -xzf ruff.tgz; install -m 755 "ruff-$t/ruff" /out/ruff; \
    curl -fsSL -o biome "https://github.com/biomejs/biome/releases/download/%40biomejs/biome%40${BIOME_VERSION}/biome-linux-$b"; \
    echo "$bs  biome" | sha256sum -c -; \
    install -m 755 biome /out/biome

FROM node AS agent-build
ENV PATH=/opt/node/bin:$PATH
WORKDIR /opt/nerd/agent
COPY agent/package.json agent/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY agent/src ./src

FROM ubuntu:${UBUNTU_VERSION} AS agent
# What the agent's bash tool is likely to need for small projects, and what
# the entrypoint uses (curl for /health, tini as PID 1), and for the tui mode
# sshd and tmux (ncurses-term has tmux-256color); Pi's TUI looks for fd and rg
# for file completion and would warn without them.
RUN apt-get update && apt-get install -y --no-install-recommends \
        tini curl ca-certificates git python3 procps less xz-utils \
        openssh-server tmux ncurses-term ripgrep fd-find \
        iproute2 tcpdump netcat-openbsd socat sudo \
        sqlite3 jq unzip zip file build-essential python3-venv python3-pip rsync dnsutils shellcheck \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/ssh/ssh_host_* \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd
# PAM reads /etc/environment for ssh sessions; the tui-mode sshd runs without
# PAM and sets the same in its own config, but a stock login gets it too.
# Without a UTF-8 LANG tmux draws borders as "qqqq" in PuTTY.
RUN printf '%s\n' 'LANG=C.UTF-8' 'LC_ALL=C.UTF-8' \
        'PATH="/home/nerd/.local/bin:/home/nerd/.cargo/bin:/home/nerd/go/bin:/home/nerd/.local/go/bin:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' \
        > /etc/environment \
 && mkdir -p /run/sshd
ENV LANG=C.UTF-8
COPY --from=node /opt/node /opt/node
# Headless Chromium for `browse` (container/browse.sh): the agent checks a web
# page the way the operator opens it, not only with curl (ticket 038). The
# headless shell, not full Chrome, and its system libraries and fonts from
# Playwright's own list; the revision is the one the agent's pinned
# playwright-core expects. Playwright builds it for linux x86_64 and arm64.
# Adds about 0.55 GB: the shell 266 MB, libraries and fonts 282 MB (CJK and
# Cyrillic included). A hand-picked library list would save ~150 MB (mesa,
# llvm, xvfb) but could break silently on the next Playwright version.
RUN --mount=type=bind,from=agent-build,source=/opt/nerd/agent/node_modules/playwright-core,target=/tmp/pw \
    PLAYWRIGHT_BROWSERS_PATH=/opt/nerd/browsers /opt/node/bin/node /tmp/pw/cli.js install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/*
COPY --from=agent-build /opt/nerd/agent /opt/nerd/agent
# The done gate (agent/src/done-gate.ts) finds the start command by the
# acceptance checker's own rule: one source, ../../acceptance from src/.
COPY acceptance/lib/parse.mjs acceptance/lib/parse.d.mts /opt/nerd/acceptance/lib/
COPY --from=searxng /opt/searxng /opt/searxng
COPY container/searxng.yml /opt/searxng/settings.yml
COPY container/entrypoint.sh container/model.sh container/ssh-login.sh container/sshd_config /opt/nerd/
COPY container/tmux.conf /etc/tmux.conf
# pkill/pgrep that refuse -f/--full: a full-command-line pattern also matches
# the agent's own shell, which then kills itself (container/pkill-guard.sh).
# /usr/local/bin is ahead of /usr/bin in every PATH the agent gets.
COPY --chmod=755 container/pkill-guard.sh /usr/local/bin/pkill
COPY --chmod=755 container/pkill-guard.sh /usr/local/bin/pgrep
COPY --chmod=755 container/test-pkill-guard.sh /opt/nerd/
COPY --chmod=755 container/browse.sh /usr/local/bin/browse
COPY --chmod=755 container/test-browse.sh /opt/nerd/
COPY --from=linters /out/ruff /out/biome /usr/local/bin/
# Languages and their packages live in the agent's home, a volume (decision
# 0012): nerd-get installs go, rust, uv there, pinned and checked.
COPY --chmod=755 container/nerd-get.sh /usr/local/bin/nerd-get
# The agent runs whatever the model asks for, so not as root. The mount points
# exist in the image, owned by nerd, so fresh named volumes inherit that owner.
# Password "*" instead of useradd's "!": no password can match, but the
# account is not "locked", which sshd without PAM would refuse even for a key.
# Ubuntu images since 24.04 ship a user "ubuntu" with uid 1000: it becomes nerd,
# without ubuntu's groups (adm and others). Root, when it is needed (tcpdump,
# apt-get install), is `sudo` without a password, from a sudoers file of its own
# (operator, 2026-10-08): the container is the boundary, not the user, and it
# runs without --privileged. NERD_SUDO=0 has the entrypoint drop that file.
RUN if id -u ubuntu >/dev/null 2>&1; then \
        usermod -l nerd -d /home/nerd -m -s /bin/bash ubuntu && groupmod -n nerd ubuntu; \
    else useradd -m -u 1000 -s /bin/bash nerd; fi \
 && usermod -G '' nerd \
 && [ "$(id -u nerd)" = 1000 ] && [ "$(id -G nerd)" = 1000 ] \
 && usermod -p '*' nerd \
 && printf '%s\n' 'nerd ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/nerd \
 && chmod 440 /etc/sudoers.d/nerd \
 && visudo -cqf /etc/sudoers.d/nerd \
 && mkdir -p /workspace /logs /ssh /home/nerd/.cache \
 && chown nerd:nerd /workspace /logs /ssh /home/nerd/.cache \
 && chmod 700 /ssh \
 && git config --system user.name "nerd agent" \
 && git config --system user.email nerd@localhost \
 && git config --system init.defaultBranch main \
 && git config --system --add safe.directory /workspace
# Above: a git identity for the agent's commits. Without one the first commit
# fails ("unable to auto-detect email address"), as it did in ticket 038; a
# repository's own config still overrides it. safe.directory: a /workspace
# bind-mounted from the host belongs to another uid there, and git refused it
# ("detected dubious ownership"), so the plan step could not commit PLAN.md
# (A/B of ticket 048, ticket 054).
# /home/nerd is a volume and /home/nerd/.cache another (compose.yaml): Docker
# fills a new volume from the image once, so nothing the image needs later is
# put in the home; tools are pointed at it here. Caches go to ~/.cache, which
# can be thrown away without losing what was installed.
ENV CARGO_HOME=/home/nerd/.cargo RUSTUP_HOME=/home/nerd/.rustup \
    GOPATH=/home/nerd/go GOMODCACHE=/home/nerd/.cache/go-mod GOCACHE=/home/nerd/.cache/go-build \
    UV_CACHE_DIR=/home/nerd/.cache/uv PIP_CACHE_DIR=/home/nerd/.cache/pip \
    npm_config_cache=/home/nerd/.cache/npm NPM_CONFIG_PREFIX=/home/nerd/.local
ENV PATH=/home/nerd/.local/bin:/home/nerd/.cargo/bin:/home/nerd/go/bin:/home/nerd/.local/go/bin:/opt/node/bin:$PATH
USER nerd
WORKDIR /workspace
# tui mode: 2222 ssh, 8000 the app the agent builds (defaults of NERD_SSH_PORT
# and NERD_APP_PORT).
EXPOSE 2222 8000
VOLUME ["/workspace", "/logs", "/ssh"]
ENTRYPOINT ["tini", "-g", "--", "/opt/nerd/entrypoint.sh"]
