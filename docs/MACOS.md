# nerd on macOS (Apple silicon)

**Status: never run on a real Mac.** Both Mac paths below were checked only on
Linux: the agent's image without CUDA, the agent talking to a model server
outside its container through `host.docker.internal`, `./UP`, `./STATUS`,
`./DOWN`; the MLX server on Linux's CPU build of mlx (tool calls, streaming).
Not checked anywhere: the Metal build of llama-server finishing on a Mac, the
model's speed and memory on a Mac, MLX on Metal. One report from a Mac so far
(a compiler error, fixed: [troubleshooting](#troubleshooting)). If you try it,
please send back what [the end of this page](#what-to-send-back) lists, whether
it worked or not.

## Which way: llama-server or MLX

Docker on macOS runs containers in a Linux VM with no access to the Mac's GPU,
so the model runs on the Mac itself and the agent stays in its container.
There are two servers for the model; `./UP` picks the first unless `.env`
says otherwise.

| | llama-server, Metal (`NERD_LLAMA=host`, the default) | MLX (`NERD_LLAMA=mlx`) |
|---|---|---|
| what runs | PrismML's llama.cpp fork, built on the Mac (same tag as the Linux image) | mlx-vlm's server in a Python venv, nothing to compile |
| the model | the same GGUF as on Linux, 5.95 GB | the same weights in MLX 2-bit, 8.6 GB |
| memory | 16 GB works (tight), 24 GB+ comfortable | 24 GB+ recommended; 16 GB only with `NERD_CTX=32768`, if at all |
| speed | not measured on a Mac | PrismML's figure: about 47 tokens/s on an M5 Max; not measured here |
| needs | Command Line Tools, Homebrew `bash` and `cmake` | Homebrew `bash`, Python 3.12 or 3.13, macOS 14+ |
| what is proven | the same server and model file run every tested Linux setup | the loader and tool calls, on Linux's CPU mlx only |

**Start with llama-server** (the default): it is the engine every tested
setup uses, with the same file, checksum and arguments, and it fits a 16 GB
Mac. Take MLX if your Mac has 24 GB or more and you want to try the faster
path, or if the llama-server build fails on your Mac.

```
macOS                                         Docker Desktop (Linux VM)
┌───────────────────────────────┐            ┌────────────────────────────────┐
│ llama-server (Metal) or       │ ◀── HTTP ─ │ nerd: the agent (Pi), sshd,    │
│ mlx-vlm's server, the model   │            │ headless browser, /workspace   │
│ 127.0.0.1:8080                │            │ ./UP  (image nerd:agent)       │
│ tools/llama-host.sh, mlx-host │            │                                │
└───────────────────────────────┘            └────────────────────────────────┘
                                                  ▲ ssh -p 2222 nerd@localhost
```

The agent runs whatever the model asks for **inside the container**, never on
the Mac.

## What the Mac needs

- **Apple silicon** (M1 or later). Intel Macs are not supported.
- **Memory** (unified: the model and its cache come out of RAM). macOS lets
  the GPU use about two thirds of it, about 10.7 GB of 16. llama-server with
  the default 64K context needs about 7.2 GiB of that, Docker's VM 4–6 GB more,
  macOS the rest. With 16 GB: give Docker Desktop 4–6 GB, close heavy apps; if
  memory pressure (Activity Monitor) turns yellow or red, `NERD_CTX=32768`
  (about 6.6 GiB). 32 GB and up: no concern. The Q2 variant (7.2 GB of
  weights) wants 24 GB or more. `tools/check-prerequisites.sh` prints the
  estimate for your settings.
- **Disk: about 15 GB** — the model 6 GB, the agent's image 1.5 GB, Docker's
  build cache and the llama.cpp build a few GB (MLX: about 12 GB for its model
  and venv instead of the llama.cpp build and the GGUF). The check's `disk`
  line may ask for 22 GB: that figure is for Linux, which also builds the CUDA
  server image.
- **macOS** recent enough for Docker Desktop (it supports the current release
  and the two before it); MLX's wheels need macOS 14 or later.
- **Docker Desktop** for Mac (Apple silicon build); it includes buildx and
  compose. Other runtimes that provide `host.docker.internal` (OrbStack) should
  work too; untested.
- **Command Line Tools and Homebrew:** `xcode-select --install`, then
  `brew install bash cmake`. Homebrew's `bash` is needed because macOS ships
  bash 3.2 and `./UP` / `./STATUS` / `./DOWN` use bash 4 features; it must be
  first in `PATH` (`which bash` → `/opt/homebrew/bin/bash`; Homebrew's
  installer tells you the `brew shellenv` line to add).
- An ssh key: `ls ~/.ssh/id_ed25519.pub`, or `ssh-keygen -t ed25519`.

## Quick start (llama-server, the default)

```sh
xcode-select --install                  # once; skip if already installed
brew install bash cmake                 # open a new terminal after it: which bash
# Docker Desktop: install, start it, Settings → Resources → Memory 4–6 GB

git clone --depth=1 https://github.com/zhukilab/nerd && cd nerd

tools/check-prerequisites.sh            # OK / WARN / MISSING per line, with a hint
tools/llama-host.sh check               # seconds: can this Mac's compiler build C++?
./UP                                    # first time: two builds and a 6 GB download (below)
ssh -p 2222 nerd@localhost
```

`.env` is optional (`cp env.example .env`, then edit the lines you need;
for a name set twice the last line wins).
With 16 GB, set `NERD_CTX=32768` there if memory gets tight.

What the first `./UP` does, in order: clones the llama.cpp fork into `~/.nerd`
and builds llama-server with Metal (a few minutes); downloads the model (5.95
GB, resumable) and checks its sha256; starts llama-server on
`127.0.0.1:8080` and waits until it answers; builds the image `nerd:agent`
(5-10 min); starts the agent's container; waits until Pi runs; prints how to
connect. A second `./UP` takes seconds.

You are now in Pi's terminal in the container, in `/workspace`. Give it a task;
it asks its questions and shows a plan first, then works. Detach with
`Ctrl-b d`; it keeps working. Talking to it, the settings, what it builds:
[OPERATE.md](OPERATE.md). What the agent serves on port 8000 opens at
`http://localhost:8000` on the Mac.

## Check that it works

1. `./STATUS`: every line `OK` or `INFO`, exit code 0.
   `tools/llama-host.sh status` names the model it serves.
2. `ssh -p 2222 nerd@localhost` shows Pi's screen.
3. A first task: *create hello.html with the text hi and serve it on port 8000*.
   The first answer should be sensible text with the agent's questions or "none"
   and a numbered plan (garbage there means a broken model build: send the
   log). Answer "your call"; when it is done, `http://localhost:8000/hello.html`
   opens on the Mac.

## What to send back

Whether it worked or not — this is the first run on a Mac, so all of it helps.
**The short way:** `tools/report.sh` packs items 1–5 below into one archive
(`var/report/nerd-report-<time>.tar.gz`, tokens in `.env` masked, the list of
files printed); send that file plus items 6 and 7 in words. By hand:

1. the log files: `./UP` and the host scripts write everything they print to
   `var/log/<command>-<time>.log` in the repository (`up-…`, `llama-host-…`,
   `mlx-host-…`) and name the file at the start and the end; send the ones from
   your attempt, no need to copy the terminal;
2. if the server failed: `~/.nerd/llama-server.log` and `~/.nerd/cmake.log`
   (MLX: `~/.nerd/mlx-server.log`, `~/.nerd/mlx-install.log`);
3. if the agent failed: `docker logs nerd > agent.log 2>&1`;
4. the output of `tools/check-prerequisites.sh` and `./STATUS`;
5. Mac model, chip, RAM, macOS version (MLX: `python3 --version` too);
6. speed and memory while the agent works: a few `prompt eval time` /
   `eval time` lines from `~/.nerd/llama-server.log` (MLX: the request lines of
   `~/.nerd/mlx-server.log`), and memory pressure in Activity Monitor;
7. whether the agent finished the small task above.

## Day to day

| | |
|---|---|
| state of both | `./STATUS` (and `tools/llama-host.sh status`) |
| stop | `./DOWN`: the agent's container and the server, the GPU and memory are free (`./DOWN --agent`: only the agent, the model stays loaded) |
| start again (after a reboot too) | `./UP`: the server on the Mac does not start by itself after a reboot; the agent's container does (Docker Desktop must be running) and waits for the server |
| another variant or context | edit `.env`, `./UP`: it restarts a server running with other settings |
| the server's log | `tools/llama-host.sh logs` (Ctrl-C ends the view, not the server) |
| update | `git pull`, `./UP --build` (llama-server is rebuilt only if the pinned tag changed) |
| something is off after an update | `./UP --rebuild`: the agent's image without docker's cache, llama-server from a fresh clone (or the MLX venv made again), the server restarted |
| remove | `./DOWN --purge-models` (containers, volumes), `rm -rf ~/.nerd` (the server, model, venv), `docker image rm nerd:agent`, and the repository |

The agent's container has a restart policy; started before the server, it
waits for it without a time limit (`./STATUS`: llama `WAIT`).

## Troubleshooting

- **`./UP`: "llama-server exited during startup"** — the last lines of its log
  are printed. Out of memory (`failed to allocate`, `Metal` buffer errors):
  `NERD_CTX=32768` in `.env`, close other apps, give Docker less.
- **`./STATUS`: llama DOWN "answers on the host … but not from the container"** —
  the container cannot reach the server on the Mac's loopback. Docker Desktop
  normally forwards `host.docker.internal` to it. If yours does not, let the server
  listen on all interfaces: `NERD_LLAMA_HOST=0.0.0.0` in `.env`, then `./UP`
  (it restarts the server with the new address). That also exposes it to
  your network: keep the macOS firewall on.
- **`syntax error`, `bad substitution` or `declare: -A: invalid option` from
  `./UP`** — it ran under macOS's bash 3.2: `brew install bash`, open a new
  terminal, `which bash`.
- **`tools/check-prerequisites.sh`: docker "daemon not reachable"** — start
  Docker Desktop (the hint printed there, `systemctl`, is for Linux).
- **`fatal error: 'cstddef' file not found`** (or `'array'`, `'mutex'`, … — the
  C++ standard headers; the first report from a Mac) — the compiler finds no
  macOS SDK. The script builds with Apple's clang and SDK through `xcrun` and
  checks that first (`tools/llama-host.sh check`). If the check still fails:
  `which -a c++ clang++` — a Homebrew llvm/gcc or conda compiler first in
  `PATH` is the usual cause; if it is Apple's, the Command Line Tools are
  broken (often after a macOS update):
  `sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install`.
- **The build fails in cmake** otherwise — the last 30 lines are shown, the
  whole output is in the log (`var/log/llama-host-…log`) and in
  `~/.nerd/cmake.log`; `xcode-select --install`, `brew install cmake`.
- **Slow** — not measured on any Mac yet. llama-server's log prints the speed
  of each request (`prompt eval time … tokens per second`, `eval time …`).

## MLX instead of llama-server (`NERD_LLAMA=mlx`)

Apple's own format and framework, MLX, in place of the llama.cpp build:
nothing to compile. The same model in a different packing
([prism-ml/Ternary-Bonsai-2-27B-mlx-2bit](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-mlx-2bit),
8.6 GB, the 2-bit MLX form of the same ternary weights, its vision part
included) served by mlx-vlm's OpenAI-compatible server; the agent and its
container stay as they are.

What it does: `tools/mlx-host.sh` makes a Python venv in `~/.nerd/mlx-venv`
with mlx 0.32.2, mlx-vlm 0.7.2 and transformers 5.14.1 (the set PrismML tests
this model with; every package pinned by sha256, wheels only:
`tools/mlx-requirements.txt`), downloads the model at a pinned revision into
`~/.nerd/mlx-models/` and checks every file against the pack's `files.json`,
then runs `python -m mlx_vlm.server` on `127.0.0.1:8080`. Bonsai 2's pack
needs mlx-vlm's own loader for it; the script checks that it is there. The
server has no context limit of its own: the agent is told `NERD_CTX` and
compacts by it. Memory use at a given context is not measured; the check's
estimate (9.5 GB plus the cache) is a guess.

Needs, besides the list above: **Python 3.12 or 3.13** (`brew install
python@3.13`; the system's `python3` is too old), **macOS 14 or later**,
**about 12 GB of disk**, **24 GB of RAM or more** recommended. On 16 GB the
check reports memory MISSING at the default 64K context; with
`NERD_CTX=32768` it fits the estimate, barely.

```sh
brew install bash python@3.13           # no cmake needed for this path
cp env.example .env                     # then set the line NERD_LLAMA=mlx (edit it, do not add a second)
tools/check-prerequisites.sh            # python, memory: OK / MISSING
./UP                                    # first time: the venv, the model (8.6 GB),
                                        # loading it (a minute or two); then the agent as above
tools/mlx-host.sh status                # the model it serves
ssh -p 2222 nerd@localhost
```

Then the same [check](#check-that-it-works) and the same
[report](#what-to-send-back); `var/log/mlx-host-*.log` is the server's part.

To try the whole path quickly with a small model first (it is too weak for real
work): `NERD_MLX_MODEL=mlx-community/Qwen3.5-2B-4bit` in `.env`, `./UP`; back to
Bonsai 2: empty the line again, `./UP` (the server restarts with the other model).

| | |
|---|---|
| the server's log | `tools/mlx-host.sh logs`; the venv's install log `~/.nerd/mlx-install.log` |
| another model | `NERD_MLX_MODEL=<owner>/<repo>[@<revision>]` (Hugging Face) or a directory |
| sampling | `NERD_SAMPLING` in `.env` (default for mlx: the model card's non-thinking values, `temperature=0.7,top_p=0.8,top_k=20,presence_penalty=1.5`) |
| back to llama-server | `NERD_LLAMA=host` (or `auto`), `./UP` |
| MLX trouble | `pip install failed`: no wheel for this macOS or Python (macOS 14+, Python 3.12/3.13); a garbled first answer: the model loaded without its own loader, send `~/.nerd/mlx-server.log` |
