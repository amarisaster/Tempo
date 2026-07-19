/**
 * Music Perception MCP
 *
 * Everything music in one place:
 * - Spotify OAuth & playback control
 * - Lyrics via LRCLIB (synced + plain)
 * - Audio analysis via Hugging Face Space (Essentia)
 * - Real-time perception (what's playing + current lyrics)
 *
 * Deploy to Cloudflare Workers, connect via SSE from any MCP client.
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ============================================================================
// Types
// ============================================================================

interface Env {
  AUDIO_PERCEPTION: DurableObjectNamespace;
  SPOTIFY_KV: KVNamespace;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  HF_SPACE_URL?: string;
  // Optional companion spotify-cloud worker that shares this KV; used only as a
  // token-refresh fallback. Leave unset to disable.
  SPOTIFY_CLOUD_URL?: string;
  // Inbound auth — fail closed: unset = 401 on the MCP/API endpoints.
  AUTH_TOKEN: string;    // primary MCP key; also accepted as ?k=<AUTH_TOKEN> in the endpoint URL
  SPOTIFY_KEY: string;   // alternate service key (Bearer)
  NEXUS_TOKEN: string;   // accepted on /api/* only
}

// Constant-time string compare — avoids timing side-channels on token checks.
function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

interface LRCLibLyrics {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

// ============================================================================
// Constants
// ============================================================================

const LRCLIB_BASE = "https://lrclib.net/api";
const SPOTIFY_API_URL = "https://api.spotify.com/v1";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";

let globalEnv: Env | null = null;

// ============================================================================
// Spotify Auth Helpers
// ============================================================================

async function getSpotifyAccessToken(env: Env): Promise<string> {
  const token = await env.SPOTIFY_KV?.get("spotify_access_token");
  const expires = await env.SPOTIFY_KV?.get("spotify_token_expires");
  const refreshToken = await env.SPOTIFY_KV?.get("spotify_refresh_token");

  if (!token) {
    throw new Error("Spotify not authenticated. Visit /auth to connect.");
  }

  if (expires && Date.now() > parseInt(expires) - 300000) {
    // Try refreshing directly if we have the client secret
    if (env.SPOTIFY_CLIENT_SECRET) {
      const response = await fetch(SPOTIFY_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken || "",
        }),
      });

      const tokens: any = await response.json();
      if (!tokens.error) {
        await env.SPOTIFY_KV.put("spotify_access_token", tokens.access_token);
        await env.SPOTIFY_KV.put("spotify_token_expires", String(Date.now() + tokens.expires_in * 1000));
        if (tokens.refresh_token) {
          await env.SPOTIFY_KV.put("spotify_refresh_token", tokens.refresh_token);
        }
        return tokens.access_token;
      }
    }

    // Optional fallback: trigger refresh via a companion spotify-cloud worker
    // that shares the same KV. Enabled only if SPOTIFY_CLOUD_URL is set.
    if (env.SPOTIFY_CLOUD_URL) {
      try {
        await fetch(`${env.SPOTIFY_CLOUD_URL}/api/now-playing`);
        const freshToken = await env.SPOTIFY_KV?.get("spotify_access_token");
        if (freshToken && freshToken !== token) return freshToken;
      } catch { /* fall through */ }
    }

    // If all else fails, try the existing token anyway
    return token;
  }

  return token;
}

async function spotifyAPI(endpoint: string, env: Env, options: RequestInit = {}): Promise<any> {
  const token = await getSpotifyAccessToken(env);
  const response = await fetch(`${SPOTIFY_API_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (response.status === 204) return { success: true };
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Spotify API error (${response.status}): ${error}`);
  }
  return response.json();
}

// ============================================================================
// LRCLIB Helper
// ============================================================================

async function fetchLRCLib(endpoint: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${LRCLIB_BASE}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });

  const response = await fetch(url.toString(), {
    headers: { "User-Agent": "MusicPerceptionMCP/2.0.0" },
  });

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`LRCLIB error: ${response.status}`);
  }
  return response.json();
}

// ============================================================================
// Lyrics Helpers
// ============================================================================

