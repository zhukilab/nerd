# Architecture

```
 operator ── ssh :2222 ──┐            browser ── :8000 ──┐
                         │                               │
┌─ container <name>, image nerd:agent (no CUDA) ─────────┼──────────────────┐
│  tini → entrypoint.sh tui                              │                  │
│    └─ sshd (user nerd, key only) ── tmux session "nerd"│                  │
│                                       └─ Pi TUI (agent/src/tui.ts)        │
│                                            + nerd extension               │
│                                            ├─ harness: plan step, loop guard
│                                            ├─ tools: read/write/edit/bash, browse
│                                            └─ verifier (optional, best-of-N)
│  volumes: /workspace (agent's work)  /logs  /ssh (host keys)              │
└───────────────────────────────────────────────┬───────────────────────────┘
                     OpenAI-compatible HTTP, NERD_BASE_URL (network <name>-net)
┌─ container <name>-llm, image nerd:server-sm<arch> ─▼──────────────────────┐
│  tini → entrypoint.sh serve → llama-server :8080                          │
│         PrismML llama.cpp fork, CUDA, Bonsai 2 27B GGUF                   │
│  volume: /models (GGUF)                                                   │
└───────────────────────────────────────────────────────────────────────────┘
          GPU via --gpus all or CDI (--device nvidia.com/gpu=all)
```

On macOS the lower box is llama-server on the Mac itself (Metal,
`tools/llama-host.sh`) or mlx-vlm's server (`NERD_LLAMA=mlx`,
`tools/mlx-host.sh`), reached as `http://host.docker.internal:8080/v1`
([MACOS.md](MACOS.md)).

## Why two containers

The agent runs whatever commands the model produces, so its container is the
sandbox: the agent is uid 1000 inside it, sees only its volumes, and cannot
reach the host's processes or files. The model server runs no commands of the
model's and needs the GPU; it lives in a container of its own, which the agent
reaches only over HTTP. So:

- the agent cannot kill, restart or read the server and its model (a shell
  that once ran `pkill -f` killed its own session; it could as well have taken
  the server down);
- the agent's image has no CUDA (1.45 GB against 2.6 GB for the server's) and
  is the same on every machine; only the server is built per GPU;
- restarting or rebuilding the agent does not reload the model (`./UP` keeps
  a server that runs with the same image and settings; `./DOWN --agent`);
- macOS is the same layout with the server outside docker, where the GPU is.

Until 2026-10 both were one container; the sandbox argument was the same, the
image was larger and the agent could see the server's processes.

## The pieces

**Model.** Bonsai 2 27B by PrismML, a ternary-quantized 27B model (PTQ1_0,
5.95 GB; PQ2_0, 7.21 GB). It needs PrismML's fork of llama.cpp: stock
llama.cpp rejects these quantizations or loads them and produces garbage.
The weights are not in the image; the server's entrypoint downloads them on
first start into `/models`, resumably, and checks size and sha256 against
values pinned in `container/model.sh`.

**llama-server** is built in the Dockerfile's first stage from a pinned fork
tag, for one GPU architecture (`CUDA_ARCH`), statically linked against
llama/ggml so the server image needs only the CUDA runtime libraries. It
listens on its container's network (`<name>-net`, no port published; on
loopback when the containers share a namespace): one slot, flash attention,
KV cache q4_0, prompt cache off (its snapshots overflow an 8 GB card). Context
64K by default; the agent reads it from the server. Its arguments are in
`container/model.sh`, shared with `tools/llama-host.sh`.

