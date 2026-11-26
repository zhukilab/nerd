# Settings

<!-- Generated from agent/src/settings-registry.ts by agent/src/settings-doc.ts; do not edit by hand. -->

Every setting of nerd. `./SETTINGS` on the host shows and changes all of them (with `all`: the tuning
knobs too); `/nerd` in Pi the agent's. Settings set by `./UP` or an entrypoint for the process it starts
are not listed. **Default** "" means worked out, as the description says.

## The host: `.env`

Read by `./UP`, `./DOWN`, `./STATUS` and the tools from `.env` (format in `env.example`). A change acts when `./UP` recreates the containers.

### machine

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_NAME` | `nerd` | text | needs ./UP | Name of the agent's container and of the compose project. The server's is <name>-llm, their network <name>-net, the volumes <name>-ws, <name>-logs, <name>-ssh, <name>-home and <name>-cache. |
| `NERD_LLAMA` | `auto` | auto / container / host / mlx / remote / provider | needs ./UP | Where the model server runs: container (llama-server in its own container <name>-llm, with the GPU), host (llama-server on this machine, tools/llama-host.sh), mlx (mlx-vlm's server on a Mac with Apple silicon, tools/mlx-host.sh), remote (llama-server or Ollama on another machine at NERD_LLAMA_URL; only the agent runs here), provider (a cloud provider's OpenAI-compatible API at NERD_PROVIDER_URL, through the key proxy <name>-keyproxy, which alone holds the key; no verifier). auto is host on macOS and container elsewhere. |
| `NERD_PROVIDER_URL` | "" | text | needs ./UP | NERD_LLAMA=provider: the provider's OpenAI-compatible API, e.g. https://openrouter.ai/api/v1, or the name of a row when the key file is a table of providers. The key proxy sends the agent's requests there with the key; NERD_MODEL names the model. |
| `NERD_PROVIDER_MODELS` (advanced) | "" | text | needs ./UP | NERD_LLAMA=provider with one key: the models it may be spent on, comma-separated (e.g. the provider's free ones); the key proxy refuses a request for any other with 403. In a table of providers the same is a row's only=<model>,<model>. Empty: any model. |
| `NERD_KEYPROXY_AUTH` (advanced) | `off` | off / on | needs ./UP | NERD_LLAMA=provider. on: the key proxy answers only a request with a token ./UP makes at each start, kept in var/keyproxy.token (600); the agent sends it as its API key, other tools of yours read it there. For a machine shared with other users, who could otherwise reach the proxy on its docker network and spend the key. off: anyone who reaches the proxy uses it. |
| `NERD_PROVIDER_KEY_FILE` | `var/provider.key` | text | needs ./UP | NERD_LLAMA=provider: the file with the provider's API key, one line, chmod 600; or a table of providers, a row "<name> <base URL> <key>" per line, each also at <proxy>/<name>/v1. Mounted into the key proxy only, never into the agent's container. After changing the key: docker restart <name>-keyproxy. |
| `NERD_GPU` | `auto` | auto / cdi / gpus | needs ./UP | How the GPU is passed to the server's container: cdi (a CDI device), gpus (--gpus all), or auto (a CDI spec if one exists and docker resolves it, else --gpus all). |
| `NERD_SUDO` | `1` | 1 / 0 | needs ./UP | 1: the agent's user has sudo without a password inside its container (tcpdump, apt-get install). 0: the container drops it at its start. |
| `NERD_TMP_SIZE` (advanced) | `2g` | text | needs ./UP | Size of /tmp, a tmpfs (memory) in both containers. A big build belongs in the workspace, not in /tmp. |
| `NERD_SHM_SIZE` (advanced) | `1g` | text | needs ./UP | Size of the agent's /dev/shm; its headless browser needs more than docker's 64m. |
| `NERD_MLX_ANY_OS` (advanced) | `0` | 1 / 0 | needs ./UP | 1 lets tools/mlx-host.sh run off a Mac with Apple silicon, for its tests only; MLX itself needs one. |

### model

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_MODEL_VARIANT` | `q1mtp` | q1mtp / q1 / q2 | needs ./UP | The model variant: q1mtp (q1 with a multi-token-prediction head, 6.30 GB: generation 1.4-2.2x faster, ~0.75 GB more VRAM, 64K still fits 8 GB but tight), q1 (5.95 GB, fits 8 GB of VRAM at 64K context) or q2 (7.21 GB, 12 GB and up). Unset, it is q1mtp, but q1 for the Mac's own llama-server (NERD_LLAMA=host: the head is not tested with Metal yet). Not used when NERD_MODEL_GGUF names another model. |
| `NERD_MTP` (advanced) | `auto` | auto / on / off | needs ./UP | Speculative decoding with the model's MTP head: auto uses it when the variant has one (q1mtp), on asks for it with any model (a NERD_MODEL_GGUF that carries a head), off never. |
| `NERD_MTP_DRAFT` (advanced) | `1` | 1–8 | needs ./UP | Tokens the MTP head drafts per step. 1 is best on an 8 GB Ampere card at long context; 2 was faster on GB10. Measure on yours. |
| `NERD_MODEL_GGUF`, older `NERD_MODEL_FILE` | "" | text | needs ./UP | Another GGUF for llama-server instead of the variant: hf:<owner>/<repo>/<file>.gguf[@<revision>] (downloaded once, its sha256 checked), or the name of a .gguf already in the models volume. Empty: the variant. |
| `NERD_MODEL_SHA256` (advanced) | "" | text | needs ./UP | Pins the sha256 of an hf: file named by NERD_MODEL_GGUF. Empty: checked against what Hugging Face publishes for it. |
| `NERD_MODEL_ALIAS` (advanced) | "" | text | needs ./UP | The model's name on the server. Empty: bonsai2-<variant> (q1mtp is served as bonsai2-q1: the same weights), or the file's name without .gguf for NERD_MODEL_GGUF. |
| `NERD_CTX` | `65536` | ≥ 1 | needs ./UP | Context window in tokens; 32768 if 64K does not fit. The server is started with it; the agent takes the context from llama-server, and with NERD_LLAMA=mlx is told this value. With NERD_LLAMA=provider the provider's model list gives it where it can; set, this overrides. |
| `NERD_SAMPLING` (advanced) | "" | text | needs ./UP | Sampling fields added to every request that does not set them, e.g. temperature=0.7,top_p=0.8,top_k=20. Empty: the server's own defaults; with NERD_LLAMA=mlx, temperature=0.7,top_p=0.8,top_k=20,presence_penalty=1.5. |
| `NERD_MLX_MODEL` | "" | text | needs ./UP | NERD_LLAMA=mlx only: the model, <owner>/<repo>[@<revision>] on Hugging Face or a directory. Empty: Bonsai 2 27B in MLX 2-bit at a pinned revision. |
| `NERD_MLX_APC` (advanced) | `1` | 1 / 0 | needs ./UP | NERD_LLAMA=mlx only: 1 keeps the server's prefix cache; 0 turns it off, and every turn computes the whole prompt again. |
| `NERD_MLX_ARGS` (advanced) | "" | text | needs ./UP | NERD_LLAMA=mlx only: extra arguments for mlx-vlm's server, split into words. |