function parseSyncedLyrics(synced: string): Array<{ time: number; text: string }> {
  const lines = synced.split("\n").filter((line) => line.trim());
  const parsed: Array<{ time: number; text: string }> = [];

  for (const line of lines) {
    const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2})\]\s*(.*)$/);
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const centiseconds = parseInt(match[3], 10);
      const text = match[4];
      const timeInSeconds = minutes * 60 + seconds + centiseconds / 100;
      parsed.push({ time: timeInSeconds, text });
    }
  }
  return parsed;
}

function findCurrentLyric(
  lyrics: Array<{ time: number; text: string }>,
  progressSeconds: number
): { current: { time: number; text: string } | null; upcoming: Array<{ time: number; text: string }> } {
  let current: { time: number; text: string } | null = null;
  const upcoming: Array<{ time: number; text: string }> = [];

  for (let i = 0; i < lyrics.length; i++) {
    const line = lyrics[i];
    const nextLine = lyrics[i + 1];

    if (line.time <= progressSeconds && (!nextLine || nextLine.time > progressSeconds)) {
      current = line;
    }
    if (line.time > progressSeconds && line.time <= progressSeconds + 30) {
      upcoming.push(line);
    }
  }
  return { current, upcoming: upcoming.slice(0, 5) };
}

// ============================================================================
// MCP Server
// ============================================================================

export class AudioPerception extends McpAgent {
  server = new McpServer({
    name: "music-perception",
    version: "2.0.0",
  });

