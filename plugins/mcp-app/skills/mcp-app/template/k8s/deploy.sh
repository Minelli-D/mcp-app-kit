#!/usr/bin/env bash
# Puts the app on Kubernetes: one pod with the gateway, the login server (Supabase Auth), the
# MCP bridge and the web app, and (with POSTGRES_MODE=own) a small Postgres for the login
# server. Everything it needs to know is in settings.env.
# Safe to run again: it changes only what is different.
#
#   bash k8s/deploy.sh
#
# It never prints a secret. To see the addresses and the login: k8s/show.sh
set -euo pipefail

# shellcheck source=k8s/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
read_settings
check_settings

APP_DIR="$ROOT/app"
# Files for a NEW, empty volume (optional folder).
SEED_DIR="$ROOT/seed"

# The names that are filled in in pod.yaml. tests/test-k8s-files.sh reads this line.
# shellcheck disable=SC2016  # the ${...} names are for envsubst, not for the shell
YAML_NAMES='${APP_NAME} ${APP_TITLE} ${APP_HOST} ${MCP_HOST} ${PULL_SECRET} ${STORAGE_CLASS} ${STORAGE_SIZE} ${INGRESS_CLASS} ${INGRESS_NAMESPACE} ${CLUSTER_ISSUER} ${POSTGRES_SERVICE} ${DB_NAME} ${DB_ROLE} ${MCP_COMMAND} ${MCP_VERSIONS} ${OPEN_PATHS} ${IMAGE_GATEWAY} ${IMAGE_BRIDGE} ${IMAGE_APP}'

# What the Secret of the app must hold (k8s/secrets.mjs makes it).
SECRET_KEYS=(MCP_SECRET LOGIN_EMAIL LOGIN_PASSWORD AUTH_DB_PASSWORD DB_SUPERUSER_PASSWORD AUTH_JWT_SECRET AUTH_JWT_KEYS AUTH_SERVICE_KEY)

# The psql command that runs inside the database pod, as the superuser of that Postgres.
# The $NAMES in it are filled in inside the pod, from the pod's own settings.
# tests/test-rehearsal.mjs reads this line and runs the same command on a test database.
# shellcheck disable=SC2016
PSQL_IN_POD='PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}"'

# ---- the parts of pod.yaml -------------------------------------------------------
# tests/test-k8s-files.sh uses these functions as they are.

# Leaves the Ingress out. The parts of the file are separated by lines of "---".
without_ingress() {
  awk 'BEGIN { RS = "\n---\n"; ORS = "\n---\n" } !/(^|\n)kind: Ingress(\n|$)/'
}

# Leaves out the list items that name the second host. With one name they would say the
# first host again, and the same host twice in an Ingress is not valid.
without_second_name() {
  # shellcheck disable=SC2016  # the ${...} name is the text in pod.yaml, not a shell variable
  awk '!/^ *- .*\$\{MCP_HOST\}/'
}

# Only the kit's own Postgres, or everything but it.
only_own_postgres() {
  awk 'BEGIN { RS = "\n---\n"; ORS = "\n---\n" } /mcp-app\/part: own-postgres/'
}
without_own_postgres() {
  awk 'BEGIN { RS = "\n---\n"; ORS = "\n---\n" } !/mcp-app\/part: own-postgres/'
}

