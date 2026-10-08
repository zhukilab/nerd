# Maintaining nerd

Everything the image is built from is pinned: the llama.cpp fork's tag, the
Node.js version (checked against its SHASUMS256), every npm package (exact
versions plus `package-lock.json`), the model files (size and sha256), the
CUDA base images by version. An update is a change to one of these pins,
then a rebuild and the checks below. Nothing updates itself.

| what | pinned in | |
|---|---|---|
| llama.cpp fork | `Dockerfile`: `LLAMA_REPO`, `LLAMA_REF` | PrismML's fork; stock llama.cpp cannot run the model. `tools/llama-host.sh` (macOS) builds the same tag, read from the Dockerfile |
| CUDA | `Dockerfile`: `CUDA_VERSION` (default), `./UP` picks 13.0.1 for sm_100+ | |
| Ubuntu base | `Dockerfile`: `UBUNTU_VERSION` (agent: 26.04), `CUDA_UBUNTU_VERSION` (server: what NVIDIA's CUDA images exist for) | the agent's fd must know `--no-require-git` (fd 8.6+): Pi's `find` passes it |
| Node.js | `Dockerfile`: `NODE_VERSION` | official tarball, hash checked |
| Pi, Pi packages, Playwright, undici | `agent/package.json` (exact) + `agent/package-lock.json` | Pi packages: `@sting8k/pi-vcc`, `@juicesharp/rpiv-web-tools` (`agent/src/packages.ts`) |
| Chromium for `browse` | follows `playwright-core` | installed by Playwright's own installer |
| the model | `container/model.sh`: `repo`, file, `size`, `sha` per variant; llama-server's arguments | used by the image and by `tools/llama-host.sh` |
| SearXNG (web search) | `Dockerfile`: `SEARXNG_REPO`, `SEARXNG_REF` (a commit); its Python requirements are pinned by SearXNG itself | settings: `container/searxng.yml`; runs on the agent image's python3 |

## Rebuild

```sh
git pull
./UP --build          # rebuild both images, recreate what changed; volumes stay
```

or by hand: `docker build -t nerd:agent .` and `docker build -t nerd:server-sm86
--target server --build-arg CUDA_ARCH=86 .`. Docker's layer cache makes a
rebuild after an agent-only change take a minute, and `./UP` then keeps the
server running (the model stays loaded); a new `LLAMA_REF` or `CUDA_VERSION`
recompiles llama-server (4-8 minutes) and replaces the server's container.
`docker builder prune` reclaims the cache, `docker image prune` old images.

## Checks

| check | how | needs |
|---|---|---|
| agent unit tests | `cd agent && npm ci && npm test` | Node ≥ 22.19 |
| agent types | `cd agent && npm run typecheck` | |
| acceptance checker | `node --test acceptance/test/*.test.mjs`; `acceptance/selftest.sh <out>` | docker for the self-test |
| pkill/pgrep guard | `docker run --rm --entrypoint /opt/nerd/test-pkill-guard.sh nerd:agent` | the agent image |
| `browse` in the image | `docker run --rm --entrypoint /opt/nerd/test-browse.sh nerd:agent` | the agent image |
| shell scripts | `shellcheck -x UP DOWN STATUS tools/*.sh` (clean); `container/*.sh acceptance/*.sh` | shellcheck |
| the whole thing | `./UP`, `./STATUS` green, log in, give it a small task ("create hello.html with the text hi and serve it on the app port"), open the page | a GPU |

Tests and scripts leave nothing in `$TMPDIR`: each makes its own temp dirs and
removes them (`agent/test/tmp.ts`, `trap` in the shell scripts), and prints one
it could not remove. `npm test` points Node's compile cache at
`~/.cache/nerd` and turns jiti's file cache off; what remains after it in
`$TMPDIR` is npm's own `node-compile-cache` (set `NODE_COMPILE_CACHE` before
`npm` to move that too). A headless run (`npm run run`) removes its agent dir,
unless the session is in it (no `NERD_SESSION_DIR`): then it prints the path.

## Updating the model

The model files and their hashes are in `container/model.sh`. For a new
upload of Bonsai 2, or another model in the same format:

1. Read the file list with sizes and hashes from the Hugging Face API:
   `curl -s https://huggingface.co/api/models/<repo>/tree/main` — `size` and
   `lfs.oid` (the sha256) of each `.gguf`. Not the web page.
2. Change `repo`, the file name, `size` and `sha` of the variant.
3. A new architecture or quantization may need a newer fork (below) and a
   different chat template; the agent relies on llama-server's `--jinja`
   template for tool calls (Qwen3 XML format for Bonsai 2).
