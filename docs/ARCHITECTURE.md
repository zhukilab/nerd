# Architecture

```
 operator ── ssh :2222 ──┐            browser ── :8000 ──┐
                         │                               │
┌─ container (one image) ┼───────────────────────────────┼──────────────────┐
│  tini → entrypoint.sh  │                               │                  │
│    ├─ sshd (user nerd, key only) ── tmux session "nerd"│                  │
│    │                                  └─ Pi TUI (agent/src/tui.ts)        │
│    │                                       + nerd extension               │
│    │                                       ├─ harness: plan step, loop guard
│    │                                       ├─ tools: read/write/edit/bash, browse
│    │                                       └─ verifier (optional, best-of-N)
│    │                                            │ OpenAI-compatible HTTP  │
│    └─ llama-server :8080 (127.0.0.1) ◄──────────┘                         │
│         PrismML llama.cpp fork, CUDA, Bonsai 2 27B GGUF                   │
│                                                                           │
│  volumes: /models (GGUF)  /workspace (agent's work)  /logs  /ssh (host keys)
└───────────────────────────────────────────────────────────────────────────┘
          GPU via --gpus all or CDI (--device nvidia.com/gpu=all)
```

## Why one container

The agent runs whatever commands the model produces. Putting the model
server, the agent and everything it may start into one container makes the
container the sandbox: the agent is uid 1000 inside it, sees only its volumes,
and cannot reach the host's processes or files. One image is also one thing to
build, pin and move between machines. The cost is a large image (CUDA
runtime libraries are most of it) and one model server per instance.

## The pieces

**Model.** Bonsai 2 27B by PrismML, a ternary-quantized 27B model (PTQ1_0,
5.95 GB; PQ2_0, 7.21 GB). It needs PrismML's fork of llama.cpp: stock
llama.cpp rejects these quantizations or loads them and produces garbage.
The weights are not in the image; the entrypoint downloads them on first
start into `/models`, resumably, and checks size and sha256 against values
pinned in `container/entrypoint.sh`.

**llama-server** is built in the Dockerfile's first stage from a pinned fork
tag, for one GPU architecture (`CUDA_ARCH`), statically linked against
llama/ggml so the final image needs only the CUDA runtime libraries. It
listens on 127.0.0.1 inside the container: one slot, flash attention, KV cache
q4_0, prompt cache off (its snapshots overflow an 8 GB card). Context 64K by
default.

**Agent.** [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
(`@earendil-works/pi-*`, pinned) provides the agent loop, tools, sessions,
context compaction and the terminal UI. nerd adds, in `agent/src/`:

| file | what |
|---|---|
| `local.ts` | the local llama-server as Pi's model, the system prompt, compaction sized to the window; Pi's telemetry and update checks off |
| `extension.ts`, `tui.ts` | the TUI: Pi's own `main()` with nerd's extension inline |
| `run.ts`, `headless.ts` | one task without a conversation (headless mode, scripts, acceptance) |
| `harness.ts`, `plan-step.ts` | the first turn of a task is read-only: assumptions, questions, plan; then `PLAN.md` is committed and work tools come on |
| `packages.ts` | third-party Pi packages, pinned and loaded from `node_modules`: [pi-vcc](https://www.npmjs.com/package/@sting8k/pi-vcc) replaces Pi's model-written compaction summary with an extracted one (no model call) and adds `vcc_recall`, a search of the session file for what compaction dropped (`NERD_PI_VCC`, on) |
| `loop-guard.ts` | tells the model when it repeats the same call with the same result |
| `bash-tool.ts` | Pi's bash with a default timeout, so a foreground server cannot hang the run |
| `browse.ts` | headless Chromium (Playwright): a page as a user sees it, with console errors and failed requests |
| `spec-check.ts` | checks the work against the task's text clause by clause |
| `verifier/` | best-of-N per step: N candidate steps, compared pairwise by the same model, the winner goes on (`NERD_VERIFY_N` > 1; off by default) |

**Container glue** (`container/`): `entrypoint.sh` (modes `tui`, a task,
`serve`, `fetch`), sshd's config and the login script that attaches to tmux,
tmux's config, `pkill-guard.sh` installed as `pkill`/`pgrep` (refuses `-f`,
which would match and kill the agent's own shell), the `browse` wrapper, and
tests that run inside the image.

**Deployment** (repository root and `tools/`): `./UP`, `./DOWN`, `./STATUS`
read `.env`, detect the GPU's compute capability and the GPU passing method
(CDI or `--gpus`), build, run, and report. `tools/check-prerequisites.sh` and
`tools/install-prerequisites.sh` prepare the host. `tools/lib.sh` is shared.

**Acceptance** (`acceptance/`): a checker that takes a repository the agent
produced for the reference task (a browser game) and checks it in a fresh
`node:lts` container: tests, server start, rules page, bot strength, a
headless-browser playthrough, a 390 px mobile layout. It runs on any machine
with docker; no GPU.

## Modes

| mode | runs | ends |
|---|---|---|
| `tui` (what `./UP` starts) | sshd, then the model, llama-server, Pi in tmux (restarted with `--continue` if it exits) | when sshd or llama-server exits; docker restarts it |
| `"<task>"` | the model, llama-server, `run.ts` on the task | when the agent finishes; exit code 0 = final answer |
| `serve` | llama-server in the foreground | never |
| `fetch` | download and check the model | after the check |

## State

| volume | holds | lost with |
|---|---|---|
| `/models` | GGUF files and a marker of the checked hash | `./DOWN --purge-models` |
| `/workspace` | the agent's projects (it commits to git there) | `./DOWN --purge` |
| `/logs` | conversations (`sessions/`), server and verifier logs | `./DOWN --purge` |
| `/ssh` | the ssh host keys (a stable fingerprint) | `./DOWN --purge` |

Processes the agent started (a web server) live only as long as the container.

## Design notes

- **Pins, not ranges.** A model's behaviour depends on the exact server build
  and the exact agent framework; an unpinned rebuild is a different system.
- **Mechanisms over prompts.** Where the model repeatedly failed an
  instruction (ask before coding, do not loop, do not run servers in the
  foreground, do not `pkill -f`), the fix is code in the harness or the image,
  not more prompt text.
- **No network beyond the task.** Pi's telemetry and version checks are off;
  the image's only own network use is the model download.
