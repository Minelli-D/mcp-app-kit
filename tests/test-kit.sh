#!/usr/bin/env bash
# The kit itself: the plugin files are in order, the script that makes a new project takes
# good values and refuses bad ones, a project made from the template passes its own quick
# tests, and nothing in the kit names the installation it was built from.
# No Docker, no cluster. Everything it writes is in a temp folder.
#
#   bash tests/test-kit.sh
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PASSED=0
FAILED=0
ok() { PASSED=$((PASSED + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '  FAIL %s\n' "$1"; }
check() {  # DESCRIPTION COMMAND...
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else fail "$name"; fi
}
not() { ! "$@"; }

PLUGIN=plugins/mcp-app
SKILL=$PLUGIN/skills/mcp-app
NEW="$SKILL/scripts/new-app.mjs"
WORK="$(mktemp -d)"

# ---- the plugin files --------------------------------------------------------------

check "the marketplace file names the plugin and where it is" python3 -c '
import json
m = json.load(open(".claude-plugin/marketplace.json"))
assert m["name"] == "mcp-app-kit" and m["owner"]["name"]
(p,) = m["plugins"]
assert p["name"] == "mcp-app" and p["source"] == "./plugins/mcp-app" and p["description"] and p["version"]'
check "the plugin file has a name, a description and a version" python3 -c '
import json
p = json.load(open("plugins/mcp-app/.claude-plugin/plugin.json"))
assert p["name"] == "mcp-app" and len(p["description"]) > 40 and p["version"] and p["author"]["name"]'
check "the two files give the plugin the same version" python3 -c '
import json
m = json.load(open(".claude-plugin/marketplace.json"))["plugins"][0]["version"]
p = json.load(open("plugins/mcp-app/.claude-plugin/plugin.json"))["version"]
assert m == p'
for command in new deploy doctor; do
  check "the command $command has a description and points to its part of the skill" python3 -c '
import re, sys
text = open(sys.argv[1]).read()
head = re.match(r"---\n(.*?)\n---\n", text, re.S).group(1)
assert re.search(r"^description: .{20,}$", head, re.M) and re.search(r"^argument-hint: ", head, re.M)
assert "`mcp-app` skill" in text and "**\"%s\"**" % sys.argv[2].capitalize() in text' "$PLUGIN/commands/$command.md" "$command"
  check "the skill has the section for $command" grep -q "^## ${command^}\$" "$SKILL/SKILL.md"
done
check "the skill has a name and says when to use it" python3 -c '
import re
text = open("plugins/mcp-app/skills/mcp-app/SKILL.md").read()
head = re.match(r"---\n(.*?)\n---\n", text, re.S).group(1)
assert re.search(r"^name: mcp-app$", head, re.M) and re.search(r"^description: .{80,}$", head, re.M)'
for file in references/playbook.md references/settings.md scripts/new-app.mjs template/settings.env template/k8s/deploy.sh \
  template/k8s/doctor.sh template/k8s/probe.mjs template/gateway/server.mjs template/app/server.py template/README.md template/ARCHITECTURE.md; do
  check "the skill has $file" test -s "$SKILL/$file"
  check "the skill text or a command leads to $file, or it is a part of the template" \
    bash -c 'grep -q -- "$1" "$2/SKILL.md" || [[ "$1" == template/* ]]' _ "$file" "$SKILL"
done
check "the skill finds its files from its own base directory, not from a setting of the system" \
  bash -c 'grep -q "base directory of this skill" "$1/SKILL.md" && ! grep -q "CLAUDE_PLUGIN_ROOT" -r plugins' _ "$SKILL"
check "the skill forbids printing a secret and asks before a deploy" \
  bash -c 'grep -q "Never print a secret" "$1/SKILL.md" && grep -q "Never run .k8s/show.sh." "$1/SKILL.md" && grep -q "without the user.s yes" "$1/SKILL.md"' _ "$SKILL"
check "every setting of the template is explained in the settings reference" bash -c '
  for name in $(sed -n "s/^\([A-Z][A-Z0-9_]*\)=.*/\1/p" "$1/template/settings.env"); do grep -q "\`$name\`" "$1/references/settings.md" || { echo "$name"; exit 1; }; done' _ "$SKILL"
check "every setting of the template is known to the scripts and to new-app.mjs" bash -c '
  for name in $(sed -n "s/^\([A-Z][A-Z0-9_]*\)=.*/\1/p" "$1/template/settings.env"); do
    grep -qw "$name" "$1/template/k8s/lib.sh" && grep -q "^  $name: \[" "$1/scripts/new-app.mjs" || { echo "$name"; exit 1; }
  done' _ "$SKILL"
check "the README of the kit has the two install lines" \
  bash -c 'grep -q "^/plugin marketplace add Minelli-D/mcp-app-kit$" README.md && grep -q "^/plugin install mcp-app@mcp-app-kit$" README.md'

# ---- nothing names the installation that the kit was built from -------------------------

# The words that must not be anywhere in the kit. The author name is allowed in four files.
FORBIDDEN='coach|english|grimoire|gam-group|hexcloud|brainplatform|bds-k8s|harbor|fluent dev|193\.24\.|\.co\.uk|davide|@gmail'
check "no file of the kit names the old installation" \
  bash -c '! grep -rniE --exclude-dir=.git --exclude=test-kit.sh -e "$1" . | grep -q .' _ "$FORBIDDEN"
check "the author is named only where an author belongs" \
  bash -c '! grep -rli --exclude-dir=.git --exclude=test-kit.sh "minelli" . | grep -vE "^\./(README\.md|LICENSE|\.claude-plugin/marketplace\.json|plugins/mcp-app/\.claude-plugin/plugin\.json)$" | grep -q .'
check "no file of the kit looks like a secret or a leftover" \
  bash -c '! find . -path ./.git -prune -o -type f \( -name ".env" -o -name "*.pem" -o -name "*.key" -o -name "*.log" -o -name "*.tar" -o -name "*.pyc" \) -print | grep -q .'
check "no file of the kit holds a token or a key" \
  bash -c '! grep -rnE --exclude-dir=.git "eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}" . | grep -q .'

# ---- the script that makes a new project ---------------------------------------------

GOOD=(--name notes-desk --title "Notes Desk" --app-host notes.example.com --mcp-host mcp-notes.example.com
  --email me@example.com --context my-cluster --namespace my-namespace --registry registry.example.com/project)
check "new-app.mjs is valid JavaScript" node --check "$NEW"
check "it makes a project" node "$NEW" --dir "$WORK/made" "${GOOD[@]}" --set STORAGE_SIZE=2Gi
check "the project has every part" bash -c 'for part in settings.env README.md ARCHITECTURE.md gateway/server.mjs bridge/Dockerfile app/server.py k8s/deploy.sh k8s/pod.yaml tests/test-gateway.mjs tests/test-rehearsal.mjs; do test -s "$1/$part" || exit 1; done' _ "$WORK/made"
check "its settings are the chosen ones, and the others keep their usual value" bash -c '
  f="$1/settings.env"
  grep -qx "APP_NAME=notes-desk" "$f" && grep -qx "APP_TITLE=Notes Desk" "$f" && grep -qx "APP_HOST=notes.example.com" "$f" \
    && grep -qx "MCP_HOST=mcp-notes.example.com" "$f" && grep -qx "LOGIN_EMAIL=me@example.com" "$f" && grep -qx "K8S_CONTEXT=my-cluster" "$f" \
    && grep -qx "K8S_NAMESPACE=my-namespace" "$f" && grep -qx "REGISTRY=registry.example.com/project" "$f" && grep -qx "STORAGE_SIZE=2Gi" "$f" \
    && grep -qx "POSTGRES_MODE=own" "$f" && grep -qx "INGRESS=yes" "$f" && grep -q "^# " "$f"' _ "$WORK/made"
check "the scripts of the project can be run" bash -c 'test -x "$1/k8s/deploy.sh" && test -x "$1/k8s/doctor.sh" && test -x "$1/k8s/show.sh" && test -x "$1/bridge/entrypoint.sh"' _ "$WORK/made"
check "without --mcp-host the name of the app does both" bash -c '
  node "$1" --dir "$2/one-name" --name one --title One --app-host one.example.com --email me@example.com --context c --namespace n --registry r.example.com/p \
    && grep -qx "MCP_HOST=one.example.com" "$2/one-name/settings.env"' _ "$NEW" "$WORK"
check "it refuses a folder that is not empty" not node "$NEW" --dir "$WORK/made" "${GOOD[@]}"
check "the template itself is not changed by making a project" bash -c 'grep -qx "APP_NAME=my-app" "$1/template/settings.env"' _ "$SKILL"

# bad NAME ARGUMENTS...  -> the script refuses, and makes no folder
bad() {
  local name="$1" dir="$WORK/bad-$RANDOM-$RANDOM"
  shift
  if node "$NEW" --dir "$dir" "$@" >/dev/null 2>&1 || [[ -e "$dir" ]]; then fail "it refuses: $name"; else ok "it refuses: $name"; fi
}
with() {  # OPTION VALUE -> the good arguments with one of them replaced
  local out=() at
  for ((at = 0; at < ${#GOOD[@]}; at += 2)); do
    if [[ "${GOOD[at]}" == "$1" ]]; then out+=("$1" "$2"); else out+=("${GOOD[at]}" "${GOOD[at + 1]}"); fi
  done
  printf '%s\0' "${out[@]}"
}
while IFS='|' read -r option value; do
  mapfile -d '' -t arguments < <(with "$option" "$value")
  bad "$option \"$value\"" "${arguments[@]}"
done <<'BAD'
--name|Notes
--name|1notes
--name|notes_desk
--name|notes-
--title|A "quoted" title
--title|$(id)
--app-host|notes
--app-host|https://notes.example.com
--mcp-host|mcp notes
--email|nobody
--context|two words
--namespace|My_Namespace
--registry|https://registry.example.com/p
BAD
bad "a missing name" --title X --app-host a.example.com --email me@example.com --context c --namespace n --registry r.example.com/p
bad "an option that does not exist" "${GOOD[@]}" --color blue
bad "a setting that does not exist" "${GOOD[@]}" --set NOT_A_SETTING=1
bad "a command in a setting" "${GOOD[@]}" --set 'MCP_COMMAND=server; rm -rf /'
bad "existing Postgres without its pod" "${GOOD[@]}" --set POSTGRES_MODE=existing

# ---- a new project passes its own quick tests ------------------------------------------

check "the new project: the gateway tests pass" bash -c 'cd "$1" && node --test tests/test-gateway.mjs' _ "$WORK/made"
check "the new project: the Kubernetes file tests pass" bash -c 'cd "$1" && bash tests/test-k8s-files.sh' _ "$WORK/made"
check "the new project: the tests of the example app pass" bash -c 'cd "$1/tests" && python3 -B -m unittest test_app -q' _ "$WORK/made"
node "$NEW" --dir "$WORK/other" --name tool-box --title "Tool Box" --app-host tools.example.org --email owner@example.org --context other-cluster \
  --namespace tools --registry ghcr.io/owner --set POSTGRES_MODE=existing --set POSTGRES_POD=pg-0 --set POSTGRES_SERVICE=pg --set INGRESS=no \
  --set STORAGE_CLASS=fast --set PULL_SECRET=regcred >/dev/null 2>&1
check "a project with one name, an existing Postgres and no Ingress passes its Kubernetes file tests too" \
  bash -c 'cd "$1" && bash tests/test-k8s-files.sh' _ "$WORK/other"

printf '%s passed, %s failed\n' "$PASSED" "$FAILED"
[[ "$FAILED" -eq 0 ]]