# A line that ends with "# optional: NAME" is left out when the setting NAME is empty.
# When it is set, only the mark goes.
with_options() {
  awk -v pull="$PULL_SECRET" -v storage="$STORAGE_CLASS" '
    /# optional: PULL_SECRET$/ { if (pull == "") next }
    /# optional: STORAGE_CLASS$/ { if (storage == "") next }
    { sub(/ +# optional: [A-Z_]+$/, ""); print }'
}

# The filled-in file: without the second name when there is one name, without the Ingress
# when INGRESS=no, without the kit's own Postgres when POSTGRES_MODE=existing, and without
# the lines of settings that are empty.
filled_yaml() {
  local second_name=cat ingress=cat postgres=cat
  if [[ "$MCP_HOST" == "$APP_HOST" ]]; then second_name=without_second_name; fi
  if [[ "$INGRESS" == no ]]; then ingress=without_ingress; fi
  if [[ "$POSTGRES_MODE" == existing ]]; then postgres=without_own_postgres; fi
  "$second_name" <"$HERE/pod.yaml" | with_options | envsubst "$YAML_NAMES" | "$ingress" | "$postgres"
}

# The script stops here when another script only wants the functions above.
if [[ "${DEPLOY_FUNCTIONS_ONLY:-}" == yes ]]; then return 0 2>/dev/null || exit 0; fi

# ---- checks before starting ---------------------------------------------------

for tool in kubectl docker node envsubst; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed."
done
[[ -f "$APP_DIR/Dockerfile" ]] || die "The web app was not found in $APP_DIR."
kubectl config get-contexts -o name 2>/dev/null | grep -qxF "$K8S_CONTEXT" \
  || die "kubectl has no context \"$K8S_CONTEXT\" (the setting K8S_CONTEXT). See: kubectl config get-contexts"
k get namespace "$K8S_NAMESPACE" >/dev/null 2>&1 \
  || die "kubectl cannot see the namespace \"$K8S_NAMESPACE\" in the cluster of \"$K8S_CONTEXT\". Check the connection, or make it: kubectl --context $K8S_CONTEXT create namespace $K8S_NAMESPACE"
if [[ "$POSTGRES_MODE" == existing ]]; then
  k get pod "$POSTGRES_POD" >/dev/null 2>&1 \
    || die "The database pod \"$POSTGRES_POD\" was not found in the namespace \"$K8S_NAMESPACE\" (the setting POSTGRES_POD)."
fi

# A Secret from an earlier run is kept. It must be complete and for the same email.
have_secret=no
if k get secret "$APP_NAME" >/dev/null 2>&1; then
  have_secret=yes
  stored_email="$(secret_value LOGIN_EMAIL)"
  [[ "$stored_email" == "$LOGIN_EMAIL" ]] \
    || die "This setup already has a login email: $stored_email. Put that email into settings.env (LOGIN_EMAIL)."
  # The names of the keys only, never a value.
  stored_keys="$(k get secret "$APP_NAME" -o go-template='{{range $key, $value := .data}}{{$key}}{{"\n"}}{{end}}')"
  for key in "${SECRET_KEYS[@]}"; do
    grep -qx "$key" <<<"$stored_keys" \
      || die "The Secret $APP_NAME has no $key: it is from an older setup. Delete it (kubectl --context $K8S_CONTEXT -n $K8S_NAMESPACE delete secret $APP_NAME) and run again. The login password will be a new one."
  done
fi

if [[ "$MCP_HOST" == "$APP_HOST" ]]; then
  info "Cluster $K8S_CONTEXT, namespace $K8S_NAMESPACE, app $APP_NAME, host $APP_HOST"
else
  info "Cluster $K8S_CONTEXT, namespace $K8S_NAMESPACE, app $APP_NAME, host $APP_HOST, and $MCP_HOST for MCP"
fi

# ---- images --------------------------------------------------------------------

# A tag made from the content of the folder (and, for the bridge, of the packages that the
# build installs): the same input gives the same tag.
image_tag() {  # FOLDER [MORE]
  { (cd "$1" && find . -type f ! -path '*/__pycache__/*' -print0 | sort -z | xargs -0 sha256sum); printf '%s\n' "${2:-}"; } \
    | sha256sum | cut -c1-12
}

build_push() {  # NAME FOLDER [MORE FOR THE TAG] [BUILD OPTIONS...] -> prints the image address
  local name="$1" folder="$2" more="${3:-}" image
  shift 2
  [[ $# -gt 0 ]] && shift
  image="$REGISTRY/$APP_NAME-$name:$(image_tag "$folder" "$more")"
  docker build -q "$@" -t "$image" "$folder" >/dev/null || die "Could not build the $name image."
  docker push -q "$image" >/dev/null || die "Could not push $image. Run: docker login ${REGISTRY%%/*}"
  printf '%s' "$image"
}

info "Images: building and pushing (the first time takes a few minutes)."
IMAGE_GATEWAY="$(build_push gateway "$ROOT/gateway")"
IMAGE_BRIDGE="$(build_push bridge "$ROOT/bridge" "$MCP_PACKAGES" --build-arg "MCP_PACKAGES=$MCP_PACKAGES")"
IMAGE_APP="$(build_push app "$APP_DIR")"
export IMAGE_GATEWAY IMAGE_BRIDGE IMAGE_APP

# ---- the Secret (made once, kept after that) ------------------------------------

if [[ "$have_secret" == yes ]]; then
  info "Secret: already there, kept."
else
  node "$HERE/secrets.mjs" "$APP_NAME" "$K8S_NAMESPACE" "$LOGIN_EMAIL" | kubectl --context "$K8S_CONTEXT" create -f - >/dev/null
  info "Secret: made."
fi

# ---- the Postgres of the kit (POSTGRES_MODE=own) ------------------------------------

if [[ "$POSTGRES_MODE" == own ]]; then
  filled_yaml | only_own_postgres | k apply -f - >/dev/null
  k rollout status "statefulset/$APP_NAME-db" --timeout=300s >/dev/null \
    || die "The Postgres of the app did not start. Look at: kubectl --context $K8S_CONTEXT -n $K8S_NAMESPACE describe pod $POSTGRES_POD"
  info "Postgres: $APP_NAME-db is running."
fi

# ---- the database of the login server -------------------------------------------

# Runs k8s/auth-db.sql in the Postgres. The password of the new database user goes in on
# standard input, as a psql variable: it is never on a command line.
prepare_database() {
  local password
  password="$(secret_value AUTH_DB_PASSWORD)"
  [[ "$password" =~ ^[0-9a-f]{32,}$ ]] || die "AUTH_DB_PASSWORD in the Secret $APP_NAME is not a password that k8s/secrets.mjs made."
  { printf '%s\n' "\\set auth_password '$password'" "\\set db_name '$DB_NAME'" "\\set db_role '$DB_ROLE'"; cat "$HERE/auth-db.sql"; } \
    | k exec -i "$POSTGRES_POD" -- sh -c "$PSQL_IN_POD" >/dev/null
}
prepare_database || die "The database of the login server could not be prepared. Look at the lines above, and at: kubectl --context $K8S_CONTEXT -n $K8S_NAMESPACE logs $POSTGRES_POD --tail=20"
info "Database: $DB_NAME is ready in $POSTGRES_POD."

# ---- the app ---------------------------------------------------------------------

filled_yaml | without_own_postgres | k apply -f - >/dev/null
if [[ "$INGRESS" == no ]]; then
  info "App: applied, WITHOUT the Ingress (INGRESS=no)."
else
  info "App: applied."
fi

k rollout status "deployment/$APP_NAME" --timeout=300s >/dev/null \
  || die "The app did not start. Look at: kubectl --context $K8S_CONTEXT -n $K8S_NAMESPACE describe pod -l app=$APP_NAME"
info "App: running."

# ---- the user --------------------------------------------------------------------

# The login server listens inside the pod only, so the user is made from inside the pod:
# k8s/create-user.mjs runs in the gateway container, which has Node and reaches the login
# server (the container's own AUTH_URL). The script and its three secrets go in on standard
# input: nothing is on a command line, and nothing stays in the container afterwards.
create_user() {
  local settings
  settings="$(SERVICE_KEY="$(secret_value AUTH_SERVICE_KEY)" LOGIN_EMAIL="$(secret_value LOGIN_EMAIL)" \
    LOGIN_PASSWORD="$(secret_value LOGIN_PASSWORD)" node -e '
      const { SERVICE_KEY, LOGIN_EMAIL, LOGIN_PASSWORD } = process.env;
      process.stdout.write(JSON.stringify({ SERVICE_KEY, LOGIN_EMAIL, LOGIN_PASSWORD }));')"
  { printf 'Object.assign(process.env, %s);\n' "$settings"; cat "$HERE/create-user.mjs"; } \
    | k exec -i "deploy/$APP_NAME" -c gateway -- node --input-type=module -
}
user_result="$(create_user | tail -n 1)" || die "The login user could not be made."
info "Login: ${user_result#create-user: }."

# ---- files for a new volume (optional) ----------------------------------------------

# Fills a NEW volume with the files of the folder seed/. A volume that already holds a file
# is left alone: a file that was deleted on the cluster must not come back with the next deploy.
seed_volume() {
  [[ -d "$SEED_DIR" ]] || return 0
  local here there
  there="$(k exec "deploy/$APP_NAME" -c bridge -- sh -c 'cd /data && find . -type f')"
  if [[ -n "$there" ]]; then
    info "Files: the volume already has files, nothing copied."
    return 0
  fi
  here="$(cd "$SEED_DIR" && find . -type f)"
  [[ -n "$here" ]] || return 0
  (cd "$SEED_DIR" && tar -cf - --no-recursion -T <(printf '%s\n' "$here")) \
    | k exec -i "deploy/$APP_NAME" -c bridge -- tar -xf - -C /data
  info "Files: copied $(wc -l <<<"$here") file(s) from seed/ to the new volume."
}
seed_volume

# ---- the result ----------------------------------------------------------------

ready="$(k get certificate "$APP_NAME-tls" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
info ""
info "Done."
info "  MCP address (for ChatGPT or Claude):  https://$MCP_HOST/mcp   (authentication: OAuth)"
info "  The web app:                          https://$APP_HOST/"
info "  The login for both:                   run k8s/show.sh"
# Every public name needs its own DNS record.
if [[ "$MCP_HOST" == "$APP_HOST" ]]; then
  dns_names="$APP_HOST"
else
  dns_names="$APP_HOST and $MCP_HOST"
fi
if [[ "$INGRESS" == no ]]; then
  info ""
  info "There is NO Ingress yet: these addresses do not work until INGRESS=yes is in settings.env,"
  info "the script is run again, and a public DNS record points $dns_names to this cluster."
elif [[ "$ready" != "True" ]]; then
  info ""
  info "The HTTPS certificate is NOT ready yet. It needs a public DNS record:"
  info "  $dns_names  ->  the public address of the ingress of this cluster"
  if [[ "$MCP_HOST" != "$APP_HOST" ]]; then
    info "It is ONE certificate for both names: it arrives only when both records exist."
  fi
  info "After the record exists, the certificate arrives by itself in a few minutes. Check with:"
  info "  bash k8s/doctor.sh"
fi