4. Check GPU memory at the default context (`nvidia-smi` while the server
   runs) and update the table in INSTALL.md and the estimate in
   `tools/check-prerequisites.sh` (`base`, 23 KiB per token).

A file already in the models volume is reused only if its size and the hash
recorded at download match; a changed pin downloads the new file next to it.
Old files can be deleted with `docker run --rm -v nerd-models:/m alpine ls -l /m`
and `rm`.

To try a GGUF without changing the pins: `NERD_MODEL_GGUF=hf:<owner>/<repo>/<file>.gguf`
in `.env` and `./UP` (downloaded into the models volume once, checked against
the sha256 Hugging Face publishes for it — its resolve URL's `X-Linked-Etag` —
and that hash kept next to the file; `NERD_MODEL_SHA256` pins one), or a file
already in the volume by its name (`NERD_MODEL_FILE`, the older name, still
works). `container/model.sh`, `nerd_model_select`, is shared by the image and
`tools/llama-host.sh`.

## The MLX server (macOS, `NERD_LLAMA=mlx`)

`tools/mlx-host.sh` installs `tools/mlx-requirements.txt` with
`--require-hashes` into a venv. The top-level pins are in
`tools/mlx-requirements.in` (the set PrismML's Bonsai-demo tests the MLX pack
with: `scripts/requirements-mlx-vlm.txt` there). After changing them:

```sh
python3 tools/mlx-lock.py > tools/mlx-requirements.txt   # any OS: pip downloads the Mac's wheels
```

It refuses an sdist (a package without a macOS arm64 wheel would build on the
Mac). The default model is pinned by revision in `tools/mlx-host.sh`
(`DEFAULT_MODEL`), together with the sha256 of the pack's `files.json`, which
lists every file's size and sha256 (`tools/mlx-verify.py` checks them after the
download). A new revision: take its commit from
`https://huggingface.co/api/models/<repo>` (`sha`) and its `files.json`'s sha256.
Bonsai 2's pack needs mlx-vlm's `prism_hadamard_qwen35` loader; an mlx-vlm
without it fails `install`.

## Updating Pi (the agent framework)

Pi's packages are `@earendil-works/pi-agent-core`, `pi-ai` and
`pi-coding-agent`, pinned to one exact version together.

```sh
cd agent
npm view @earendil-works/pi-coding-agent version          # latest
npm install --save-exact @earendil-works/pi-agent-core@X @earendil-works/pi-ai@X @earendil-works/pi-coding-agent@X
npm run typecheck && npm test
```

What has broken before, and where to look:

- The interactive `main()` replaces `globalThis.fetch` with its own undici; the
  verifier uses its own pinned `undici` for that reason
  (`agent/src/verifier/llama.ts`).
- Since 0.99 a non-zero bash exit is a result with `isError`, not an
  exception (`agent/src/bash-tool.ts`).
- Since 1.0 the TUI defaults to fullscreen; nerd sets `tuiMode: "regular"` so
  tmux scrollback and `capture-pane` keep working.
- Built-in extensions are disabled with `--no-extensions`; nerd's extension is
  loaded inline (`agent/src/tui.ts`).
- `engines.node`: check Pi's requirement against `NODE_VERSION`.

Then rebuild and run the whole-thing check, in the TUI and headless.

**Pi packages** (third-party extensions from npm, listed in
`agent/src/packages.ts`) are pinned like Pi and loaded from `node_modules` by
path, never with `pi install`. Their peer range must include the Pi version
(`npm view <name>@<version> peerDependencies`). After a change:
`npm install --save-exact <name>@<version>`, `npm test` (it loads pi-vcc, calls
`vcc_recall` with `NERD_VCC_RECALL=1` and compacts without a model request), then a long run with
several compactions. pi-vcc writes its config to `PI_VCC_CONFIG_PATH`, which
nerd points into Pi's agent directory and rewrites on start.

`playwright-core` decides which Chromium the image downloads. After changing
its version, rebuild and run `test-browse.sh` in the image.

## Updating the llama.cpp fork

```sh
git ls-remote --tags https://github.com/PrismML-Eng/llama.cpp | tail
```

Set `LLAMA_REF` in the Dockerfile to the new tag, rebuild, and check:

- the server starts and `/health` answers (`./STATUS`);
- answers are sane: a broken quantization kernel does not fail, it produces
  garbage. Ask something with a checkable answer (17·23 = 391; a short
  function) through the TUI or `curl http://127.0.0.1:8080/v1/chat/completions`
  inside the server's container (`docker exec <name>-llm curl ...`);
