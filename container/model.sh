# shellcheck shell=bash
# The model nerd runs: Bonsai 2 from Hugging Face, file, size and sha256 per
# variant, as the Hugging Face API lists them (/api/models/<repo>/tree/main,
# lfs.oid is the sha256), pinned so a changed upstream file is noticed rather
# than used. Sourced by the image's entrypoint and by tools/llama-host.sh (the
# server on the host, macOS); sets repo, rev, file, size, sha and mtp (1: the
# file carries a multi-token-prediction head) for $1 (q1 | q2 | q1mtp), or
# returns 1.
# q1mtp: PrismML's PTQ1_0 file byte for byte (all 851 tensors) with Qwen 3.8
# 27B's MTP head grafted on as block 64 (from unsloth's Qwen3.8-27B GGUF; the
# "lean" graft, without its own copy of the token embedding), by
# sudoingx/Ternary-Bonsai-2-27B-PTQ1_0-MTP-GGUF, Apache-2.0, pinned to a
# revision. Without the head the server answers byte for byte as q1; with it
# (--spec-type draft-mtp, nerd_server_args) generation was measured 1.4-2.2x
# faster on an 8 GB Ampere card and on GB10, for ~0.75-0.9 GB more GPU memory;
# 64K context still fits 8 GB.
nerd_model() {
  repo=prism-ml/Ternary-Bonsai-2-27B-gguf rev=main mtp=0
  case "${1:-q1}" in
    q1) file=Ternary-Bonsai-2-27B-PTQ1_0.gguf; size=5946648928
        sha=53107f530aa52eb00912263ab1ee29bd199261c87cd7b4ad4ca1318c1fe33ee3 ;;
    q2) file=Ternary-Bonsai-2-27B-PQ2_0.gguf; size=7206168928
        sha=3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1 ;;
    q1mtp) repo=sudoingx/Ternary-Bonsai-2-27B-PTQ1_0-MTP-GGUF rev=fc13bb8af037f46e07425e73ff5a9ac3d75b8924 mtp=1
        file=Ternary-Bonsai-2-27B-PTQ1_0-mtp-lean.gguf; size=6297658848
        sha=1e33c571a5ce7a9a3e42474d66192923d5a6d77da7fb3a22986dc809522b5685 ;;
    *) return 1 ;;
  esac
}