### ports and network

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_SSH_PORT` | `2222` | 1–65535 | needs ./UP | Port to ssh into the agent's terminal; the same number inside the container and on the host. |
| `NERD_APP_PORT` | `8000` | 1–65535 | needs ./UP | Port on which what the agent builds is served; the agent is told it. The same number inside the container and on the host. |
| `NERD_LLAMA_PORT`, older `NERD_PORT` | `8080` | 1–65535 | needs ./UP | The model server's port: on <name>-net (not published), or on this machine with NERD_LLAMA=host or mlx. |
| `NERD_BIND` | `0.0.0.0` | text | needs ./UP | Host address the ports are published on: 0.0.0.0 (all) or 127.0.0.1 (this machine only). |
| `NERD_OPERATOR_URL` | "" | text | needs ./UP | The address at which you open what the agent builds, as you type it in your browser (e.g. http://my-gpu-box:8000). The agent is told it as a fact; empty: the agent is told only the port. |
| `NERD_NETWORK` (advanced) | "" | text | needs ./UP | container:<name>: both containers join that container's network namespace (e.g. a VPN sidecar) instead of <name>-net; ports are then not published and the server listens on loopback only. |
| `NERD_LLAMA_URL` (advanced) | "" | text | needs ./UP | The server as the agent's container reaches it. Empty: http://<name>-llm:<port>/v1, http://127.0.0.1:<port>/v1 with NERD_NETWORK, http://host.docker.internal:<port>/v1 with NERD_LLAMA=host or mlx. Required with NERD_LLAMA=remote. |
| `NERD_LLAMA_HOST` (advanced) | `127.0.0.1` | text | needs ./UP | NERD_LLAMA=host or mlx only: the address the server on this machine binds. |

### images and build

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_IMAGE` (advanced) | `nerd:agent` | text | needs ./UP | The agent's image tag; ./UP builds it if missing. |
| `NERD_SERVER_IMAGE` (advanced) | "" | text | needs ./UP | The server's image tag; ./UP builds it if missing. Empty: nerd:server-sm<CUDA_ARCH>, e.g. nerd:server-sm86. |
| `NERD_CUDA_ARCH` (advanced) | "" | text | needs ./UP | The server's GPU compute capability without the dot (86 = RTX 30xx, 89 = RTX 40xx, 121 = GB10), a build argument. Empty: detected with nvidia-smi, 86 if that fails. |
| `NERD_CUDA_VERSION` (advanced) | "" | text | needs ./UP | The CUDA version the server is built with; the host driver must support it. Empty: 12.4.1, or 13.0.1 for compute capability 10.0 and up. |
| `NERD_MLX_PYTHON` (advanced) | "" | text | needs ./UP | NERD_LLAMA=mlx only: the python3.12 or 3.13 to make the server's venv with. Empty: the first found. |
| `NERD_MLX_REQUIREMENTS` (advanced) | "" | text | needs ./UP | Another requirements file for the MLX venv, for tests only. Empty: tools/mlx-requirements.txt. |

