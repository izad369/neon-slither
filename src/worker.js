// Neon Slither — Cloudflare Worker entry
// Serves static assets, handles /api/* auth, upgrades /ws to Arena Durable Object

import { Arena } from './arena.js';

export { Arena };

const encoder = new TextEncoder();

async function hashPassword(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeToken() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function handleApi(request, env, pathname) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (!env.USERS) {
    return json({ error: 'KV binding USERS not configured. Create a KV namespace and bind it as USERS.' }, 500);
  }

  if (pathname === '/api/register' && request.method === 'POST') {
    const { username, password } = await readJson(request);
    if (!username || !password || username.length < 3 || password.length < 4) {
      return json({ error: 'Username needs 3+ chars, password 4+ chars.' }, 400);
    }
    const key = username.toLowerCase();
    const existing = await env.USERS.get('user:' + key);
    if (existing) return json({ error: 'That username is taken.' }, 409);
    const salt = makeSalt();
    const hash = await hashPassword(password, salt);
    const user = { username, salt, hash, bestScore: 0, skin: 'classic' };
    await env.USERS.put('user:' + key, JSON.stringify(user));
    const token = makeToken();
    await env.USERS.put('token:' + token, key, { expirationTtl: 60 * 60 * 24 * 30 });
    return json({ token, username, bestScore: 0, skin: 'classic' });
  }

  if (pathname === '/api/login' && request.method === 'POST') {
    const { username, password } = await readJson(request);
    const key = (username || '').toLowerCase();
    const raw = await env.USERS.get('user:' + key);
    if (!raw) return json({ error: 'Wrong username or password.' }, 401);
    const u = JSON.parse(raw);
    const hash = await hashPassword(password || '', u.salt);
    if (hash !== u.hash) return json({ error: 'Wrong username or password.' }, 401);
    const token = makeToken();
    await env.USERS.put('token:' + token, key, { expirationTtl: 60 * 60 * 24 * 30 });
    return json({ token, username: u.username, bestScore: u.bestScore || 0, skin: u.skin || 'classic' });
  }

  if (pathname === '/api/profile' && request.method === 'POST') {
    const { token } = await readJson(request);
    const key = await env.USERS.get('token:' + token);
    if (!key) return json({ error: 'Session expired, please log in again.' }, 401);
    const raw = await env.USERS.get('user:' + key);
    if (!raw) return json({ error: 'Session expired, please log in again.' }, 401);
    const u = JSON.parse(raw);
    return json({ username: u.username, bestScore: u.bestScore || 0, skin: u.skin || 'classic' });
  }

  if (pathname === '/api/set-skin' && request.method === 'POST') {
    const { token, skin } = await readJson(request);
    const key = await env.USERS.get('token:' + token);
    if (!key) return json({ error: 'Not logged in.' }, 401);
    const raw = await env.USERS.get('user:' + key);
    if (!raw) return json({ error: 'Not logged in.' }, 401);
    const u = JSON.parse(raw);
    u.skin = skin;
    await env.USERS.put('user:' + key, JSON.stringify(u));
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // WebSocket → Durable Object
    if (url.pathname === '/ws') {
      const id = env.ARENA.idFromName('main');
      const stub = env.ARENA.get(id);
      return stub.fetch(request);
    }

    // API
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url.pathname);
    }

    // Static assets (index.html etc.)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Neon Slither Worker is running. Add [assets] binding.', { status: 200 });
  },
};
