# Neon Slither — Cloudflare Workers edition

Online multiplayer + auth runs on **Cloudflare Workers + Durable Objects + KV**.

## One-time setup

1. Create a KV namespace:
```bash
npx wrangler kv namespace create USERS
npx wrangler kv namespace create USERS --preview
```

2. Paste the returned IDs into `wrangler.toml` under `[[kv_namespaces]]`.

3. Deploy:
```bash
npm install
npx wrangler deploy
```

## What works

| Feature | Status |
|---------|--------|
| Offline vs bots | ✅ |
| Online multiplayer | ✅ |
| Lobby / matchmaking | ✅ |
| Login / Register / Best score | ✅ |
| Skins | ✅ |
| In-game chat | ✅ |

## Local development

```bash
npx wrangler dev
```
