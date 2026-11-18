# Operating nerd

## Start, stop, status

```sh
./UP                  # build the images if missing, start the server and the agent, wait, print how to connect
./UP --build          # rebuild first (after git pull); docker's cache keeps what did not change
./UP --rebuild        # rebuild everything from nothing when something is off: no cache, fresh base images, the host server too
tools/report.sh       # one archive with logs, checks and machine facts to send when something fails
./UP --no-wait        # return at once; ./STATUS says when it is ready
./UP --dry-run        # print the compose command and the resolved compose configuration only
./STATUS              # both containers, llama-server as the agent reaches it, sshd, the agent's tmux session, the app port
./DOWN                # stop and remove both containers; volumes stay
./DOWN --agent        # only the agent; the model stays loaded
./DOWN --purge        # ... and delete the workspace, logs/conversations, ssh host keys, home, caches
./DOWN --purge-models # ... and the model volume too
```

Two containers: the server `<name>-llm` (llama-server with the model, the GPU)
and the agent `<name>` (Pi, sshd, the workspace), on the network `<name>-net`
(docs/ARCHITECTURE.md). `compose.yaml` describes them; `./UP` works out the
machine (GPU and how docker reaches it, macOS, the ssh key, free ports),
passes the settings to docker compose and picks the overlays that fit
(`compose.cdi.yaml` or `compose.gpus.yaml`, `compose.netns.yaml`,
`compose.workspace-dir.yaml`, `compose.host-llama.yaml`). Run them through
`./UP`, not `docker compose` by hand: compose does not read `.env`. Both run
with `restart: unless-stopped`: they come back after a reboot or a docker
restart, and stay down after `./DOWN` or `docker stop`. `./UP` on a running
instance replaces only a container whose image or settings changed: after
`./UP --build` the agent's container is new, the volumes stay, the
conversation continues, processes the agent started (a web server) do not.
The model is not reloaded unless the server's variant, context, MTP settings
(`NERD_MTP`, `NERD_MTP_DRAFT`) or image changed. An `.env` made from an older
`env.example` pins `NERD_MODEL_VARIANT=q1`, which stays q1; empty the line (or
set `q1mtp`) to get the current default, q1 with its MTP head.

## What lives outside the containers

| volume | in the container | holds |
|---|---|---|
| `NERD_MODELS_VOLUME` (`nerd-models`) | server `/models` | the model, shared by every instance |
| `<name>-ws` (or `NERD_WORKSPACE`) | `/workspace` | the projects |
| `<name>-logs` | `/logs` | logs and Pi's conversations |
| `<name>-ssh` | `/ssh` | the ssh host keys (the fingerprint survives a rebuild) |
| `<name>-home` | `/home/nerd` | what the agent installed: `nerd-get go\|rust\|uv`, `npm -g`, uv tools; its memory |
| `<name>-cache` | `/home/nerd/.cache` | npm, go, uv, pip caches: safe to throw away |

`/tmp` is a tmpfs in both containers (`NERD_TMP_SIZE`, 2g): it is memory, it
is empty after a restart, and programs may run from it. Command-line tools
that change rarely (git, python3, sqlite3, jq, gcc and make, tcpdump, tmux,
shellcheck, ruff, biome) are in the image; languages and their packages are
not, `nerd-get` puts them in the home. The image puts nothing into
`/home/nerd` that it needs later: docker fills a new volume from the image
only once.

The first start downloads the model (6-7 GB, resumable, checked against a
pinned sha256); later starts take seconds. `./UP` shows the progress of both.

## Changing settings: `./SETTINGS` and `/nerd`

