#!/usr/bin/env bash
set -Eeuo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
assume_yes=false
case ${1:-} in
    '') ;;
    --yes|-y) assume_yes=true ;;
    *) echo 'Usage: ./run.sh [--yes]' >&2; exit 1 ;;
esac
[[ $# -le 1 ]] || { echo 'Usage: ./run.sh [--yes]' >&2; exit 1; }
export CTF_WORKSPACE=${CTF_WORKSPACE:-$PWD}
CTF_WORKSPACE=$(cd -- "$CTF_WORKSPACE" && pwd)
export CTF_WORKSPACE
export CTF_UID=${CTF_UID:-$(id -u)} CTF_GID=${CTF_GID:-$(id -g)}
export CTF_PORT=${CTF_PORT:-8080} CTF_TIMEZONE=${CTF_TIMEZONE:-Europe/Bucharest}
command -v docker >/dev/null || { echo 'Docker Engine / Desktop and Compose v2 are required.' >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is required.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Docker is not running or access is denied.' >&2; exit 1; }
[[ -f "$CTF_WORKSPACE/config" && -f "$CTF_WORKSPACE/pack-public" && -f "$CTF_WORKSPACE/util/pack-common" ]] || { echo 'Run this script from the CTF repository root.' >&2; exit 1; }
compose=(docker compose --project-name ctf-author --project-directory "$script_dir" -f "$script_dir/compose.yaml")
existing=$(docker ps --all --quiet --filter label=com.docker.compose.project=ctf-author)
if [[ -n "$existing" ]]; then
    if [[ "$assume_yes" != true ]]; then
        printf 'An existing CTF Author instance was found. Restart it? [y/N] '
        answer=''
        read -r answer || true
        case "$answer" in
            y|Y|yes|YES|da|DA|Da) ;;
            *) echo 'Existing instance kept.'; exit 0 ;;
        esac
    fi
    "${compose[@]}" down --remove-orphans
fi
for directory in .ctf-author Challenges; do
    [[ ! -L "$CTF_WORKSPACE/$directory" ]] || { echo "$directory must not be a symlink." >&2; exit 1; }
    mkdir -p -- "$CTF_WORKSPACE/$directory"
done
chmod 700 -- "$CTF_WORKSPACE/.ctf-author"
token_file="$CTF_WORKSPACE/.ctf-author/access-token"
[[ ! -L "$token_file" ]] || { echo 'Token file must not be a symlink.' >&2; exit 1; }
if [[ ! -s "$token_file" ]]; then
    (umask 077; od -An -N24 -tx1 /dev/urandom | tr -d ' \n' > "$token_file"; printf '\n' >> "$token_file")
fi
chmod 600 -- "$token_file"
"${compose[@]}" up --build --detach --wait --wait-timeout 120
printf '\nCTF Author: http://localhost:%s\n' "$CTF_PORT"
if command -v hostname >/dev/null; then
    for address in $(hostname -I 2>/dev/null || true); do
        [[ "$address" == *:* ]] || printf 'LAN: http://%s:%s\n' "$address" "$CTF_PORT"
    done
fi
printf 'Access token: '
cat -- "$token_file"