# The model the server runs, from the settings (both places use it):
#   NERD_MODEL_GGUF=hf:<owner>/<repo>/<path in the repo>.gguf[@<revision>]
#                   any GGUF on Hugging Face: downloaded once into the models
#                   volume (or directory) and checked against the sha256
#                   Hugging Face publishes for it, or NERD_MODEL_SHA256 if set
#   NERD_MODEL_GGUF=<name>.gguf
#                   a file already in the models volume (or directory): used
#                   as it is, nothing downloaded (NERD_MODEL_FILE, the older
#                   name, means the same)
#   neither:        the pinned variant NERD_MODEL_VARIANT (q1 | q2 | q1mtp)
# Sets repo, file (path in the repo), rev, name (the local file), size and sha
# (empty while not known: an unpinned hf: file before its first download),
# as_is (1: use the file as it is), mtp (1: a variant with an MTP head) and
# alias (the name the server gives the model: NERD_MODEL_ALIAS, or
# bonsai2-<variant>, or the file's name without .gguf). q1mtp is served as
# bonsai2-q1: the same weights, so clients that name the model keep working.
# Prints why and returns 1 on a bad setting.
# shellcheck disable=SC2034  # as_is, name, alias, mtp: read by the callers
nerd_model_select() {
  local spec=${NERD_MODEL_GGUF:-${NERD_MODEL_FILE:-}} path v=${NERD_MODEL_VARIANT:-q1}
  rev=main as_is=0 mtp=0
  if [ -z "$spec" ]; then
    nerd_model "$v" || { echo "NERD_MODEL_VARIANT must be q1, q2 or q1mtp, not '${NERD_MODEL_VARIANT}'"; return 1; }
    name=$file
    alias=${NERD_MODEL_ALIAS:-bonsai2-${v%mtp}}
    return 0
  fi
  case "$spec" in
    hf:*)
      path=${spec#hf:}
      case "$path" in *@*) rev=${path##*@}; path=${path%@*} ;; esac
      repo=$(echo "$path" | cut -d/ -f1-2)
      file=${path#"$repo"/}
      case "$file" in
        "$path"|"") echo "NERD_MODEL_GGUF=$spec: expected hf:<owner>/<repo>/<file>.gguf"; return 1 ;;
      esac
      name=${file##*/}
      size="" sha=${NERD_MODEL_SHA256:-} ;;
    */*) echo "NERD_MODEL_GGUF=$spec: a local file is named without a directory (it lives in the models volume or directory), or use hf:<owner>/<repo>/<file>"; return 1 ;;
    *)
      repo="" file=$spec name=$spec size="" sha="" as_is=1 ;;
  esac
  case "$name" in *.gguf) ;; *) echo "NERD_MODEL_GGUF=$spec: not a .gguf file"; return 1 ;; esac
  alias=${NERD_MODEL_ALIAS:-${name%.gguf}}
}

# Size and sha256 of a Hugging Face file, as its resolve URL's headers give
# them (X-Linked-Size, X-Linked-Etag: the LFS object's sha256). Fills size, and
# sha unless it is already set (NERD_MODEL_SHA256 pins it). Returns 1 if the
# headers do not have them (not an LFS file, a gated repo without HF_TOKEN).
nerd_hf_meta() {
  local h
  local -a auth=()
  [ -n "${HF_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $HF_TOKEN")
  h=$(curl -sIL -m 30 ${auth[@]+"${auth[@]}"} "https://huggingface.co/$repo/resolve/$rev/$file" | tr -d '\r') || return 1
  size=$(echo "$h" | sed -n 's/^[Xx]-[Ll]inked-[Ss]ize: *//p' | head -1)
  [ -n "$sha" ] || sha=$(echo "$h" | sed -n 's/^[Xx]-[Ll]inked-[Ee]tag: *"\{0,1\}\([0-9a-f]\{64\}\)"\{0,1\}.*/\1/p' | head -1)
  [ -n "$size" ] && [ -n "$sha" ]
}

# llama-server's arguments for the model, as both places run it (after -m and
# before --host/--port): context, KV cache type, all layers on the GPU, flash
# attention, one slot, the chat template from the GGUF. Call after
# nerd_model_select (the alias).
# --cache-ram (NERD_CACHE_RAM, MiB): llama-server's prompt cache keeps snapshots
# of earlier prompts in host RAM, so a conversation that comes back after another
# one used the slot (a subagent, the other half of a pair, a judge) is not
# processed again. Measured on an 8 GB card under WSL (2026-10-24): a 61K-token
# context back after a 5K one in 4 s against 4 min, GPU memory unchanged. 0 turns
# it off (it was off until then: an older build overflowed the card with it).
# Speculative decoding with the model's MTP head (NERD_MTP): auto, the default,
# uses it when the variant carries one (q1mtp); on asks for it with any model
# (a NERD_MODEL_GGUF with an MTP head: llama-server refuses to start on one
# without); off never. NERD_MTP_DRAFT tokens are drafted per step (1): on an
# 8 GB Ampere card 2 drafts gained at short context and lost at 30K, on GB10 2
# was better everywhere (1.9x against 1.6x). Every drafted token is verified
# against the model, so greedy text stays the model's own (it can differ at
# near-ties, as batched verification changes the order of float sums).
nerd_server_args() {
  local spec=""
  case "${NERD_MTP:-auto}" in
    auto) [ "${mtp:-0}" = 1 ] && spec=on ;;
    on) spec=on ;;
  esac
  [ -n "$spec" ] && spec=" --spec-type draft-mtp --spec-draft-n-max ${NERD_MTP_DRAFT:-1}"
  local v=${NERD_MODEL_VARIANT:-q1}
  echo "--alias ${alias:-bonsai2-${v%mtp}} -c ${NERD_CTX:-65536} -ctk ${NERD_KV:-q4_0} -ctv ${NERD_KV:-q4_0}" \
    "-ngl ${NERD_NGL:-99} -fa on -np ${NERD_SLOTS:-1} --cache-ram ${NERD_CACHE_RAM:-4096} --jinja$spec"
}