**Agent.** [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
(`@earendil-works/pi-*`, pinned) provides the agent loop, tools, sessions,
context compaction and the terminal UI. nerd adds, in `agent/src/`:

| file | what |
|---|---|
| `local.ts` | the local llama-server as Pi's model, the system prompt, compaction sized to the window; Pi's telemetry and update checks off |
| `extension.ts`, `tui.ts` | the TUI: Pi's own `main()` with nerd's extension inline |
| `run.ts`, `headless.ts` | one task without a conversation (headless mode, scripts, acceptance) |
| `harness.ts`, `plan-step.ts` | the first turn of a task is read-only: assumptions, questions, plan; then `PLAN.md` is committed and work tools come on |
| `packages.ts` | third-party Pi packages, pinned and loaded from `node_modules`: [pi-vcc](https://www.npmjs.com/package/@sting8k/pi-vcc) replaces Pi's model-written compaction summary with an extracted one (no model call) and adds `vcc_recall`, a search of the session file for what compaction dropped (`NERD_PI_VCC`, on); [rpiv-web-tools](https://www.npmjs.com/package/@juicesharp/rpiv-web-tools): `web_search` through SearXNG in the container and `web_fetch` (`NERD_WEB`, on) |
| `loop-guard.ts` | tells the model when it repeats the same call with the same result |
| `bash-tool.ts` | Pi's bash with a default timeout, so a foreground server cannot hang the run |
| `browse.ts` | headless Chromium (Playwright): a page as a user sees it, with console errors and failed requests |
| `spec-check.ts` | checks the work against the task's text clause by clause |
| `verifier/` | best-of-N per step: N candidate steps, compared pairwise by the same model, the winner goes on (`NERD_VERIFY_N` > 1; off by default) |

**Container glue** (`container/`): `entrypoint.sh` (agent: `tui`, a task;
server: `serve`, `fetch`), `model.sh` (model files, checksums, server
arguments), sshd's config and the login script that attaches to tmux,
tmux's config, `pkill-guard.sh` installed as `pkill`/`pgrep` (refuses `-f`,
which would match and kill the agent's own shell), the `browse` wrapper, and
tests that run inside the image.

**Deployment** (repository root and `tools/`): `./UP`, `./DOWN`, `./STATUS`
read `.env`, detect the GPU's compute capability and the GPU passing method
(CDI or `--gpus`), build both images, run both containers on their network,
and report. `tools/check-prerequisites.sh` and `tools/install-prerequisites.sh`
prepare the host; `tools/llama-host.sh` is the server on a Mac.
`tools/lib.sh` is shared.

**Acceptance** (`acceptance/`): a checker that takes a repository the agent
produced for the reference task (a browser game) and checks it in a fresh
`node:lts` container: tests, server start, rules page, bot strength, a
headless-browser playthrough, a 390 px mobile layout. It runs on any machine
with docker; no GPU.

## Modes

| image | mode | runs | ends |
|---|---|---|---|
| agent | `tui` (what `./UP` starts) | sshd, waits for the server (as long as it takes), Pi in tmux (restarted with `--continue` if it exits) | when sshd exits; docker restarts it. A server that goes away is retried by Pi |
| agent | `"<task>"` | waits for the server (up to 15 min), `run.ts` on the task | when the agent finishes; exit code 0 = final answer |
| server | `serve` (default) | download and check the model if needed, llama-server in the foreground | never; docker restarts it |
| server | `fetch` | download and check the model | after the check |

## State

| volume | container | holds | lost with |
|---|---|---|---|
| `/models` | server | GGUF files and a marker of the checked hash | `./DOWN --purge-models` |
| `/workspace` | agent | the agent's projects (it commits to git there) | `./DOWN --purge` |
| `/logs` | agent | conversations (`sessions/`), event and verifier logs | `./DOWN --purge` |
| `/ssh` | agent | the ssh host keys (a stable fingerprint) | `./DOWN --purge` |

The server logs to docker (`docker logs <name>-llm`). Processes the agent
started (a web server) live only as long as its container.

## Design notes

- **Pins, not ranges.** A model's behaviour depends on the exact server build
  and the exact agent framework; an unpinned rebuild is a different system.
- **Mechanisms over prompts.** Where the model repeatedly failed an
  instruction (ask before coding, do not loop, do not run servers in the
  foreground, do not `pkill -f`), the fix is code in the harness or the image,
  not more prompt text.
- **No network beyond the task.** Pi's telemetry and version checks are off;
  the images' own network use is the model download and, when the agent
  searches, SearXNG's queries to public search engines (`NERD_WEB=0`: none).
