#!/usr/bin/env bash
# Makes a project from the template and runs its rehearsal: the whole pod in Docker, with the
# real login server, a plain Postgres, the real bridge and the example app. Needs Docker.
# Slow (a few minutes the first time: it builds the images).
#
#   bash tests/test-kit-rehearsal.sh
set -eu
cd "$(dirname "${BASH_SOURCE[0]}")/.."
command -v docker >/dev/null 2>&1 && docker version >/dev/null 2>&1 || { echo "Docker is not running: this test needs it." >&2; exit 2; }

WORK="$(mktemp -d)"
node plugins/mcp-app/skills/mcp-app/scripts/new-app.mjs --dir "$WORK/rehearsal" --name notes-desk --title "Notes Desk" \
  --app-host notes.example.com --mcp-host mcp-notes.example.com --email me@example.com --context my-cluster \
  --namespace my-namespace --registry registry.example.com/project >/dev/null
cd "$WORK/rehearsal"
node --test tests/test-rehearsal.mjs 2>&1 | grep -E '^not ok|^# (tests|pass|fail|skipped)'
