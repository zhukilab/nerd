# Installing nerd

nerd needs a Linux machine (or Windows with WSL2) with an NVIDIA GPU of 8 GB
or more, Docker, and the NVIDIA Container Toolkit. **macOS on Apple silicon**
runs the model on the Mac itself and the agent in its container:
[MACOS.md](MACOS.md) (so far run on one Mac). Everything else is in two images built from this repository — the
server's (CUDA runtime, llama-server) and the agent's (Node.js, the agent, a
headless browser) — and the model is downloaded on first start.

```sh
git clone --depth=1 https://github.com/zhukilab/nerd && cd nerd
tools/check-prerequisites.sh            # what is OK / WARN / MISSING, with a hint per line
tools/install-prerequisites.sh          # Ubuntu/Debian: prints the plan, changes nothing
tools/install-prerequisites.sh --yes    # ... and does it (sudo)
cp env.example .env                     # optional: ports, key, variant, context
./UP
```

## Platforms

| platform | status | notes |
|---|---|---|
| Linux x86_64 + NVIDIA (Turing or newer) | tested on an RTX 3080 Laptop (8 GB, sm_86) | the default build: `CUDA_ARCH=86`, CUDA 12.4.1 |
| Windows 11 + WSL2 + NVIDIA | tested (the same laptop) | Docker Engine inside a WSL2 Ubuntu distribution; see below |
| Linux aarch64, NVIDIA GB10 (DGX Spark and similar) | tested | `CUDA_ARCH=121`, CUDA 13.0.1; GPU through CDI; detected automatically |
| RTX 40xx (sm_89), RTX 50xx (sm_120) | should work, untested | `./UP` detects the compute capability; sm_100+ builds with CUDA 13.0.1, which needs driver 580+ |
| macOS on Apple silicon | run on one Mac (M1 Pro, 16 GB) | llama-server with Metal or MLX on the Mac, the agent in Docker Desktop: [MACOS.md](MACOS.md) |
| AMD or Intel GPUs | no | the container build has only PrismML's CUDA kernels |
| no GPU (CPU only) | no, not tried | `./UP` has no CPU mode; a 27B model on a CPU would be far too slow for an agent anyway |

The NVIDIA driver must be 550 or newer (CUDA 12.4.1), 580 or newer for
sm_100+. `./UP` reads the compute capability from `nvidia-smi` and passes it to the
build as `CUDA_ARCH` (e.g. `8.6` → `86`); `NERD_CUDA_ARCH` and
`NERD_CUDA_VERSION` in `.env` override it. The image's CUDA version must not be
newer than the driver supports (`nvidia-smi` prints "CUDA Version"); the check
reports a mismatch.

## What the machine needs

| | q1 (default) | q2 |
|---|---|---|
| model download (first start) | 5.95 GB | 7.21 GB |
| GPU memory, context 64K (default), KV cache q4_0 | about 7.2 GiB | weights alone 6.7 GiB: 12 GB card and up (untested) |
| GPU memory, context 32K | about 6.5 GiB | |
| context 128K | does not fit 8 GB | |
| tested | yes | no |

- **GPU memory** grows by about 23 KiB per token of context (KV cache q4_0).
  On an 8 GB card Q1 at 64K leaves about 0.7 GiB; a desktop session on the same
  card takes 200-500 MiB of that. If 64K does not fit, set `NERD_CTX=32768`.
  On GB10 the GPU uses the system's unified memory; there is no separate total.
- **Disk:** the two images together are 4-6 GB (aarch64: the server 2.6 GB,
  the agent 1.45 GB; x86_64 somewhat more); the build pulls the CUDA devel
  base image (about 2.7 GB compressed) and keeps a build cache; plus the model.
  Plan for about 22 GB free under docker's data directory for the first build;
  `docker builder prune` frees the cache after.
- **RAM:** 16 GB recommended, 8 GB minimum (the build, Node, Chromium).
- **Network:** the build needs Docker Hub, Ubuntu's package mirrors, GitHub
  (the llama.cpp fork, SearXNG, the linters), nodejs.org, the npm registry,
  PyPI (SearXNG's packages) and Playwright's download server (the headless
  browser); the first start needs huggingface.co. After that nerd runs offline
  (the agent's web search and the languages `nerd-get` installs need the
  network). `HF_TOKEN` in `.env` is sent to Hugging Face if set.
- **An ssh key pair:** you log in to the agent with a public key; the private
  key stays on the machine you connect from.

Build time: about 4-8 minutes of compiling, plus downloading the base images.
Measured: x86_64, 16 threads, 8 minutes (the image 5.2 GB before the browser
layer was added); GB10, 20 cores, under 4 minutes.

## Prerequisites in detail

`tools/install-prerequisites.sh` does these on Ubuntu and Debian (and their
derivatives), each step skipped when it is already done:

1. **Docker Engine** from Docker's apt repository, with the buildx plugin (the
   Dockerfile needs BuildKit) and the compose plugin (`./UP` runs `docker
   compose`, 2.24 or newer). Docker from the distribution (`docker.io`) works
   too if `docker buildx version` and `docker compose version` do (Ubuntu's
   `docker-buildx` and `docker-compose-v2`); the script does not replace it.