### paths

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_WORKSPACE` | "" | text | needs ./UP | Where the agent works: a host directory, writable by uid 1000 (the agent container's user). Empty: a docker volume <name>-ws. |
| `NERD_AUTHORIZED_KEYS_FILE` | "" | text | needs ./UP | The file with the public key(s) allowed to log in. Empty: the first of ~/.ssh/id_ed25519.pub, ~/.ssh/id_ecdsa.pub, ~/.ssh/id_rsa.pub. |
| `NERD_MODELS_VOLUME` (advanced) | `nerd-models` | text | needs ./UP | Docker volume with the model, shared by every nerd server on the machine. |
| `NERD_HOST_DIR` (advanced) | `~/.nerd` | text | needs ./UP | NERD_LLAMA=host or mlx only: the directory for the server's source or venv, model and log. |
| `NERD_ENV_FILE` (advanced) | "" | text | needs ./UP | The settings file the host scripts read. Empty: .env next to ./UP. |

## The model server

Read in the model server's container (`container/model.sh`). `compose.yaml` does not pass these through: set them in `compose.override.yaml` (docs/OPERATE.md), or in `.env` with `NERD_LLAMA=host`.

### model server

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_KV` (advanced) | `q4_0` | text | needs ./UP | llama-server's KV cache type, for keys and values (e.g. q4_0, q8_0, f16). In the server's container through compose.override.yaml; .env serves the server on this machine. |
| `NERD_NGL` (advanced) | `99` | ≥ 0 | needs ./UP | Layers llama-server puts on the GPU; 99 is all of them. |
| `NERD_SLOTS` (advanced) | `1` | ≥ 1 | needs ./UP | llama-server's parallel slots; the context is shared among them. |
| `NERD_CACHE_RAM` (advanced) | `4096` | ≥ 0 | needs ./UP | llama-server's prompt cache in host RAM, MiB: a conversation that comes back after another one used the slot is not processed again. 0 turns it off. |
| `NERD_LLAMA_ARGS` (advanced) | "" | text | needs ./UP | Extra llama-server arguments, split into words. |

