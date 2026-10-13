# mcp-app-kit

A Claude Code plugin that creates and deploys, from zero, a **web app with a login and an MCP
endpoint** on Kubernetes. ChatGPT or Claude can connect to the MCP endpoint with OAuth, and
you use the web app in a browser, behind the same login.

It is for ONE user: your own tools, your own data.

```
internet ──► ingress ──► gateway ──┬──► bridge  (the MCP server) ──┬──► files (one volume)
                                   ├──► app     (your web pages) ──┘
                                   └──► auth    (Supabase Auth) ──► Postgres
```

One pod, four containers. Only the gateway can be reached from outside. It has the login
page, keeps the session, does the OAuth part for MCP clients, checks every token, and passes
a request on only when it may pass.

## Install

```
/plugin marketplace add Minelli-D/mcp-app-kit
/plugin install mcp-app@mcp-app-kit
```

## The three commands

| Command | What it does |
|---|---|
| `/mcp-app:new` | Asks for a few values (name, the two public names, email, cluster, registry) and makes a new project with green tests |
| `/mcp-app:deploy` | Runs the tests, asks once, then builds, pushes and deploys, and checks the result from outside |
| `/mcp-app:doctor` | Finds out why a login or an MCP connection fails, from the logs and a real test, and says how to fix it |

## What a new project holds

- `gateway/`: the public door (Node.js, no dependencies), with 127 tests.
- `bridge/`: `supergateway` plus the MCP server you choose (usually the file server).
- `app/`: a small example app that you replace with your own.
- `k8s/`: the Kubernetes file and the scripts `deploy.sh`, `doctor.sh`, `probe.mjs`, `show.sh`.
- `tests/`: the gateway tests, the Kubernetes file tests, the app tests, and a rehearsal that
  runs the whole pod in Docker with the real login server.
- `settings.env`: every name and value of your installation, with comments. No secret.

## What you need

- A Kubernetes cluster with an ingress controller (the files are written for ingress-nginx)
  and cert-manager.
- A registry that you may push to.
- Two public DNS names (or one) that point to the ingress.
- On your machine: `kubectl`, `docker`, `node` 20 or newer, `envsubst`, `python3` with PyYAML.

By default the kit runs its own small Postgres for the login server. It can also use a
Postgres that is already in the namespace.

## What it takes care of

- No secret is ever printed or written to a file. The password is made at the first deploy
  and lives in a Kubernetes Secret.
- Every kubectl call names the cluster of the settings, so a deploy cannot go to another
  cluster by accident.
- Nobody can sign up. The gateway lets one email in.
- ChatGPT asks in the newest MCP protocol version first. The gateway answers in the way an
  older MCP server does, so that ChatGPT falls back to the handshake that a stdio MCP server
  understands.

## Limits

- One user. Many users would be another design.
- It was built from one real installation and is tested in Docker. On another cluster some
  values will need a change (storage class, issuer, ingress).
- MCP clients change. The list of protocol versions (`MCP_VERSIONS`) may need an update.

## Tests of the kit

```bash
bash tests/test-kit.sh              # quick, no Docker
bash tests/test-kit-rehearsal.sh    # makes a project and runs its whole pod in Docker
```

## Licence

MIT. See [LICENSE](LICENSE).
