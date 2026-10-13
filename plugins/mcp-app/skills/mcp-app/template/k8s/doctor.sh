#!/usr/bin/env bash
# Looks at the app on the cluster and from outside, and prints what it finds. It changes
# nothing and prints no secret. Use it after a deploy, and when a login or an MCP client fails.
#
#   bash k8s/doctor.sh
set -uo pipefail

# shellcheck source=k8s/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
read_settings
check_settings

section() {
  printf '\n== %s ==\n' "$*"
}

# The status and one header of an address, from outside. "000" when nothing answers.
outside() {  # METHOD URL -> "status [www-authenticate]"
  curl -s -o /dev/null -m 15 -X "$1" -w '%{http_code} %header{www-authenticate}' "$2" 2>/dev/null || printf '000'
}

section "Settings"
info "app $APP_NAME, context $K8S_CONTEXT, namespace $K8S_NAMESPACE"
info "app https://$APP_HOST/   MCP https://$MCP_HOST/mcp   Postgres: $POSTGRES_MODE ($POSTGRES_POD)"

section "The pod"
if ! kubectl config get-contexts -o name 2>/dev/null | grep -qxF "$K8S_CONTEXT"; then
  info "PROBLEM: kubectl has no context \"$K8S_CONTEXT\"."
elif ! k get deployment "$APP_NAME" >/dev/null 2>&1; then
  info "PROBLEM: the app is not on the cluster (no Deployment $APP_NAME). Run k8s/deploy.sh."
else
  k get pods -l "app=$APP_NAME" --no-headers 2>/dev/null || true
  # Each container: ready or not, restarts, and why it waits or stopped last.
  k get pods -l "app=$APP_NAME" -o jsonpath='{range .items[*].status.containerStatuses[*]}{.name}{": ready="}{.ready}{" restarts="}{.restartCount}{" waiting="}{.state.waiting.reason}{" last="}{.lastState.terminated.reason}{"\n"}{end}' 2>/dev/null || true
  k get deployment "$APP_NAME" -o jsonpath='{range .spec.template.spec.containers[*]}{"image "}{.name}{": "}{.image}{"\n"}{end}' 2>/dev/null || true
  if [[ "$POSTGRES_MODE" == own ]]; then
    k get pods -l "app=$APP_NAME-db" --no-headers 2>/dev/null || info "PROBLEM: the Postgres of the app has no pod."
  fi
fi

section "Ingress and certificate"
if [[ "$INGRESS" == no ]]; then
  info "INGRESS=no in settings.env: there is no public address."
else
  k get ingress "$APP_NAME" --no-headers 2>/dev/null || info "PROBLEM: there is no Ingress $APP_NAME."
  ready="$(k get certificate "$APP_NAME-tls" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
  until="$(k get certificate "$APP_NAME-tls" -o jsonpath='{.status.notAfter}' 2>/dev/null || true)"
  if [[ "$ready" == True ]]; then
    info "certificate: ready, good until $until"
  else
    info "PROBLEM: the certificate is not ready. It is ONE certificate for every public name: it arrives only when each name points to the ingress."
    k get certificate "$APP_NAME-tls" -o jsonpath='{.status.conditions[?(@.type=="Ready")].message}{"\n"}' 2>/dev/null || true
  fi
fi

section "DNS"
ingress_address="$(k get ingress "$APP_NAME" -o jsonpath='{.status.loadBalancer.ingress[*].ip}{.status.loadBalancer.ingress[*].hostname}' 2>/dev/null || true)"
[[ -n "$ingress_address" ]] && info "the Ingress says its address is: $ingress_address"
for name in "$APP_HOST" "$MCP_HOST"; do
  found="$(getent ahosts "$name" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
  if [[ -n "$found" ]]; then info "$name -> $found"; else info "PROBLEM: $name does not resolve. It needs a public DNS record that points to the ingress."; fi
  [[ "$MCP_HOST" == "$APP_HOST" ]] && break
done

section "From outside"
if [[ "$INGRESS" == yes ]]; then
  info "GET  https://$APP_HOST/healthz        -> $(outside GET "https://$APP_HOST/healthz")   (good: 200)"
  info "GET  https://$APP_HOST/login          -> $(outside GET "https://$APP_HOST/login")   (good: 200)"
  info "GET  https://$APP_HOST/               -> $(outside GET "https://$APP_HOST/")   (good: 303, to the login)"
  info "POST https://$MCP_HOST/mcp   no token -> $(outside POST "https://$MCP_HOST/mcp")"
  info "     (good: 401 and a line that names .../.well-known/oauth-protected-resource/mcp)"
  info "GET  https://$MCP_HOST/.well-known/oauth-protected-resource -> $(outside GET "https://$MCP_HOST/.well-known/oauth-protected-resource")   (good: 200)"
fi

section "What the gateway refused in the last 6 hours"
# One line for each kind of refusal on /mcp: how often, and the newest example. The log holds
# no address, no name and no token.
lines="$(k logs "deploy/$APP_NAME" -c gateway --since=6h 2>/dev/null | grep '^{' || true)"
if [[ -z "$lines" ]]; then
  info "no log lines (the pod is new, or it cannot be read)"
else
  node -e '
    const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
    const kinds = new Map();
    let good = 0;
    const routes = new Map();
    for (const text of lines) {
      let line;
      try { line = JSON.parse(text); } catch { continue; }
      if (line.error) { kinds.set("gateway error: " + line.error, { count: (kinds.get("gateway error: " + line.error)?.count ?? 0) + 1, last: line }); continue; }
      const key = `${line.route} ${line.method} ${line.status}`;
      routes.set(key, (routes.get(key) ?? 0) + 1);
      if (line.route !== "mcp") continue;
      if (line.status < 400) { good += 1; continue; }
      const kind = `${line.status} ${line.why ?? "(no reason)"}`;
      kinds.set(kind, { count: (kinds.get(kind)?.count ?? 0) + 1, last: line });
    }
    console.log(`/mcp answered well ${good} time(s).`);
    for (const [kind, { count, last }] of kinds) {
      console.log(`${count} x ${kind}`);
      if (last.sent) console.log(`     sent: ${JSON.stringify(last.sent)}`);
      if (last.answer) console.log(`     answer: ${String(last.answer).slice(0, 240)}`);
    }
    console.log("requests by kind: " + [...routes].sort().map(([key, count]) => `${key} x${count}`).join(", "));
  ' <<<"$lines"
fi

section "The login server in the last 6 hours"
k logs "deploy/$APP_NAME" -c auth --since=6h 2>/dev/null | grep '^{' | node -e '
  const kinds = new Map();
  for (const text of require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean)) {
    let line;
    try { line = JSON.parse(text); } catch { continue; }
    if (!line.path || !/token|logout|oauth/.test(line.path)) continue;
    const key = `${line.path} ${line.grant_type ?? ""} ${line.status ?? ""} ${line.error_code ?? ""}`.replace(/\s+/g, " ").trim();
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
  }
  if (kinds.size === 0) console.log("no login or token requests");
  for (const [key, count] of [...kinds].sort()) console.log(`${count} x ${key}`);
' 2>/dev/null || info "the log of the login server cannot be read"

info ""
info "For a test of the whole login and the MCP handshake: node k8s/probe.mjs"
