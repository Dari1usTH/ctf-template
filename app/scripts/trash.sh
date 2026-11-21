#!/usr/bin/env bash
# Delete/undo are reversible moves; the server validates both paths first.
set -Eeuo pipefail
[[ $# == 2 && -e "$1" && ! -e "$2" && ! -L "$1" && ! -L "$2" ]] || exit 1
mkdir -p -- "$(dirname -- "$2")"
mv -T -- "$1" "$2"
