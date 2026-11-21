#!/usr/bin/env bash
set -Eeuo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
check=false
case ${1:-} in '' ) ;; --check) check=true ;; *) echo 'Usage: ./install.sh [--check]' >&2; exit 1 ;; esac
[[ $# -le 1 ]] || exit 1
ready() {
    command -v bash >/dev/null && command -v od >/dev/null && command -v docker >/dev/null && docker compose version >/dev/null 2>&1
}
if [[ "$check" == true ]]; then
    ready || { echo 'Missing dependencies. Run ./install.sh.' >&2; exit 1; }
    echo 'Dependencies ready.'
    exit
fi
if ! ready; then
    command -v apt-get >/dev/null || { echo 'Automatic installation supports Debian/Ubuntu. Install Docker Desktop and Compose v2 on other systems.' >&2; exit 1; }
    elevate=()
    if [[ $(id -u) != 0 ]]; then
        command -v sudo >/dev/null || { echo 'Run install.sh as root or install sudo.' >&2; exit 1; }
        elevate=(sudo)
    fi
    "${elevate[@]}" apt-get update
    packages=()
    while IFS= read -r requirement || [[ -n "$requirement" ]]; do
        [[ -n "$requirement" && "$requirement" != \#* ]] || continue
        if [[ "$requirement" == docker.io ]] && command -v docker >/dev/null; then continue; fi
        if [[ "$requirement" == *'|'* ]] && docker compose version >/dev/null 2>&1; then continue; fi
        IFS='|' read -r -a alternatives <<< "$requirement"
        selected=''
        for package in "${alternatives[@]}"; do
            [[ "$package" =~ ^[a-z0-9.+-]+$ ]] || { echo 'Invalid requirements.txt entry.' >&2; exit 1; }
            candidate=$(apt-cache policy "$package" | awk '/Candidate:/ {print $2; exit}')
            if [[ -n "$candidate" && "$candidate" != '(none)' ]]; then selected=$package; break; fi
        done
        [[ -n "$selected" ]] || { echo "Package unavailable: $requirement" >&2; exit 1; }
        packages+=("$selected")
    done < "$script_dir/requirements.txt"
    if (( ${#packages[@]} )); then "${elevate[@]}" apt-get install -y --no-install-recommends "${packages[@]}"; fi
fi
ready || { echo 'Docker Compose v2 is required.' >&2; exit 1; }
if ! docker info >/dev/null 2>&1; then
    if command -v systemctl >/dev/null; then
        if [[ $(id -u) == 0 ]]; then systemctl enable --now docker; else sudo systemctl enable --now docker; fi
    fi
    if ! docker info >/dev/null 2>&1; then
        echo 'Dependencies installed. Start Docker and grant your user Docker access, then run ./run.sh.'
        exit
    fi
fi
docker compose --project-name ctf-author --project-directory "$script_dir" -f "$script_dir/compose.yaml" build
echo 'Dependencies ready. Run ./run.sh.'
