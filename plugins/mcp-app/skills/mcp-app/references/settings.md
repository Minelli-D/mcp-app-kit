# The settings

One file in each project: `settings.env`. One setting per line, `NAME=value`. No secret is in
it. The scripts READ the file line by line; they never run it. Every value is checked before
it is used, because it goes into a Kubernetes file, an address or a command.

| Setting | Usual value | Meaning |
|---|---|---|
| `APP_NAME` | (asked) | Lower-case letters, digits and `-`, starts with a letter, at most 40. Names every Kubernetes object, the images, the Secret, and the database (with `_` for `-`) |
| `APP_TITLE` | (asked) | The name on the login page and on the page where an MCP client asks to connect |
| `APP_HOST` | (asked) | The public name of the app and of the login |
| `MCP_HOST` | the same as `APP_HOST` | The public name for MCP clients: `https://<MCP_HOST>/mcp` |
| `LOGIN_EMAIL` | (asked) | The one user. Nobody else can sign up or log in |
| `K8S_CONTEXT` | (asked) | The kubectl context. Every kubectl call names it |
| `K8S_NAMESPACE` | (asked) | The namespace. It must exist |
| `REGISTRY` | (asked) | `host/project`: where the images are pushed |
| `PULL_SECRET` | empty | The Secret with the registry login, when the cluster needs one to pull |
| `STORAGE_CLASS` | empty | The storage class of the volumes. Empty: the default class of the cluster |
| `STORAGE_SIZE` | `1Gi` | The size of the volume that the MCP server and the app share |
| `INGRESS` | `yes` | `no` leaves the Ingress out: no public address and no certificate yet |
| `INGRESS_CLASS` | `nginx` | The ingress class. The file is written for ingress-nginx |
| `INGRESS_NAMESPACE` | `ingress-nginx` | Where the ingress controller runs. Only that namespace may reach the gateway |
| `CLUSTER_ISSUER` | `letsencrypt` | The cert-manager issuer that makes the certificate |
| `POSTGRES_MODE` | `own` | `own`: the kit runs a small Postgres for the login server. `existing`: use one that is already in the namespace |
| `POSTGRES_POD` | empty | Only with `existing`: the pod of that Postgres. The database script runs inside it, as its superuser |
| `POSTGRES_SERVICE` | empty | Only with `existing`: the name that the login server connects to |
| `MCP_PACKAGES` | the file server, with its version | The npm packages of the MCP server. They are installed into the bridge image |
| `MCP_COMMAND` | `mcp-server-filesystem /data` | The command that starts the MCP server over standard input and output |
| `MCP_VERSIONS` | `2025-11-25,2025-06-18,2025-03-26,2024-11-05,2024-10-07` | The MCP protocol versions that go on to the bridge. Any other version gets the answer of an older MCP server, and the client falls back |
| `OPEN_PATHS` | `/static/` | The paths of the app that need no login. An entry that ends with `/` opens everything under it |

## The names that follow from `APP_NAME`

For `APP_NAME=my-app`: Deployment, Service, Ingress, NetworkPolicy and Secret `my-app`; volume
claim `my-app-data`; certificate secret `my-app-tls`; images `<REGISTRY>/my-app-gateway`,
`-bridge`, `-app`; database `my_app` and its user `my_app_auth`; with `POSTGRES_MODE=own` the
StatefulSet, Service and NetworkPolicy `my-app-db`.

## The Secret (made at the first deploy, never printed)

`MCP_SECRET` (the secret path of the bridge), `LOGIN_EMAIL`, `LOGIN_PASSWORD`,
`AUTH_DB_PASSWORD`, `DB_SUPERUSER_PASSWORD` (own Postgres), `AUTH_JWT_SECRET`, `AUTH_JWT_KEYS`,
`AUTH_SERVICE_KEY`. `bash k8s/show.sh` prints the email and the password for the user.
