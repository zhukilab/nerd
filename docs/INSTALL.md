# Installing nerd

nerd needs a Linux machine with an NVIDIA GPU, Docker, and the NVIDIA
Container Toolkit. **macOS on Apple silicon** runs the model on the Mac itself
and the agent in its container: [MACOS.md](MACOS.md) (new, untested on a real
Mac). Everything else is in two images built from this repository — the
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
| macOS, AMD, Intel GPUs | no | the model needs PrismML's CUDA kernels |

`./UP` reads the compute capability from `nvidia-smi` and passes it to the
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
- **Network:** the build needs Docker Hub, GitHub (the llama.cpp fork),
  nodejs.org and the npm registry; the first start needs huggingface.co. After
  that nerd runs offline. `HF_TOKEN` in `.env` is sent to Hugging Face if set.
- **An ssh key pair:** you log in to the agent with a public key; the private
  key stays on the machine you connect from.

Build time: about 4-8 minutes of compiling, plus downloading the base images.
Measured: x86_64, 16 threads, 8 minutes (the image 5.2 GB before the browser
layer was added); GB10, 20 cores, under 4 minutes.

## Prerequisites in detail

`tools/install-prerequisites.sh` does these on Ubuntu and Debian (and their
derivatives), each step skipped when it is already done:

1. **Docker Engine** from Docker's apt repository, with the buildx plugin (the
   Dockerfile needs BuildKit). Docker from the distribution (`docker.io`) works
   too if `docker buildx version` does; the script does not replace it.
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

1. Install the NVIDIA driver on Windows (any recent Game Ready or Studio
   driver supports WSL2). Do not install a Linux driver inside WSL.
2. `wsl --install -d Ubuntu-24.04` (or a separate distribution just for nerd),
   then inside it enable systemd in `/etc/wsl.conf` (`[boot]` `systemd=true`)
   and restart that distribution from Windows: `wsl --terminate <distribution>`
   (`wsl.conf` is read when the distribution starts; other distributions keep
   running). If `systemctl is-system-running` inside then says neither
   `running` nor `degraded`, `wsl --shutdown` (it stops every distribution).
3. Inside the distribution: clone, `tools/install-prerequisites.sh --yes`,
   `./UP`. `nvidia-smi` inside WSL should list the GPU.
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
  `wsl -d <distribution> -- sleep infinity`. `--restart unless-stopped` brings
  the container back when the distribution starts again.
- **GPU memory overflow is silent** (the WDDM driver spills into shared
  system memory instead of failing): see
  [MAINTAIN.md](MAINTAIN.md#troubleshooting).
- `wsl --terminate <distribution>` restarts the distribution but not WSL's
  kernel; if services inside fail to start afterwards, `wsl --shutdown`.
- Laptops: the vendor's power mode matters. On the tested laptop a quiet
  power mode halved generation speed (13 against about 24 tokens/s).

## Next

[OPERATE.md](OPERATE.md): starting, connecting, settings.