- speed and GPU memory against the numbers in INSTALL.md / README.

The fork's CMake turns `CUDA_ARCH=12X` into `12Xa`; `GGML_NATIVE=OFF` keeps the
CPU code portable. Never substitute stock llama.cpp for this model.

## Updating Node.js or CUDA

`NODE_VERSION`: any current LTS; the hash is checked automatically against
nodejs.org's `SHASUMS256.txt`. `CUDA_VERSION`: the `nvidia/cuda`
`-devel-` and `-runtime-` images must both exist for that version, Ubuntu
version and CPU architecture, and the host driver must support it; Blackwell
GPUs need 12.8 or later.

## Troubleshooting

`./STATUS` first, then `docker logs <name>-llm` (the server) and
`docker logs <name>` (the agent).

| symptom | cause | fix |
|---|---|---|
| `./UP`: "docker is not usable" | not in group docker, or the daemon is down | `tools/check-prerequisites.sh` says which |
| `./STATUS`: llama WAIT for long, agent log "still waiting for …/health" | the server is downloading or loading the model, or fails to start | `docker logs <name>-llm` |
| the agent's container stops: "NERD_BASE_URL is not set" | the agent image run without a server | `./UP` sets it; by hand: README, "Running the containers by hand" |
| `could not select device driver "nvidia"` / `unresolvable CDI devices` | toolkit or CDI not set up for this docker | `tools/install-prerequisites.sh`; `NERD_GPU=gpus` or `cdi` in `.env` forces one |
| container restarts, log: `tui: no public key` | no key reached the container | `NERD_AUTHORIZED_KEYS_FILE`, then `./UP` |
| `Permission denied (publickey)` | the private key does not match, or the user is not `nerd` | `ssh -i <key> -p <port> nerd@<host>`; in PuTTY the user is set in the session |
| `REMOTE HOST IDENTIFICATION HAS CHANGED` | `./DOWN --purge` deleted the host keys | `ssh-keygen -R "[<host>]:<port>"` |
| download stops or repeats | network; the download resumes on restart | `docker logs <name>-llm`; behind a proxy: `HTTPS_PROXY` for the `llm` service in `compose.override.yaml` (docs/OPERATE.md) |
| `sha256 mismatch` | corrupted download or the file changed upstream | the partial file is removed; restart. If it repeats, the upstream file changed: update the pin (above) |
| `llama-server exited during startup`, `cudaMalloc failed: out of memory` | not enough GPU memory | smaller `NERD_CTX`, `q1`, close other GPU users |
| `CUDA driver version is insufficient` / `no kernel image is available` | the image's CUDA is newer than the driver, or built for another GPU | update the driver, or set `NERD_CUDA_VERSION`/`NERD_CUDA_ARCH` and `./UP --build` |
| everything works but 3-8× slower than expected | **silent GPU memory overflow** (below), or a quiet laptop power mode | below |
| the model answers nonsense | stock llama.cpp, or a fork version with a broken kernel | rebuild from the pinned `LLAMA_REF` |
| tmux borders drawn as `qqqq` | the terminal is not UTF-8 | PuTTY: Translation → UTF-8; the session already sets `LANG=C.UTF-8` |
| the agent's web server is gone | a new agent container (restart, `./UP`) does not restart processes the agent started | ask the agent to start it again |
| the agent stops with "Context overflow recovery failed" | the conversation outgrew the context | a larger `NERD_CTX` if memory allows; `/task` starts a fresh task |
| the agent repeats the same command | the model looped; the loop guard tells it after `NERD_LOOP_GUARD_N` repeats | interrupt with a remark (type and Enter) |

**Silent GPU memory overflow.** On WSL2 (and Windows generally) the driver
does not fail when GPU memory runs out: it moves the excess to shared system
memory, and llama-server runs 3-8 times slower with no error. Signs:
`nvidia-smi` shows `memory.used` within ~250 MiB of the card's total; in
Windows' Task Manager the GPU's "Shared GPU memory" grows; `dmesg` in WSL may
show `dxgkio_make_resident: Ioctl failed: -12`. Only when shared memory is
exhausted too does it fail (`cudaMalloc failed`). Fix: a smaller context
(`NERD_CTX=32768`), close other programs that use the GPU (browsers, a second
nerd), keep `--cache-ram 0` (the entrypoint's default: llama-server's prompt
cache keeps KV snapshots in GPU memory, about 1.3 GiB each at 32K).
`tools/check-prerequisites.sh` estimates the need for the configured variant
and context.