## The agent

Read by the agent (Pi). Set them with `/nerd` in Pi or `./SETTINGS` on the host; they are kept in `~/.config/nerd/settings.env` in the agent's home volume, which wins over the container's environment.

### thinking

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_THINKING` | `off` | off / low / medium / high | acts after a reload | The model's thinking level: off (really off), or low, medium, high for longer reasoning before each reply, slower. It also raises the plan step's reply cap. /nerd sets it for the conversation at once. |

### loop and checks

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_RALPH` | `1` | 1 / 0 | acts after a reload | 1: the Ralph loop: the plan's Done when items carry check commands; after the work they run in a clean clone, and failures start a new round from the files. 0: off. |
| `NERD_RALPH_ROUNDS` | `3` | ≥ 0 | acts after a reload | How many rounds the Ralph loop may start after the first delivery. |
| `NERD_RALPH_MINUTES` | `0` | ≥ 0 | acts after a reload | The Ralph loop's wall clock in minutes; 0: no limit. |
| `NERD_RALPH_AMEND_GUARD` (advanced) | `0` | 1 / 0 | acts after a reload | 1: a check the model corrected is taken only if it also passes on the code of the first "done". |
| `NERD_RALPH_FRESH` (advanced) | `0` | 1 / 0 | needs a Pi restart | Headless runs only. 1: each Ralph round starts in a new session instead of the compacted one. |
| `NERD_RALPH_PROGRESS` (advanced) | `failures` | failures / work | acts after a reload | When the Ralph loop sees no progress. failures: the same checks failed twice in a row. work (a long task): two rounds in a row changed neither the failing checks nor the committed code, and then the run pauses (exit 75, marked stalled) instead of ending; each check's command may be corrected once. |
| `NERD_RALPH_GATE` (advanced) | "" | text | acts after a reload | A command (sh -c) asked before each next Ralph round and before a headless run's first turn: it prints decision=continue\|pause, work_minutes=N, reason=...; a pause commits the work, saves the loop's state and exits 75 (agent/src/ralph-gate.ts). Empty: no gate. |
| `NERD_RALPH_RESUME` (advanced) | `0` | 1 / 0 | needs a Pi restart | Headless runs only. 1: go on with the run paused by the gate (or stopped by a signal) from its saved state: no plan step, the round that was about to start. |
| `NERD_RALPH_STATE` (advanced) | "" | text | needs a Pi restart | Where a paused run's state is saved (relative: to the workspace). Empty: nerd-ralph-state.json inside the workspace's .git. |
| `NERD_DONE_GATE` | `1` | 1 / 0 | acts after a reload | 1: when a turn of work ends, the committed project is checked (build, tests) and failures go back to the model. 0: no check. |
| `NERD_DONE_GATE_ROUNDS` (advanced) | `2` | ≥ 0 | acts after a reload | How many times the done gate may send failures back per operator message. |
| `NERD_SPEC_CHECK` (advanced) | `0` | 1 / 0 | needs a Pi restart | Headless runs only. 1: after the first "done" the work is checked against the task text clause by clause. In the TUI it is the /spec-check command. |
| `NERD_SPEC_CHECK_ROUNDS` (advanced) | `3` | ≥ 1 | acts after a reload | How many rounds the spec check repeats while clauses fail. |
| `NERD_SPEC_CHECK_SNAPSHOT` (advanced) | "" | text | needs a Pi restart | Headless runs, for measurement: a directory the workspace is copied to at the first "done", before the spec check. |
| `NERD_STEPS` (advanced) | `0` | 1 / 0 | acts after a reload | 1: after each commit of the model's, the plan's steps not yet done are checked by their check: commands in a clean clone, and each step done is logged. |
| `NERD_WORK_MAX_MINUTES` | `0` | ≥ 0 | acts after a reload | The wall clock of each turn of work, in minutes: then a note asks to commit and sum up, and 15 minutes later the tools go away. 0: no limit. |
| `NERD_VERIFY_N` (advanced) | `1` | ≥ 1 | acts after a reload | Candidates per step for the verifier, which picks the best of them; 1 runs the plain loop. |

