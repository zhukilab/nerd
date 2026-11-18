#!/bin/bash
# container/model.sh without a GPU or network: the variants, the alias, and the MTP arguments of
# nerd_server_args.   bash container/test-model.sh   (exit 0: all passed)
set -u
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=container/model.sh
. "$here/model.sh"
fail=0
eq() {  # name, got, want
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2', want '$3'"; fail=1; fi
}
has() {  # name, haystack, needle, 1 = must contain / 0 = must not
  case "$2" in *"$3"*) r=1 ;; *) r=0 ;; esac
  if [ "$r" = "$4" ]; then echo "ok   $1"; else echo "FAIL $1: '$3' $([ "$4" = 1 ] && echo missing from || echo present in) '$2'"; fail=1; fi
}
sel() { unset NERD_MODEL_GGUF NERD_MODEL_FILE NERD_MODEL_ALIAS NERD_MTP NERD_MTP_DRAFT; NERD_MODEL_VARIANT=$1; nerd_model_select >/dev/null; }

sel q1;    eq "q1 repo" "$repo" prism-ml/Ternary-Bonsai-2-27B-gguf; eq "q1 rev" "$rev" main; eq "q1 mtp" "$mtp" 0
           eq "q1 alias" "$alias" bonsai2-q1; has "q1 no head" "$(nerd_server_args)" draft-mtp 0
sel q2;    eq "q2 alias" "$alias" bonsai2-q2; eq "q2 mtp" "$mtp" 0
sel "";    eq "default variant is q1mtp" "$file" Ternary-Bonsai-2-27B-PTQ1_0-mtp-lean.gguf; eq "default mtp" "$mtp" 1
           eq "default alias" "$alias" bonsai2-q1
# tools/lib.sh's default: q1mtp, but q1 on the Mac's own server (NERD_LLAMA=host)
# shellcheck source=tools/lib.sh
. "$here/../tools/lib.sh"
for case_ in container:q1mtp host:q1 remote:q1mtp; do
  ( unset NERD_MODEL_VARIANT; NERD_LLAMA=${case_%%:*}; nerd_settings >/dev/null 2>&1
    [ "$NERD_MODEL_VARIANT" = "${case_#*:}" ] ) && echo "ok   lib default with NERD_LLAMA=${case_%%:*}" \
    || { echo "FAIL lib default with NERD_LLAMA=${case_%%:*}: want ${case_#*:}"; fail=1; }
done
( NERD_MODEL_VARIANT=q2; NERD_LLAMA=host; nerd_settings >/dev/null 2>&1; [ "$NERD_MODEL_VARIANT" = q2 ] ) \
  && echo "ok   lib keeps an explicit variant" || { echo "FAIL lib keeps an explicit variant"; fail=1; }
sel q1mtp; eq "q1mtp repo" "$repo" sudoingx/Ternary-Bonsai-2-27B-PTQ1_0-MTP-GGUF
           eq "q1mtp rev pinned" "${#rev}" 40; eq "q1mtp sha" "${#sha}" 64; eq "q1mtp size" "$size" 6297658848
           eq "q1mtp alias is q1's" "$alias" bonsai2-q1; eq "q1mtp mtp" "$mtp" 1
           has "q1mtp head on by default" "$(nerd_server_args)" "--spec-type draft-mtp --spec-draft-n-max 1" 1
NERD_MTP=off;     has "q1mtp NERD_MTP=off" "$(nerd_server_args)" draft-mtp 0; unset NERD_MTP
NERD_MTP_DRAFT=2; has "q1mtp NERD_MTP_DRAFT=2" "$(nerd_server_args)" "--spec-draft-n-max 2" 1; unset NERD_MTP_DRAFT
unset alias; has "q1mtp alias without select" "$(nerd_server_args)" "--alias bonsai2-q1 " 1
sel q1; NERD_MTP=on; has "q1 NERD_MTP=on asks for the head" "$(nerd_server_args)" draft-mtp 1; unset NERD_MTP
NERD_MODEL_VARIANT=q3; msg=$(nerd_model_select); eq "bad variant refused" "$?" 1; has "bad variant message" "$msg" q1mtp 1
unset NERD_MODEL_VARIANT; NERD_MODEL_GGUF=other.gguf; nerd_model_select >/dev/null
eq "local gguf: mtp off" "$mtp" 0; has "local gguf: no head" "$(nerd_server_args)" draft-mtp 0
NERD_MTP=on; has "local gguf NERD_MTP=on" "$(nerd_server_args)" draft-mtp 1
exit $fail
