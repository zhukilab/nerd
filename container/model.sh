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

# llama-server's arguments for the model, as both places run it (after -m and
# before --host/--port): context, KV cache type, all layers on the GPU, flash
# attention, one slot, the chat template from the GGUF.
# --cache-ram 0: llama-server's prompt cache keeps KV snapshots of earlier
# prompts in device memory (1.3 GiB each at 32K); one of them on top of
# Bonsai 2 at 32K overflows an 8 GB card, silently on WDDM drivers.
nerd_server_args() {
  echo "--alias bonsai2-${NERD_MODEL_VARIANT:-q1} -c ${NERD_CTX:-65536} -ctk ${NERD_KV:-q4_0} -ctv ${NERD_KV:-q4_0}" \
    "-ngl ${NERD_NGL:-99} -fa on -np ${NERD_SLOTS:-1} --cache-ram 0 --jinja"
}
