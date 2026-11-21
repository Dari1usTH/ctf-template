#!/usr/bin/env bash
set -Eeuo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 1; }
docker compose --project-name ctf-author --project-directory "$script_dir" -f "$script_dir/compose.yaml" down --remove-orphans
echo 'CTF Author stopped.'
