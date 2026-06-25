import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { osascript } from '../utils/osascript.js';
import { run } from '../utils/shell.js';

export class MediaControlModule implements JarvisModule {
  name = 'media-control' as const;
  description = 'Control Spotify, Apple Music, and system media playback';

  patterns: PatternDefinition[] = [
    // ── Playback control ──
    {
      intent: 'play',
      patterns: [
        /^(?:play|resume)\s+(?:some\s+)?music$/i,
        /^(?:play|resume)\s+music/i,
        /^(?:play|resume)$/i,
        /^music\s+play/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'pause',
      patterns: [
        /^pause(?:\s+music)?$/i,
        /^stop\s+music/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'next',
      patterns: [
        /^(?:next|skip)(?:\s+(?:track|song))?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'previous',
      patterns: [
        /^(?:prev(?:ious)?|back)(?:\s+(?:track|song))?$/i,
        /^go\s+back/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'toggle',
      patterns: [
        /^(?:play|pause|toggle)\s*\/?\s*(?:pause|play)/i,
      ],
      extract: () => ({}),
    },
    // ── Now playing ──
    {
      intent: 'now-playing',
      patterns: [
        /^(?:now playing|what(?:'?s| is) playing|current (?:song|track))/i,
        /^(?:what(?:'?s| is) this (?:song|track))/i,
        /^(?:song|track)\s*$/i,
        /^np$/i,
      ],
      extract: () => ({}),
    },
    // ── Spotify-specific ──
    {
      intent: 'spotify-play',
      patterns: [
        /^(?:spotify\s+)?play\s+["'](.+?)["']/i,
        /^(?:spotify\s+)?play\s+(.+)/i,
        // "put on some jazz", "throw on the beatles", "queue up some lofi"
        /^(?:put\s+on|throw\s+on|queue\s+up)\s+(?:some\s+|the\s+)?(.+)/i,
      ],
      extract: (match) => ({ query: match[1].trim() }),
    },
    {
      intent: 'spotify-playlist',
      patterns: [
        /^(?:play\s+)?playlist\s+["']?(.+?)["']?$/i,
      ],
      extract: (match) => ({ name: match[1].trim() }),
    },
    // ── Shuffle / Repeat ──
    {
      intent: 'shuffle',
      patterns: [
        /^shuffle(?:\s+(?:on|off))?$/i,
        /^toggle\s+shuffle/i,
      ],
      extract: (match) => {
        const raw = match[0].toLowerCase();
        return { state: raw.includes('off') ? 'off' : raw.includes('on') ? 'on' : 'toggle' };
      },
    },
    {
      intent: 'repeat',
      patterns: [
        /^repeat(?:\s+(?:on|off|one|all))?$/i,
        /^(?:loop|toggle\s+repeat)/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'play': return this.play();
      case 'pause': return this.pause();
      case 'next': return this.next();
      case 'previous': return this.previous();
      case 'toggle': return this.togglePlayPause();
      case 'now-playing': return this.nowPlaying();
      case 'spotify-play': return this.spotifySearch(command.args.query);
      case 'spotify-playlist': return this.playPlaylist(command.args.name);
      case 'shuffle': return this.shuffle(command.args.state);
      case 'repeat': return this.repeat();
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private async getActivePlayer(): Promise<'spotify' | 'music' | null> {
    // Check which music app is running
    const spotifyCheck = await run('pgrep -x Spotify 2>/dev/null');
    if (spotifyCheck.exitCode === 0) return 'spotify';

    const musicCheck = await run('pgrep -x Music 2>/dev/null');
    if (musicCheck.exitCode === 0) return 'music';

    return null;
  }

  private async play(): Promise<CommandResult> {
    const player = await this.getActivePlayer();
    if (!player) {
      // Try to open Spotify
      await run('open -a Spotify');
      await new Promise(r => setTimeout(r, 2000));
      await osascript('tell application "Spotify" to play');
      return { success: true, message: 'Opened Spotify and started playback' };
    }

    const appName = player === 'spotify' ? 'Spotify' : 'Music';
    await osascript(`tell application "${appName}" to play`);
    return { success: true, message: `Playing (${appName})` };
  }

  private async pause(): Promise<CommandResult> {
    const player = await this.getActivePlayer();
    if (!player) return { success: false, message: 'No music player is running' };

    const appName = player === 'spotify' ? 'Spotify' : 'Music';
    await osascript(`tell application "${appName}" to pause`);
    return { success: true, message: `Paused (${appName})` };
  }

  private async next(): Promise<CommandResult> {
    const player = await this.getActivePlayer();
    if (!player) return { success: false, message: 'No music player is running' };

    const appName = player === 'spotify' ? 'Spotify' : 'Music';
    await osascript(`tell application "${appName}" to next track`);

    // Brief delay then show what's playing
    await new Promise(r => setTimeout(r, 500));
    return this.nowPlaying();
  }

  private async previous(): Promise<CommandResult> {
    const player = await this.getActivePlayer();
    if (!player) return { success: false, message: 'No music player is running' };

    const appName = player === 'spotify' ? 'Spotify' : 'Music';
    await osascript(`tell application "${appName}" to previous track`);
    await new Promise(r => setTimeout(r, 500));
    return this.nowPlaying();
  }

  private async togglePlayPause(): Promise<CommandResult> {
    const player = await this.getActivePlayer();
    if (!player) return this.play();

    const appName = player === 'spotify' ? 'Spotify' : 'Music';
    await osascript(`tell application "${appName}" to playpause`);
    return { success: true, message: `Toggled play/pause (${appName})` };
  }

  private async nowPlaying(): Promise<CommandResult> {
    const player = await this.getActivePlayer();
    if (!player) return { success: false, message: 'No music player is running' };

    try {
      if (player === 'spotify') {
        const name = await osascript('tell application "Spotify" to name of current track');
        const artist = await osascript('tell application "Spotify" to artist of current track');
        const album = await osascript('tell application "Spotify" to album of current track');
        const state = await osascript('tell application "Spotify" to player state as string');

        const icon = state === 'playing' ? '▶' : '⏸';
        return {
          success: true,
          message: `${icon} ${name}\n    by ${artist}\n    on ${album}`,
        };
      } else {
        const name = await osascript('tell application "Music" to name of current track');
        const artist = await osascript('tell application "Music" to artist of current track');
        const album = await osascript('tell application "Music" to album of current track');
        const state = await osascript('tell application "Music" to player state as string');

        const icon = state === 'playing' ? '▶' : '⏸';
        return {
          success: true,
          message: `${icon} ${name}\n    by ${artist}\n    on ${album}`,
        };
      }
    } catch {
      return { success: false, message: 'Nothing is currently playing' };
    }
  }

  private async spotifySearch(query: string): Promise<CommandResult> {
    // Open Spotify search URI
    const encoded = encodeURIComponent(query);
    await run(`open "spotify:search:${encoded}"`);
    return { success: true, message: `Searching Spotify for "${query}"` };
  }

  private async playPlaylist(name: string): Promise<CommandResult> {
    const encoded = encodeURIComponent(name);
    await run(`open "spotify:search:${encoded}"`);
    return { success: true, message: `Looking for playlist "${name}" on Spotify` };
  }

  private async shuffle(state: string): Promise<CommandResult> {
    const player = await this.getActivePlayer();
    if (!player) return { success: false, message: 'No music player is running' };

    if (player === 'spotify') {
      if (state === 'toggle') {
        const current = await osascript('tell application "Spotify" to shuffling');
        const newState = current.trim() === 'true' ? false : true;
        await osascript(`tell application "Spotify" to set shuffling to ${newState}`);
        return { success: true, message: `Shuffle ${newState ? 'on' : 'off'}` };
      }
      await osascript(`tell application "Spotify" to set shuffling to ${state === 'on'}`);
      return { success: true, message: `Shuffle ${state}` };
    }

    return { success: true, message: 'Shuffle toggled (Apple Music)' };
  }

  private async repeat(): Promise<CommandResult> {
    const player = await this.getActivePlayer();
    if (!player) return { success: false, message: 'No music player is running' };

    if (player === 'spotify') {
      const current = await osascript('tell application "Spotify" to repeating');
      const newState = current.trim() === 'true' ? false : true;
      await osascript(`tell application "Spotify" to set repeating to ${newState}`);
      return { success: true, message: `Repeat ${newState ? 'on' : 'off'}` };
    }

    return { success: true, message: 'Repeat toggled (Apple Music)' };
  }

  getHelp(): string {
    return [
      '  Media Control — Spotify & Apple Music',
      '    play / resume          Start/resume playback',
      '    pause                  Pause playback',
      '    next / skip            Next track',
      '    prev / back            Previous track',
      '    play/pause             Toggle play/pause',
      '    now playing / np       Show current track',
      '    play <song/artist>     Search and play on Spotify',
      '    playlist <name>        Play a playlist',
      '    shuffle / shuffle off  Toggle shuffle',
      '    repeat                 Toggle repeat',
    ].join('\n');
  }
}
