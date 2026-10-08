# shellcheck shell=bash
# The model nerd runs: Bonsai 2 from Hugging Face, file, size and sha256 per
# variant, as the Hugging Face API lists them (/api/models/<repo>/tree/main,
# lfs.oid is the sha256), pinned so a changed upstream file is noticed rather
# than used. Sourced by the image's entrypoint and by tools/llama-host.sh (the
# server on the host, macOS); sets repo, file, size, sha for $1 (q1 | q2), or
# returns 1.
nerd_model() {
  repo=prism-ml/Ternary-Bonsai-2-27B-gguf
  case "${1:-q1}" in
    q1) file=Ternary-Bonsai-2-27B-PTQ1_0.gguf; size=5946648928
        sha=53107f530aa52eb00912263ab1ee29bd199261c87cd7b4ad4ca1318c1fe33ee3 ;;
    q2) file=Ternary-Bonsai-2-27B-PQ2_0.gguf; size=7206168928
        sha=3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1 ;;
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
#   neither:        the pinned variant NERD_MODEL_VARIANT (q1 | q2)
# Sets repo, file (path in the repo), rev, name (the local file), size and sha
# (empty while not known: an unpinned hf: file before its first download),
# as_is (1: use the file as it is) and alias (the name the server gives the
# model: NERD_MODEL_ALIAS, or bonsai2-<variant>, or the file's name without
# .gguf). Prints why and returns 1 on a bad setting.
# shellcheck disable=SC2034  # as_is, name, alias: read by the callers
nerd_model_select() {
  local spec=${NERD_MODEL_GGUF:-${NERD_MODEL_FILE:-}} path
  rev=main as_is=0
  if [ -z "$spec" ]; then
    nerd_model "${NERD_MODEL_VARIANT:-q1}" || { echo "NERD_MODEL_VARIANT must be q1 or q2, not '${NERD_MODEL_VARIANT}'"; return 1; }
    name=$file
    alias=${NERD_MODEL_ALIAS:-bonsai2-${NERD_MODEL_VARIANT:-q1}}
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
# --cache-ram 0: llama-server's prompt cache keeps KV snapshots of earlier
# prompts in device memory (1.3 GiB each at 32K); one of them on top of
# Bonsai 2 at 32K overflows an 8 GB card, silently on WDDM drivers.
nerd_server_args() {
  echo "--alias ${alias:-bonsai2-${NERD_MODEL_VARIANT:-q1}} -c ${NERD_CTX:-65536} -ctk ${NERD_KV:-q4_0} -ctv ${NERD_KV:-q4_0}" \
    "-ngl ${NERD_NGL:-99} -fa on -np ${NERD_SLOTS:-1} --cache-ram 0 --jinja"
}