  async init() {
    // Durable-Object isolate fix: the module-level `globalEnv` is only set in
    // the main worker's fetch(), but these tools run inside the DO isolate,
    // where it was never populated → every tool threw "Environment not
    // available" (Spotify unavailable on Nexus, 2026-07-10). Bind it from the
    // DO's own env here so all tool handlers have it.
    if (this.env) globalEnv = this.env as Env;

    // ========================================================================
    // SPOTIFY PLAYBACK CONTROLS
    // ========================================================================

    this.server.tool("spotify_now_playing", {}, async () => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        const data = await spotifyAPI("/me/player/currently-playing", globalEnv);

        if (!data || !data.item) {
          return { content: [{ type: "text", text: JSON.stringify({ playing: false, message: "Nothing playing" }) }] };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              track: data.item.name,
              artist: data.item.artists.map((a: any) => a.name).join(", "),
              album: data.item.album.name,
              progress_ms: data.progress_ms,
              duration_ms: data.item.duration_ms,
              is_playing: data.is_playing,
              uri: data.item.uri,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("spotify_play", {
      uri: z.string().optional().describe("Spotify URI to play"),
    }, async ({ uri }) => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        const body: any = {};
        if (uri) body.uris = [uri];

        await spotifyAPI("/me/player/play", globalEnv, {
          method: "PUT",
          body: Object.keys(body).length ? JSON.stringify(body) : undefined,
        });
        return { content: [{ type: "text", text: "Playback started" }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("spotify_pause", {}, async () => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        await spotifyAPI("/me/player/pause", globalEnv, { method: "PUT" });
        return { content: [{ type: "text", text: "Paused" }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("spotify_next", {}, async () => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        await spotifyAPI("/me/player/next", globalEnv, { method: "POST" });
        return { content: [{ type: "text", text: "Skipped to next" }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("spotify_previous", {}, async () => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        await spotifyAPI("/me/player/previous", globalEnv, { method: "POST" });
        return { content: [{ type: "text", text: "Previous track" }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("spotify_volume", {
      volume: z.number().min(0).max(100).describe("Volume level 0-100"),
    }, async ({ volume }) => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        await spotifyAPI(`/me/player/volume?volume_percent=${volume}`, globalEnv, { method: "PUT" });
        return { content: [{ type: "text", text: `Volume set to ${volume}%` }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("spotify_shuffle", {
      state: z.boolean().describe("Shuffle on/off"),
    }, async ({ state }) => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        await spotifyAPI(`/me/player/shuffle?state=${state}`, globalEnv, { method: "PUT" });
        return { content: [{ type: "text", text: `Shuffle ${state ? "on" : "off"}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("spotify_repeat", {
      state: z.enum(["track", "context", "off"]).describe("Repeat mode"),
    }, async ({ state }) => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        await spotifyAPI(`/me/player/repeat?state=${state}`, globalEnv, { method: "PUT" });
        return { content: [{ type: "text", text: `Repeat: ${state}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("spotify_search", {
      query: z.string().describe("Search query"),
      type: z.enum(["track", "album", "artist", "playlist"]).optional().describe("Search type"),
      limit: z.number().optional().describe("Results limit (1-50)"),
    }, async ({ query, type = "track", limit = 10 }) => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        const data = await spotifyAPI(`/search?q=${encodeURIComponent(query)}&type=${type}&limit=${Math.min(limit, 50)}`, globalEnv);
        const key = type + "s";
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              type,
              results: data[key]?.items?.map((item: any) => ({
                name: item.name,
                uri: item.uri,
                ...(type === "track" && { artist: item.artists?.map((a: any) => a.name).join(", ") }),
                ...(type === "album" && { artist: item.artists?.map((a: any) => a.name).join(", ") }),
              })) || [],
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("spotify_queue", {
      uri: z.string().describe("Spotify URI to add to queue"),
    }, async ({ uri }) => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        await spotifyAPI(`/me/player/queue?uri=${encodeURIComponent(uri)}`, globalEnv, { method: "POST" });
        return { content: [{ type: "text", text: "Added to queue" }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("spotify_devices", {}, async () => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        const data = await spotifyAPI("/me/player/devices", globalEnv);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              devices: data.devices?.map((d: any) => ({
                id: d.id,
                name: d.name,
                type: d.type,
                is_active: d.is_active,
                volume: d.volume_percent,
              })) || [],
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("spotify_transfer", {
      device_id: z.string().describe("Target device ID"),
    }, async ({ device_id }) => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        await spotifyAPI("/me/player", globalEnv, {
          method: "PUT",
          body: JSON.stringify({ device_ids: [device_id] }),
        });
        return { content: [{ type: "text", text: "Playback transferred" }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    // ========================================================================
    // PLAYLIST / HISTORY TOOLS (queue+recent+list ported from the tempo draft
    // 2026-07-13; create/add are new — need playlist-modify scopes, re-auth
    // via /auth?k= after deploy)
    // ========================================================================

    this.server.tool("spotify_playlists", {
      limit: z.number().optional().describe("Number of playlists (1-50)"),
    }, async ({ limit = 20 }) => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        const data = await spotifyAPI(`/me/playlists?limit=${Math.min(limit, 50)}`, globalEnv);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              playlists: data.items?.map((p: any) => ({
                name: p.name,
                uri: p.uri,
                id: p.id,
                tracks: p.tracks?.total,
                owner: p.owner?.display_name,
              })) || [],
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("spotify_get_queue", {}, async () => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        const data = await spotifyAPI("/me/player/queue", globalEnv);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              currently_playing: data.currently_playing ? {
                name: data.currently_playing.name,
                artist: data.currently_playing.artists?.map((a: any) => a.name).join(", "),
              } : null,
              queue: data.queue?.slice(0, 20).map((t: any) => ({
                name: t.name,
                artist: t.artists?.map((a: any) => a.name).join(", "),
                uri: t.uri,
              })) || [],
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("spotify_recent", {
      limit: z.number().optional().describe("Number of recent tracks (1-50)"),
    }, async ({ limit = 20 }) => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        const data = await spotifyAPI(`/me/player/recently-played?limit=${Math.min(limit, 50)}`, globalEnv);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              tracks: data.items?.map((item: any) => ({
                track: item.track.name,
                artist: item.track.artists?.map((a: any) => a.name).join(", "),
                uri: item.track.uri,
                played_at: item.played_at,
              })) || [],
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("spotify_create_playlist", {
      name: z.string().describe("Playlist name"),
      description: z.string().optional().describe("Playlist description"),
      is_public: z.boolean().optional().describe("Public playlist (default false = private)"),
      track_uris: z.array(z.string()).optional().describe("Spotify track URIs to add right away (max 100)"),
    }, async ({ name, description, is_public = false, track_uris }) => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        const playlist = await spotifyAPI(`/me/playlists`, globalEnv, {
          method: "POST",
          body: JSON.stringify({ name, description: description || "", public: is_public }),
        });
        let added = 0;
        if (track_uris?.length) {
          await spotifyAPI(`/playlists/${playlist.id}/items`, globalEnv, {
            method: "POST",
            body: JSON.stringify({ uris: track_uris.slice(0, 100) }),
          });
          added = Math.min(track_uris.length, 100);
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              created: playlist.name,
              id: playlist.id,
              uri: playlist.uri,
              url: playlist.external_urls?.spotify,
              public: is_public,
              tracks_added: added,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("spotify_add_to_playlist", {
      playlist_id: z.string().describe("Playlist ID (from spotify_playlists or spotify_create_playlist)"),
      track_uris: z.array(z.string()).describe("Spotify track URIs to add (max 100 per call)"),
    }, async ({ playlist_id, track_uris }) => {
      try {
        if (!globalEnv) throw new Error("Environment not available");
        await spotifyAPI(`/playlists/${playlist_id}/items`, globalEnv, {
          method: "POST",
          body: JSON.stringify({ uris: track_uris.slice(0, 100) }),
        });
        return { content: [{ type: "text", text: JSON.stringify({ added: Math.min(track_uris.length, 100), playlist_id }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    // ========================================================================
    // LYRICS TOOLS
    // ========================================================================

    this.server.tool("get_lyrics", {
      track_name: z.string().describe("Track name"),
      artist_name: z.string().describe("Artist name"),
    }, async ({ track_name, artist_name }) => {
      try {
        const result = await fetchLRCLib("/get", { track_name, artist_name });
        if (!result) {
          return { content: [{ type: "text", text: JSON.stringify({ found: false }) }] };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              found: true,
              track: result.trackName,
              artist: result.artistName,
              album: result.albumName,
              instrumental: result.instrumental,
              synced: !!result.syncedLyrics,
              lyrics: result.syncedLyrics ? parseSyncedLyrics(result.syncedLyrics) : result.plainLyrics,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("search_lyrics", {
      query: z.string().describe("Search query"),
    }, async ({ query }) => {
      try {
        const results = await fetchLRCLib("/search", { q: query });
        if (!results || results.length === 0) {
          return { content: [{ type: "text", text: JSON.stringify({ found: false }) }] };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              found: true,
              count: results.length,
              results: results.slice(0, 10).map((r: LRCLibLyrics) => ({
                track: r.trackName,
                artist: r.artistName,
                album: r.albumName,
                synced: !!r.syncedLyrics,
              })),
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    // ========================================================================
    // PERCEPTION TOOLS
    // ========================================================================

    this.server.tool("perceive_now_playing", {}, async () => {
      try {
        if (!globalEnv) throw new Error("Environment not available");

        const spotifyData = await spotifyAPI("/me/player/currently-playing", globalEnv);
        if (!spotifyData || !spotifyData.item) {
          return { content: [{ type: "text", text: JSON.stringify({ playing: false }) }] };
        }

        const track = spotifyData.item.name;
        const artist = spotifyData.item.artists[0]?.name;
        const album = spotifyData.item.album.name;
        const progressMs = spotifyData.progress_ms;
        const progressSec = progressMs / 1000;
        const durationMs = spotifyData.item.duration_ms;

        let lyrics: LRCLibLyrics | null = null;
        try {
          lyrics = await fetchLRCLib("/get", { track_name: track, artist_name: artist });
        } catch (e) { /* continue without */ }

        const perception: any = {
          playing: true,
          is_playing: spotifyData.is_playing,
          track,
          artist: spotifyData.item.artists.map((a: any) => a.name).join(", "),
          album,
          progress_ms: progressMs,
          duration_ms: durationMs,
        };

        if (lyrics && lyrics.syncedLyrics && !lyrics.instrumental) {
          const parsed = parseSyncedLyrics(lyrics.syncedLyrics);
          const { current, upcoming } = findCurrentLyric(parsed, progressSec);
          perception.current_line = current;
          perception.upcoming_lines = upcoming;
        }

        return { content: [{ type: "text", text: JSON.stringify(perception, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    this.server.tool("analyze_audio", {
      youtube_url: z.string().describe("YouTube URL to analyze"),
    }, async ({ youtube_url }) => {
      try {
        const hfSpaceUrl = globalEnv?.HF_SPACE_URL;
        if (!hfSpaceUrl) {
          return { content: [{ type: "text", text: JSON.stringify({ error: true, message: "HF_SPACE_URL not configured" }) }] };
        }

        const response = await fetch(`${hfSpaceUrl}/api/predict`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: [null, youtube_url] }),
        });

        if (!response.ok) {
          throw new Error(`HF Space error: ${response.status}`);
        }

        const result = await response.json();
        return { content: [{ type: "text", text: JSON.stringify(result.data?.[0] || result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : "Unknown error" }) }] };
      }
    });

    // ========================================================================
    // UTILITY
    // ========================================================================

    this.server.tool("ping", {}, async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "alive",
          service: "music-perception-mcp",
          version: "2.0.0",
          capabilities: ["spotify", "lyrics", "audio_analysis"],
        }),
      }],
    }));
  }
}

// ============================================================================
// OAuth Handlers
// ============================================================================

async function handleAuth(url: URL, env: Env): Promise<Response> {
  const redirectUri = `${url.origin}/callback`;
  const scopes = [
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "user-read-recently-played",
    "playlist-read-private",
    // playlist create/add (2026-07-13 — Mai wants companion-made playlists)
    "playlist-modify-public",
    "playlist-modify-private",
  ].join(" ");

  const authUrl = `${SPOTIFY_AUTH_URL}?` + new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: scopes,
  });

  return Response.redirect(authUrl, 302);
}

async function handleCallback(url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) return new Response(`Auth error: ${error}`, { status: 400 });
  if (!code) return new Response("No code provided", { status: 400 });

  const redirectUri = `${url.origin}/callback`;
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  const tokens: any = await response.json();
  if (tokens.error) return new Response(`Token error: ${tokens.error}`, { status: 400 });

  await env.SPOTIFY_KV.put("spotify_access_token", tokens.access_token);
  await env.SPOTIFY_KV.put("spotify_refresh_token", tokens.refresh_token);
  await env.SPOTIFY_KV.put("spotify_token_expires", String(Date.now() + tokens.expires_in * 1000));

  return new Response("Spotify connected! You can close this window.", {
    headers: { "Content-Type": "text/plain" },
  });
}

// ============================================================================
// CORS Helper
// ============================================================================

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ============================================================================
// REST API Handlers
// ============================================================================

async function handleNowPlaying(env: Env): Promise<Response> {
  try {
    const data = await spotifyAPI("/me/player/currently-playing", env);
    if (!data || !data.item) {
      return jsonResponse({ is_playing: false });
    }

    return jsonResponse({
      is_playing: data.is_playing,
      track: {
        name: data.item.name,
        artist: data.item.artists.map((a: any) => a.name).join(", "),
        album: data.item.album.name,
        album_art: data.item.album.images?.[0]?.url || null,
        duration_ms: data.item.duration_ms,
        progress_ms: data.progress_ms,
        uri: data.item.uri,
      },
    });
  } catch (error) {
    return jsonResponse({ is_playing: false, error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
}

async function handlePerceive(env: Env): Promise<Response> {
  try {
    const data = await spotifyAPI("/me/player/currently-playing", env);
    if (!data || !data.item) {
      return jsonResponse({ is_playing: false });
    }

    const track = data.item.name;
    const artist = data.item.artists[0]?.name;
    const progressMs = data.progress_ms;
    const progressSec = progressMs / 1000;

    const result: any = {
      is_playing: data.is_playing,
      track: {
        name: track,
        artist: data.item.artists.map((a: any) => a.name).join(", "),
        album: data.item.album.name,
        album_art: data.item.album.images?.[0]?.url || null,
        duration_ms: data.item.duration_ms,
        progress_ms: progressMs,
        uri: data.item.uri,
      },
      lyrics: null,
    };

    try {
      const lyrics = await fetchLRCLib("/get", { track_name: track, artist_name: artist });
      if (lyrics && lyrics.syncedLyrics && !lyrics.instrumental) {
        const parsed = parseSyncedLyrics(lyrics.syncedLyrics);
        const { current, upcoming } = findCurrentLyric(parsed, progressSec);
        result.lyrics = { current_line: current, upcoming_lines: upcoming };
      }
    } catch { /* continue without lyrics */ }

    return jsonResponse(result);
  } catch (error) {
    return jsonResponse({ is_playing: false, error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
}

async function handlePlaybackControl(action: string, env: Env): Promise<Response> {
  try {
    const map: Record<string, { endpoint: string; method: string }> = {
      play: { endpoint: "/me/player/play", method: "PUT" },
      pause: { endpoint: "/me/player/pause", method: "PUT" },
      next: { endpoint: "/me/player/next", method: "POST" },
      previous: { endpoint: "/me/player/previous", method: "POST" },
    };

    const config = map[action];
    if (!config) return jsonResponse({ error: "Unknown action" }, 400);

    await spotifyAPI(config.endpoint, env, { method: config.method });
    return jsonResponse({ success: true });
  } catch (error) {
    return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
}

// ============================================================================
// Worker Export
// ============================================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    globalEnv = env;
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/health") {
      const hasToken = !!(await env.SPOTIFY_KV?.get("spotify_access_token"));
      return jsonResponse({
        status: "alive",
        service: "music-perception-mcp",
        version: "2.0.0",
        spotify: hasToken ? "connected" : "not connected - visit /auth",
      });
    }

    // ============ INBOUND AUTH GATE (audit 2026-07-12 — CRITICAL) ============
    // /mcp + /sse + /api/* carried full Spotify playback control with zero auth.
    // Fail-closed: token via Bearer header OR ?k=/?key= query param (claude.ai
    // connectors can't set headers — the ?k= URL ships WITH this gate, lovense
    // 07-13 lesson). /health stays open (status only); /callback stays open
    // (Spotify redirects there). /auth is gated — it can rebind the Spotify
    // account. NEXUS_TOKEN is accepted on /api/* only: it ships in the public
    // frontend bundle, so it must never unlock the full MCP toolset.
    {
      const gatedMcp = ["/mcp", "/sse", "/sse/message", "/auth"].includes(url.pathname);
      const gatedApi = url.pathname.startsWith("/api/");
      if (gatedMcp || gatedApi) {
        const auth = request.headers.get("Authorization") || "";
        const headerTok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const queryTok = (url.searchParams.get("k") || url.searchParams.get("key") || "").trim();
        const tok = headerTok || queryTok;
        const ok = (secret: string | undefined) => !!(tok && secret && timingSafeEqualStr(tok, secret));
        const allowed = ok(env.AUTH_TOKEN) || ok(env.SPOTIFY_KEY) || (gatedApi && ok(env.NEXUS_TOKEN));
        if (!allowed) return jsonResponse({ error: "unauthorized" }, 401);
      }
    }

    if (url.pathname === "/auth") return handleAuth(url, env);
    if (url.pathname === "/callback") return handleCallback(url, env);

    // REST API routes (for Triad Nexus and other apps)
    if (url.pathname === "/api/now-playing") return handleNowPlaying(env);
    if (url.pathname === "/api/perceive") return handlePerceive(env);
    if (url.pathname.startsWith("/api/") && request.method === "POST") {
      const action = url.pathname.replace("/api/", "");
      if (["play", "pause", "next", "previous"].includes(action)) {
        return handlePlaybackControl(action, env);
      }
    }

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return AudioPerception.serveSSE("/sse", { binding: "AUDIO_PERCEPTION" }).fetch(request, env, ctx);
    }
    if (url.pathname === "/mcp") {
      return AudioPerception.serve("/mcp", { binding: "AUDIO_PERCEPTION" }).fetch(request, env, ctx);
    }

    if (url.pathname === "/") {
      return jsonResponse({
        name: "Music Perception MCP",
        version: "2.0.0",
        endpoints: {
          health: "/health",
          auth: "/auth",
          sse: "/sse",
          mcp: "/mcp",
          api: {
            now_playing: "/api/now-playing",
            perceive: "/api/perceive",
            play: "POST /api/play",
            pause: "POST /api/pause",
            next: "POST /api/next",
            previous: "POST /api/previous",
          },
        },
      });
    }

    // 404 unmatched paths — a 200 catch-all makes claude.ai's OAuth discovery
    // (/.well-known/*) think this server has OAuth and breaks the connector
    // (lovense incident, 2026-07-13).
    return new Response("Not found", { status: 404 });
  },
};