2. **Your user in group `docker`.** Log out and in afterwards. The group is
   root-equivalent; if that is not acceptable on the machine, run `./UP` with
   sudo instead.
3. **NVIDIA driver: checked, not installed.** Installing a driver by script on
   a machine you do not know can leave it without a display. Install it from
   your distribution (`sudo ubuntu-drivers install` on Ubuntu) or from
   <https://www.nvidia.com/Download/index.aspx>, reboot, and check `nvidia-smi`.
4. **NVIDIA Container Toolkit** from NVIDIA's apt repository.
5. **GPU access for docker:** `nvidia-ctk runtime configure --runtime=docker`
   (for `--gpus all`) and a CDI spec, `nvidia-ctk cdi generate
   --output=/etc/cdi/nvidia.yaml` (for `--device nvidia.com/gpu=all`), then a
   docker restart. `./UP` uses CDI when the spec exists and docker resolves CDI
   devices (Docker 28.2+ does by default), `--gpus all` otherwise; `NERD_GPU`
   in `.env` forces one.

Other distributions: the script prints the links for each step and stops.

## Windows (WSL2)

The GPU reaches WSL2 through the Windows driver; nothing NVIDIA is installed
on the Linux side except the container toolkit.

### The easy way: two clicks

For a Windows 10 or 11 PC with an NVIDIA graphics card of 8 GB or more. Nothing
here touches your other WSL distributions, if you have any. Not yet run end to
end on a fresh Windows machine: if a step fails, the message says what to do,
and running the file again goes on from where it stopped.

**Once, to prepare the PC:**

1. **The NVIDIA driver.** Install the current one for your card from
   <https://www.nvidia.com/Download/index.aspx> (Game Ready or Studio, either
   works) and reboot if it asks. That is all the CUDA you need: Linux gets the
   GPU from this driver. Do not install any NVIDIA driver inside Linux.
2. **WSL.** Open the Start menu, type `cmd`, right-click *Command Prompt*,
   *Run as administrator*, and type:

   ```bat
   wsl --install --no-distribution
   ```

   Reboot when it is done. Already have WSL? Run `wsl --update` instead (the
   script needs a recent one).
3. **Disk space.** About 30 GB free on the drive that will hold nerd (the
   model is 6 GB, the images and Linux the rest).

**Install nerd (one run, 15-40 minutes, mostly downloads and builds):**

4. Download one file:
   <https://raw.githubusercontent.com/zhukilab/nerd/main/create_nerd_wsl.cmd>
   (right-click, *Save link as*), into a folder of your choice, e.g. your
   Downloads.
5. Double-click `create_nerd_wsl.cmd`. A black window shows each step; leave
   it until it prints `Done.` It needs no answers. To put nerd's Linux disk on
   another drive, run it from a Command Prompt instead:

   ```bat
   create_nerd_wsl.cmd --location D:\wsl\nerd
   ```

   If it stops with a table where a line says `MISSING`, do what that line
   says (usually: the NVIDIA driver, or disk space) and double-click the file
   again.

It makes a Linux of its own, named `nerd` (Debian, with systemd; Windows
programs and the Windows PATH off inside it; a user `nerd` with sudo without a
password), restarts only that Linux (`wsl --terminate nerd`; it never runs
`wsl --shutdown`, which would stop all of them), downloads nerd into it, installs
Docker and NVIDIA's container toolkit there, checks the machine, builds nerd and
downloads the model. At the end it puts `run_nerd.cmd` and `shrink_nerd_wsl.cmd` next to itself.

**Work with it, every time:**

6. Double-click `run_nerd.cmd`. It starts nerd if it is not running (a minute
   or two: the model loads) and opens the agent's screen.
7. Type your task in plain words and press Enter, e.g. *"Make a small web page
   with a to-do list, on Node.js"*. The agent first asks its questions and
   shows a plan: answer them, or say "your call". Then it works on its own; it
   can take a long time. What it builds for a browser opens at
   <http://localhost:8000> on this PC.
8. To leave the agent working and the screen alone: `Ctrl-b`, then `d`. The
   agent keeps working **while that window stays open**; closing the window
   stops it a few seconds later. `run_nerd.cmd` again brings you back to it.