### planning

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_PLAN_STEP` | `1` | 1 / 0 | acts after a reload | 1: a questions-and-plan turn without write tools before the work of each task. 0: straight to the work. |
| `NERD_PLAN_ANSWER` (advanced) | `на твоё усмотрение` | text | acts after a reload | Headless runs: the answer to the plan step's questions, as there is no operator to ask. |
| `NERD_PLAN_LINT` (advanced) | `1` | 1 / 0 | acts after a reload | 1: the final plan is linted, and placeholders, tool-call text instead of a plan, and Done when checks that cannot run, cannot fail or do not parse go back once. 0: off. |
| `NERD_PLAN_LINT_OWN_INPUT` (advanced) | `0` | 1 / 0 | acts after a reload | 1: plan-lint wants a behaviour check on an input that is not in the task. |
| `NERD_PLAN_MAX_CALLS` (advanced) | `40` | ≥ 0 | acts after a reload | The plan step's tool calls; past them the tools are put away and the plan is asked for. 0: no limit. |
| `NERD_PLAN_MAX_TOKENS` (advanced) | "" | ≥ 0 | acts after a reload | Caps each reply of the plan step, in tokens; 0: no cap. Empty: 6144, or 24576 with thinking on. |
| `NERD_PLAN_MAX_MINUTES` | `45` | ≥ 0 | acts after a reload | The plan step's wall clock in minutes; past it the tools go away and requests go without thinking, so the next reply is the plan. 0: no limit. |
| `NERD_PLAN_CALC` (advanced) | `0` | 1 / 0 | needs a Pi restart | 1: the plan step has calc, a Python calculator, for the numbers of the plan's checks. |
| `NERD_PLAN_CALC_NOTE` (advanced) | "" | text | acts after a reload | With NERD_PLAN_CALC=1: text added to the plan step's prompt, for experiments. |
| `NERD_PLAN_CALC_LINT` (advanced) | `0` | 1 / 0 | acts after a reload | With NERD_PLAN_CALC=1: plan-lint wants each number in a Done when check to come from the task, an input, or a calc call. |
| `NERD_PLAN_BASE_URL` (advanced) | "" | text | acts after a reload | The ping-pong pair: the model at this OpenAI-compatible endpoint writes the plan and its checks (and corrects them in the Ralph amend round), the main one writes the code. Empty: one model does both. |
| `NERD_PLAN_MODEL` (advanced) | "" | text | acts after a reload | The planner's model id at NERD_PLAN_BASE_URL. Empty: whatever that server serves. |

### tools

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_BASH_TIMEOUT` (advanced) | `600` | ≥ 1 | acts after a reload | Seconds a bash call may run when the model gives no timeout of its own. |
| `NERD_RUNS` | `1` | 1 / 0 | acts after a reload | 1: each command of the agent runs in a window of tmux session nerd-runs, where you can watch it (tmux attach -t nerd-runs) and stop it with Ctrl-C. 0: commands run unseen, as Pi's own. |
| `NERD_RUNS_BACKGROUND` | `1` | 1 / 0 | acts after a reload | 1: the runs tool, for commands in the background (a dev server, a long build): start, list, output, stop; they end with the session. Needs NERD_RUNS=1. |
| `NERD_RUNS_KEEP` (advanced) | `10` | ≥ 0 | acts after a reload | How many windows of finished commands nerd-runs keeps; older ones close. |
| `NERD_BASH_MAX_CHARS` (advanced) | `8000` | ≥ 0 | acts after a reload | A longer bash output reaches the model as its head and tail, the whole of it in a file. 0: off. |
| `NERD_QUIET` (advanced) | `1` | 1 / 0 | acts at once | 1: quiet defaults for the model's commands (no colour, progress bars, npm fund/audit notices, pager). 0: off. |
| `NERD_LINT` (advanced) | `1` | 1 / 0 | acts after a reload | 1: a linter runs after each write or edit and its findings go with the result. 0: off. |
| `NERD_CALC` (advanced) | `0` | 1 / 0 | needs a Pi restart | 1: every calculation by a program: a rule in the system prompt, and a reply that computes by hand is cut and steered. |
| `NERD_SCOUT` | `0` | 1 / 0 | needs a Pi restart | Headless runs only. 1: the work and the plan step have scout: a question about the project goes to a helper session with reading tools only, its findings to notes/scout/. |
| `NERD_SCOUT_MAX_CALLS` (advanced) | `25` | ≥ 0 | acts at once | The scout's tool calls per question. |
| `NERD_SCOUT_MAX_MINUTES` (advanced) | `15` | ≥ 0 | acts at once | The scout's wall clock per question, in minutes. |

