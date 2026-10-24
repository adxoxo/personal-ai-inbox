#!/bin/sh
set -eu
umask 077
PATH="${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export PATH
app_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd -- "$app_root"
exec flock -w 20 .supervisor-start.lock node scripts/ensure-supervisor.mjs
