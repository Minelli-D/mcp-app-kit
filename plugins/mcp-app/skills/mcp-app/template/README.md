# A web app with a login and an MCP endpoint, on Kubernetes

This project was made with the `mcp-app` kit. It runs as ONE pod:

```
internet ──► ingress ──► gateway ──┬──► bridge  (MCP, for ChatGPT or Claude) ──┬──► files (one volume)
                                   ├──► app     (your web pages) ──────────────┘
                                   └──► auth    (the login: Supabase Auth) ──► Postgres
```

- **gateway** (`gateway/`): the only public door. The login page and the session of the web
  app, the OAuth login for MCP clients, the check of every token, and the log.
- **auth**: Supabase Auth, a stock image. One user. Nobody can sign up.
- **bridge** (`bridge/`): makes an MCP server that speaks over standard input and output
  reachable over HTTP. Only the gateway talks to it.
- **app** (`app/`): the web app. It starts as a small example. Replace it with yours.

How each request travels, and what protects it, is in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## The settings

Everything that names this installation is in [`settings.env`](settings.env). Every line has
a comment. No secret is in it: the password and the keys are made at the first deploy and
live in a Kubernetes Secret.

## What you need

- `kubectl` with a context for the cluster, `docker`, `node` 20 or newer, `envsubst`, `python3`.
- On the cluster: an ingress controller (the files are written for ingress-nginx) and
  cert-manager with a cluster issuer.
- A registry that you may push to (`docker login`).
- A public DNS record for each public name (`APP_HOST` and `MCP_HOST`) that points to the
  ingress of the cluster.

## Tests (on this machine, before a deploy)

```bash
node --test tests/test-gateway.mjs                         # the gateway, with stand-ins
bash tests/test-k8s-files.sh                               # the settings and the Kubernetes file
python3 -B -m unittest discover -s tests -p 'test_*.py'    # the example app
node --test tests/test-rehearsal.mjs                       # the whole pod in Docker: real login server, Postgres, bridge, app
```

## Deploy

```bash
bash k8s/deploy.sh
```

It builds and pushes the three images, makes the Secret (once), prepares the database of
the login server, applies `k8s/pod.yaml`, and makes the user. It is safe to run again: it
changes only what is different. It never prints a secret.

| Script | What it does |
|---|---|
| `bash k8s/deploy.sh` | build, push, deploy |
| `bash k8s/doctor.sh` | looks at the pod, the certificate, DNS, the public addresses and the log, and prints what it finds. Changes nothing, prints no secret |
| `node k8s/probe.mjs` | logs in with the real login and plays an MCP client against the public addresses. Prints no secret |
| `bash k8s/show.sh` | prints the addresses, the email and the **password**. Do not paste its output anywhere |

## Use it

- **The web app**: open `https://<APP_HOST>/` and log in.
- **An MCP client** (ChatGPT, Claude): add a connector with the address
  `https://<MCP_HOST>/mcp` and authentication OAuth. The client opens the login page; log in
  and press Allow.

## Replace the example app

`app/` is an example: it says "You are logged in", lists the files of the shared volume, and
has one form. Put your own app in its place, in any language. It must keep this contract:

- It listens on `127.0.0.1:8080` and has **no login of its own**. The gateway lets only the
  logged-in user through, and nothing else in the cluster can reach that address.
- A form (any request that is not GET or HEAD) reaches the app only when the gateway found
  that it comes from this site.
- The paths that anybody may read without the login are the setting `OPEN_PATHS` (usually
  `/static/`). Put nothing private there.
- The app gets no token and no session cookie: the gateway removes them. Its own cookies
  pass.
- The files that the MCP server sees are in `/data` (the same volume in both containers).
- Keep `app/Dockerfile`: `k8s/deploy.sh` builds the image from that folder.

## Another MCP server

The settings `MCP_PACKAGES` (npm packages, with versions) and `MCP_COMMAND` (how to start it
over standard input and output) say which MCP server the bridge runs. The usual one is the
file server on `/data`.

`MCP_VERSIONS` lists the MCP protocol versions that the gateway lets through. ChatGPT asks in
the newest version first. An MCP server from before that version cannot answer it, so the
gateway answers "Unsupported protocol version", as an older server would, and the client goes
on with the older handshake. Add a version to the list only when your MCP server can answer it.

## When something does not work

Run `bash k8s/doctor.sh`, then `node k8s/probe.mjs`. The gateway log names the reason of every
refusal on `/mcp` (`why`), without any address or token:

```bash
kubectl --context <K8S_CONTEXT> -n <K8S_NAMESPACE> logs deploy/<APP_NAME> -c gateway | grep '"mcp"' | tail -20
```

## Taking it away

These commands delete things for good. Copy the files of the volume first.

```bash
kubectl --context <K8S_CONTEXT> -n <K8S_NAMESPACE> delete ingress,deployment,service,networkpolicy <APP_NAME>
kubectl --context <K8S_CONTEXT> -n <K8S_NAMESPACE> delete statefulset,service,networkpolicy <APP_NAME>-db     # POSTGRES_MODE=own
kubectl --context <K8S_CONTEXT> -n <K8S_NAMESPACE> delete secret <APP_NAME> <APP_NAME>-tls
kubectl --context <K8S_CONTEXT> -n <K8S_NAMESPACE> delete pvc <APP_NAME>-data db-<APP_NAME>-db-0             # THE FILES AND THE USERS ARE GONE
```
