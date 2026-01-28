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
    if (tokens.error) throw new Error(`Token refresh failed: ${tokens.error}`);

    await env.SPOTIFY_KV.put("spotify_access_token", tokens.access_token);
    await env.SPOTIFY_KV.put("spotify_token_expires", String(Date.now() + tokens.expires_in * 1000));
    if (tokens.refresh_token) {
      await env.SPOTIFY_KV.put("spotify_refresh_token", tokens.refresh_token);
    }
    return tokens.access_token;
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
// Worker Export
// ============================================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    globalEnv = env;
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const hasToken = !!(await env.SPOTIFY_KV?.get("spotify_access_token"));
      return Response.json({
        status: "alive",
        service: "music-perception-mcp",
        version: "2.0.0",
        spotify: hasToken ? "connected" : "not connected - visit /auth",
      });
    }

    if (url.pathname === "/auth") return handleAuth(url, env);
    if (url.pathname === "/callback") return handleCallback(url, env);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return AudioPerception.serveSSE("/sse", { binding: "AUDIO_PERCEPTION" }).fetch(request, env, ctx);
    }
    if (url.pathname === "/mcp") {
      return AudioPerception.serve("/mcp", { binding: "AUDIO_PERCEPTION" }).fetch(request, env, ctx);
    }

    return Response.json({
      name: "Music Perception MCP",
      version: "2.0.0",
      endpoints: { health: "/health", auth: "/auth", sse: "/sse", mcp: "/mcp" },
    });
  },
};