### guards

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_LOOP_GUARD_N` (advanced) | `3` | ≥ 0 | acts after a reload | Repeats of one call (same arguments, same result) before the loop guard's note to try another way. 0: off. |
| `NERD_LOOP_GUARD_HARD` (advanced) | `2` | ≥ 0 | acts after a reload | Notes on one looping call before the loop guard cuts the reply: the next repeat is cut and the model told what it looped on (twice per task), then the turn just ends. 0: notes only. |
| `NERD_REPEAT_GUARD` (advanced) | `1` | 1 / 0 | acts after a reload | 1: a reply that repeats one piece of text over and over is cut and steered, at most twice per task. 0: off. |
| `NERD_FETCH_GUARD` (advanced) | `1` | 1 / 0 | acts after a reload | 1: a note on a web_fetch 404 for an address that no web_search result had (a made-up address). 0: off. |

### context and memory

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_PI_VCC` | `1` | 1 / 0 | needs a Pi restart | 1: the pi-vcc package does every compaction, without a model call. 0: Pi's own compaction. |
| `NERD_REFLEX` (advanced) | `1` | 1 / 0 | needs a Pi restart | 1: an edit or write of a file shows the workspace's notes that name that file (once per note), taken out of the context a few turns later. 0: off. |
| `NERD_REFLEX_KEEP_TURNS` (advanced) | `2` | ≥ 0 | needs a Pi restart | Assistant turns a reflex note stays in the context before it is cut out (kept short: changing older messages costs the model server a re-read). |
| `NERD_VCC_RECALL` (advanced) | `0` | 1 / 0 | needs a Pi restart | 1: with pi-vcc on, the model also has its vcc_recall tool, a search of the session's earlier history. |
| `NERD_ANCHORS` (advanced) | `1` | 1 / 0 | acts after a reload | 1: after a compaction the task, PLAN.md, notes/ and the changed files are put back into the context. 0: off. |
| `NERD_ANCHORS_MAX_CHARS` (advanced) | `4000` | ≥ 1 | acts after a reload | The anchors' size in characters; each part is cut to fit. |
| `NERD_RULES_FILE` (advanced) | "" | text | acts after a reload | The operator's rules for every project (/remember, /forget). Empty: RULES.md in Pi's agent directory. |
| `NERD_RULES_MAX_CHARS` (advanced) | `4000` | ≥ 1 | acts after a reload | The rules' size in characters; what does not fit is named, not dropped silently. |
| `NERD_SUMMARY_GOAL` (advanced) | `1` | 1 / 0 | acts after a reload | 1: the compaction summary's goal is set to the task. 0: the goal as pi-vcc wrote it. |
| `NERD_THINKING_KEEP` (advanced) | `0` | text | acts after a reload | A number N: only the last N replies' thinking goes back to the model in each request. all: all of it, as Pi does. |

