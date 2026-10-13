// Makes the one user of the app in Supabase Auth, with the admin API.
// Safe to run again: a user that is already there is left as it is.
//
// Needs: AUTH_URL, SERVICE_KEY, LOGIN_EMAIL, LOGIN_PASSWORD.
//
// Supabase Auth listens inside the pod only, so k8s/deploy.sh runs this script inside the pod,
// in the gateway container: the script goes to Node on standard input, with the three secrets
// written in front of it. No file and no secret stays in the container.

const { AUTH_URL, SERVICE_KEY, LOGIN_EMAIL, LOGIN_PASSWORD } = process.env;
for (const [name, value] of Object.entries({ AUTH_URL, SERVICE_KEY, LOGIN_EMAIL, LOGIN_PASSWORD })) {
  if (!value) {
    console.error(`create-user: ${name} is not set`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A request that never answers must still end: fetch alone does not promise that.
function within(ms, promise) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Supabase Auth did not answer in time')), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function create() {
  const response = await within(10_000, fetch(`${AUTH_URL}/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD, email_confirm: true }),
  }));
  const answer = await response.json().catch(() => ({}));
  if (response.ok) return 'created';
  if (answer.error_code === 'email_exists') return 'already there';
  throw new Error(`Supabase Auth answered ${response.status} ${answer.error_code ?? ''} ${answer.msg ?? ''}`.trim());
}

// Supabase Auth can still be starting: try for one minute.
let lastError;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    console.log(`create-user: the user is ${await create()}`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    await sleep(2000);
  }
}
console.error(`create-user: ${lastError.message}`);
process.exit(1);