**Disk space.** After the install nerd's Linux takes about 29 GB on Windows,
half of it leftovers of the build. Double-click `shrink_nerd_wsl.cmd` (also put
next to the others) to give that back: it drops what further work does not
need (docker's build cache, untagged images, the package cache; never the
model or your work), stops nerd's Linux only and compacts its disk: 28.7 GB
went down to 14.4 GB on the tested laptop. `run_nerd.cmd` starts nerd again
as before; only a later rebuild (`./UP --build`) takes longer. An older WSL
compacts only as administrator; the file says so.

`run_nerd.cmd --shell` (from a Command Prompt) opens a Linux shell in nerd's
folder instead, for `./STATUS`, `./DOWN`, `.env` and the rest of this
documentation. To remove nerd entirely: `wsl --unregister nerd` (everything in
it, the work too, is deleted).

### By hand, in a distribution of your own

1. Install the NVIDIA driver on Windows (any recent Game Ready or Studio
   driver supports WSL2). Do not install a Linux driver inside WSL.
2. `wsl --install -d Ubuntu-24.04` (or a separate distribution just for nerd).
3. Inside the distribution: clone, `tools/install-prerequisites.sh --yes`.
   It sets two lines of `/etc/wsl.conf` (the old file is kept as
   `/etc/wsl.conf.before-nerd`): `[boot] systemd = true`, so docker starts
   with the distribution, and `[interop] appendWindowsPath = false`, so no
   Windows program stands in for the distribution's own (Docker Desktop's
   `docker` would: the script installs Docker Engine inside the distribution
   either way). Windows commands then need their full path under
   `/mnt/<drive letter>/`. It also adds you to group `docker`. Both
   take effect after a restart of the distribution, from Windows:
   `wsl --terminate <distribution>` (other distributions keep running; if
   systemd still does not run after it, `wsl --shutdown`). Run the script
   again, then `tools/check-prerequisites.sh` (it checks `wsl.conf` too) and
   `./UP`. `nvidia-smi` inside WSL should list the GPU.
   The ssh key: `./UP` takes the public key from `~/.ssh` inside WSL. To log
   in from Windows (PowerShell's `ssh`, PuTTY), point it at the Windows one:
   `NERD_AUTHORIZED_KEYS_FILE` in `.env` set to the Windows `.pub` file as WSL
   sees it (`/mnt/<drive letter>/Users/<you>/.ssh/id_ed25519.pub`) (`ssh-keygen -t ed25519` in PowerShell makes one).
4. WSL2 gets half of the Windows RAM by default; `.wslconfig` (`memory=`)
   changes it. `.wslconfig` is WSL's VM as a whole: it takes effect only after
   `wsl --shutdown`.

Things that behave differently on WSL2:

- **Ports.** Windows forwards ports that WSL listens on to its own
  `localhost`, so `ssh -p 2222 nerd@localhost` and `http://localhost:8000`
  work from Windows. From other machines, forward the port on Windows
  (`netsh interface portproxy`) or use WSL's mirrored networking.
- **The distribution stops when its last client disconnects.** WSL shuts a
  distribution down a few seconds after the last `wsl.exe` session ends, and
  the container with it. Keep one open, e.g. a Windows logon task running
  `wsl -d <distribution> -- sleep infinity`. The restart policy (`unless-stopped`) brings
  the container back when the distribution starts again.
- **GPU memory overflow is silent** (the WDDM driver spills into shared
  system memory instead of failing): see
  [MAINTAIN.md](MAINTAIN.md#troubleshooting).
- `wsl --terminate <distribution>` restarts the distribution but not WSL's
  kernel; if services inside fail to start afterwards, `wsl --shutdown`.
- Laptops: the vendor's power mode matters. On the tested laptop a quiet
  power mode halved generation speed (13 against about 24 tokens/s).
- Docker Desktop for Windows (its WSL integration) instead of Docker Engine
  inside the distribution: untested. `tools/install-prerequisites.sh` leaves
  an integration that works alone; Desktop's Windows `docker` on the Windows
  PATH, without the integration, does not count as installed.

## Check that it works

1. `./UP` ends with "ready" and how to connect; `./STATUS` shows every line
   `OK` or `INFO` and exits 0.
2. `ssh -p 2222 nerd@localhost` (or `nerd@<host>`) shows Pi's screen.
3. A first task: *create hello.html with the text hi and serve it on port
   8000*. The agent answers first with its questions or "none" and a numbered
   plan; answer "your call". When it is done, `http://<host>:8000/hello.html`
   opens.

If something fails, these say what happened: `var/log/up-<time>.log` (all
that `./UP` printed; it names the file at the start and the end), the output
of `tools/check-prerequisites.sh` and `./STATUS`, `docker logs nerd-llm` (the
server) and `docker logs nerd` (the agent); `tools/report.sh` packs all of
them into one archive to send. After an update that went wrong, `./UP --rebuild`
builds everything again without docker's cache.
[MAINTAIN.md](MAINTAIN.md#troubleshooting) lists the usual causes.

## Next

[OPERATE.md](OPERATE.md): starting, connecting, settings.
