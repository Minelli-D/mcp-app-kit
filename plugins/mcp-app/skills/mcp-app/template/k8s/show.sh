#!/usr/bin/env bash
# Prints the addresses and the login of the app.
# The output holds a secret (the password): do not paste it anywhere.
set -euo pipefail

# shellcheck source=k8s/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
read_settings
check_settings

k get secret "$APP_NAME" >/dev/null 2>&1 \
  || die "The app $APP_NAME is not on the cluster (context $K8S_CONTEXT, namespace $K8S_NAMESPACE). Run k8s/deploy.sh first."

printf 'MCP address (for ChatGPT or Claude):  https://%s/mcp   (authentication: OAuth)\n' "$MCP_HOST"
printf 'The web app:                          https://%s/\n' "$APP_HOST"
printf 'One login for both.\n'
printf '  Email:     %s\n' "$(secret_value LOGIN_EMAIL)"
printf '  Password:  %s\n' "$(secret_value LOGIN_PASSWORD)"
if ! k get ingress "$APP_NAME" >/dev/null 2>&1; then
  printf 'There is NO Ingress yet: the two addresses do not work from outside.\n'
fi
