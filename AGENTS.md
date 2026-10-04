# AGENTS.md — maintaining this repository

For a coding agent (or a person) changing nerd. What nerd is: README.md.
How it fits together: docs/ARCHITECTURE.md. Public home:
https://github.com/zhukilab/nerd.

## Layout

```
UP DOWN STATUS          deploy: bash, settings from .env (template env.example)
tools/                  check-prerequisites.sh, install-prerequisites.sh, lib.sh (shared)
Dockerfile              one image: llama.cpp fork build, Node, agent, Chromium, sshd
container/              entrypoint.sh (modes), sshd/tmux config, pkill guard, browse wrapper, in-image tests
agent/                  the agent: TypeScript run directly by Node (no build step)
  src/                  see docs/ARCHITECTURE.md for each file
  test/                 node:test unit tests
acceptance/             checker for the reference task's result, with fixtures and a self-test
docs/                   INSTALL, OPERATE, MAINTAIN, ARCHITECTURE
```

## How to test

No GPU needed:

```sh
cd agent && npm ci && npm test && npm run typecheck     # Node >= 22.19
node --test acceptance/test/*.test.mjs
shellcheck -x UP DOWN STATUS tools/*.sh                # clean; container/ and acceptance/ still carry
                                                       # a few notes (trap handlers read as unreachable)
GUARD=container/pkill-guard.sh bash container/test-pkill-guard.sh
acceptance/selftest.sh /tmp/selftest                   # docker
tools/check-prerequisites.sh                           # reports MISSING without a GPU; that is fine
./UP --dry-run                                         # the docker commands UP would run
```

With a GPU: `./UP --build`, `./STATUS` (exit 0), log in over ssh, give a small
task, check the result; the in-image tests:
`docker run --rm --entrypoint /opt/nerd/test-browse.sh <image>` and
`.../test-pkill-guard.sh`. Then `./DOWN`. Use your own `NERD_NAME` and ports
if another instance runs on the machine; never touch containers you did not
start.

## Invariants

1. **Nothing private in the repository.** No machine names, host names,
   network or VPN names, IP addresses, user names, home-directory paths, keys,
   tokens or e-mail addresses (except the image's `nerd@localhost`). Write
   "the GPU machine", `<host>`, `example`. Examples use documentation values
   (`gpu-box.example`, ports 2222/8000). Settings that differ per machine go
   in `.env`, which is git-ignored.
2. **Pin every version.** Fork tag, Node version, npm packages (exact, with the
   lock file), model file size and sha256, CUDA base image version. No
   `latest`, no `^` in runtime dependencies. An update changes a pin
   deliberately and is checked (docs/MAINTAIN.md).
3. **Stock llama.cpp is never a substitute** for the fork: with this model it
   fails or, worse, silently produces garbage.
4. **The container is the sandbox.** The agent runs as uid 1000, not root; do
   not add capabilities, host mounts beyond the volumes, or `--privileged`.
5. **Mechanism over prompt.** When the model keeps failing an instruction, fix
   it in the harness or the image (see the loop guard, bash timeout, pkill
   guard) and say why in a comment with the evidence.
6. **Scripts stay shellcheck-clean** and do nothing destructive by default:
   `install-prerequisites.sh` changes nothing without `--yes`; `./DOWN` keeps
   volumes without `--purge`; the NVIDIA driver is never installed by script.
7. **Docs follow the code.** A changed variable, port, default or command is
   changed in env.example, docs/ and README in the same commit. Numbers in the
   docs (VRAM, sizes, speeds) are measurements: say on what hardware, and
   re-measure rather than guess when the thing measured changes.
8. **English** in code, comments, docs and commit messages.

## Conventions

- Comments explain why, with the observed failure that motivated the code.
- Commit messages: one subject line saying what changed, a body saying why.
- New environment variables are named `NERD_*`, documented in the header of
  the file that reads them, and listed in docs/OPERATE.md (deploy settings)
  or the README's "Settings" (agent settings).
- Third-party Pi packages go in `agent/src/packages.ts`: pinned, loaded from
  `node_modules` by path (no `pi install`, nothing fetched at run time), behind
  a `NERD_*` switch. Measure before turning one on by default: tokens added to
  every request (the server's own count) and a long run against the default.
- Any language the model sees in prompts follows the existing prompt files;
  the agent's operator may write in any language.
