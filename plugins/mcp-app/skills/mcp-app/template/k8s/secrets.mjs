// Makes every secret of the Kubernetes setup and prints them as one Kubernetes Secret
// (JSON, for "kubectl create -f -"). Nothing is written to disk.
//
//   node k8s/secrets.mjs <name of the app> <namespace> <login email>
//
// The Secret has the name of the app. Its keys:
//   MCP_SECRET                      the secret path of the bridge, inside the pod
//   LOGIN_EMAIL, LOGIN_PASSWORD     the login of the one user, for MCP clients and for the web app
//   AUTH_DB_PASSWORD                the database password of the login server (k8s/auth-db.sql)
//   DB_SUPERUSER_PASSWORD           the superuser of the kit's own Postgres (POSTGRES_MODE=own)
//   AUTH_JWT_SECRET, AUTH_JWT_KEYS  the keys of the login server
//   AUTH_SERVICE_KEY                an admin token of the login server. It is in the settings
//                                   of no container: k8s/deploy.sh hands it, on standard input,
//                                   to the one short program that makes my user.

import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

// A long-lived token for one Supabase role, signed with the shared JWT secret.
export function roleToken(role, jwtSecret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ role, iss: 'supabase', iat: nowSeconds, exp: nowSeconds + 10 * 365 * 24 * 3600 });
  return `${head}.${body}.${createHmac('sha256', jwtSecret).update(`${head}.${body}`).digest('base64url')}`;
}

// The key list of Supabase Auth: a new ES256 key that signs the login tokens, and the
// shared secret, which may only CHECK tokens (the role token above is signed with it).
export function signingKeys(jwtSecret) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return [
    { ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256', use: 'sig', key_ops: ['sign', 'verify'] },
    { kty: 'oct', k: b64(jwtSecret), kid: randomUUID(), alg: 'HS256', use: 'sig', key_ops: ['verify'] },
  ];
}

// The keys of the Secret, with new values.
export function makeSecrets(email) {
  const jwtSecret = randomBytes(48).toString('base64url');
  return {
    MCP_SECRET: randomBytes(16).toString('hex'),
    LOGIN_EMAIL: email,
    LOGIN_PASSWORD: randomBytes(18).toString('base64url'),
    // Only letters and digits: this password is written inside a database address and in a psql line.
    AUTH_DB_PASSWORD: randomBytes(24).toString('hex'),
    DB_SUPERUSER_PASSWORD: randomBytes(24).toString('hex'),
    AUTH_JWT_SECRET: jwtSecret,
    AUTH_JWT_KEYS: JSON.stringify(signingKeys(jwtSecret)),
    AUTH_SERVICE_KEY: roleToken('service_role', jwtSecret),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, namespace, email] = process.argv.slice(2);
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name ?? '') || !namespace || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email ?? '')) {
    console.error('usage: node k8s/secrets.mjs <name of the app> <namespace> <login email>');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace, labels: { 'app.kubernetes.io/part-of': name } },
    type: 'Opaque',
    stringData: makeSecrets(email),
  }));
}