`./SETTINGS` on the host shows every setting with its value and where it comes
from (`.env` or the agent's settings file, or the default); Enter changes one, Esc closes. On
closing it applies what changed, asking first: `./UP` for the host's settings,
a restart of the agent's container for the agent's (Pi comes back and
continues the conversation). `./SETTINGS all` lists the tuning knobs too. It
runs from the agent's image, so `./UP` must have built that once.

`/nerd` in Pi does the same for the agent's own settings (thinking, Ralph, the
done gate, the scout, web, limits) without leaving the conversation. A change
acts at once, after a reload of the extensions (`/nerd` offers it), or after a
restart of Pi (`/quit`: in the container Pi starts again and continues); each
row says which. (Pi's own `/settings` is Pi's interface settings.)

The agent's settings are kept in `~/.config/nerd/settings.env` in its home
volume (`<name>-home`), lines `NAME=VALUE`; it outlives restarts and new
images, and wins over the container's environment. Editing it by hand is as
good. A name nerd does not know, or a value its setting does not allow, is
reported when Pi starts and left out. The full list with defaults:
[docs/SETTINGS.md](SETTINGS.md), generated from `agent/src/settings-registry.ts`.

## Settings: `.env`

`cp env.example .env` and edit; every line is optional, `env.example` explains
each. `.env` is read, not executed, and is git-ignored. A variable set in the
environment wins over the file (`NERD_NAME=test ./UP`). Within the file the
last line for a name wins, so `echo NERD_LLAMA=mlx >> .env` works; editing
the line that is there keeps the file readable.

