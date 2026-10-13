# The doctor playbook

What a symptom means, how to see it, and the fix. Every case here happened on a real
installation. Start with `bash k8s/doctor.sh` and `node k8s/probe.mjs`.

The gateway writes one JSON line for each request: time, kind (`route`), method, status,
milliseconds. A refusal on `/mcp` adds `why`. A refusal of the bridge also adds `sent` (the
headers that describe the request, and the first bytes of the body) and `answer`.

## 1. ChatGPT says "couldn't find an available action" or "action discovery failed"

Look at the `/mcp` lines of the gateway log.

- **`400` with `why: this protocol version is not served`, followed by `200` lines.**
  This is normal. ChatGPT asks in the newest MCP version first (`server/discover`, version
  `2026-07-28`). The gateway answers "Unsupported protocol version", as an older MCP server
  would, and ChatGPT goes on with `initialize`. Nothing to fix.
- **The same `400`, and NO `200` after it.** The client has no fallback to the older
  handshake. Add the version to `MCP_VERSIONS` only if the MCP server behind the bridge can
  answer that version. If it cannot, the MCP server must be updated first.
- **`400` with `why: the bridge said no` and an answer `-32020 ... mcp-method does not match
  the request body`.** Something in front of the bridge removes the `Mcp-*` headers. The
  gateway passes every header that starts with `mcp-`; look for another proxy in between.
- **A `400` with the answer "Parse error: invalid JSON".** The body is compressed and
  `Content-Encoding` did not reach the bridge. The gateway passes that header; look for
  another proxy.
- **`406` from the bridge.** The client must accept both `application/json` and
  `text/event-stream`.

## 2. `401` with `why: no token`

Normal before a login: this is how an MCP client finds the login server. It is a problem
only when it comes AFTER a login, again and again: then the client lost its token (see 4).

## 3. A form of the app answers 403 "This request came from another site"

The gateway takes a form only from this site. Chrome sends `Origin: null` when the page was
served with `Referrer-Policy: no-referrer`; the gateway accepts that only together with
`Sec-Fetch-Site: same-origin`. A proxy in front that removes `Sec-Fetch-Site` breaks this.
An app that posts from another origin (another host name, another port) is refused on purpose.

## 4. The login page comes back about an hour after a login

The access token lasts one hour; then the gateway renews it with the refresh token. If the
log of the login server shows `refresh_token_not_found`, the sessions were removed from the
database (somebody cleaned it) or the database is a new one. Log in again: nothing else to do.

On an iPhone, each "Add to Home Screen" is a separate app with its own empty login.

## 5. Many logins in a few seconds, then 429

The password check is slow on purpose. Repeated taps on "Log in" are joined into one check by
the gateway. The limit is 10 tries in 10 minutes for one address: wait ten minutes.

## 6. The certificate is not ready

It is ONE certificate for both public names. It arrives only when BOTH names have a public
DNS record that points to the ingress. `doctor.sh` prints what each name resolves to and the
message of the certificate. Also check that cert-manager runs and that `CLUSTER_ISSUER` is
the name of an issuer that exists.

## 7. The login server (container `auth`) does not start

- **`role "postgres" does not exist`**: the migrations of Supabase Auth give rights to a role
  named `postgres`. `k8s/auth-db.sql` makes that role (without login) when it is missing. Run
  `k8s/deploy.sh` again; if it still fails, the database script did not run in the right
  Postgres (`POSTGRES_POD`).
- **It cannot connect to the database**: with `POSTGRES_MODE=existing`, `POSTGRES_SERVICE`
  must be the name that pods use to reach that Postgres, and a network rule there may have to
  let the pod of the app in.

## 8. `docker push` is refused

The registry user may only pull. Run `docker login <registry host>` with a user that may push
to the project of `REGISTRY`.

## 9. After a deploy a page keeps its old look

A browser keeps a stylesheet or a picture that has a fixed address, sometimes for a year.
Give such addresses a mark that changes with the content (`/static/app.css?v=<hash>`). The
gateway does this for its own stylesheet.

## 10. kubectl talks to the wrong cluster

It cannot happen through the scripts: every call names `K8S_CONTEXT`. If `deploy.sh` says
that the context does not exist, compare the setting with `kubectl config get-contexts`.

## 11. The pod does not start after a deploy

`kubectl --context <context> -n <namespace> describe pod -l app=<APP_NAME>` says why.
The usual reasons: the image cannot be pulled (set `PULL_SECRET`), the volume is not bound
(no default storage class: set `STORAGE_CLASS`), or the old pod still holds the volume (the
Deployment replaces the pod as a whole; wait a minute).

## 12. An MCP client can connect, but its tools fail or see no files

The MCP server runs in the bridge and sees `/data` only. The app sees the same volume at
`/data`. A tool that fails with "access denied" was given a path outside `/data`.
