# nerd on macOS (Apple silicon)

**Status: new and untested on a real Mac.** Everything here was checked on Linux
(aarch64): the image without CUDA, the agent talking to a llama-server outside its
container through `host.docker.internal`, `./UP`, `./STATUS`, `./DOWN`. The
Metal build of llama-server and its speed on a Mac were not. Reports welcome
(what to send: [at the end](#what-to-report)).

## How it runs on a Mac

Docker on macOS runs containers in a Linux VM that has no access to the Mac's
GPU, so the model cannot run in the container as it does on Linux with NVIDIA.
It runs on the Mac itself instead, built with Metal, and the agent stays in its
container:

```
macOS                                         Docker Desktop (Linux VM)
┌───────────────────────────────┐            ┌────────────────────────────────┐
│ llama-server (Metal, the GPU) │ ◀── HTTP ─ │ nerd: the agent (Pi), sshd,    │
│ Bonsai 2, 127.0.0.1:8080      │            │ headless browser, /workspace   │
│ tools/llama-host.sh           │            │ ./UP  (image nerd:host)        │
└───────────────────────────────┘            └────────────────────────────────┘
                                                  ▲ ssh -p 2222 nerd@localhost
```

The server is the same llama.cpp fork at the same pinned tag as the Linux image
(PrismML's fork has Metal kernels for Bonsai 2's PTQ1_0 and PQ2_0), the same model
file with the same checksum, the same arguments. The agent runs whatever the model
asks for **inside the container**, never on the Mac.

## What the Mac needs

- **Apple silicon** (M1 or later). Intel Macs are not supported.
- **Memory: 16 GB works, tightly.** macOS lets the GPU use about two thirds of
  RAM (about 10.7 GB of 16). The model with a 64K context needs about 7.3 GiB of
  it, Docker's VM 4–6 GB more, macOS the rest. With 16 GB: give Docker Desktop
  4–6 GB, close heavy apps; if memory pressure (Activity Monitor) turns yellow or
  red, use `NERD_CTX=32768` (about 6.6 GiB). 32 GB and up: no concern. The
  Q2 variant (7.2 GB of weights) wants 24 GB or more.
- **Disk: about 15 GB** — the model 6 GB, the image 1.5 GB, Docker's build cache
  and the llama.cpp build a few GB.
- **Docker Desktop** for Mac (Apple silicon build). Other runtimes that provide
  `host.docker.internal` (OrbStack) should work too; untested.
- **Command line tools and Homebrew:** `xcode-select --install`, then
  `brew install bash cmake`. The `bash` from Homebrew is needed because macOS
  ships bash 3.2 and `./UP` / `./STATUS` / `./DOWN` use bash 4 features; Homebrew's
  is first in `PATH` once Homebrew is set up (`which bash` →
  `/opt/homebrew/bin/bash`).
- An ssh key: `ls ~/.ssh/id_ed25519.pub`, or `ssh-keygen -t ed25519`.

## Install

```sh
xcode-select --install                  # once; skip if already installed
brew install bash cmake
# Docker Desktop: install, start it, Settings → Resources → Memory 4–6 GB

git clone https://github.com/zhukilab/nerd && cd nerd
git checkout m1                         # until the macOS support is merged into main

tools/check-prerequisites.sh            # OK / WARN / MISSING per line, with a hint
cp env.example .env                     # optional; NERD_CTX=32768 here if memory is tight

tools/llama-host.sh start               # first time: clones and builds llama-server with
                                        # Metal (~5 min), downloads the model (6 GB),
                                        # checks its sha256, starts it, waits until it answers
./UP                                    # first time: builds the image nerd:host (~5-10 min),
                                        # starts the agent's container, prints how to connect
ssh -p 2222 nerd@localhost
```

You are now in Pi's terminal in the container, in `/workspace`. Give it a task;
it asks its questions and shows a plan first, then works. Everything else —
how to talk to it, what the agent builds and where to open it, the settings — is
the same as on Linux: [OPERATE.md](OPERATE.md), [README](../README.md). What the
agent serves on port 8000 opens at `http://localhost:8000` on the Mac.

`tools/llama-host.sh` keeps everything under `~/.nerd` (`NERD_HOST_DIR`): the
llama.cpp source and build, `models/`, `llama-server.log`.

## Day to day

| | |
|---|---|
| state of both | `tools/llama-host.sh status` and `./STATUS` |
| stop | `./DOWN`, then `tools/llama-host.sh stop` (`./DOWN` does not stop the server) |
| start again (after a reboot too) | `tools/llama-host.sh start`, then `./UP` |
| the server's log | `tools/llama-host.sh logs` (Ctrl-C ends the view, not the server) |
| update | `git pull`, `tools/llama-host.sh stop && tools/llama-host.sh start` (rebuilds only if the pinned tag changed), `./UP --build` |
| remove | `./DOWN --purge`, `tools/llama-host.sh stop`, `rm -rf ~/.nerd`, `docker image rm nerd:host` |

The container has a restart policy; started before the server, it waits for it up
to 15 minutes and then stops with "no llama-server at …" (Docker restarts it).

## Troubleshooting

- **`./UP`: "no llama-server answers on 127.0.0.1:8080"** — start it first:
  `tools/llama-host.sh start`.
- **`tools/llama-host.sh start`: "llama-server exited during startup"** — the last
  lines of its log are printed. Out of memory (`failed to allocate`, `Metal`
  buffer errors): `NERD_CTX=32768` in `.env`, close other apps, give Docker less.
- **`./STATUS`: llama DOWN "answers on the host … but not from the container"** —
  the container cannot reach the server on the Mac's loopback. Docker Desktop
  normally forwards `host.docker.internal` to it. If yours does not, let the server
  listen on all interfaces: `NERD_LLAMA_HOST=0.0.0.0` in `.env`, then
  `tools/llama-host.sh stop && tools/llama-host.sh start`. That also exposes it to
  your network: keep the macOS firewall on.
- **`syntax error` or `bad substitution` from `./UP`** — it ran under macOS's
  bash 3.2: `brew install bash`, open a new terminal, `which bash`.
- **The build fails in cmake** — `xcode-select --install`, `brew install cmake`,
  then `tools/llama-host.sh build` to see the full output: remove `>/dev/null`
  from the two cmake lines in `tools/llama-host.sh` if needed.
- **Slow** — not measured on any Mac yet. llama-server's log prints the speed
  of each request (`prompt eval time … tokens per second`, `eval time …`).

## What to report

If you try it, these help most: Mac model, chip and RAM; macOS version; whether
`tools/llama-host.sh start` built and started (and the error if not); from
`~/.nerd/llama-server.log` a few `prompt eval time` / `eval time` lines during a
task; memory pressure in Activity Monitor while the agent works; whether the
agent finished a small task (a web page it serves on port 8000, say).
