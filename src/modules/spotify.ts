import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = join(__dirname, '..', '..', 'config');
const tokensPath = join(configDir, 'spotify-tokens.json');

const API_BASE = 'https://api.spotify.com/v1';

interface SpotifyTokens {
  access_token: string;
  refresh_token: string;
  client_id: string;
  client_secret: string;
}

function loadTokens(): SpotifyTokens {
  if (!existsSync(tokensPath)) {
    throw new Error('Spotify not configured. Place spotify-tokens.json in config/ with access_token, refresh_token, client_id, and client_secret.');
  }
  return JSON.parse(readFileSync(tokensPath, 'utf-8'));
}

async function refreshAccessToken(tokens: SpotifyTokens): Promise<string> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${tokens.client_id}:${tokens.client_secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${text}`);
  }

  const data = await res.json() as { access_token: string; refresh_token?: string };
  const updated: SpotifyTokens = {
    ...tokens,
    access_token: data.access_token,
    ...(data.refresh_token && { refresh_token: data.refresh_token }),
  };
  writeFileSync(tokensPath, JSON.stringify(updated, null, 2));
  return data.access_token;
}

async function spotifyFetch(
  path: string,
  options: { method?: string; body?: unknown } = {},
  retried = false,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const tokens = loadTokens();

  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (res.status === 401 && !retried) {
    await refreshAccessToken(tokens);
    return spotifyFetch(path, options, true);
  }

  if (res.status === 204) {
    return { ok: true, status: 204, data: null };
  }

  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

export class SpotifyModule implements JarvisModule {
  name = 'spotify' as const;
  description = 'Control Spotify playback and search music';

  patterns: PatternDefinition[] = [
    {
      intent: 'play',
      patterns: [
        /^play (.+?)(?:\s+on spotify)?$/i,
        /^(?:spotify )?play (.+)$/i,
      ],
      extract: (match) => ({ query: match[1] || '' }),
    },
    {
      intent: 'pause',
      patterns: [
        /^(?:pause|stop) (?:the )?(?:music|spotify|playback|song|track)$/i,
        /^(?:spotify )?pause$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'skip',
      patterns: [
        /^(?:skip|next) (?:this )?(?:song|track)?$/i,
        /^(?:next|skip)$/i,
        /^(?:spotify )?(?:skip|next)(?: track)?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'previous',
      patterns: [
        /^(?:previous|prev|go back|last) (?:song|track)?$/i,
        /^(?:spotify )?(?:previous|prev)$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'queue',
      patterns: [
        /^(?:queue|add to queue) (.+?)(?:\s+on spotify)?$/i,
        /^(?:spotify )?queue (.+)$/i,
      ],
      extract: (match) => ({ query: match[1] || '' }),
    },
    {
      intent: 'now-playing',
      patterns: [
        /^what(?:'?s| is) (?:currently )?playing$/i,
        /^(?:now playing|current (?:song|track))$/i,
        /^what(?:'?s| is) (?:this )?song$/i,
        /^(?:spotify )?(?:now playing|what's playing)$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'volume',
      patterns: [
        /^(?:set )?(?:spotify )?volume (?:to )?(\d+)$/i,
        /^(?:spotify )?volume (\d+)$/i,
      ],
      extract: (match) => ({ level: match[1] || '' }),
    },
    {
      intent: 'shuffle',
      patterns: [
        /^(?:toggle )?shuffle(?: (on|off))?$/i,
        /^(?:spotify )?shuffle(?: (on|off))?$/i,
      ],
      extract: (match) => ({ state: match[1] || 'toggle' }),
    },
    {
      intent: 'playlists',
      patterns: [
        /^(?:show |list )?(?:my )?playlists$/i,
        /^(?:spotify )?playlists$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'devices',
      patterns: [
        /^(?:show |list )?(?:spotify )?(?:available )?devices$/i,
        /^(?:spotify )?devices$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'search',
      patterns: [
        // Require an explicit Spotify reference so "find me research papers" /
        // "search the web" don't get hijacked into a music search.
        /^(?:search|find|look\s+up)\s+(?:on\s+)?spotify\s+(?:for\s+)?(.+)$/i,
        /^spotify\s+search\s+(.+)$/i,
        /^(?:search|find|look\s+up)\s+(?:for\s+)?(.+?)\s+on\s+spotify$/i,
      ],
      extract: (match) => ({ query: match[1] || '' }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    try {
      switch (command.action) {
        case 'play': return await this.play(command.args);
        case 'pause': return await this.pause();
        case 'skip': return await this.skip();
        case 'previous': return await this.previous();
        case 'queue': return await this.addToQueue(command.args);
        case 'now-playing': return await this.nowPlaying();
        case 'volume': return await this.setVolume(command.args);
        case 'shuffle': return await this.toggleShuffle(command.args);
        case 'playlists': return await this.listPlaylists();
        case 'devices': return await this.listDevices();
        case 'search': return await this.search(command.args);
        default: return { success: false, message: `Unknown Spotify action: ${command.action}` };
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('not configured')) {
        return { success: false, message: msg };
      }
      return { success: false, message: `Spotify error: ${msg}` };
    }
  }

  private async play(args: Record<string, string>): Promise<CommandResult> {
    const query = args.query || '';
    if (!query) {
      const res = await spotifyFetch('/me/player/play', { method: 'PUT' });
      if (!res.ok && res.status !== 204) return { success: false, message: 'No active device or playback failed.' };
      return { success: true, message: 'Resumed playback.' };
    }

    const searchRes = await spotifyFetch(`/search?q=${encodeURIComponent(query)}&type=track,album,playlist&limit=1`);
    if (!searchRes.ok) return { success: false, message: 'Search failed.' };

    const data = searchRes.data as {
      tracks?: { items: Array<{ uri: string; name: string; artists: Array<{ name: string }> }> };
      albums?: { items: Array<{ uri: string; name: string; artists: Array<{ name: string }> }> };
      playlists?: { items: Array<{ uri: string; name: string }> };
    };

    const track = data.tracks?.items?.[0];
    const album = data.albums?.items?.[0];
    const playlist = data.playlists?.items?.[0];

    if (track) {
      const playRes = await spotifyFetch('/me/player/play', {
        method: 'PUT',
        body: { uris: [track.uri] },
      });
      if (!playRes.ok && playRes.status !== 204) {
        return { success: false, message: 'Failed to play. Make sure a Spotify device is active.' };
      }
      return {
        success: true,
        message: `Playing: ${track.name} by ${track.artists.map(a => a.name).join(', ')}`,
        voiceMessage: `Playing ${track.name} by ${track.artists[0]?.name || 'unknown artist'}.`,
      };
    }

    if (album) {
      const playRes = await spotifyFetch('/me/player/play', {
        method: 'PUT',
        body: { context_uri: album.uri },
      });
      if (!playRes.ok && playRes.status !== 204) {
        return { success: false, message: 'Failed to play album. Make sure a Spotify device is active.' };
      }
      return { success: true, message: `Playing album: ${album.name} by ${album.artists.map(a => a.name).join(', ')}` };
    }

    if (playlist) {
      const playRes = await spotifyFetch('/me/player/play', {
        method: 'PUT',
        body: { context_uri: playlist.uri },
      });
      if (!playRes.ok && playRes.status !== 204) {
        return { success: false, message: 'Failed to play playlist. Make sure a Spotify device is active.' };
      }
      return { success: true, message: `Playing playlist: ${playlist.name}` };
    }

    return { success: false, message: `No results found for "${query}".` };
  }

  private async pause(): Promise<CommandResult> {
    const res = await spotifyFetch('/me/player/pause', { method: 'PUT' });
    if (!res.ok && res.status !== 204) return { success: false, message: 'Failed to pause. No active playback?' };
    return { success: true, message: 'Playback paused.' };
  }

  private async skip(): Promise<CommandResult> {
    const res = await spotifyFetch('/me/player/next', { method: 'POST' });
    if (!res.ok && res.status !== 204) return { success: false, message: 'Failed to skip track.' };
    return { success: true, message: 'Skipped to next track.' };
  }

  private async previous(): Promise<CommandResult> {
    const res = await spotifyFetch('/me/player/previous', { method: 'POST' });
    if (!res.ok && res.status !== 204) return { success: false, message: 'Failed to go to previous track.' };
    return { success: true, message: 'Playing previous track.' };
  }

  private async addToQueue(args: Record<string, string>): Promise<CommandResult> {
    const query = args.query || '';
    if (!query) return { success: false, message: 'Specify a song to queue.' };

    const searchRes = await spotifyFetch(`/search?q=${encodeURIComponent(query)}&type=track&limit=1`);
    if (!searchRes.ok) return { success: false, message: 'Search failed.' };

    const data = searchRes.data as { tracks?: { items: Array<{ uri: string; name: string; artists: Array<{ name: string }> }> } };
    const track = data.tracks?.items?.[0];
    if (!track) return { success: false, message: `No track found for "${query}".` };

    const res = await spotifyFetch(`/me/player/queue?uri=${encodeURIComponent(track.uri)}`, { method: 'POST' });
    if (!res.ok && res.status !== 204) return { success: false, message: 'Failed to add to queue.' };

    return { success: true, message: `Queued: ${track.name} by ${track.artists.map(a => a.name).join(', ')}` };
  }

  private async nowPlaying(): Promise<CommandResult> {
    const res = await spotifyFetch('/me/player/currently-playing');
    if (!res.ok || !res.data) return { success: true, message: 'Nothing is currently playing.' };

    const data = res.data as {
      is_playing: boolean;
      item?: {
        name: string;
        artists: Array<{ name: string }>;
        album: { name: string };
        duration_ms: number;
      };
      progress_ms?: number;
    };

    if (!data.item) return { success: true, message: 'Nothing is currently playing.' };

    const track = data.item;
    const progress = data.progress_ms || 0;
    const formatTime = (ms: number) => {
      const mins = Math.floor(ms / 60000);
      const secs = Math.floor((ms % 60000) / 1000);
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const status = data.is_playing ? 'Playing' : 'Paused';
    const msg = [
      `${status}: ${track.name}`,
      `Artist: ${track.artists.map(a => a.name).join(', ')}`,
      `Album: ${track.album.name}`,
      `Progress: ${formatTime(progress)} / ${formatTime(track.duration_ms)}`,
    ].join('\n');

    return {
      success: true,
      message: msg,
      voiceMessage: `${data.is_playing ? 'Now playing' : 'Paused on'} ${track.name} by ${track.artists[0]?.name || 'unknown'}.`,
    };
  }

  private async setVolume(args: Record<string, string>): Promise<CommandResult> {
    const level = parseInt(args.level || '', 10);
    if (isNaN(level) || level < 0 || level > 100) {
      return { success: false, message: 'Volume must be between 0 and 100.' };
    }

    const res = await spotifyFetch(`/me/player/volume?volume_percent=${level}`, { method: 'PUT' });
    if (!res.ok && res.status !== 204) return { success: false, message: 'Failed to set volume.' };
    return { success: true, message: `Volume set to ${level}%.` };
  }

  private async toggleShuffle(args: Record<string, string>): Promise<CommandResult> {
    let state: boolean;

    if (args.state === 'on') {
      state = true;
    } else if (args.state === 'off') {
      state = false;
    } else {
      const playerRes = await spotifyFetch('/me/player');
      if (!playerRes.ok || !playerRes.data) return { success: false, message: 'No active playback to toggle shuffle.' };
      state = !(playerRes.data as { shuffle_state: boolean }).shuffle_state;
    }

    const res = await spotifyFetch(`/me/player/shuffle?state=${state}`, { method: 'PUT' });
    if (!res.ok && res.status !== 204) return { success: false, message: 'Failed to toggle shuffle.' };
    return { success: true, message: `Shuffle ${state ? 'on' : 'off'}.` };
  }

  private async listPlaylists(): Promise<CommandResult> {
    const res = await spotifyFetch('/me/playlists?limit=20');
    if (!res.ok) return { success: false, message: 'Failed to fetch playlists.' };

    const data = res.data as { items: Array<{ name: string; tracks: { total: number }; owner: { display_name: string } }> };
    if (!data.items?.length) return { success: true, message: 'No playlists found.' };

    const lines = data.items.map((p, i) => `${i + 1}. ${p.name} (${p.tracks.total} tracks) — ${p.owner.display_name}`);
    return { success: true, message: `Your playlists:\n\n${lines.join('\n')}` };
  }

  private async listDevices(): Promise<CommandResult> {
    const res = await spotifyFetch('/me/player/devices');
    if (!res.ok) return { success: false, message: 'Failed to fetch devices.' };

    const data = res.data as { devices: Array<{ name: string; type: string; is_active: boolean; volume_percent: number }> };
    if (!data.devices?.length) return { success: true, message: 'No Spotify devices found.' };

    const lines = data.devices.map((d, i) => {
      const active = d.is_active ? ' (active)' : '';
      return `${i + 1}. ${d.name} — ${d.type}${active} [${d.volume_percent}%]`;
    });
    return { success: true, message: `Available devices:\n\n${lines.join('\n')}` };
  }

  private async search(args: Record<string, string>): Promise<CommandResult> {
    const query = args.query || '';
    if (!query) return { success: false, message: 'Specify a search query.' };

    const res = await spotifyFetch(`/search?q=${encodeURIComponent(query)}&type=track,album,artist,playlist&limit=5`);
    if (!res.ok) return { success: false, message: 'Search failed.' };

    const data = res.data as {
      tracks?: { items: Array<{ name: string; artists: Array<{ name: string }> }> };
      albums?: { items: Array<{ name: string; artists: Array<{ name: string }> }> };
      artists?: { items: Array<{ name: string; followers: { total: number } }> };
      playlists?: { items: Array<{ name: string; owner: { display_name: string } }> };
    };

    const sections: string[] = [];

    if (data.tracks?.items?.length) {
      sections.push('Tracks:\n' + data.tracks.items.map((t, i) =>
        `  ${i + 1}. ${t.name} — ${t.artists.map(a => a.name).join(', ')}`
      ).join('\n'));
    }
    if (data.albums?.items?.length) {
      sections.push('Albums:\n' + data.albums.items.map((a, i) =>
        `  ${i + 1}. ${a.name} — ${a.artists.map(ar => ar.name).join(', ')}`
      ).join('\n'));
    }
    if (data.artists?.items?.length) {
      sections.push('Artists:\n' + data.artists.items.map((a, i) =>
        `  ${i + 1}. ${a.name}`
      ).join('\n'));
    }
    if (data.playlists?.items?.length) {
      sections.push('Playlists:\n' + data.playlists.items.map((p, i) =>
        `  ${i + 1}. ${p.name} — by ${p.owner.display_name}`
      ).join('\n'));
    }

    if (sections.length === 0) return { success: true, message: `No results for "${query}".` };
    return { success: true, message: `Search results for "${query}":\n\n${sections.join('\n\n')}` };
  }

  getHelp(): string {
    return [
      '  Spotify — control music playback',
      '    play <song/album>     Play a track, album, or playlist',
      '    pause                 Pause playback',
      '    skip / next           Skip to next track',
      '    previous              Go to previous track',
      '    queue <song>          Add a track to queue',
      '    now playing           Show current track',
      '    volume <0-100>        Set volume level',
      '    shuffle on/off        Toggle shuffle',
      '    playlists             List your playlists',
      '    devices               List available devices',
      '    search <query>        Search Spotify',
    ].join('\n');
  }
}