| setting | default | |
|---|---|---|
| `NERD_NAME` | `nerd` | the agent's container and the compose project; the server's is `<name>-llm`, the network `<name>-net`, volumes `<name>-ws`, `-logs`, `-ssh`, `-home`, `-cache` |
| `NERD_IMAGE` | `nerd:agent` | the agent's image tag |
| `NERD_SERVER_IMAGE` | `nerd:server-sm<arch>` | the server's image tag |
| `NERD_CUDA_ARCH`, `NERD_CUDA_VERSION` | detected | the server's build arguments (see INSTALL.md) |
| `NERD_GPU` | `auto` | `cdi`, `gpus` or `auto` |
| `NERD_LLAMA` | `auto` | `container` (Linux), `host` (macOS: llama-server on the machine, MACOS.md), `mlx` (macOS: mlx-vlm's server, the model in MLX format, MACOS.md) or `remote` (a server on another machine, below) |
| `NERD_MODEL` | what the server serves | the model the agent asks for; required with Ollama, which serves many (`ollama list`) |
| `NERD_MODEL_VARIANT` | `q1mtp` (`q1` with `NERD_LLAMA=host`) | `q1mtp` (q1 with a multi-token-prediction head: generation 1.4-2.2x faster, ~750 MiB more VRAM; 64K fits 8 GB, tightly; `NERD_MTP=off` if it does not), `q1` or `q2` |
| `NERD_MTP` | `auto` | speculative decoding with the model's MTP head: `auto` (when the variant has one), `on` (any model; a `NERD_MODEL_GGUF` with a head), `off`; `NERD_MTP_DRAFT` tokens per step (1) |
| `NERD_MODEL_GGUF` | none | another GGUF: `hf:<owner>/<repo>/<file>.gguf[@rev]` (downloaded, sha256 checked; `NERD_MODEL_SHA256` pins it) or a file already in the models volume; named `NERD_MODEL_ALIAS` |
| `NERD_MLX_MODEL` | Bonsai 2, MLX 2-bit, pinned | `NERD_LLAMA=mlx`: `<owner>/<repo>[@rev]` or a directory; `NERD_MLX_APC=0` turns off the server's prefix cache |
| `NERD_LLAMA_URL` | `http://<name>-llm:<port>/v1` | the server as the agent's container reaches it (`127.0.0.1` with `NERD_NETWORK`, `host.docker.internal` with `host` or `mlx`) |
| `NERD_LLAMA_HOST`, `NERD_HOST_DIR`, `NERD_MLX_PYTHON` | `127.0.0.1`, `~/.nerd`, found | macOS only: the server's address, its directory, the Python for MLX (MACOS.md) |
| `NERD_SAMPLING` | none (mlx: the model card's) | sampling fields added to every request, e.g. `temperature=0.7,top_p=0.8,top_k=20` |
| `NERD_CTX` | `65536` | context in tokens |
| `NERD_SUDO` | `1` | `0`: the agent's user has no sudo in its container |
| `NERD_SSH_PORT` | `2222` | ssh into the agent's terminal |
| `NERD_APP_PORT` | `8000` | where the agent serves what it builds |
| `NERD_LLAMA_PORT` | `8080` | llama-server's port on `<name>-net` (not published), or on the Mac |
| `NERD_BIND` | `0.0.0.0` | host address the ports are published on; `127.0.0.1` keeps them local |
| `NERD_AUTHORIZED_KEYS_FILE` | `~/.ssh/id_ed25519.pub` (or ecdsa, rsa) | who may log in |
| `NERD_OPERATOR_URL` | none | the address you open the app at, told to the agent |
| `NERD_WORKSPACE` | volume `<name>-ws` | a host directory instead (writable by uid 1000) |
| `NERD_MODELS_VOLUME` | `nerd-models` | shared by all instances on the machine |
| `NERD_NETWORK` | none | `container:<name>`: both join another container's network, publish nothing |
| `NERD_TMP_SIZE` | `2g` | size of `/tmp` (a tmpfs) in both containers |
| `NERD_SHM_SIZE` | `1g` | the agent's `/dev/shm` (its headless browser) |
| `HF_TOKEN` | none | sent to Hugging Face if set |

### The model on another machine: `NERD_LLAMA=remote`

Only the agent runs here, with no GPU; the model is served by llama-server or
Ollama on another machine, which `./UP` neither starts nor stops:

```sh
NERD_LLAMA=remote
NERD_LLAMA_URL=http://<machine>:11434/v1   # as the agent's container reaches it
NERD_MODEL=qwen3.6:latest                  # Ollama: one of `ollama list`
```

With Ollama the context window is the server's (`OLLAMA_CONTEXT_LENGTH`, or the
model's own when memory allows); the agent reads it from Ollama, `NERD_CTX`
overrides. Thinking is turned off with `reasoning_effort`, which Ollama
understands. A request that fails on the network is retried for about 2.5 minutes
(`NERD_RETRIES`); past that the turn ends with the error, and `./STATUS` says
whether the server answers the agent.

### A cloud provider: `NERD_LLAMA=provider`

The model is a cloud provider's, through its OpenAI-compatible API. Its key
never enters the agent's container: a small key proxy, the container
`<name>-keyproxy`, holds it, and the agent talks to the proxy without one. The
model can use the key through the proxy but cannot read it or carry it off.

```sh
NERD_LLAMA=provider
NERD_PROVIDER_URL=https://openrouter.ai/api/v1
NERD_MODEL=<the provider's model id>
# NERD_PROVIDER_KEY_FILE=var/provider.key   the default
```

Put the key into that file, one line, and `chmod 600` it; `./UP` refuses a
file others can read. The window and the longest reply come from the
provider's model list where it gives them (OpenRouter does); otherwise set
`NERD_CTX`, and replies are capped at 8192 tokens. Thinking is the provider's
default for the model; the verifier is off (it needs logprobs and a prefilled
reply, which providers lack). `docker logs <name>-keyproxy` has one line per
request, never the key. A new key: write the file, then
`docker restart <name>-keyproxy`; the agent keeps running. `./STATUS` asks the
provider for its model list through the proxy and says whether it takes the key.

Several providers, each with its own key (free ones among them): make the key
file a table, a row per provider, and name the row the agent uses in
`NERD_PROVIDER_URL`:

```sh
# var/provider.key, chmod 600 — <name> <OpenAI-compatible base> <key>
llm7   https://api.llm7.io/v1          <token from token.llm7.io>
cline  https://api.cline.bot/api/v1    <API key from app.cline.bot>
```

```sh
NERD_LLAMA=provider
NERD_PROVIDER_URL=llm7
NERD_MODEL=<a model of llm7>
```

Every row is also served at `<proxy>/<name>/v1`, for other tools beside the
agent. A row may end in `only=<model>,<model>` (with one key:
`NERD_PROVIDER_MODELS=<model>,<model>`): the key is then spent on those models
alone, and a request for another is refused by the proxy before it reaches the
provider — for a key with credit on it that you mean to use on free models only.
So is a request that names other models or paid extras beside its own (the
fields `models`, `route`, `preset`, `plugins`: OpenRouter's fallbacks and web
search), and any method but POST and a GET without a body.

The proxy answers anyone who reaches it on its docker network: the agent, and
other tools of yours you point at it. On a machine shared with other users they
can reach it too. `NERD_KEYPROXY_AUTH=on` closes that: `./UP` makes a new token
at each start and keeps it in `var/keyproxy.token` (600); the agent sends it as
its API key, the proxy answers a request without it with 401, and a tool of
yours sends `Authorization: Bearer <that token>`. Get the keys on this machine, never in the agent's container: an API key
or token from the provider's site rather than a login that refreshes itself.
Free providers, as of 2026-10: some refuse requests from some countries, and a
free model that gives no answer once may answer an hour later.

## Your own additions: `compose.override.yaml`

Anything else for a container goes into `compose.override.yaml` next to
`compose.yaml` (git-ignored); `./UP` adds it when it exists, and compose
merges it over the rest. The agent's own variables can go here too
(`NERD_THINKING`, `NERD_RALPH`, ...; all in [docs/SETTINGS.md](SETTINGS.md)),
though `./SETTINGS` or `/nerd` is easier and its file wins over this; then the
server's (`NERD_LLAMA_ARGS`,
`NERD_KV`, `NERD_CACHE_RAM`), a proxy, one GPU of several:

```yaml
services:
  agent:
    environment:
      NERD_VERIFY_N: "2"
  llm:
    environment:
      HTTPS_PROXY: http://proxy:3128
      CUDA_VISIBLE_DEVICES: "0"
```

`./UP --dry-run` shows the merged result. (Before decision 0012 the same went
into `NERD_DOCKER_ARGS` / `NERD_SERVER_DOCKER_ARGS`; `./UP` now refuses those
and says where to move them.)

**Several instances on one machine:** give each its own `NERD_NAME` and
ports (a separate checkout, or `NERD_NAME=b NERD_SSH_PORT=2223
NERD_APP_PORT=8001 ./UP`). They share the model volume. Each has its own
server and loads its own copy of the model into GPU memory, so two need twice
the VRAM. (Several agents on one server — llama-server with more slots — is
possible by hand: `NERD_SLOTS` and `NERD_CTX` for the server, `NERD_BASE_URL`
for each agent; `./UP` does not do it.)

## Connecting

```sh
ssh -p 2222 nerd@<host>        # attaches to the agent's terminal (Pi in tmux)
```

- **Login** is by public key only, as user `nerd`: no password, no root login.
  Inside the container `nerd` (you, and the agent) has `sudo` without a password
  for what needs root, such as `sudo tcpdump -i any port 8000` or
  `sudo apt-get install …` (gone on the next `./UP --build`; lasting tools go
  to the home volume, `nerd-get`). The container is the boundary: it runs without
  `--privileged`. `NERD_SUDO=0` in `.env` turns sudo off. The
  keys are the lines of `NERD_AUTHORIZED_KEYS_FILE`, read when the container
  is created (`./UP` again after changing them; the server is not touched). The host key is generated on
  the first start and kept in the `<name>-ssh` volume, so its fingerprint
  survives `./UP`; `docker logs <name> | head` prints it.
- **Detach** with `Ctrl-b d`; the agent keeps working. Log in again to come
  back. Two logins see the same screen.
- **Run a command** instead of attaching: `ssh -p 2222 nerd@<host> <command>`,
  e.g. `tmux capture-pane -p -t nerd` prints the agent's screen.
- **Watch the agent's commands:** each one runs in a window of tmux session
  `nerd-runs` (`c<N>` a command, `b<N>` one in the background, a dev server say).
  From the agent's screen `Ctrl-b s` lists both sessions; or log in with
  `ssh -t -p 2222 nerd@<host> tmux attach -t nerd-runs`. `Ctrl-b n`/`p` go
  through the windows; `Ctrl-c` in one stops that command (the agent sees exit
  code 130). The last `NERD_RUNS_KEEP` (10) finished windows stay; background
  commands end with the agent's session. `NERD_RUNS=0` turns the windows off.
- **PuTTY:** Connection → Data → Terminal-type `xterm`; Window → Translation →
  UTF-8; the private key (converted to `.ppk` by PuTTYgen) in Connection → SSH
  → Auth → Credentials; user `nerd`. The session runs with `LANG=C.UTF-8`;
  without a UTF-8 locale tmux draws its borders as `qqqq` in PuTTY.

## Talking to the agent

The agent starts in conversation: it answers in words, may read the project,
and changes nothing. When what you ask is work, it says how it would go about
it and offers a mode; the work starts only when you choose one:

| command | what happens | who checks |
|---|---|---|
| `/plan [text]` | assumptions, questions, a plan in `PLAN.md`, committed; then it stops for you to read. From then on each message of yours revises the plan (revised, not written anew; each revision a commit "Plan" on top, so `git diff HEAD~1 PLAN.md` shows what changed), until `/solve`, `/ralph` or `/talk`. A `PLAN.md` left from an earlier session is not revised: the first `/plan` writes a new one (the old stays in git) | you |
| `/solve [text]` | the work, as the agent sees fit: no plan step, no check loop. The harness commits what is uncommitted when the cycle starts ("Before solve") and when it ends ("Solve: …"); a remark after it is the next cycle | you |
| `/ralph [text]` | `PLAN.md` carried out: when the work ends, the harness checks the committed project in a clean clone and runs the plan's DONE WHEN check commands there; a failure is a new round (`NERD_RALPH=0` off). Refused without a `PLAN.md` | the checks |
| `/task <text>` | both at once, as before: questions and a plan, then the work under the checks | the checks |
| `/talk [text]` | back to conversation | — |

With no text, `/plan` and `/solve` take what you said in the conversation since
the last of them as the task (`PLAN.md` quotes it). Answer the plan's questions, or say "your
call". Anything typed while it works is queued as a remark and delivered after
its current step. A headless run picks its mode with `NERD_MODE` (below).

**Your rules for every project.** `/remember <text>` keeps a rule ("commit
messages in English, imperative", "serve on port 8123 by default") in
`~/.pi/nerd/RULES.md` in the agent's home, which survives `./UP --build`; the
model gets the list in its system prompt from your next message on, in this and
every later project. `/rules` shows the list, `/forget <number or text>` drops
one. Only you write the file: the model has no tool for it.

`/spec-check` checks the work against the task clause by clause. Details: the README, "Talking to the agent: `tui`".

Conversations are stored in the logs volume (`/logs/sessions`). If Pi exits
(`/quit`, a crash) it starts again and continues the last conversation; so
does a new container on the same volumes. `./DOWN --purge` starts from scratch.

## What the agent builds: ports and the operator address

The agent is told to serve anything meant for a browser on `0.0.0.0` at
`NERD_APP_PORT`; `./UP` publishes that port, so `http://<host>:8000` opens it.

From inside its container the agent cannot know the name under which you
reach the machine (a DNS name, a VPN name, a forwarded port). Set
`NERD_OPERATOR_URL` (e.g. `http://gpu-box.example:8000`) and the agent is told
as a fact that this is where you open the app, and names it when it reports;
without it the agent knows only the port.

Without publishing the app port, an ssh tunnel reaches it too:
`ssh -L 8000:127.0.0.1:8000 -p 2222 nerd@<host>`, then `http://localhost:8000`.

To put the ports on a VPN without publishing them on the host, run the
containers in the network namespace of a VPN client container:
`NERD_NETWORK=container:<vpn container>`. Nothing is published then; the ports
are reached at the VPN address, and containers sharing one namespace need
different `NERD_SSH_PORT`, `NERD_APP_PORT` and `NERD_LLAMA_PORT`. The server
listens on loopback there, not on the VPN. Both have to be recreated
(`./DOWN && ./UP`) whenever the VPN container is.

An example with Tailscale, as its own compose project next to nerd (the state
volume keeps the node's identity across restarts):

```yaml
# tailscale/compose.yaml — docker compose up -d, then ./UP with
# NERD_NETWORK=container:nerd-ts in nerd's settings
services:
  tailscale:
    image: tailscale/tailscale:stable
    container_name: nerd-ts
    hostname: nerd
    environment:
      TS_AUTHKEY: ${TS_AUTHKEY:-}   # empty: the log prints a login URL (docker logs nerd-ts)
      TS_AUTH_ONCE: "true"
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: "false"
      # Some networks break the long poll to the coordination server on port 80:
      # the node goes offline about two minutes after each start. "true" keeps it on 443.
      TS_FORCE_NOISE_443: ${TS_FORCE_NOISE_443:-}
    volumes: [state:/var/lib/tailscale]
    devices: [/dev/net/tun:/dev/net/tun]
    cap_add: [NET_ADMIN, NET_RAW]
    restart: unless-stopped
volumes:
  state:
```

Then `ssh -p <NERD_SSH_PORT> nerd@nerd` and the app at `http://nerd:<NERD_APP_PORT>`
from any machine of the tailnet.

## `browse`: how the agent checks a page

The image has a headless Chromium and a `browse` command; the agent uses it to
check a page the way you will see it (status, content type, console errors,
uncaught exceptions, failed requests, visible text, actions like click and
fill). You can use it too, from a login: `browse http://localhost:8000/`.
Options: README, "`browse`".

## Headless: one task, no conversation

The agent's image also runs one task to the end and exits, for scripts and CI,
against a running server (the one `./UP` started, on `<name>-net`):

```sh
docker run --rm --network nerd-net -e NERD_BASE_URL=http://nerd-llm:8080/v1 \
    -v "$PWD/work":/workspace nerd:agent "<task>"
```

Without `./UP`, start the server first: README, "Running the containers by
hand".

The exit code is 0 when the agent finished with a final answer and, under the
checks, the plan's Done when showed it done (at least one check run and none
failing); 1 when it did not, 2 for bad arguments; SIGTERM (`docker stop`) and SIGINT abort the turn and
end the run cleanly, 143 and 130. Questions in
the plan step are answered with `NERD_PLAN_ANSWER` (default «на твоё
усмотрение», Russian for "your call").
The event log goes to `/logs` (mount it to keep it).

The task can also be a file in the workspace: `-e NERD_PROBLEM_FILE=PROBLEM.md`
and no task argument. `NERD_MODE` picks what the run does with it:

| `NERD_MODE` | what the run does | exit 0 when |
|---|---|---|
| unset | questions and a plan, then the work under the checks, as above | the final answer, the checks passed |
| `plan` | the plan only, committed as "Plan"; a `PLAN.md` there is revised to the task, not written anew | the plan saved and committed (or the same as the last "Plan") |
| `solve` | the work with no plan step and no check loop; what is there is committed before ("Before solve") and after ("Solve: …") | the final answer |
| `ralph` | a `PLAN.md` there is carried out under the checks, with no plan step (no task needed: a task given is added to the ask); without one, as unset | the final answer, the checks passed |

For a plan you shape before any work: write `PROBLEM.md`, run with
`NERD_MODE=plan`, read `PLAN.md`, change `PROBLEM.md`, run again (the plan is
revised and committed on top, beside your change), and when it is right run
with `NERD_MODE=ralph`.
[`acceptance/check.sh`](../acceptance/check.sh) checks a result against the
acceptance criteria of the reference task; see the README.

## Under a session manager: `hold`

A program that runs agents for you (starts and stops sessions, carries
messages to them) can start Pi itself instead of the container doing it. In
`hold` mode the agent's container runs only SearXNG, no Pi and no sshd, and
waits; the manager runs Pi with `docker exec`:

```sh
docker exec -it <name> nerd-pi tui [--continue]   # Pi's TUI in /workspace, sessions in /logs/sessions
docker exec <name> nerd-pi run "<task>"           # the headless run, event log /logs/events-<time>.jsonl
```

Exit codes are the headless run's (above). Stop a `run` with SIGTERM to its
process inside the container (`docker exec <name> kill -TERM <pid>`), not to
the `docker exec` client; stop the TUI as a person would, with `/quit` (Escape
first if it is busy, then Ctrl-C to clear the editor).

`AGORA_PI_CHANNEL=<socket path in the container>` (the older name
`NERD_AGORA_CHANNEL` is read when it is not set) connects Pi to the
manager's channel, a unix socket in a directory the manager mounts: Pi reports
its session's events (start, each prompt and tool call, end of a turn,
compaction, context used, end), takes the manager's letters as messages, and
gets a `send_letter` tool to write back. The manager keeps any account or
token itself; nothing of it enters the container. Without the variable none of
this loads ([`agent/src/agora-channel.ts`](../agent/src/agora-channel.ts)).
How a letter reaches the model depends on the sender's ring, which the manager
puts in the letter from its rights table (the letter cannot claim one):
`NERD_LETTERS_OPERATOR`, `_RING0`, `_RING1`, `_RING2`, `_OTHERS` are each
`prompt` (a message of its own: a turn), `inject` (into the context with its
author, no turn; the model sees it at its next step) or `triage` (one short
request to the model first: dropped, a digest injected, or a turn; a sender in
no ring never gets a turn). By default the operator prompts, ring0 and ring1
inject, ring2 and others are triaged; a request or a question
(`NERD_LETTERS_TURN_KINDS`) from an injecting ring is a turn. A dropped letter
is in the session file as an `agora-letter-dropped` entry. A letter without a
ring (an older manager) is a prompt, as before
([`agent/src/letter-delivery.ts`](../agent/src/letter-delivery.ts)).
A prompted letter reaches the model as a message from its operator, so whoever
the manager lets write to the agent that way can direct it as you can, with
everything the container gives it: decide that in the manager, not in the
container.

## Logs

| where | what |
|---|---|
| `var/log/up-<time>.log` (in the repository) | everything `./UP` printed; `tools/llama-host.sh` and `tools/mlx-host.sh` write theirs there too |
| `docker logs <name>-llm` | the server: model download, llama-server (macOS: `~/.nerd/llama-server.log` or `mlx-server.log`) |
| `docker logs <name>` | the agent's entrypoint: host key fingerprint, waiting for the server |
| `/logs/sessions/` | conversations (Pi's session files) |
| `/logs/sshd.log` | logins |
| `/logs/searxng.log` | the web search behind `web_search` |
| `/logs/events-*.jsonl` | a headless run's event log |
| `/logs/verifier-*.jsonl` | the verifier's decisions, when `NERD_VERIFY_N` > 1 |

`docker exec <name> ls /logs`, or log in and look. Problems:
[MAINTAIN.md](MAINTAIN.md#troubleshooting).
