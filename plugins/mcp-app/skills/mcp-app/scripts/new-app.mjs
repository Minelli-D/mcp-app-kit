#!/usr/bin/env node
// Makes a new project from the template of this kit: a web app with a login and an MCP
// endpoint, for Kubernetes. It copies the template and writes the settings file.
// It runs no kubectl and no docker, and it has no dependencies.
//
//   node new-app.mjs --dir <new folder> --name <APP_NAME> --title <APP_TITLE>
//        --app-host <APP_HOST> --mcp-host <MCP_HOST> --email <LOGIN_EMAIL>
//        --context <K8S_CONTEXT> --namespace <K8S_NAMESPACE> --registry <REGISTRY>
//        [--set NAME=value ...]      any other setting of settings.env
//
// Example:
//   node new-app.mjs --dir ~/code/notes-desk --name notes-desk --title "Notes Desk" \
//     --app-host notes.example.com --mcp-host mcp-notes.example.com --email me@example.com \
//     --context my-cluster --namespace my-namespace --registry registry.example.com/project

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'template');

// The options with a name of their own, and the setting each one writes.
const OPTIONS = {
  '--name': 'APP_NAME', '--title': 'APP_TITLE', '--app-host': 'APP_HOST', '--mcp-host': 'MCP_HOST', '--email': 'LOGIN_EMAIL',
  '--context': 'K8S_CONTEXT', '--namespace': 'K8S_NAMESPACE', '--registry': 'REGISTRY',
};
// What a new project cannot do without. Everything else has a usual value in the template.
const NEEDED = ['APP_NAME', 'APP_TITLE', 'APP_HOST', 'LOGIN_EMAIL', 'K8S_CONTEXT', 'K8S_NAMESPACE', 'REGISTRY'];

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const NAME = /^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/;
// The same rules as k8s/lib.sh of the template, which checks every setting again at each
// deploy. A value goes into a Kubernetes file, an address or a command: it may hold only what
// is safe there.
const RULES = {
  APP_NAME: [(v) => /^[a-z][a-z0-9-]{0,39}$/.test(v) && !v.endsWith('-') && !v.includes('--'), 'lower-case letters, digits and "-", starting with a letter, at most 40 long'],
  APP_TITLE: [(v) => v.length >= 1 && v.length <= 60 && /^[A-Za-z0-9 ._&'!,:+()-]+$/.test(v), "1 to 60 letters, digits, spaces and . _ & ' ! , : + ( ) -"],
  APP_HOST: [(v) => HOST.test(v), 'a host name such as app.example.com'],
  MCP_HOST: [(v) => v === '' || HOST.test(v), 'a host name such as mcp.example.com (or empty: the name of the app does both)'],
  LOGIN_EMAIL: [(v) => /^[^@\s"'\\]+@[^@\s"'\\]+\.[^@\s"'\\]+$/.test(v), 'an email address'],
  K8S_CONTEXT: [(v) => /^[A-Za-z0-9@._:/-]+$/.test(v), 'the name of a kubectl context (see: kubectl config get-contexts)'],
  K8S_NAMESPACE: [(v) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(v), 'the name of a namespace'],
  REGISTRY: [(v) => /^[a-z0-9]([a-z0-9.:-]*[a-z0-9])?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*$/.test(v), 'host/project, without https://'],
  PULL_SECRET: [(v) => v === '' || NAME.test(v), 'the name of a Secret, or empty'],
  STORAGE_CLASS: [(v) => v === '' || NAME.test(v), 'the name of a storage class, or empty'],
  STORAGE_SIZE: [(v) => /^[1-9][0-9]{0,3}(Mi|Gi)$/.test(v), 'a size such as 1Gi or 500Mi'],
  INGRESS: [(v) => v === 'yes' || v === 'no', 'yes or no'],
  INGRESS_CLASS: [(v) => NAME.test(v), 'the name of an ingress class'],
  INGRESS_NAMESPACE: [(v) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(v), 'the name of a namespace'],
  CLUSTER_ISSUER: [(v) => NAME.test(v), 'the name of a cluster issuer'],
  POSTGRES_MODE: [(v) => v === 'own' || v === 'existing', 'own or existing'],
  POSTGRES_POD: [(v) => v === '' || NAME.test(v), 'the name of a pod, or empty'],
  POSTGRES_SERVICE: [(v) => v === '' || NAME.test(v), 'the name of a Service, or empty'],
  MCP_PACKAGES: [(v) => /^[@A-Za-z0-9._/ -]+$/.test(v), 'npm package names with their versions, with spaces between them'],
  MCP_COMMAND: [(v) => /^[A-Za-z0-9@._/=:, -]+$/.test(v), 'letters, digits, spaces and @ . _ / = : , -'],
  MCP_VERSIONS: [(v) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}(, ?[0-9]{4}-[0-9]{2}-[0-9]{2})*$/.test(v), 'dates such as 2025-11-25, with commas between them'],
  OPEN_PATHS: [(v) => /^\/[A-Za-z0-9._/-]*(, ?\/[A-Za-z0-9._/-]*)*$/.test(v) && !v.includes('..') && !v.includes('//'), 'paths that start with "/", with commas between them'],
};

function stop(message) {
  console.error(`new-app: ${message}`);
  process.exit(2);
}

// ---- what was asked for ----------------------------------------------------------------

const words = process.argv.slice(2);
const chosen = {};
let dir = null;
for (let at = 0; at < words.length; at += 1) {
  const word = words[at];
  const value = words[at + 1];
  if (word === '--help' || word === '-h') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 15).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  }
  if (value === undefined) stop(`${word} needs a value. See --help.`);
  if (word === '--dir') dir = value;
  else if (word in OPTIONS) chosen[OPTIONS[word]] = value;
  else if (word === '--set') {
    const cut = value.indexOf('=');
    if (cut < 1) stop(`--set wants NAME=value, not "${value}".`);
    chosen[value.slice(0, cut)] = value.slice(cut + 1);
  } else stop(`"${word}" is not an option. See --help.`);
  at += 1;
}
if (!dir) stop('--dir is missing: the folder of the new project.');
for (const name of NEEDED) {
  if (!chosen[name]) stop(`${Object.entries(OPTIONS).find(([, setting]) => setting === name)[0]} is missing (${name}).`);
}
if (chosen.MCP_HOST === undefined) chosen.MCP_HOST = chosen.APP_HOST;
for (const [name, value] of Object.entries(chosen)) {
  if (!(name in RULES)) stop(`${name} is not a setting of this kit.`);
  const [good, wanted] = RULES[name];
  if (!good(value)) stop(`${name} must be ${wanted}. It is: "${value}"`);
}
if ((chosen.POSTGRES_MODE ?? 'own') === 'existing' && !(chosen.POSTGRES_POD && chosen.POSTGRES_SERVICE)) {
  stop('POSTGRES_MODE=existing needs POSTGRES_POD and POSTGRES_SERVICE (use --set).');
}

