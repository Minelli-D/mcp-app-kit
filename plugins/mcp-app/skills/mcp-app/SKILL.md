---
name: mcp-app
description: Create, deploy and repair a single-user web app with a login and an MCP endpoint on Kubernetes (one pod - a gateway, Supabase Auth, an MCP bridge and the app). Use when the user wants a new app with MCP and OAuth from zero, wants to deploy a project that has a settings.env made by this kit, or when the login or the MCP connection of such an app fails (ChatGPT or Claude cannot connect, "action discovery failed", 401 or 403, no certificate).
---

# mcp-app

This skill makes and looks after one kind of project: a web app for ONE user, with a login,
plus an MCP endpoint that ChatGPT or Claude can connect to with OAuth. It runs on Kubernetes
as one pod:

```
internet ──► ingress ──► gateway ──┬──► bridge  (the MCP server) ──┬──► /data (one volume)
                                   ├──► app     (the web pages) ───┘
                                   └──► auth    (Supabase Auth) ──► Postgres
```

The files of this skill are in **the base directory of this skill** (the line "Base directory
for this skill" above says where). Use that directory for every path below:

- `template/` - the project that a new app starts from. Do not edit it; copy it with the script.
- `scripts/new-app.mjs` - makes a new project from the template.
- `references/settings.md` - every setting and its usual value.
- `references/playbook.md` - what each symptom means and how to fix it. Read it for "Doctor".
- `template/ARCHITECTURE.md` - how each request travels. Read it when the user asks how it works.

## Rules for every section

- Write to the user in short, plain sentences. Many users do not read in their first language.
- **Never print a secret.** Never run `k8s/show.sh` (it prints the password): tell the user to
  run it. Never read a Kubernetes Secret onto the screen. `k8s/doctor.sh` and `k8s/probe.mjs`
  are safe: they print no secret.
- **Nothing reaches a cluster or a registry without the user's yes** in this conversation.
  `k8s/deploy.sh` pushes images and changes the cluster: ask once, right before you run it,
  and say exactly where it goes (context, namespace, registry, the two public names).
- Every script takes the cluster from `K8S_CONTEXT` in `settings.env`. Never change the
  current kubectl context, and never run `kubectl` without `--context`.
- Do not copy template files by hand. Use `scripts/new-app.mjs`.

## New

Goal: a new folder with a working project and green tests.

1. Ask, in ONE short round, only for what has no usual value. Offer an example for each:
   - the name of the app (lower-case letters, digits, `-`), and its title for the login page;
   - the two public names: one for the app, one for MCP (they may be the same);
   - the login email;
   - the kubectl context and the namespace (offer the list from `kubectl config get-contexts -o name`);
   - the registry (`host/project`);
   - the folder for the new project.
   Do not ask about the other settings. Say that `settings.env` has them, with comments.
   If the cluster already has a Postgres in that namespace that should be used, the settings
   are `POSTGRES_MODE=existing`, `POSTGRES_POD` and `POSTGRES_SERVICE` (see `references/settings.md`).
2. Run the script (it refuses a folder that is not empty, and any value that is not safe):
   ```bash
   node "<base directory of this skill>/scripts/new-app.mjs" --dir <folder> --name <name> --title "<title>" \
     --app-host <host> --mcp-host <host> --email <email> --context <context> --namespace <namespace> \
     --registry <registry> [--set NAME=value ...]
   ```
3. In the new folder run the quick tests and show the last line of each:
   ```bash
   node --test tests/test-gateway.mjs
   bash tests/test-k8s-files.sh
   python3 -B -m unittest discover -s tests -p 'test_*.py'
   ```
   If Docker is running, also offer `node --test tests/test-rehearsal.mjs` (the whole pod on
   this machine, a minute or two).
4. Tell the user what a deploy needs, as a short list:
   - a public DNS record for each public name, pointing to the ingress of the cluster;
   - `docker login` to the registry, with a user that may push;
   - on the cluster: an ingress controller and cert-manager with the cluster issuer of the settings.
5. Say that `app/` is an example and that `README.md` (section "Replace the example app")
   says what their own app must keep.

## Deploy

Goal: the app runs on the cluster and answers from outside.

1. Work in the folder of the project (it has `settings.env` and `k8s/deploy.sh`). If there is
   none, say so and offer "New".
2. Read `settings.env` and check, without changing anything:
   - the tools: `kubectl`, `docker`, `node`, `envsubst`, `python3`;
   - the context of the settings exists: `kubectl config get-contexts -o name`;
   - the namespace exists: `kubectl --context <context> get namespace <namespace>`;
   - the two names resolve: `getent hosts <name>` (if not, the deploy still works, but the
     certificate will not arrive: say so);
   - `INGRESS`, `POSTGRES_MODE`: say which they are.
3. Run the tests of step 3 of "New". Stop when one fails, and fix that first.
4. Show the user what will happen and ask once:
   "Deploy `<APP_NAME>` to context `<context>`, namespace `<namespace>`, pushing images to
   `<registry>`, with the public names `<APP_HOST>` and `<MCP_HOST>`?"
5. On yes: `bash k8s/deploy.sh`. It prints one line per step and no secret. When it stops with
   an error, read the line: it says what to do. See `references/playbook.md` for the usual ones.
6. Then run `bash k8s/doctor.sh` and `node k8s/probe.mjs` and report what they say, in a short
   table: good, or the problem and its fix.
7. Give the two addresses. Say: "`bash k8s/show.sh` shows the email and the password. Run it
   yourself and do not paste its output anywhere."
8. For ChatGPT or Claude: add a connector with `https://<MCP_HOST>/mcp`, authentication OAuth.

## Doctor

Goal: the cause of a problem, in plain words, and the fix.

1. Read `references/playbook.md`.
2. In the folder of the project run `bash k8s/doctor.sh`, then `node k8s/probe.mjs`.
3. Match what they print with the playbook. The gateway log is the best evidence: every
   refusal on `/mcp` has a `why`, and a refusal of the bridge also shows what the client sent
   and what the bridge answered.
4. Tell the user: what is wrong, how you know (the line that shows it), and the fix. If the
   fix changes code or the cluster, say what you would change and ask before a deploy.
5. Do not guess. When the evidence does not show the cause, say what is still unknown and
   what to try next (for example: "try the connector again, then I read the new log lines").
