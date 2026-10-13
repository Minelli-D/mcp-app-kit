#!/usr/bin/env bash
# The settings of the app, for the scripts in this folder. It is read by them (". lib.sh"),
# never run by itself.
#
# settings.env is READ, line by line, not run as a script: a value can never become a command.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERE="$ROOT/k8s"
SETTINGS_FILE="${SETTINGS_FILE:-$ROOT/settings.env}"

# Every setting that settings.env may hold, with its value when the file does not say.
SETTING_NAMES=(APP_NAME APP_TITLE APP_HOST MCP_HOST LOGIN_EMAIL K8S_CONTEXT K8S_NAMESPACE REGISTRY PULL_SECRET
  STORAGE_CLASS STORAGE_SIZE INGRESS INGRESS_CLASS INGRESS_NAMESPACE CLUSTER_ISSUER POSTGRES_MODE POSTGRES_POD POSTGRES_SERVICE
  MCP_PACKAGES MCP_COMMAND MCP_VERSIONS OPEN_PATHS)
APP_NAME="" APP_TITLE="" APP_HOST="" MCP_HOST="" LOGIN_EMAIL="" K8S_CONTEXT="" K8S_NAMESPACE="" REGISTRY=""
PULL_SECRET="" STORAGE_CLASS="" STORAGE_SIZE="1Gi" INGRESS="yes" INGRESS_CLASS="nginx" INGRESS_NAMESPACE="ingress-nginx" CLUSTER_ISSUER="letsencrypt"
POSTGRES_MODE="own" POSTGRES_POD="" POSTGRES_SERVICE=""
MCP_PACKAGES="@modelcontextprotocol/server-filesystem@2026.8.31" MCP_COMMAND="mcp-server-filesystem /data"
MCP_VERSIONS="2025-11-25,2025-06-18,2025-03-26,2024-11-05,2024-10-07" OPEN_PATHS="/static/"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '%s\n' "$*"
}

is_host_name() {  # NAME
  [[ "$1" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]
}

# Reads settings.env into the variables above. A line is NAME=value; spaces around the value
# and one pair of quotes around it are dropped. A name that is not a setting stops the script.
read_settings() {
  [[ -f "$SETTINGS_FILE" ]] || die "The settings file was not found: $SETTINGS_FILE"
  local line name value known
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[[:space:]]*([A-Z][A-Z0-9_]*)=(.*)$ ]] || die "settings.env: this line is not NAME=value: $line"
    name="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    known=no
    for known_name in "${SETTING_NAMES[@]}"; do [[ "$known_name" == "$name" ]] && known=yes; done
    [[ "$known" == yes ]] || die "settings.env: $name is not a setting of this kit."
    printf -v "$name" '%s' "$value"
  done <"$SETTINGS_FILE"
}