// ---- the new folder --------------------------------------------------------------------

const target = resolve(dir);
if (existsSync(target) && readdirSync(target).length > 0) stop(`the folder is not empty: ${target}`);
mkdirSync(target, { recursive: true });
cpSync(TEMPLATE, target, { recursive: true });

// The settings file of the template, with the chosen values in the place of its sample values.
const settingsFile = join(target, 'settings.env');
const written = new Set();
const lines = readFileSync(settingsFile, 'utf8').split('\n').map((line) => {
  const name = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
  if (!name || !(name in chosen)) return line;
  written.add(name);
  return `${name}=${chosen[name]}`;
});
for (const name of Object.keys(chosen)) {
  if (!written.has(name)) stop(`the template has no line for ${name} in settings.env.`);
}
writeFileSync(settingsFile, lines.join('\n'));

const mcpHost = chosen.MCP_HOST;
console.log(`Made: ${target}

  the app      https://${chosen.APP_HOST}/
  MCP address  https://${mcpHost}/mcp   (for ChatGPT or Claude, authentication: OAuth)
  cluster      context ${chosen.K8S_CONTEXT}, namespace ${chosen.K8S_NAMESPACE}

Next:
  1. Look at settings.env in the new folder. Every setting has a comment.
  2. Run the tests of the new project:
       node --test tests/test-gateway.mjs
       bash tests/test-k8s-files.sh
       python3 -B -m unittest discover -s tests -p 'test_*.py'
       node --test tests/test-rehearsal.mjs      (needs Docker; the whole pod on this machine)
  3. Before a deploy you need: a public DNS record for ${mcpHost === chosen.APP_HOST ? chosen.APP_HOST : `${chosen.APP_HOST} and for ${mcpHost}`}
     that points to the ingress of the cluster; push rights to ${chosen.REGISTRY.split('/')[0]} (docker login);
     and on the cluster an ingress controller and cert-manager.
  4. Deploy: bash k8s/deploy.sh   Then: bash k8s/doctor.sh and node k8s/probe.mjs
  5. Replace the example app in app/ with your own (README.md says what it must keep).`);
