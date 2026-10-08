#!/bin/bash
# nerd-get: install a language toolchain into the agent's home (a volume, so it
# survives ./UP --build; decision 0012). Pinned versions, each download checked
# against its sha256; nothing outside $HOME is touched, no root needed.
#
#   nerd-get go | rust | uv      install (again: says it is there)
#   nerd-get list                what it can install, and what is installed
#
# Where things go (the image's environment points the tools there):
#   go    ~/.local/go, GOPATH ~/go, module cache ~/.cache/go-mod
#   rust  rustup in ~/.rustup, cargo and its bin in ~/.cargo (minimal profile)
#   uv    ~/.local/bin/uv and uvx; its cache ~/.cache/uv
set -euo pipefail

GO_VERSION=1.27.1
GO_SHA_amd64=63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445
GO_SHA_arm64=3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec
RUSTUP_VERSION=1.29.1
RUSTUP_SHA_amd64=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
RUSTUP_SHA_arm64=15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433
UV_VERSION=0.12.23
UV_SHA_amd64=9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6
UV_SHA_arm64=6524bd338177ed50d035d39354e12545e993bbeba2ecbddf0480c5b3a81d313f

die() { echo "nerd-get: $*" >&2; exit 1; }
case "$(uname -m)" in
  x86_64) arch=amd64 triple=x86_64-unknown-linux-gnu ;;
  aarch64|arm64) arch=arm64 triple=aarch64-unknown-linux-gnu ;;
  *) die "unsupported machine $(uname -m)" ;;
esac
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# fetch <url> <sha256> <file>: download and check, or stop.
fetch() {
  curl -fsSL --retry 3 -o "$3" "$1" || die "download failed: $1"
  echo "$2  $3" | sha256sum -c --quiet - || die "sha256 mismatch for $1 — nothing installed"
}
sha() { local v="${1}_SHA_$arch"; echo "${!v}"; }

have() { command -v "$1" >/dev/null 2>&1; }

case "${1:-}" in
  go)
    if [ -x "$HOME/.local/go/bin/go" ]; then echo "go is there: $("$HOME/.local/go/bin/go" version)"; exit 0; fi
    fetch "https://go.dev/dl/go$GO_VERSION.linux-$arch.tar.gz" "$(sha GO)" "$tmp/go.tgz"
    mkdir -p "$HOME/.local"
    tar -xzf "$tmp/go.tgz" -C "$tmp" && mv "$tmp/go" "$HOME/.local/go"
    "$HOME/.local/go/bin/go" version ;;
  rust)
    if have cargo; then echo "rust is there: $(cargo --version)"; exit 0; fi
    fetch "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/$triple/rustup-init" "$(sha RUSTUP)" "$tmp/rustup-init"
    chmod +x "$tmp/rustup-init"
    "$tmp/rustup-init" -y --no-modify-path --profile minimal >/dev/null
    "$HOME/.cargo/bin/cargo" --version ;;
  uv)
    if [ -x "$HOME/.local/bin/uv" ]; then echo "uv is there: $("$HOME/.local/bin/uv" --version)"; exit 0; fi
    fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$triple.tar.gz" "$(sha UV)" "$tmp/uv.tgz"
    mkdir -p "$HOME/.local/bin"
    tar -xzf "$tmp/uv.tgz" -C "$tmp"
    install -m 755 "$tmp/uv-$triple/uv" "$tmp/uv-$triple/uvx" "$HOME/.local/bin/"
    "$HOME/.local/bin/uv" --version ;;
  list)
    echo "go $GO_VERSION    $([ -x "$HOME/.local/go/bin/go" ] && echo installed || echo -)"
    echo "rust (rustup $RUSTUP_VERSION, stable)    $(have cargo && cargo --version || echo -)"
    echo "uv $UV_VERSION    $([ -x "$HOME/.local/bin/uv" ] && echo installed || echo -)" ;;
  *) sed -n 2,12p "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
