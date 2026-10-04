# Operating nerd

## Start, stop, status

```sh
./UP                  # build the images if missing, start the server and the agent, wait, print how to connect
./UP --build          # rebuild first (after git pull)
./UP --no-wait        # return at once; ./STATUS says when it is ready
./UP --dry-run        # print the docker commands only
./STATUS              # both containers, llama-server as the agent reaches it, sshd, the agent's tmux session, the app port
./DOWN                # stop and remove both containers; volumes stay
./DOWN --agent        # only the agent; the model stays loaded
./DOWN --purge        # ... and delete the workspace, logs/conversations, ssh host keys
./DOWN --purge-models # ... and the model volume too
```

Two containers: the server `<name>-llm` (llama-server with the model, the GPU)
and the agent `<name>` (Pi, sshd, the workspace), on the network `<name>-net`
(docs/ARCHITECTURE.md). Both run with `--restart unless-stopped`: they come
back after a reboot or a docker restart, and stay down after `./DOWN` or
`docker stop`. `./UP` on a running instance replaces the agent's container and
keeps the volumes: the conversation continues, processes the agent started (a
web server) do not. The server's container is kept if it runs with the same
image and settings, so the model is not reloaded; a change of variant,
context or image replaces it.

The first start downloads the model (6-7 GB, resumable, checked against a
pinned sha256); later starts take seconds. `./UP` shows the progress of both.

## Settings: `.env`

`cp env.example .env` and edit; every line is optional, `env.example` explains
each. `.env` is read, not executed, and is git-ignored. A variable set in the
environment wins over the file (`NERD_NAME=test ./UP`).

| setting | default | |
|---|---|---|
| `NERD_NAME` | `nerd` | the agent's container; the server's is `<name>-llm`, the network `<name>-net`, volumes `<name>-ws`, `<name>-ssh`, `<name>-logs` |
| `NERD_IMAGE` | `nerd:agent` | the agent's image tag |
| `NERD_SERVER_IMAGE` | `nerd:server-sm<arch>` | the server's image tag |
| `NERD_CUDA_ARCH`, `NERD_CUDA_VERSION` | detected | the server's build arguments (see INSTALL.md) |
| `NERD_GPU` | `auto` | `cdi`, `gpus` or `auto` |
| `NERD_LLAMA` | `auto` | `container` (Linux) or `host` (macOS: the server on the machine, MACOS.md) |
| `NERD_MODEL_VARIANT` | `q1` | `q1` or `q2` |
| `NERD_CTX` | `65536` | context in tokens |
| `NERD_SSH_PORT` | `2222` | ssh into the agent's terminal |
| `NERD_APP_PORT` | `8000` | where the agent serves what it builds |
| `NERD_LLAMA_PORT` | `8080` | llama-server's port on `<name>-net` (not published), or on the Mac |
| `NERD_BIND` | `0.0.0.0` | host address the ports are published on; `127.0.0.1` keeps them local |
| `NERD_AUTHORIZED_KEYS_FILE` | `~/.ssh/id_ed25519.pub` (or ecdsa, rsa) | who may log in |
| `NERD_OPERATOR_URL` | none | the address you open the app at, told to the agent |
| `NERD_WORKSPACE` | volume `<name>-ws` | a host directory instead (writable by uid 1000) |
| `NERD_MODELS_VOLUME` | `nerd-models` | shared by all instances on the machine |
| `NERD_NETWORK` | none | `container:<name>`: both join another container's network, publish nothing |
| `NERD_DOCKER_ARGS` | none | more `docker run` arguments for the agent, e.g. `-e NERD_VERIFY_N=2` |
| `NERD_SERVER_DOCKER_ARGS` | none | the same for the server, e.g. `-e HTTPS_PROXY=...` or `-e NERD_LLAMA_ARGS=...` |
| `HF_TOKEN` | none | sent to Hugging Face if set |

The agent's own variables (`NERD_THINKING`, `NERD_VERIFY_N`,
`NERD_SPEC_CHECK`, `NERD_BASH_TIMEOUT`, `NERD_PLAN_STEP`, `NERD_LOOP_GUARD_N`,
`NERD_PI_VCC` ...) are passed with `NERD_DOCKER_ARGS="-e NAME=value"`; the README's
"Settings" section and the header of `agent/src/run.ts` describe them.

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

- **Login** is by public key only, as user `nerd`: no password, no root. The
  keys are the lines of `NERD_AUTHORIZED_KEYS_FILE`, read when the container
  is created (`./UP` again after changing them; the server is not touched). The host key is generated on
  the first start and kept in the `<name>-ssh` volume, so its fingerprint
  survives `./UP`; `docker logs <name> | head` prints it.
- **Detach** with `Ctrl-b d`; the agent keeps working. Log in again to come
  back. Two logins see the same screen.
- **Run a command** instead of attaching: `ssh -p 2222 nerd@<host> <command>`,
  e.g. `tmux capture-pane -p -t nerd` prints the agent's screen.
- **PuTTY:** Connection → Data → Terminal-type `xterm`; Window → Translation →
  UTF-8; the private key (converted to `.ppk` by PuTTYgen) in Connection → SSH
  → Auth → Credentials; user `nerd`. The session runs with `LANG=C.UTF-8`;
  without a UTF-8 locale tmux draws its borders as `qqqq` in PuTTY.

## Talking to the agent

Type the task and press Enter. The first message of a conversation is a new
task: the agent first lists its assumptions and questions and writes a plan;
answer the questions, or say "your call". Anything typed while it works is
queued as a remark and delivered after its current step. `/task <text>` starts
a new task in the same conversation; `/spec-check` checks the work against the
task clause by clause. Details: the README, "Talking to the agent: `tui`".

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

The exit code is 0 when the agent finished with a final answer. Questions in
the plan step are answered with `NERD_PLAN_ANSWER` (default «на твоё
усмотрение», Russian for "your call").
The event log goes to `/logs` (mount it to keep it).
[`acceptance/check.sh`](../acceptance/check.sh) checks a result against the
acceptance criteria of the reference task; see the README.

## Logs

| where | what |
|---|---|
| `docker logs <name>-llm` | the server: model download, llama-server |
| `docker logs <name>` | the agent's entrypoint: host key fingerprint, waiting for the server |
| `/logs/sessions/` | conversations (Pi's session files) |
| `/logs/sshd.log` | logins |
| `/logs/verifier-*.jsonl` | the verifier's decisions, when `NERD_VERIFY_N` > 1 |

`docker exec <name> ls /logs`, or log in and look. Problems:
[MAINTAIN.md](MAINTAIN.md#troubleshooting).
