# Architecture of the pod

What is inside the pod, who talks to whom, and how each kind of request travels.
No secret is written in this file.

## 1. One picture

```
   browser                         MCP client (ChatGPT, Claude)
      │ https://APP_HOST                │ https://MCP_HOST/mcp
      ▼                                 ▼
   ┌──────────────────────────────────────────────────────┐
   │ ingress (TLS ends here; one certificate, both names) │
   └──────────────────────────────────────────────────────┘
      │ http, port 9000, only from the ingress namespace (NetworkPolicy)
      ▼
 ┌───────────────────────────── pod ─────────────────────────────┐
 │  ┌──────────┐ 127.0.0.1:9999 ┌────────────────┐               │
 │  │          │ ─────────────► │ auth           │ ──► Postgres  │
 │  │ gateway  │                └────────────────┘               │
 │  │ :9000    │ 127.0.0.1:8000 ┌────────────────┐               │
 │  │          │ ─────────────► │ bridge (MCP)   │ ──┐           │
 │  │ the only │                └────────────────┘   ├─► /data   │
 │  │ door     │ 127.0.0.1:8080 ┌────────────────┐   │  (volume) │
 │  │          │ ─────────────► │ app            │ ──┘           │
 │  └──────────┘                └────────────────┘               │
 └───────────────────────────────────────────────────────────────┘
```

Four containers share the network of the pod, so they reach each other on `127.0.0.1`. Only
the gateway has a port that the outside can reach.

## 2. The containers

| | gateway | auth | bridge | app |
|---|---|---|---|---|
| Job | Login, sessions, checks every request, passes it on | Users, passwords, tokens, OAuth | Gives an MCP client its tools | Your web pages |
| Code | `gateway/` (Node.js, no dependencies) | Stock image `supabase/gotrue` | `supergateway` + the MCP server of the settings | `app/` |
| Listens on | `0.0.0.0:9000` | `127.0.0.1:9999` | port `8000`, on a secret path | `127.0.0.1:8080` |
| Volume | none | none (uses Postgres) | `/data` | `/data` |

Every container runs as user 1000, with a read-only root file system, no Linux capabilities
and a memory limit. The pod gets no Kubernetes API token.

With `POSTGRES_MODE=own` a second, small pod runs Postgres 16 for the login server only. A
network rule lets only the pod of the app reach it.

## 3. How a request travels

**Open the app.** The browser asks for a page. Without a session the gateway answers with a
redirect to `/login`. The login form goes to the gateway, which asks the login server to check
the password, checks the token it gets back, and sets two cookies: an access token (1 hour)
and a refresh token (30 days). Both are `HttpOnly`, `Secure` and `SameSite=Lax`. With the
cookies the page comes from the app.

**The session renews itself.** When the access token has run out, the gateway uses the
refresh token to get a new pair and sets new cookies. Requests that arrive together share one
renewal.

**How a token is checked** (the same for a browser session and for an MCP client): the
signature, with the public keys of the login server (never a shared secret); the issuer;
not expired; a logged-in user; and the email is the one allowed email.

**A form.** A request that changes something passes only when it comes from this site: the
gateway looks at `Sec-Fetch-Site` and `Origin`. `Origin: null` (what Chrome sends when a page
asks for no referrer) is accepted only together with `Sec-Fetch-Site: same-origin`.

**An MCP client connects for the first time (OAuth 2.1).** The client calls `/mcp` without a
token and gets 401 with the address of a small document. That document names the login
server. The client registers itself, sends the user to the login and consent page (on the
name of the app), and gets a token.

**An MCP client uses a tool.** The client sends `/mcp` with the token. The gateway checks
the token, removes it, and passes the request to the bridge with the headers of the protocol
(`Mcp-*`, `Content-Type`, `Content-Length`, `Content-Encoding`, `Accept`, `Last-Event-ID`).
For each request the bridge starts the MCP server, lets it answer, and stops it.

**Protocol versions.** A request in a version that is not in `MCP_VERSIONS` is answered by the
gateway itself with "Unsupported protocol version", in the words of an older MCP server. A
client that asked in the newest version first then goes on with `initialize`.

## 4. What protects it

- One public door; the login server and the app listen on `127.0.0.1` only; the bridge is
  behind a network rule and a secret path.
- TLS at the ingress, with an automatic certificate.
- Nobody can sign up. One user. The gateway checks the email on every request.
- Tokens are checked by the gateway itself, and never passed on to the bridge or the app.
- Session cookies cannot be read by scripts and are not sent by forms of other sites.
- Rate limits: 10 login tries in 10 minutes for one address.
- Secrets live in one Kubernetes Secret, never in an image, a log or this repository.
- The gateway log holds no address, no name and no token.

## 5. The settings and the names that follow from them

| From `APP_NAME=my-app` | Name |
|---|---|
| Deployment, Service, Ingress, NetworkPolicy, Secret | `my-app` |
| Volume claim of the files | `my-app-data` |
| Certificate secret | `my-app-tls` |
| Images | `<REGISTRY>/my-app-gateway`, `-bridge`, `-app` |
| Database and its user | `my_app`, `my_app_auth` |
| Own Postgres (`POSTGRES_MODE=own`) | StatefulSet, Service, NetworkPolicy `my-app-db` |
