#!/usr/bin/env bash
# The Kubernetes files (k8s/): the scripts can be read, the settings are checked, and
# k8s/pod.yaml, filled in the way k8s/deploy.sh fills it, is the pod that is meant: with its own
# Postgres or with an existing one, with the Ingress or without it, with two public names or
# with one, with and without the optional settings.
#
# This test talks to no cluster, starts no container and writes no file outside a temp folder.
# The file is read with Python (PyYAML), not with "kubectl apply --dry-run": kubectl asks a
# cluster which kinds of objects exist, also for a dry run.
#
#   bash tests/test-k8s-files.sh
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

for tool in python3 envsubst node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is needed for this test." >&2; exit 2; }
done
python3 -c 'import yaml' 2>/dev/null || { echo "The Python module yaml (PyYAML) is needed for this test." >&2; exit 2; }

WORK="$(mktemp -d)"

# ---- the scripts -----------------------------------------------------------------

for script in k8s/lib.sh k8s/deploy.sh k8s/show.sh k8s/doctor.sh; do
  check "$script is valid bash" bash -n "$script"
done
for script in k8s/secrets.mjs k8s/create-user.mjs k8s/probe.mjs; do
  check "$script is valid JavaScript" node --check "$script"
done

# A deploy to the wrong cluster must not be possible by accident: every kubectl call names the
# context of the settings. The one call without it only lists the contexts that exist.
check "every kubectl call in k8s/ names the context of the settings" \
  bash -c '! grep -hE "(^|[^A-Za-z\"])kubectl " k8s/lib.sh k8s/deploy.sh k8s/show.sh k8s/doctor.sh \
    | grep -Ev -- "--context|kubectl config get-contexts|^[[:space:]]*#|for tool in|die \"|info \"|printf " | grep -q .'
check "the scripts read settings.env, they do not run it" not grep -Eq '^\s*(\.|source) .*settings\.env' k8s/lib.sh k8s/deploy.sh k8s/show.sh k8s/doctor.sh
check "only show.sh prints the password" \
  bash -c '! grep -l "secret_value LOGIN_PASSWORD" k8s/*.sh | grep -v -e show.sh -e deploy.sh | grep -q . && ! grep -Eq "(info|printf|echo).*secret_value" k8s/deploy.sh k8s/doctor.sh'
check "deploy.sh sends the database password on standard input, as a psql variable" grep -q '\\\\set auth_password' k8s/deploy.sh
check "deploy.sh puts no psql variable on a command line" not grep -Eq -- "(^|[[:space:]])(-v|--set|--variable)[= ]+auth_password" k8s/deploy.sh
check "deploy.sh makes the user from inside the pod, with the script on standard input" \
  grep -q -- '-c gateway -- node --input-type=module -$' k8s/deploy.sh