### web

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_WEB` | `1` | 1 / 0 | needs ./UP | 1: the web tools (web_search through a local SearXNG, which the container starts, and web_fetch). 0: no web tools and no SearXNG. |
| `NERD_WEB_NOTES` (advanced) | `1` | 1 / 0 | acts after a reload | 1: a copy of each fetched web page goes to notes/web/ of the project. 0: off. |
| `NERD_SEARXNG_PORT` (advanced) | `8888` | 1–65535 | needs ./UP | The port of the agent container's SearXNG, on loopback. |

### logs and debug

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_PI_VCC_DEBUG` (advanced) | `0` | 1 / 0 | needs a Pi restart | 1: pi-vcc's debug output. |

### session

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_MODEL` (advanced) | "" | text | needs a Pi restart | The model id the agent asks for. Empty: whatever the server serves. Required for Ollama, which serves many, and with NERD_LLAMA=provider. |
| `NERD_RETRIES` (advanced) | `8` | ≥ 0 | needs a Pi restart | Retries of a failed model request (a dropped connection, a server restarting) before the turn ends with the error; waits 2, 4, 8, 16 s, then 30 s each: 8 cover about 2.5 min of a network outage. |
| `NERD_SETTINGS_FILE` (advanced) | "" | text | needs a Pi restart | The file with the agent's settings, which /nerd edits and which wins over the container's environment. Empty: ~/.config/nerd/settings.env in the agent's home. |
| `NERD_TASK` (advanced) | "" | text | needs ./UP | The task of a headless container when none is given as its argument. |
| `NERD_PROBLEM_FILE` (advanced) | "" | text | needs ./UP | A headless run's task from this file, relative to the workspace, when none is given as an argument (before NERD_TASK). Edit it and run NERD_MODE=plan again: the plan is revised to it. |
| `NERD_MODE` (advanced) | "" | text | needs ./UP | A headless run's mode. Unset: the plan step, then the work under Ralph. plan: the plan only (PLAN.md there is revised, not written anew). solve: the work with no plan step and no Ralph, committed before and after. ralph: PLAN.md there carried out under Ralph without a plan step (none: as unset). The TUI has the commands /plan, /solve, /ralph instead. |
| `NERD_HEALTH_TIMEOUT` (advanced) | "" | ≥ 0 | needs ./UP | Seconds the agent's container waits for the model server; 0: no limit. Empty: 900 for a headless task, no limit in tui mode. |

### letters

| Setting | Default | Values | Change | What it does |
|---|---|---|---|---|
| `NERD_LETTERS_OPERATOR` (advanced) | `prompt` | prompt / inject / triage | acts at once | A letter from the agent's operator: prompt, a turn of its own; inject, into the context without a turn; triage, a short request to the model decides first (drop, a digest injected, or a turn). |
| `NERD_LETTERS_RING0` (advanced) | `inject` | prompt / inject / triage | acts at once | A letter from ring0, partners in a common work: prompt, a turn of its own; inject, into the context without a turn; triage, a short request to the model decides first (drop, a digest injected, or a turn). |
| `NERD_LETTERS_RING1` (advanced) | `inject` | prompt / inject / triage | acts at once | A letter from ring1, colleagues: prompt, a turn of its own; inject, into the context without a turn; triage, a short request to the model decides first (drop, a digest injected, or a turn). |
| `NERD_LETTERS_RING2` (advanced) | `triage` | prompt / inject / triage | acts at once | A letter from ring2, outside agents: prompt, a turn of its own; inject, into the context without a turn; triage, a short request to the model decides first (drop, a digest injected, or a turn). |
| `NERD_LETTERS_OTHERS` (advanced) | `triage` | prompt / inject / triage | acts at once | A letter from senders in no ring: prompt, a turn of its own; inject, into the context without a turn; triage, a short request to the model decides first (drop, a digest injected, or a turn). |
| `NERD_LETTERS_TURN_KINDS` (advanced) | `todo,query` | text | acts at once | Kinds of letter (agora's todo, query, note, status, answer, reply), comma-separated, that are a turn of their own where the sender's ring would inject them: a request or a question gets an answer. |
