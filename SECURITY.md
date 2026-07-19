# 🛡️ Security & Privacy

Tempo is a Cloudflare Worker that provides AI assistants with Spotify control, lyrics access, and audio analysis capabilities. This document explains how your data is handled and how to secure your deployment.

---

## 🔑 Key Security Features

### Your Deployment, Your Control

When you deploy Tempo, it runs on **your own** Cloudflare account. You control the worker, the configuration, and all connected services.

> **What this means:** Your Tempo instance is isolated. Your credentials, your Spotify connection, your data—none of it touches anyone else's deployment.

### What This MCP Can Do

| Category | Capabilities |
|----------|--------------|
| **Playback** | Play, pause, skip, volume, shuffle, repeat, device switching |
| **Search** | Find tracks, albums, artists, playlists |
| **Queue** | Manage playback queue |
| **Lyrics** | Fetch synced lyrics for current/specified tracks |
| **Perception** | Analyze audio features (BPM, key, energy) via `perceive_now_playing` |
| **Playlists** | Create playlists, add tracks, list your playlists |

### External Service Connections

Tempo connects to several services:

| Service | Purpose | Data Sent |
|---------|---------|-----------|
| **Spotify API** | Playback control, library access | OAuth tokens, API requests |
| **Lyrics Database** | Song lyric lookup | Track name, artist |
| **Hugging Face** | Audio analysis (BPM, energy, mood) | Audio features (optional) |

> **What this means:** Tempo acts as a bridge between you and these services. Review each provider's privacy policy for how they handle data.

### Credential Security

All credentials are stored as **Cloudflare environment secrets**, never in code:

```bash
wrangler secret put SPOTIFY_CLIENT_ID
wrangler secret put SPOTIFY_CLIENT_SECRET
```

OAuth tokens are stored in Cloudflare KV, scoped to your account.

### MCP Endpoint Authentication

The MCP endpoints — `/mcp`, `/sse`, `/sse/message`, and `/api/*` — are **gated by a token you set**. Set it once:

```bash
wrangler secret put AUTH_TOKEN
```

Every request to those endpoints must present it, either as a header:

```
Authorization: Bearer <AUTH_TOKEN>
```

or, for clients that can only pass a URL, as a query parameter: `?k=<AUTH_TOKEN>`. Requests without a valid token get `401 Unauthorized`. `/health`, `/auth`, and `/callback` stay open so OAuth and status checks still work.

> **What this means:** without `AUTH_TOKEN` set and sent, anyone who learns your worker URL could drive your Spotify. Set it before you connect a client. If you're upgrading from an earlier version, add `AUTH_TOKEN` and update your client config in the same change — otherwise you'll lock yourself out mid-session.

### No Listening History Storage

Tempo processes requests in real-time. It does **not** maintain a database of your listening habits.

> **What this means:** The worker fetches what's playing now, returns it, and moves on. No profile building, no history logging.

---

## 🔐 Best Practices

### Enable 2FA on All Connected Accounts

| Platform | Why It Matters |
|----------|----------------|
| **Spotify** | Protects your music account and tokens |
| **Cloudflare** | Protects your worker and KV storage |
| **Hugging Face** | Protects your Space (if using custom deployment) |
| **GitHub** | Protects your code |

### Store Secrets Properly

Never put credentials in `wrangler.toml`. Use:
```bash
wrangler secret put <SECRET_NAME>
```

### Monitor API Usage

Check your Spotify Developer Dashboard and Hugging Face usage for unexpected spikes.

### Revoke if Compromised

If credentials are exposed:
1. Revoke Spotify access and regenerate client secret
2. Rotate any Hugging Face tokens
3. Update all Cloudflare secrets

---

## 🚫 What This MCP Does NOT Do

- ❌ Store your listening history
- ❌ Log lyrics searches
- ❌ Send analytics or telemetry
- ❌ Access data beyond what's needed for the request
- ❌ Share your data with unauthorized parties

---

## 🔍 Transparency

This project is fully open source. You can audit every line of code. There are no hidden endpoints, no telemetry, no data collection.

Your music, your lyrics, your control.