check "deploy.sh checks that the Secret has every key that secrets.mjs makes" \
  bash -c 'keys="$(sed -n "s/^SECRET_KEYS=(\(.*\))\$/\1/p" k8s/deploy.sh)"; made="$(node --input-type=module -e "
    import { makeSecrets } from \"./k8s/secrets.mjs\";
    console.log(Object.keys(makeSecrets(\"me@example.test\")).join(\" \"));")"; test -n "$keys" && test "$keys" = "$made"'
check "secrets.mjs makes a Secret with the name of the app" \
  bash -c 'node k8s/secrets.mjs sample-app sample-ns me@example.test | python3 -c "
import json, sys
made = json.load(sys.stdin)
assert made[\"metadata\"] == {\"name\": \"sample-app\", \"namespace\": \"sample-ns\", \"labels\": {\"app.kubernetes.io/part-of\": \"sample-app\"}}, made[\"metadata\"]
assert all(len(value) >= 16 for key, value in made[\"stringData\"].items() if key != \"LOGIN_EMAIL\")
"'
check "secrets.mjs refuses a name that is not the name of an app" not node k8s/secrets.mjs Bad_Name sample-ns me@example.test

# ---- the database file -----------------------------------------------------------

check "auth-db.sql takes the password and the two names from psql variables" \
  bash -c "grep -q \":'auth_password'\" k8s/auth-db.sql && grep -q ':\"db_role\"' k8s/auth-db.sql && grep -q ':\"db_name\"' k8s/auth-db.sql"
check "auth-db.sql holds no password and no name of its own" \
  bash -c '! grep -v "create role postgres nologin" k8s/auth-db.sql | grep -Eiq "^[^-]*(password +\x27[^)]|create (role|database) [a-z])"'
check "auth-db.sql makes the role postgres when it is missing" grep -q "create role postgres nologin" k8s/auth-db.sql
check "auth-db.sql takes only plain names" grep -q "bad_name" k8s/auth-db.sql

# ---- the settings ----------------------------------------------------------------

# settings KEY=VALUE...  -> a settings file for one check: the settings of this project, with
# the choices that the checks build on set to the usual ones (so that the checks say the same
# in every project), and then these changes.
USUAL=(POSTGRES_MODE=own POSTGRES_POD= POSTGRES_SERVICE= INGRESS=yes PULL_SECRET= STORAGE_CLASS=
  INGRESS_CLASS=nginx INGRESS_NAMESPACE=ingress-nginx CLUSTER_ISSUER=letsencrypt STORAGE_SIZE=1Gi)
settings() {
  local file="$WORK/settings-$RANDOM-$RANDOM.env" change
  cp settings.env "$file"
  for change in "${USUAL[@]}" "$@"; do
    sed -i "/^${change%%=*}=/d" "$file"
    printf '%s\n' "$change" >>"$file"
  done
  printf '%s' "$file"
}
# checked FILE  -> the settings pass the checks of lib.sh
checked() {
  SETTINGS_FILE="$1" bash -c '. k8s/lib.sh && read_settings && check_settings'
}

check "the settings of this project pass" env SETTINGS_FILE=settings.env bash -c '. k8s/lib.sh && read_settings && check_settings'
check "the settings of this project fill in the whole file" bash -c '
  IMAGE_GATEWAY=a IMAGE_BRIDGE=b IMAGE_APP=c DEPLOY_FUNCTIONS_ONLY=yes bash -c ". k8s/deploy.sh && filled_yaml" \
    | python3 -c "
import sys, yaml
text = sys.stdin.read()
docs = [doc for doc in yaml.safe_load_all(text) if doc]
lines = [line for line in text.splitlines() if not line.lstrip().startswith(\"#\")]
sys.exit(0 if len(docs) >= 4 and not any(\"\${\" in line or \"# optional\" in line for line in lines) else 1)"'
check "the usual settings pass" checked "$(settings)"
while IFS= read -r bad; do
  check "a bad setting is refused: $bad" not checked "$(settings "$bad")"
done <<'BAD'
APP_NAME=MyApp
APP_NAME=1app
APP_NAME=my_app
APP_NAME=app-
APP_NAME=a-very-long-name-that-has-more-than-forty-characters
APP_TITLE=
APP_TITLE=A "quoted" title
APP_TITLE=$(id)
APP_HOST=not a host
APP_HOST=localhost
MCP_HOST=mcp_host.example.com
LOGIN_EMAIL=nobody
K8S_CONTEXT=
K8S_CONTEXT=two words
K8S_NAMESPACE=My_Namespace
REGISTRY=https://registry.example.com
STORAGE_SIZE=lots
INGRESS=maybe
POSTGRES_MODE=cloud
POSTGRES_MODE=existing
MCP_PACKAGES=pkg; rm -rf /
MCP_COMMAND=server "$(id)"
MCP_VERSIONS=latest
OPEN_PATHS=static/
OPEN_PATHS=/a/../b
NOT_A_SETTING=1
BAD
check "a line that is not NAME=value is refused" not checked "$(f="$(settings)"; echo 'echo hello' >>"$f"; printf '%s' "$f")"
check "a value in quotes is taken without them" \
  bash -c 'SETTINGS_FILE="$1" bash -c ". k8s/lib.sh && read_settings && check_settings && test \"\$APP_TITLE\" = \"Quoted Title\""' _ "$(settings 'APP_TITLE="Quoted Title"')"
check "settings.env is read, not run: a command in a value does nothing" \
  bash -c 'SETTINGS_FILE="$1" bash -c ". k8s/lib.sh && read_settings" ; test ! -e "$2"' _ "$(settings "PULL_SECRET=\$(touch $WORK/ran)")" "$WORK/ran"
check "without MCP_HOST the one name does both" \
  bash -c 'SETTINGS_FILE="$1" bash -c ". k8s/lib.sh && read_settings && check_settings && test \"\$MCP_HOST\" = one.example.test"' _ "$(settings APP_HOST=one.example.test MCP_HOST=)"
check "the database is named after the app, with _ for -" \
  bash -c 'SETTINGS_FILE="$1" bash -c ". k8s/lib.sh && read_settings && check_settings && test \"\$DB_NAME/\$DB_ROLE\" = notes_desk_2/notes_desk_2_auth"' _ "$(settings APP_NAME=notes-desk-2)"

# ---- k8s/pod.yaml, filled in the way deploy.sh fills it ---------------------------

# fill KEY=VALUE...  -> pod.yaml as deploy.sh would apply it, with these settings. deploy.sh is
# read for its functions only (DEPLOY_FUNCTIONS_ONLY): nothing of it runs.
fill() {
  SETTINGS_FILE="$(settings "$@")" IMAGE_GATEWAY=registry.example.test/p/sample-gateway:aaa \
    IMAGE_BRIDGE=registry.example.test/p/sample-bridge:bbb IMAGE_APP=registry.example.test/p/sample-app:ccc \
    DEPLOY_FUNCTIONS_ONLY=yes bash -c '. k8s/deploy.sh && filled_yaml' 2>/dev/null
}

# facts NAME SETTINGS... -- EXPRESSION  -> ok when the Python expression is true for the file
facts() {
  local name="$1" changes=() expression
  shift
  while [[ "$1" != -- ]]; do changes+=("$1"); shift; done
  expression="$2"
  if fill "${changes[@]}" | python3 -c '
import sys, yaml
text = sys.stdin.read()
docs = [doc for doc in yaml.safe_load_all(text) if doc]
def kind(name):
    return [doc for doc in docs if doc["kind"] == name]
kinds = sorted("%s/%s" % (doc["kind"], doc["metadata"]["name"]) for doc in docs)
deployment = kind("Deployment")[0]
pod = deployment["spec"]["template"]["spec"]
containers = {c["name"]: c for c in pod["containers"]}
def env(container, name):
    return next((e.get("value", e.get("valueFrom")) for e in containers[container].get("env", []) if e["name"] == name), None)
secret_refs = [e["valueFrom"]["secretKeyRef"] for doc in docs for tpl in [doc.get("spec", {}).get("template", {}).get("spec", {})]
               for c in tpl.get("containers", []) for e in c.get("env", []) if "valueFrom" in e]
ingress = (kind("Ingress") or [None])[0]
db = (kind("StatefulSet") or [None])[0]
policies = {doc["metadata"]["name"]: doc["spec"] for doc in kind("NetworkPolicy")}
sys.exit(0 if eval(sys.argv[1]) else 1)' "$expression" 2>/dev/null; then ok "$name"; else fail "$name"; fi
}

BASE=(APP_NAME=sample APP_HOST=app.example.test MCP_HOST=mcp.example.test)
KEYS="$(node --input-type=module -e 'import { makeSecrets } from "./k8s/secrets.mjs"; console.log(Object.keys(makeSecrets("me@example.test")).join(" "));')"

for mode in own existing; do
  for ingress in yes no; do
    for names in two one; do
      case_settings=("${BASE[@]}" "POSTGRES_MODE=$mode" "INGRESS=$ingress" PULL_SECRET= STORAGE_CLASS=)
      [[ "$mode" == existing ]] && case_settings+=(POSTGRES_POD=postgres-0 POSTGRES_SERVICE=postgres)
      [[ "$names" == one ]] && case_settings+=(MCP_HOST=app.example.test)
      label="$mode Postgres, Ingress $ingress, $names name(s)"
      facts "every name is filled in and no mark is left ($label)" "${case_settings[@]}" -- \
        'not any("${" in line or "# optional" in line for line in text.splitlines() if not line.lstrip().startswith("#")) and len(docs) >= 4'
      expected="['Deployment/sample', 'NetworkPolicy/sample', 'PersistentVolumeClaim/sample-data', 'Service/sample']"
      [[ "$ingress" == yes ]] && expected="${expected%]}, 'Ingress/sample']"
      [[ "$mode" == own ]] && expected="${expected%]}, 'NetworkPolicy/sample-db', 'Service/sample-db', 'StatefulSet/sample-db']"
      facts "exactly the objects that are meant ($label)" "${case_settings[@]}" -- "kinds == sorted($expected)"
    done
  done
done

TWO=("${BASE[@]}")
facts "one pod, replaced as a whole, with the four programs" "${TWO[@]}" -- \
  'deployment["spec"]["replicas"] == 1 and deployment["spec"]["strategy"]["type"] == "Recreate" and list(containers) == ["gateway", "auth", "bridge", "app"]'
facts "the pod is not root, has no token of the cluster and no service addresses" "${TWO[@]}" -- \
  'pod["securityContext"]["runAsNonRoot"] is True and pod["securityContext"]["runAsUser"] == 1000 and pod["automountServiceAccountToken"] is False and pod["enableServiceLinks"] is False'
facts "every container is locked: read-only, no extra rights" "${TWO[@]}" -- \
  'all(c["securityContext"] == {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}} for c in containers.values())'
facts "every container has a memory limit" "${TWO[@]}" -- 'all("memory" in c["resources"]["limits"] for c in containers.values())'
facts "only the gateway has a port to the outside" "${TWO[@]}" -- \
  '[name for name, c in containers.items() if c.get("ports")] == ["gateway"] and containers["gateway"]["ports"][0]["containerPort"] == 9000'
facts "the images are the three that deploy.sh built, and the stock login server" "${TWO[@]}" -- \
  '[c["image"] for c in containers.values()] == ["registry.example.test/p/sample-gateway:aaa", "supabase/gotrue:v2.197.0", "registry.example.test/p/sample-bridge:bbb", "registry.example.test/p/sample-app:ccc"]'
facts "every secret comes from the Secret of the app, and secrets.mjs makes every key that is used" "${TWO[@]}" -- \
  "all(ref['name'] == 'sample' and ref['key'] in '$KEYS'.split() for ref in secret_refs) and len(secret_refs) >= 7"
facts "the gateway knows the two names, the app, the bridge and the login server" "${TWO[@]}" -- \
  'env("gateway", "PUBLIC_URL") == "https://app.example.test" and env("gateway", "MCP_PUBLIC_URL") == "https://mcp.example.test" and env("gateway", "AUTH_URL") == "http://127.0.0.1:9999" and env("gateway", "APP_UPSTREAM_URL") == "http://127.0.0.1:8080" and env("gateway", "MCP_UPSTREAM_URL") == "http://127.0.0.1:8000/mcp-$(MCP_SECRET)"'
facts "the gateway gets the title, the MCP versions and the open paths from the settings" "${TWO[@]}" "APP_TITLE=Notes & Co" MCP_VERSIONS=2025-11-25 "OPEN_PATHS=/static/, /favicon.ico" -- \
  'env("gateway", "APP_TITLE") == "Notes & Co" and env("gateway", "MCP_VERSIONS") == "2025-11-25" and env("gateway", "OPEN_PATHS") == "/static/, /favicon.ico"'
facts "the login server listens inside the pod only, takes no sign-up, and describes itself with the name of the app" "${TWO[@]}" -- \
  'env("auth", "GOTRUE_API_HOST") == "127.0.0.1" and env("auth", "GOTRUE_DISABLE_SIGNUP") == "true" and env("auth", "GOTRUE_JWT_ISSUER") == "https://app.example.test/auth/v1" and env("auth", "GOTRUE_URI_ALLOW_LIST") == "https://app.example.test/oauth/consent"'
facts "own Postgres: the login server connects to it, with the database and the user of the app" "${TWO[@]}" APP_NAME=notes-desk -- \
  'env("auth", "GOTRUE_DB_DATABASE_URL") == "postgres://notes_desk_auth:$(AUTH_DB_PASSWORD)@notes-desk-db:5432/notes_desk"'
facts "existing Postgres: the login server connects to the one that was named" "${TWO[@]}" POSTGRES_MODE=existing POSTGRES_POD=pg-0 POSTGRES_SERVICE=pg -- \
  'env("auth", "GOTRUE_DB_DATABASE_URL") == "postgres://sample_auth:$(AUTH_DB_PASSWORD)@pg:5432/sample" and db is None'
facts "the bridge gets the command of the MCP server from the settings" "${TWO[@]}" "MCP_COMMAND=my-mcp-server --root /data" -- \
  'env("bridge", "MCP_COMMAND") == "my-mcp-server --root /data"'
facts "the bridge and the app see the same volume at /data" "${TWO[@]}" -- \
  'all({"name": "data", "mountPath": "/data"} in containers[name]["volumeMounts"] for name in ("bridge", "app")) and {"name": "data", "persistentVolumeClaim": {"claimName": "sample-data"}} in pod["volumes"]'
facts "the volume has the size of the settings, and the default storage class when none is named" "${TWO[@]}" STORAGE_SIZE=5Gi STORAGE_CLASS= -- \
  'kind("PersistentVolumeClaim")[0]["spec"]["resources"]["requests"]["storage"] == "5Gi" and "storageClassName" not in kind("PersistentVolumeClaim")[0]["spec"] and "storageClassName" not in db["spec"]["volumeClaimTemplates"][0]["spec"]'
facts "a storage class that is named is used for both volumes" "${TWO[@]}" STORAGE_CLASS=fast -- \
  'kind("PersistentVolumeClaim")[0]["spec"]["storageClassName"] == "fast" and db["spec"]["volumeClaimTemplates"][0]["spec"]["storageClassName"] == "fast"'
facts "no pull secret unless one is named" "${TWO[@]}" PULL_SECRET= -- '"imagePullSecrets" not in pod'
facts "a pull secret that is named is used" "${TWO[@]}" PULL_SECRET=registry-login -- 'pod["imagePullSecrets"] == [{"name": "registry-login"}]'
facts "only the ingress controller may reach the pod, and only the gateway's port" "${TWO[@]}" INGRESS_NAMESPACE=my-ingress -- \
  'policies["sample"]["podSelector"] == {"matchLabels": {"app": "sample"}} and policies["sample"]["policyTypes"] == ["Ingress"] and policies["sample"]["ingress"] == [{"from": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "my-ingress"}}}], "ports": [{"protocol": "TCP", "port": 9000}]}]'
facts "the Ingress has both names, one certificate, and the class and issuer of the settings" "${TWO[@]}" INGRESS_CLASS=my-class CLUSTER_ISSUER=my-issuer -- \
  '[rule["host"] for rule in ingress["spec"]["rules"]] == ["app.example.test", "mcp.example.test"] and ingress["spec"]["tls"] == [{"hosts": ["app.example.test", "mcp.example.test"], "secretName": "sample-tls"}] and ingress["spec"]["ingressClassName"] == "my-class" and ingress["metadata"]["annotations"]["cert-manager.io/cluster-issuer"] == "my-issuer"'
facts "the Ingress lets a long MCP answer through" "${TWO[@]}" -- \
  'ingress["metadata"]["annotations"]["nginx.ingress.kubernetes.io/proxy-buffering"] == "off" and ingress["metadata"]["annotations"]["nginx.ingress.kubernetes.io/proxy-read-timeout"] == "3600"'
facts "with one name the Ingress names it once" "${TWO[@]}" MCP_HOST=app.example.test -- \
  '[rule["host"] for rule in ingress["spec"]["rules"]] == ["app.example.test"] and ingress["spec"]["tls"][0]["hosts"] == ["app.example.test"] and env("gateway", "MCP_PUBLIC_URL") == "https://app.example.test"'
facts "own Postgres: version 16, not root, read-only, its password from the Secret" "${TWO[@]}" -- \
  'db["spec"]["template"]["spec"]["containers"][0]["image"] == "postgres:16-alpine" and db["spec"]["template"]["spec"]["securityContext"]["runAsNonRoot"] is True and db["spec"]["template"]["spec"]["containers"][0]["securityContext"]["readOnlyRootFilesystem"] is True and {"name": "POSTGRES_PASSWORD", "valueFrom": {"secretKeyRef": {"name": "sample", "key": "DB_SUPERUSER_PASSWORD"}}} in db["spec"]["template"]["spec"]["containers"][0]["env"]'
facts "own Postgres: only the pod of the app may reach it" "${TWO[@]}" -- \
  'policies["sample-db"]["podSelector"] == {"matchLabels": {"app": "sample-db"}} and policies["sample-db"]["ingress"] == [{"from": [{"podSelector": {"matchLabels": {"app": "sample"}}}], "ports": [{"protocol": "TCP", "port": 5432}]}]'

# The two halves that deploy.sh applies one after the other are together the whole file.
names_of() {  # reads YAML, prints the kind and name of each object, sorted
  python3 -c 'import sys, yaml; print(" ".join(sorted(d["kind"] + "/" + d["metadata"]["name"] for d in yaml.safe_load_all(sys.stdin) if d)))'
}
halves() {  # FUNCTION  -> the names of the objects in that half of the filled file
  SETTINGS_FILE="$SAMPLE" IMAGE_GATEWAY=a IMAGE_BRIDGE=b IMAGE_APP=c DEPLOY_FUNCTIONS_ONLY=yes \
    bash -c ". k8s/deploy.sh && filled_yaml | $1" 2>/dev/null | names_of
}
SAMPLE="$(settings)"
ALL="$(halves cat)"
DB_HALF="$(halves only_own_postgres)"
REST_HALF="$(halves without_own_postgres)"
check "the Postgres part has its three objects" test "$(wc -w <<<"$DB_HALF")" = 3
check "the rest has the five objects of the app" test "$(wc -w <<<"$REST_HALF")" = 5
check "the Postgres part and the rest are together the whole file" \
  test "$(tr ' ' '\n' <<<"$DB_HALF $REST_HALF" | sort | tr '\n' ' ')" = "$(tr ' ' '\n' <<<"$ALL" | sort | tr '\n' ' ')"

printf '%s passed, %s failed\n' "$PASSED" "$FAILED"
[[ "$FAILED" -eq 0 ]]
