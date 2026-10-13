// The consent page. I log in with Supabase Auth, the page shows which app asks for
// access, and it sends my answer. The login token stays in memory only: it is gone
// when the page closes.

const id = new URLSearchParams(location.search).get('authorization_id');
const el = (name) => document.getElementById(name);
let token = null;

function say(text) {
  el('message').textContent = text;
}

async function call(method, path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetch(`/auth/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

// Goes back to the app. Only to a web address: never to "javascript:" or the like.
function leave(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    say('The app gave an address this page does not open. Nothing was allowed.');
    return;
  }
  location.replace(url.href);
}

async function showRequest() {
  const { status, data } = await call('GET', `/oauth/authorizations/${encodeURIComponent(id)}`);
  if (status !== 200 || !data) {
    say('This request is too old or not valid. Go back to the app and connect again.');
    return;
  }
  // I allowed this app before: Supabase Auth sends me back at once.
  if (data.redirect_url) {
    leave(data.redirect_url);
    return;
  }
  let target = '';
  try {
    target = new URL(data.redirect_uri).host;
  } catch {
    // Without a readable address there is nothing safe to show.
  }
  if (!target) {
    say('This request is not valid. Go back to the app and connect again.');
    return;
  }
  el('client').textContent = data.client?.name || 'An app';
  el('target').textContent = target;
  el('request').hidden = false;
}

async function answer(action) {
  el('allow').disabled = true;
  el('deny').disabled = true;
  const { status, data } = await call('POST', `/oauth/authorizations/${encodeURIComponent(id)}/consent`, { action });
  if (status === 200 && data?.redirect_url) {
    leave(data.redirect_url);
    return;
  }
  el('request').hidden = true;
  say('That did not work. Go back to the app and connect again.');
}

el('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  say('');
  const { status, data } = await call('POST', '/token?grant_type=password', {
    email: el('email').value.trim(),
    password: el('password').value,
  });
  if (status === 200 && data?.access_token) {
    token = data.access_token;
    el('password').value = '';
    el('login').hidden = true;
    await showRequest();
  } else if (status === 429) {
    say('Too many tries. Wait ten minutes, then try again.');
  } else if (status === 400) {
    say('Wrong email or password.');
  } else {
    say('The login did not work. Try again in a minute.');
  }
});

el('allow').addEventListener('click', () => answer('approve'));
el('deny').addEventListener('click', () => answer('deny'));

if (id) {
  el('login').hidden = false;
} else {
  say('This page is only used when an app asks to connect.');
}