# Checks every setting, and works out the names that follow from them. A value goes into a
# Kubernetes file, an address or a command, so each one may hold only what is safe there.
check_settings() {
  [[ "$APP_NAME" =~ ^[a-z][a-z0-9-]{0,39}$ && "$APP_NAME" != *- && "$APP_NAME" != *--* ]] \
    || die "APP_NAME must be lower-case letters, digits and \"-\", start with a letter, and be at most 40 long. It is: \"$APP_NAME\""
  [[ -n "$APP_TITLE" && ${#APP_TITLE} -le 60 && "$APP_TITLE" =~ ^[A-Za-z0-9\ ._\&\'!,:+()-]+$ ]] \
    || die "APP_TITLE must be 1 to 60 letters, digits, spaces and . _ & ' ! , : + ( ) -. It is: \"$APP_TITLE\""
  is_host_name "$APP_HOST" || die "APP_HOST is not a host name: \"$APP_HOST\". Example: app.example.com"
  [[ -n "$MCP_HOST" ]] || MCP_HOST="$APP_HOST"
  is_host_name "$MCP_HOST" || die "MCP_HOST is not a host name: \"$MCP_HOST\". Example: mcp.example.com"
  [[ "$LOGIN_EMAIL" =~ ^[^@[:space:]\"\'\\]+@[^@[:space:]\"\'\\]+\.[^@[:space:]\"\'\\]+$ ]] \
    || die "LOGIN_EMAIL is not an email address: \"$LOGIN_EMAIL\""
  [[ "$K8S_CONTEXT" =~ ^[A-Za-z0-9@._:/-]+$ ]] || die "K8S_CONTEXT is missing or has signs that a context name does not have: \"$K8S_CONTEXT\""
  [[ "$K8S_NAMESPACE" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "K8S_NAMESPACE is not the name of a namespace: \"$K8S_NAMESPACE\""
  [[ "$REGISTRY" =~ ^[a-z0-9]([a-z0-9.:-]*[a-z0-9])?(/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*$ ]] \
    || die "REGISTRY must look like host/project. It is: \"$REGISTRY\""
  [[ -z "$PULL_SECRET" || "$PULL_SECRET" =~ ^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$ ]] || die "PULL_SECRET is not the name of a Secret: \"$PULL_SECRET\""
  [[ -z "$STORAGE_CLASS" || "$STORAGE_CLASS" =~ ^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$ ]] || die "STORAGE_CLASS is not the name of a storage class: \"$STORAGE_CLASS\""
  [[ "$STORAGE_SIZE" =~ ^[1-9][0-9]{0,3}(Mi|Gi)$ ]] || die "STORAGE_SIZE must look like 1Gi or 500Mi. It is: \"$STORAGE_SIZE\""
  [[ "$INGRESS" == yes || "$INGRESS" == no ]] || die "INGRESS must be yes or no. It is: \"$INGRESS\""
  [[ "$INGRESS_CLASS" =~ ^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$ ]] || die "INGRESS_CLASS is not the name of an ingress class: \"$INGRESS_CLASS\""
  [[ "$INGRESS_NAMESPACE" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "INGRESS_NAMESPACE is not the name of a namespace: \"$INGRESS_NAMESPACE\""
  [[ "$CLUSTER_ISSUER" =~ ^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$ ]] || die "CLUSTER_ISSUER is not the name of a cluster issuer: \"$CLUSTER_ISSUER\""
  [[ "$MCP_PACKAGES" =~ ^[@A-Za-z0-9._/\ -]+$ ]] || die "MCP_PACKAGES must be npm package names with their versions, with spaces between them. It is: \"$MCP_PACKAGES\""
  [[ "$MCP_COMMAND" =~ ^[A-Za-z0-9@._/=:,\ -]+$ ]] || die "MCP_COMMAND may hold letters, digits, spaces and @ . _ / = : , - only. It is: \"$MCP_COMMAND\""
  [[ "$MCP_VERSIONS" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}(,\ ?[0-9]{4}-[0-9]{2}-[0-9]{2})*$ ]] || die "MCP_VERSIONS must be dates like 2025-11-25 with commas between them. It is: \"$MCP_VERSIONS\""
  [[ "$OPEN_PATHS" =~ ^/[A-Za-z0-9._/-]*(,\ ?/[A-Za-z0-9._/-]*)*$ && "$OPEN_PATHS" != *..* && "$OPEN_PATHS" != *//* ]] \
    || die "OPEN_PATHS must be paths that start with \"/\", with commas between them. It is: \"$OPEN_PATHS\""

  # The database of the login server, and its user: the name of the app with "_" for "-".
  DB_NAME="${APP_NAME//-/_}"
  DB_ROLE="${DB_NAME}_auth"
  case "$POSTGRES_MODE" in
    own)
      POSTGRES_POD="$APP_NAME-db-0"
      POSTGRES_SERVICE="$APP_NAME-db"
      ;;
    existing)
      [[ "$POSTGRES_POD" =~ ^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$ ]] || die "POSTGRES_MODE=existing needs POSTGRES_POD, the pod of that Postgres. It is: \"$POSTGRES_POD\""
      [[ "$POSTGRES_SERVICE" =~ ^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$ ]] || die "POSTGRES_MODE=existing needs POSTGRES_SERVICE, the name the login server connects to. It is: \"$POSTGRES_SERVICE\""
      ;;
    *) die "POSTGRES_MODE must be own or existing. It is: \"$POSTGRES_MODE\"" ;;
  esac
  export APP_NAME APP_TITLE APP_HOST MCP_HOST PULL_SECRET STORAGE_CLASS STORAGE_SIZE INGRESS_CLASS INGRESS_NAMESPACE CLUSTER_ISSUER
  export POSTGRES_SERVICE DB_NAME DB_ROLE MCP_COMMAND MCP_VERSIONS OPEN_PATHS
}

# kubectl, always with the context and the namespace of the settings.
k() {
  kubectl --context "$K8S_CONTEXT" -n "$K8S_NAMESPACE" "$@"
}

# One value of the Secret, on standard output. Only ever used inside $(...) or a pipe.
secret_value() {  # KEY
  k get secret "$APP_NAME" -o "jsonpath={.data.$1}" | base64 -d
}
