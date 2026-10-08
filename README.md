# nerd

A long-running coding agent on a local model. You give it a task over ssh, it
asks what it needs to know, writes a plan, and works for hours on your own GPU:
no cloud, no API key, nothing leaves the machine except the model download.

- **Model:** Bonsai 2 27B (PrismML), a ternary GGUF of 6-7 GB that fits an
  8 GB card with a 64K context, served by llama-server from PrismML's
  llama.cpp fork (stock llama.cpp cannot run it).
- **Agent:** [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
  with a harness of its own in [`agent/`](agent/): a questions-and-plan step
  before code, a loop guard, a bash timeout, a headless browser to check web
  pages, an optional verifier that picks the best of several candidate steps.
- **Two containers:** the model server (with the GPU) and the agent (with an
  ssh server), from one Dockerfile. The agent runs every command inside its
  own container, which is its sandbox; it reaches the server only over HTTP.
  `./UP` starts both.

## Quick start

On a Linux machine (or Windows with WSL2: [docs/INSTALL.md](docs/INSTALL.md#windows-wsl2))
with an NVIDIA GPU of 8 GB or more. A Mac with Apple silicon and 16 GB or
more has its own short path, never run on a real Mac yet:
[docs/MACOS.md](docs/MACOS.md). Without a GPU nerd does not run.

```sh
git clone --depth=1 https://github.com/zhukilab/nerd && cd nerd
tools/check-prerequisites.sh      # one table: what is OK, what is MISSING and how to fix it
./UP                              # build the images for your GPU, fetch the model, start
```

If the check reports anything MISSING, `tools/install-prerequisites.sh` prints
what it would install on Ubuntu or Debian (Docker Engine, NVIDIA Container
Toolkit) and `--yes` does it; the NVIDIA driver you install yourself. The
first `./UP` builds two images (5-15 minutes) and downloads the model (6 GB).
It ends by printing how to connect:

```sh
ssh -p 2222 nerd@<this machine>   # the agent's terminal (Pi); detach with Ctrl-b d
```

Type the task. What the agent builds for a browser is served on port 8000.
`./STATUS` says whether everything is up, `./DOWN` stops it (keeping the
workspace and the conversation). Settings (ports, key, model variant, context,
the address you open the app at) go in `.env`: `cp env.example .env`. How to
check it works and what to look at when it does not:
[docs/INSTALL.md](docs/INSTALL.md#check-that-it-works).

## Documentation

| | |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | platforms (x86_64 + NVIDIA, WSL2, aarch64 GB10), VRAM/disk/RAM per model variant, prerequisites |
| [docs/MACOS.md](docs/MACOS.md) | macOS on Apple silicon: the model on the Mac (llama-server with Metal, or MLX), the agent in its container — never run on a real Mac yet; what to send back |
| [docs/OPERATE.md](docs/OPERATE.md) | `./UP` `./DOWN` `./STATUS`, `.env`, connecting, keys, ports, the operator address, PuTTY, headless runs |
| [docs/MAINTAIN.md](docs/MAINTAIN.md) | updating the model, Pi, the llama.cpp fork, Node; rebuilding; troubleshooting |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | what runs where and why |
| [AGENTS.md](AGENTS.md) | for an agent (or a person) maintaining this repository |

The rest of this file describes how the agent behaves and how to run the
containers by hand.

## Running the containers by hand

`./UP` does this for you, through docker compose (`compose.yaml`, with the
volumes for the agent's home and caches and `/tmp` as a tmpfs; docs/OPERATE.md);
by hand it comes down to the commands below. Two images from one
Dockerfile: the server (built once per GPU architecture; `CUDA_ARCH` is the
compute capability without the dot) and the agent (no CUDA, the same
everywhere):

```sh
docker build -t nerd:agent .
docker build -t nerd:server --target server .                                       # sm_86, RTX 30xx
docker build -t nerd:server --target server --build-arg CUDA_ARCH=89 .              # RTX 40xx
docker build -t nerd:server --target server --build-arg CUDA_ARCH=121 \
    --build-arg CUDA_VERSION=13.0.1 .                                               # GB10 (DGX Spark), aarch64
```

The model is not in the image: on first start the server downloads it from
Hugging Face into the models volume (resumable, checked against a pinned size
and sha256) and reuses it after that. The server and the agent share a docker
network, where the agent finds the server by its container name:

```sh
docker network create nerd-net
docker run -d --name nerd-llm --network nerd-net --gpus all -v nerd-models:/models nerd:server
docker run --rm --network nerd-net -e NERD_BASE_URL=http://nerd-llm:8080/v1 \
    -v "$PWD/work":/workspace nerd:agent "<task>"                        # one task, headless
```

Where the NVIDIA toolkit provides a CDI spec (`nvidia-ctk cdi list` shows
`nvidia.com/gpu=all`) and docker has no `nvidia` runtime, pass
`--device nvidia.com/gpu=all` instead of `--gpus all`. `docker logs -f nerd-llm`
shows the download and the server; the agent waits for it (a headless task up
to 15 minutes, `NERD_HEALTH_TIMEOUT`).

The agent works in `/workspace` and runs every command the model asks for
inside its container. It runs as uid 1000, so a bind-mounted workspace (or
`/logs`) must be writable by that uid, or pass `--user "$(id -u):$(id -g)"`.
Named volumes need nothing. The agent's event log goes to `/logs` (mount it to
keep it). The exit code is the agent's: 0 when it finished with a final
answer, 1 otherwise.

Server modes: `serve` (the default) downloads the model if needed and runs
llama-server in the foreground, on `0.0.0.0:8080` of its network (publish
`-p 127.0.0.1:8080:8080` to reach it from the host); `fetch` only downloads and
checks the model. Agent modes: `"<task>"` headless, `tui` the conversation,
below. Build times, image sizes and measured speeds are in
[docs/INSTALL.md](docs/INSTALL.md).

### Talking to the agent: `tui`

`tui` runs Pi's own interactive terminal UI in a tmux session inside the
agent's container and an ssh server to reach it. You give the task, answer the
agent's questions, and drop remarks while it works; Enter during a run queues
the text as a steering message, delivered after the current step.

```sh
docker run -d --name nerd --network nerd-net -p 2222:2222 -p 8000:8000 \
  -e NERD_BASE_URL=http://nerd-llm:8080/v1 \
  -e NERD_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
  -v nerd-ws:/workspace -v nerd-ssh:/ssh -v nerd-logs:/logs \
  nerd:agent tui
ssh -p 2222 nerd@localhost          # attaches to Pi; detach with Ctrl-b d
```

- **Ports.** `2222` is ssh. `8000` (`NERD_APP_PORT`) is for what the agent
  builds: it is told to serve anything meant for a browser on
  `0.0.0.0:8000`, so `http://localhost:8000` opens it. Instead of `-p 8000:8000`,
  `ssh -L 8000:127.0.0.1:8000 -p 2222 nerd@host` reaches it too. Inside the
  containers the ports come from the environment: `NERD_SSH_PORT` (2222),
  `NERD_LLAMA_PORT` (8080, llama-server's; the agent follows `NERD_BASE_URL`)
  and `NERD_APP_PORT` (8000); containers that share one network namespace
  (`--network container:…`, `--network host`) need different values, and
  there the server should listen on loopback only (`-e NERD_HOST=127.0.0.1`).
- **The address the operator opens.** From inside its container the agent
  cannot learn the name under which you reach the machine (a tailnet name, a
  forwarded port). Set `NERD_OPERATOR_URL`, e.g.
  `-e NERD_OPERATOR_URL=http://myhost:8000`, and the agent is told as a fact
  that the operator reaches the app at that address; without it the agent is
  told only the port.
- **Keys.** Login is by public key only, as user `nerd` (no password, no
  root). The keys come from `NERD_AUTHORIZED_KEYS` (one or more lines) or from a
  file mounted at `/run/nerd/authorized_keys`; without either the container
  refuses to start. Host keys are generated on first start into the `/ssh`
  volume, so the fingerprint survives a new container; `docker logs` prints it.
- **Terminal.** The session runs with `LANG=C.UTF-8` (also in
  `/etc/environment`); without a UTF-8 locale tmux draws borders as `qqqq` in
  PuTTY. In PuTTY: Connection → Data → Terminal-type `xterm`, Window →
  Translation → UTF-8, key in Connection → SSH → Auth → Credentials.
- **Sessions.** Conversations are stored in `/logs/sessions`. If Pi exits
  (`/quit`, a crash) it starts again with `--continue`, and a new container on
  the same `/logs` continues the last conversation too. Processes the agent
  started (a web server) do not survive a new container.
- `ssh -p 2222 nerd@host <command>` runs the command instead of attaching, e.g.
  `tmux capture-pane -p -t nerd` to read the screen.

What the headless run has, the TUI has too ([`agent/src/extension.ts`](agent/src/extension.ts),
loaded by [`agent/src/tui.ts`](agent/src/tui.ts); shared setup in
[`agent/src/local.ts`](agent/src/local.ts)): the local model with the same
settings (`NERD_THINKING`, context from the server, compaction sized to the
window), the verifier with `NERD_VERIFY_N` > 1 (a step then appears only after
its candidates are drawn and judged), and the specification check as the
command `/spec-check [task]` (the task defaults to the first message of the
conversation; there is no single "done" in a conversation to trigger it).

Two traps of the agent's shell are closed by mechanism, in both modes. A bash
call the model gives no timeout gets `NERD_BASH_TIMEOUT` seconds (600,
[`agent/src/bash-tool.ts`](agent/src/bash-tool.ts)); a server started in the
foreground is then killed, and the model is told to start it detached with its
output in a file. And `pkill`/`pgrep` in the image refuse `-f`/`--full`
([`container/pkill-guard.sh`](container/pkill-guard.sh)): a full-command-line
pattern also matches the shell that runs it, which then kills itself; the
refusal suggests `-x`, a pid file or `$!` instead.

**Questions and a plan before work; a guard against loops** (both modes,
[`agent/src/harness.ts`](agent/src/harness.ts)). Asked by prompt to raise open
questions before coding, the model never did, so the first turn of a new task
is a step of its own ([`agent/src/plan-step.ts`](agent/src/plan-step.ts)): only
the read-only tools (`read`, `ls`, `grep`, `find`) are on, and the model replies
with the choices it would otherwise make by guessing, its questions for the
operator about those (or "none"), a numbered plan with a check per step, and
what "done" will look like. With questions, the TUI turn ends and
the operator answers; headless, `NERD_PLAN_ANSWER` answers (default «на твоё
усмотрение»). Then the harness writes the plan to `PLAN.md`, commits it
(`git init` first if needed), switches the work tools back on and the run
continues. A new task is the first message of a conversation, or one sent with
`/task <text>`; anything else is a remark within the task. `NERD_PLAN_STEP=0`
skips the step. The loop guard ([`agent/src/loop-guard.ts`](agent/src/loop-guard.ts))
appends a note to a tool result when the same call with the same result has
come `NERD_LOOP_GUARD_N` times (3; 0 = off) among the recent calls: the model is
told it is repeating itself and must change approach. It does not stop the run.
The fetch guard ([`agent/src/fetch-guard.ts`](agent/src/fetch-guard.ts)) does the
same for `web_fetch`: a 404 for an address that no `web_search` result had (the
model guessed it) gets a note to search instead of guessing again, and
npmjs.com's 403 a pointer to the registry (`NERD_FETCH_GUARD=0` = off).
After every successful `write` or `edit` the harness runs a linter on the file
([`agent/src/lint-check.ts`](agent/src/lint-check.ts)): biome for JS/TS, JSON,
CSS and a page's inline scripts, ruff for Python, shellcheck for shell. Only
what the linter calls an error, never style: a script that does not parse, an
undeclared name (a missing import). It is appended to the tool's result; a
clean file adds nothing (`NERD_LINT=0` = off).
When a turn of work ends, the harness checks the committed project the way
the operator's checker will, in a clean clone of HEAD
([`agent/src/done-gate.ts`](agent/src/done-gate.ts)): nothing left
uncommitted; with a `package.json`, a real `test` script (not `npm init`'s
placeholder) that passes, and a start command (`scripts.start`, or one
node/npm command in a README "Run" section) that serves `/` on `$PORT`; no
linter errors in the files changed. What fails goes back to the model as one
message, at most twice per operator message (`NERD_DONE_GATE_ROUNDS`); a
passing check adds nothing (`NERD_DONE_GATE=0` = off).
A `bash` output longer than `NERD_BASH_MAX_CHARS` (8000 characters; 0 = off)
reaches the model as its first and last lines, with the place of the whole
output in between ([`agent/src/output-cap.ts`](agent/src/output-cap.ts)); runs
of identical lines are collapsed first. Most of it is the tail, where a test
runner's summary and a build's error end up; lines of the left-out middle that
read like errors are shown with their line numbers. The model's commands run with
quiet defaults: no colour, no progress bars, no npm fund/audit notices, no pager
(`NERD_QUIET=0` = off). After each compaction of the conversation the harness
hands the model its anchors in one message: the task in the operator's words,
the latest remark, `PLAN.md`, the `notes/` index and the files changed since the
task began, within `NERD_ANCHORS_MAX_CHARS` (4000)
([`agent/src/anchors.ts`](agent/src/anchors.ts); `NERD_ANCHORS=0` = off).

**`browse`: a page as the user sees it.** `curl` cannot tell a working page
from one whose script dies on load or that is served as `text/plain`. The
image has Chromium's headless shell (Playwright, pinned with the agent) and a
command for it; the operator prompt mentions it in one sentence:

```sh
browse http://localhost:8000/ [--click TEXT] [--fill FIELD=VALUE] [--press KEY] [--wait MS] \
       [--shot page.png] [--width 390] [--text 2000]
```

It loads the page, waits for the network to go idle, runs the actions in
order (click by visible text; fill a field by label, placeholder or name),
and prints the main document's HTTP status and Content-Type, every request
(status, type, path), console errors and warnings, uncaught exceptions with
file and line, failed requests, and the visible text. Exit 0: clean; 1: the page
has errors (also a main document that is not HTML); 2: it could not be opened
or an action failed. Every call starts a fresh browser, so a sequence of steps
goes into one call.

git has a system-wide identity in the image (`nerd agent <nerd@localhost>`,
default branch `main`), so the agent's first commit does not fail for want of
one; a repository's own config overrides it. [`container/test-browse.sh`](container/test-browse.sh)
checks it in the image (`docker run --rm --entrypoint /opt/nerd/test-browse.sh nerd:agent`).

### Variants

| | `q1` (default) | `q2` |
|---|---|---|
| file | `Ternary-Bonsai-2-27B-PTQ1_0.gguf` | `Ternary-Bonsai-2-27B-PQ2_0.gguf` |
| first-start download | 5.95 GB | 7.21 GB |
| VRAM, KV `q4_0` | 64K (default): 7.2 GiB at server start on the RTX 3080 Laptop; a long agent run on 8 GB not yet measured. 32K: 6.5 GiB (6605 MiB peak during an agent run) | weights alone 6.7 GiB: not with context on 8 GB; meant for 12 GB and up, untested |
| tested | yes: RTX 3080 Laptop 8 GB, x86_64 (13 t/s, power-saving mode); DGX Spark GB10, aarch64 (31 t/s generation, 830 t/s prompt) | no |

The variant is the server's: `NERD_MODEL_VARIANT=q2` in `.env` and `./UP`
(it replaces the server's container), or by hand:

```sh
docker run -d --name nerd-llm --network nerd-net --gpus all -e NERD_MODEL_VARIANT=q2 -v nerd-models:/models nerd:server
```

Both variants need the fork; stock llama.cpp rejects these quantizations or
loads them and produces garbage.

Another model: `NERD_MODEL_GGUF=hf:<owner>/<repo>/<file>.gguf` in `.env`
(downloaded once, its sha256 checked against what Hugging Face publishes), or
the name of a GGUF already in the models volume; the server calls it by the
file's name (`NERD_MODEL_ALIAS`). On a Mac the same model also runs in Apple's
MLX format: `NERD_LLAMA=mlx` ([docs/MACOS.md](docs/MACOS.md)).

### Settings

Server defaults, each overridable in the server's environment (through
`./UP`: `NERD_CTX`, `NERD_MODEL_VARIANT` in `.env`, the rest in
`compose.override.yaml`, docs/OPERATE.md): context `NERD_CTX=65536`, KV cache
`NERD_KV=q4_0`, `NERD_NGL=99` (all layers on the GPU), flash attention on,
`NERD_SLOTS=1`, prompt cache off (`--cache-ram 0`: its KV snapshots overflow an
8 GB card), extra flags in `NERD_LLAMA_ARGS`. The agent's own variables
(`NERD_THINKING`, `NERD_VERIFY_N`, `NERD_SPEC_CHECK`, `NERD_BASH_TIMEOUT`,
`NERD_PLAN_STEP`, `NERD_PLAN_ANSWER`, `NERD_LOOP_GUARD_N`, `NERD_FETCH_GUARD`, `NERD_LINT`, `NERD_DONE_GATE`, `NERD_BASH_MAX_CHARS`, `NERD_QUIET`, `NERD_ANCHORS`, `NERD_WEB_NOTES`, `NERD_PI_VCC`, `NERD_WEB`) are described in
[`agent/src/run.ts`](agent/src/run.ts). `HF_TOKEN` is sent to Hugging Face if
set. Header comments of [`Dockerfile`](Dockerfile) and
[`container/entrypoint.sh`](container/entrypoint.sh) list the rest.

**Context and compaction.** At 32K a long run compacted every ~7 minutes, and
Pi's summary, which grows as each compaction folds the last one in, reached its
cap after about four hours; from then on compaction failed and Pi stopped at a
full window. At the 64K default the agent compacts at 44K, keeps the last 16K
verbatim, and may write a summary of up to 16K, 2.5 times the largest seen in
that run ([`agent/src/local.ts`](agent/src/local.ts), `settingsFor`). The same
fractions apply to any `NERD_CTX`; on a card where 64K does not fit, set
`NERD_CTX=32768`.

The summary itself is no longer written by the model: the
[pi-vcc](https://www.npmjs.com/package/@sting8k/pi-vcc) package extracts it
(goal, files, commits, open items, a short transcript of the turns) and gives
the agent `vcc_recall` to search the session for what was dropped. In an A/B on
one long task (six feature requests in a row, 64K, four hours, four agents
sharing one GPU) Pi's own compaction ran 7 times and took 46 of 229 minutes,
from 2 to 12 minutes each and growing with its summary; pi-vcc's 8 took no
measurable time, its summaries stayed under 8.3K characters, and both agents
finished the same requests. `NERD_PI_VCC=0` brings Pi's compaction back
([`agent/src/packages.ts`](agent/src/packages.ts)).

**Web search.** The agent has `web_search` and `web_fetch`
([rpiv-web-tools](https://www.npmjs.com/package/@juicesharp/rpiv-web-tools)),
also in the plan step, since both only read. Search goes through
[SearXNG](https://docs.searxng.org/), which runs inside the agent's container
on `127.0.0.1:8888` (`NERD_SEARXNG_PORT`) and asks public engines (DuckDuckGo,
Brave, Startpage, Mojeek, Wikipedia) without an account or key; nothing else in
the image goes to the network on its own. `web_fetch` reads a page as text; it
refuses localhost and private addresses (the agent checks its own app with
`browse`). Cost: 526 tokens in every request (the tools' schemas and a
shortened guidance). Asked to find the canonical wuxing cycles and cite its
sources, the agent searched, read three Wikipedia pages and wrote both cycles
correctly with the URLs. Public engines rate-limit and show CAPTCHAs at times;
SearXNG then answers with what the others found. `NERD_WEB=0` turns both the
tools and SearXNG off.

## Acceptance check

[`acceptance/check.sh`](acceptance/check.sh) checks a game the agent handed in
against the acceptance criteria 5–10 and 13 of decision 0006 in
`nerd-doc`, in a clean container: the repository's `HEAD` (`git archive`; a plain
directory is copied without `node_modules`) goes into a fresh container of the
official `node:lts` image, with no agent volume and no npm cache. Needs bash,
tar, git and docker on any machine; network only for pulling images and `npm ci`.

```sh
acceptance/check.sh <agent-repo> <out-dir>     # report: <out-dir>/report.md, report.json
acceptance/selftest.sh <out-dir>               # the checker against its own fixtures
node --test acceptance/test/*.test.mjs         # parsers, no docker
```

Each criterion gets **PASS**, **FAIL** or **OPERATOR** (the checker cannot
decide; the operator looks at the evidence named next to it: logs, screenshots).
Exit code 1 if anything failed, 3 if the checker itself broke.

| | how it is checked |
|---|---|
| P5 | `npm ci && npm test`, both exit 0; the number of tests from the summary of node:test, jest, vitest, mocha or ava. Count 0: FAIL; no known summary: OPERATOR |
| P6 | `npm start` if `package.json` has `scripts.start`; else the only node/npm command in a fenced block under a README heading like Run / Start / Usage / Запуск (none or several: FAIL, with the candidates). Run with `PORT=8000 HOST=0.0.0.0`; ports printed by the server are tried too. `curl -sf` must give HTML (content type or `<html`) within 60 s |
| P7 | Same-origin pages to depth 2, plus rules shown behind a "rules" button, plus `npm run rules` if there is such a script. Element names in Russian, English or 木火土金水; relations by keywords (feeds, overcomes, порождает, подавляет …; passive forms reversed), from table columns or from text and arrow chains. A source that yields ≥ 4 edges of a cycle must give exactly the canonical cycle (else FAIL); both cycles and a sentence about scoring on the same page: PASS; otherwise OPERATOR. Heuristic in the header of [`acceptance/lib/rules.mjs`](acceptance/lib/rules.mjs) |
| P8, P9 | Headless Chromium (Playwright) without knowledge of the markup: controls found by their text (bot levels, network game, moves named after an element), random moves until a "new game" control or a "match over" line appears. Two browser contexts for P8 (the second opens the first one's address, or the link it shows, or the same network button). Reaching the end: PASS; anything else: OPERATOR with screenshots, never FAIL |
| P10 | One `package.json` script named like rank / ladder / bench / bots, else the only node/npm command under a README heading like Rank / Bots / Ранги. Output read line by line: two level names (level N, easy/medium/hard, лёгкий/средний/сильный …), a share as `W/N`, `W из N` or `NN%`, and the number of games. Every adjacent pair ≥ 200 games and the stronger ≥ 60 %; unreadable output: FAIL |
| P13 | Viewport 390 px (mobile, touch): a bot match; `scrollWidth > clientWidth` at any step: FAIL; match finished without it: PASS; not finished: OPERATOR |

The self-test runs the reference game ([`acceptance/fixtures/reference`](acceptance/fixtures/reference),
small on purpose: rules page, three bot levels, rank script, network game by polling)
and broken copies of it ([`acceptance/fixtures/broken`](acceptance/fixtures/broken):
wrong generation cycle, no tests, server that does not start, equal bots, horizontal
scroll at 390 px); the reference must pass everything, each copy must fail its criterion.
