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
│ tools/llama-host.sh           │            │ ./UP  (image nerd:agent)       │
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

tools/check-prerequisites.sh            # OK / WARN / MISSING per line, with a hint
cp env.example .env                     # optional; NERD_CTX=32768 here if memory is tight

tools/llama-host.sh check               # seconds: can this Mac's compiler build C++?
./UP                                    # starts llama-server (tools/llama-host.sh start; first
                                        # time: clones and builds it with Metal, ~5 min, downloads
                                        # the model, 6 GB, checks its sha256), waits until it
                                        # answers; builds the image nerd:agent (first time
                                        # ~5-10 min), starts the agent's container, prints how to connect
ssh -p 2222 nerd@localhost
```

You are now in Pi's terminal in the container, in `/workspace`. Give it a task;
it asks its questions and shows a plan first, then works. Everything else —
how to talk to it, what the agent builds and where to open it, the settings — is
the same as on Linux: [OPERATE.md](OPERATE.md), [README](../README.md). What the
agent serves on port 8000 opens at `http://localhost:8000` on the Mac.

`tools/llama-host.sh` keeps everything under `~/.nerd` (`NERD_HOST_DIR`): the
llama.cpp source and build, `models/`, `llama-server.log`.

**Logs.** `./UP` and `tools/llama-host.sh check|build|fetch|start` write
everything they print to `var/log/<command>-<time>.log` in the repository as
well, and name the file at the start and at the end. If something fails, send
that file — no need to copy the terminal.

## Day to day

| | |
|---|---|
| state of both | `tools/llama-host.sh status` and `./STATUS` |
| stop | `./DOWN`: the agent's container and the server, the GPU and memory are free (`./DOWN --agent`: only the agent, the model stays loaded) |
| start again (after a reboot too) | `./UP` |
| another variant or context | edit `.env`, `./UP`: it restarts a server running with other settings |
| the server's log | `tools/llama-host.sh logs` (Ctrl-C ends the view, not the server) |
| update | `git pull`, `./DOWN`, `./UP --build` (llama-server is rebuilt only if the pinned tag changed) |
| remove | `./DOWN --purge`, `rm -rf ~/.nerd`, `docker image rm nerd:agent` |

The container has a restart policy; started before the server, it waits for it up
to 15 minutes and then stops with "no llama-server at …" (Docker restarts it).

## Troubleshooting

- **`./UP`: "llama-server exited during startup"** — the last
  lines of its log are printed. Out of memory (`failed to allocate`, `Metal`
  buffer errors): `NERD_CTX=32768` in `.env`, close other apps, give Docker less.
- **`./STATUS`: llama DOWN "answers on the host … but not from the container"** —
  the container cannot reach the server on the Mac's loopback. Docker Desktop
  normally forwards `host.docker.internal` to it. If yours does not, let the server
  listen on all interfaces: `NERD_LLAMA_HOST=0.0.0.0` in `.env`, then `./UP`
  (it restarts the server with the new address). That also exposes it to
  your network: keep the macOS firewall on.
- **`syntax error` or `bad substitution` from `./UP`** — it ran under macOS's
  bash 3.2: `brew install bash`, open a new terminal, `which bash`.
- **`fatal error: 'cstddef' file not found`** (or `'array'`, `'mutex'`, … — the
  C++ standard headers; the first report from a Mac) — the compiler finds no
  macOS SDK. Since 2026-10-05 the script builds with Apple's clang and SDK
  through `xcrun` and checks that first (`tools/llama-host.sh check`). If the
  check still fails: `which -a c++ clang++` — a Homebrew llvm/gcc or conda
  compiler first in `PATH` is the usual cause; if it is Apple's, the Command
  Line Tools are broken (often after a macOS update):
  `sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install`.
- **The build fails in cmake** otherwise — the last 30 lines are shown, the
  whole output is in the log (`var/log/llama-host-…log`) and in
  `~/.nerd/cmake.log`; `xcode-select --install`, `brew install cmake`.
