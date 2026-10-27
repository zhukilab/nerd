# Architecture

```
 operator ── ssh :2222 ──┐            browser ── :8000 ──┐
                         │                               │
┌─ container <name>, image nerd:agent (no CUDA) ─────────┼──────────────────┐
│  tini → entrypoint.sh tui                              │                  │
│    └─ sshd (user nerd, key only) ── tmux session "nerd"│                  │
│                                       └─ Pi TUI (agent/src/tui.ts)        │
│                                            + nerd extension               │
│                                            ├─ harness: plan step, guards, done gate, Ralph loop
│                                            ├─ tools: read/write/edit/bash, browse, web
│                                            └─ verifier (optional, best-of-N)
│  SearXNG on loopback (web_search)                                         │
│  volumes: /workspace (agent's work)  /logs  /ssh (host keys)              │
│           /home/nerd, /home/nerd/.cache;  /tmp is a tmpfs                 │
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
sandbox: the agent is uid 1000 inside it (with `sudo` there unless
`NERD_SUDO=0`), sees only its volumes, and cannot
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
KV cache q4_0, prompt cache in host RAM (`NERD_CACHE_RAM`, 4096 MiB: a context
that comes back after another one used the slot is not processed again). Context
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
| `harness.ts` | the modules that act around the model (plan step, guards, done gate, Ralph loop, ...) wired into one extension for both modes |
| `plan-step.ts` | the first turn of a task is read-only: assumptions, questions, plan; then `PLAN.md` is committed (a repository it creates starts with the project as given) and work tools come on (`NERD_PLAN_STEP`, on; a reply cap and a wall clock of its own) |
| `plan-lint.ts` | checks `PLAN.md` before it is frozen (placeholders, Done when checks that cannot run, cannot fail or do not parse) and sends errors back once (`NERD_PLAN_LINT`, on) |
| `plan-calc.ts` | a Python calculator `calc` in the plan step (`NERD_PLAN_CALC=1`; off) |
| `ralph.ts`, `done-when.ts` | the Ralph loop: after the work the plan's Done when commands run in a clean clone with the done gate; failures start a new round after compaction (`NERD_RALPH`, on; `NERD_RALPH=0` off) |
| `done-gate.ts`, `gate-guard.cjs`, `cargo.ts` | the done gate: when a turn of work ends, the committed project is checked in a clean clone (uncommitted changes, `npm test` or `cargo test` and clippy, start command, README check commands, linter errors, tests weakened since the task began); loopback ports that were already listening are refused to it (`NERD_DONE_GATE`, on) |
| `step-log.ts` | after each commit of the model's, the plan's steps not yet done are checked by their `check:` commands (`NERD_STEPS=1`; off) |
| `thinking-keep.ts` | only the last N replies' thinking goes back to the model in each request; the session keeps all of it (`NERD_THINKING_KEEP=N`, 0 by default; `all` = off) |
| `anchors.ts` | after a compaction: the phase, the task, `PLAN.md`'s head, `notes/`, the files changed since the task began (`NERD_ANCHORS`, on) |
| `lint-check.ts`, `lint/` | after every write or edit, the linter's errors (not style) appended to the result: biome, ruff, shellcheck, `cargo check` (`NERD_LINT`, on) |
| `output-cap.ts` | long bash output as head and tail, the whole of it in a file (`NERD_BASH_MAX_CHARS`, 8000) |
| `repeat-guard.ts` | cuts a reply whose tail repeats one piece of text, or a tool call whose streamed arguments do, at most twice per task (`NERD_REPEAT_GUARD`, on) |
| `scout.ts` | `scout`: a question about the project goes to a helper session with reading tools only, its findings to `notes/scout/` (`NERD_SCOUT=1`; off) |
| `agora-channel.ts` | a session manager's channel (a unix socket): session events out, letters in as the operator's messages, the `send_letter` tool (`NERD_AGORA_CHANNEL`; unset, nothing loads) |
| `calc-guard.ts` | every calculation by a program: a rule in the system prompt, and a reply of hand arithmetic is cut (`NERD_CALC=1`; off) |
| `work-budget.ts` | the wall clock of each turn of work: a note, then the tools go away and the harness commits (`NERD_WORK_MAX_MINUTES`; off) |
| `fetch-guard.ts` | a note when `web_fetch` gets 404 for an address no search result had (`NERD_FETCH_GUARD`, on) |
| `web-notes.ts` | each page `web_fetch` read kept in the project's `notes/web/` (`NERD_WEB_NOTES`, on) |
| `sampling.ts` | sampling fields added to every request (`NERD_SAMPLING`) |
| `pair.ts` | the ping-pong pair: another model writes the plan and its checks (`NERD_PLAN_BASE_URL`; unset, one model) |
| `event-log.ts` | what of a session event goes into the headless run's `--log` |
| `packages.ts` | third-party Pi packages, pinned and loaded from `node_modules`: [pi-vcc](https://www.npmjs.com/package/@sting8k/pi-vcc) replaces Pi's model-written compaction summary with an extracted one (no model call; patched at install, `agent/patches/`) (`NERD_PI_VCC`, on; its `vcc_recall` is not offered unless `NERD_VCC_RECALL=1`); [rpiv-web-tools](https://www.npmjs.com/package/@juicesharp/rpiv-web-tools): `web_search` through SearXNG in the container and `web_fetch` (`NERD_WEB`, on) |
| `loop-guard.ts` | tells the model when it repeats the same call with the same result |
| `rules.ts` | the operator's rules for every project: `RULES.md` in the agent's home, in each turn's system prompt, written only by `/remember` and `/forget` |
| `summary-goal.ts` | the compaction summary's goal set to the task in the operator's words, before each request |
| `bash-tool.ts` | Pi's bash with a default timeout, so a foreground server cannot hang the run, and quiet defaults for the model's commands (`NERD_QUIET`) |
| `browse.ts` | headless Chromium (Playwright): a page as a user sees it, with console errors and failed requests |
| `spec-check.ts` | checks the work against the task's text clause by clause (headless `NERD_SPEC_CHECK=1`, off; in the TUI `/spec-check`) |
| `verifier/` | best-of-N per step: N candidate steps, compared pairwise by the same model, the winner goes on (`NERD_VERIFY_N` > 1; off by default) |

**Container glue** (`container/`): `entrypoint.sh` (agent: `tui`, a task;
server: `serve`, `fetch`), `model.sh` (model files, checksums, server
arguments), sshd's config and the login script that attaches to tmux,
tmux's config, `pkill-guard.sh` installed as `pkill`/`pgrep` (refuses `-f`,
which would match and kill the agent's own shell), the `browse` wrapper,
`nerd-get.sh` (languages installed into the agent's home), `nerd-rs-eval.mjs`
(a Rust library's behaviour check), SearXNG's settings, and tests that run
inside the image.

**Deployment** (repository root and `tools/`): `./UP`, `./DOWN`, `./STATUS`
read `.env`, detect the GPU's compute capability and the GPU passing method
(CDI or `--gpus`), build both images, run both containers on their network
through `docker compose` (`compose.yaml` and the overlays that fit the
machine), and report. `tools/check-prerequisites.sh` and
`tools/install-prerequisites.sh` prepare the host; `tools/llama-host.sh` and
`tools/mlx-host.sh` are the server on a Mac; `tools/report.sh` packs one
archive to send when something fails. `tools/lib.sh` is shared.

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
| agent | `hold` | SearXNG only, no Pi, no sshd: a session manager runs `docker exec -it <c> nerd-pi tui [--continue]` or `nerd-pi run "<task>"` (`container/nerd-pi.sh`) | when stopped (143 at once); Pi's life is the manager's |
| server | `serve` (default) | download and check the model if needed, llama-server in the foreground | never; docker restarts it |
| server | `fetch` | download and check the model | after the check |

## State

| volume | container | holds | lost with |
|---|---|---|---|
| `/models` | server | GGUF files and a marker of the checked hash | `./DOWN --purge-models` |
| `/workspace` | agent | the agent's projects (it commits to git there) | `./DOWN --purge` |
| `/logs` | agent | conversations (`sessions/`), event and verifier logs | `./DOWN --purge` |
| `/ssh` | agent | the ssh host keys (a stable fingerprint) | `./DOWN --purge` |
| `/home/nerd` | agent | the agent's home: installed languages and their packages, Pi's agent dir (`RULES.md`) | `./DOWN --purge` |
| `/home/nerd/.cache` | agent | caches | `./DOWN --purge` |

`/tmp` is a tmpfs in both containers.

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