- **Slow** — not measured on any Mac yet. llama-server's log prints the speed
  of each request (`prompt eval time … tokens per second`, `eval time …`).

## What to report

If you try it, these help most: the files in `var/log/`; Mac model, chip and
RAM; macOS version; whether `./UP` built and started llama-server; from
`~/.nerd/llama-server.log` a few `prompt eval time` / `eval time` lines during a
task; memory pressure in Activity Monitor while the agent works; whether the
agent finished a small task (a web page it serves on port 8000, say).

## MLX instead of llama-server (`NERD_LLAMA=mlx`)

**Status: new, never run on a Mac.** Apple's own format and framework, MLX, in
place of the llama.cpp build: nothing to compile, and PrismML's figures for
Bonsai 2 in MLX are about 47 tokens/s on an M5 Max. The same model in a
different packing ([prism-ml/Ternary-Bonsai-2-27B-mlx-2bit](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-mlx-2bit),
8.6 GB, the 2-bit MLX form of the same ternary weights) served by mlx-vlm's
OpenAI-compatible server; the agent and its container stay as they are.

What it does: `tools/mlx-host.sh` makes a Python venv in `~/.nerd/mlx-venv`
with mlx 0.32.2, mlx-vlm 0.7.2 and transformers 5.14.1 (the set PrismML tests
this model with; every package pinned by sha256, wheels only:
`tools/mlx-requirements.txt`), downloads the model at a pinned revision into
`~/.nerd/mlx-models/` and checks every file against the pack's `files.json`,
then runs `python -m mlx_vlm.server` on `127.0.0.1:8080`. Bonsai 2's pack
needs mlx-vlm's own loader for it; the script checks that it is there.

Needs, besides the list above: **Python 3.12 or 3.13** (`brew install
python@3.13`), **about 12 GB of disk** for the model and the venv, **24 GB of
RAM or more** recommended (the model is 8.6 GB, its vision part included, and
Docker's VM comes on top; 16 GB may work with `NERD_CTX=32768`).

```sh
echo NERD_LLAMA=mlx >> .env
tools/check-prerequisites.sh            # python, memory: OK / MISSING
./UP                                    # first time: the venv (~120 MB), the model (8.6 GB),
                                        # loading it (a minute or two); then the agent as above
tools/mlx-host.sh status                # the model it serves
ssh -p 2222 nerd@localhost
```

To try the whole path quickly with a small model first (it is too weak for real
work): `NERD_MLX_MODEL=mlx-community/Qwen3.5-2B-4bit` in `.env`, `./UP`; back to
Bonsai 2: remove the line, `./UP` (the server restarts with the other model).

| | |
|---|---|
| the server's log | `tools/mlx-host.sh logs`; the venv's install log `~/.nerd/mlx-install.log` |
| another model | `NERD_MLX_MODEL=<owner>/<repo>[@<revision>]` (Hugging Face) or a directory |
| sampling | `NERD_SAMPLING` in `.env` (default for mlx: the model card's non-thinking values, `temperature=0.7,top_p=0.8,top_k=20,presence_penalty=1.5`) |
| back to llama-server | `NERD_LLAMA=host` (or remove the line), `./UP` |

**What to send back** — this is the first run anywhere, so all of it helps:

1. `var/log/mlx-host-*.log` and `var/log/up-*.log`, or whatever failed and its last lines;
2. Mac model, chip, RAM, macOS version, `python3 --version`;
3. `tools/mlx-host.sh status`, and `./STATUS`;
4. speed: from `~/.nerd/mlx-server.log` the lines about a request while the agent
   works (prompt tokens, generation speed), and memory pressure in Activity Monitor;
5. whether the agent's first answer is sensible text with its questions and a plan
   (garbage there means the model loaded without its own loader — send the log);
6. whether it finishes a small task, e.g. "a web page with a counter, served on port 8000".
