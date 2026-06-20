import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { run } from '../utils/shell.js';
import { osascript } from '../utils/osascript.js';
import { pushUndo } from '../core/undo-stack.js';

export class SystemControlModule implements JarvisModule {
  name = 'system-control' as const;
  description = 'Control volume, brightness, dark mode, Do Not Disturb, WiFi, Bluetooth, screenshots, sleep, lock, and more';

  patterns: PatternDefinition[] = [
    // ── Volume ──
    {
      intent: 'volume-set',
      patterns: [
        /^(?:set\s+)?volume\s+(?:up\s+)?(?:to\s+)?(\d+)/i,  // "volume to 100", "volume up to 100"
        /^vol\s+(\d+)/i,
        /^(?:turn|set|put)\s+(?:the\s+|my\s+)?(?:volume|sound)\s+(?:up\s+)?(?:to\s+)?(\d+)/i,  // "turn the/my volume to 100", "turn volume up to 100"
      ],
      extract: (match) => ({ level: (match[1] || '').replace(/%/g, '') }),
    },
    {
      intent: 'volume-up',
      patterns: [
        /^volume\s+up(?!\s+(?:to\s+)?\d)/i,  // "volume up" but NOT "volume up to 100"
        /^(?:turn\s+up|increase|raise)\s+(?:the\s+|my\s+)?volume(?!\s+(?:to\s+)?\d)/i,
        /^turn\s+(?:the\s+|my\s+)?(?:volume|sound)\s+up(?!\s+(?:to\s+)?\d)/i,
        /^(?:put|set)\s+(?:the\s+|my\s+)?(?:volume|sound)\s+(?:to\s+)?(?:the\s+)?max/i,
        /^louder/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'volume-down',
      patterns: [
        /^volume\s+down/i,
        /^(?:turn\s+down|decrease|lower)\s+(?:the\s+|my\s+)?volume/i,
        /^turn\s+(?:the\s+|my\s+)?(?:volume|sound)\s+down/i,
        /^quieter/i,
        /^softer/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'mute',
      patterns: [
        /^mute/i,
        /^(?:toggle\s+)?mute/i,
        /^silence/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'unmute',
      patterns: [
        /^unmute/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'volume-get',
      patterns: [
        /^(?:get\s+|show\s+|check\s+|what(?:'s| is)\s+(?:the\s+)?)volume/i,
        /^volume$/i,
      ],
      extract: () => ({}),
    },
    // ── Brightness ──
    {
      intent: 'brightness-set',
      patterns: [
        /^(?:set\s+)?brightness\s+(?:up\s+)?(?:to\s+)?(\d+)/i,
        /^(?:turn|set|put)\s+(?:the\s+|my\s+)?brightness\s+(?:up\s+)?(?:to\s+)?(\d+)/i,
      ],
      extract: (match) => ({ level: (match[1] || '').replace(/%/g, '') }),
    },
    {
      intent: 'brightness-up',
      patterns: [
        /^brightness\s+up(?!\s+(?:to\s+)?\d)/i,
        /^(?:turn\s+up|increase|raise)\s+(?:the\s+|my\s+)?brightness(?!\s+(?:to\s+)?\d)/i,
        /^brighter/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'brightness-down',
      patterns: [
        /^brightness\s+down/i,
        /^(?:turn\s+down|decrease|lower)\s+(?:the\s+|my\s+)?brightness/i,
        /^dimmer/i,
      ],
      extract: () => ({}),
    },
    // ── Dark Mode ──
    {
      intent: 'dark-mode-on',
      patterns: [
        /^dark\s+mode\s+on/i,
        /^(?:enable|activate|turn on)\s+dark\s+mode/i,
        /^go\s+dark/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'dark-mode-off',
      patterns: [
        /^dark\s+mode\s+off/i,
        /^(?:disable|deactivate|turn off)\s+dark\s+mode/i,
        /^light\s+mode/i,
        /^go\s+light/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'dark-mode-toggle',
      patterns: [
        /^(?:toggle\s+)?dark\s+mode$/i,
      ],
      extract: () => ({}),
    },
    // ── Do Not Disturb ──
    {
      intent: 'dnd-on',
      patterns: [
        /^(?:do not disturb|dnd)\s+on/i,
        /^(?:enable|turn on)\s+(?:do not disturb|dnd|focus)/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'dnd-off',
      patterns: [
        /^(?:do not disturb|dnd)\s+off/i,
        /^(?:disable|turn off)\s+(?:do not disturb|dnd|focus)/i,
      ],
      extract: () => ({}),
    },
    // ── Sleep / Lock / Screensaver ──
    {
      intent: 'sleep',
      patterns: [
        /^sleep/i,
        /^(?:put\s+(?:the\s+)?(?:computer|mac|machine)\s+to\s+)?sleep/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'lock',
      patterns: [
        /^lock(?:\s+screen)?/i,
        /^lock\s+(?:the\s+)?(?:computer|mac|machine)/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'screensaver',
      patterns: [
        /^screensaver/i,
        /^(?:start|show|activate)\s+screensaver/i,
      ],
      extract: () => ({}),
    },
    // ── Trash ──
    {
      intent: 'empty-trash',
      patterns: [
        /^empty\s+(?:the\s+)?trash/i,
        /^clean\s+(?:the\s+)?trash/i,
      ],
      extract: () => ({}),
    },
    // ── WiFi ──
    {
      intent: 'wifi-on',
      patterns: [
        /^(?:turn\s+on|enable|activate)\s+(?:the\s+)?wi-?fi/i,
        /^wi-?fi\s+on/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'wifi-off',
      patterns: [
        /^(?:turn\s+off|disable|deactivate)\s+(?:the\s+)?wi-?fi/i,
        /^wi-?fi\s+off/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'wifi-status',
      patterns: [
        /^wi-?fi(?:\s+status)?$/i,
        /^(?:what(?:'s| is)\s+(?:the\s+)?)?wi-?fi\s+(?:status|network)/i,
        /^(?:am i|are we)\s+connected/i,
      ],
      extract: () => ({}),
    },
    // ── Bluetooth ──
    {
      intent: 'bluetooth-on',
      patterns: [
        /^(?:turn\s+on|enable|activate)\s+(?:the\s+)?bluetooth/i,
        /^bluetooth\s+on/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'bluetooth-off',
      patterns: [
        /^(?:turn\s+off|disable|deactivate)\s+(?:the\s+)?bluetooth/i,
        /^bluetooth\s+off/i,
      ],
      extract: () => ({}),
    },
    // ── Screenshot ──
    {
      intent: 'screenshot',
      patterns: [
        /^(?:take\s+(?:a\s+)?)?screenshot/i,
        /^(?:screen\s*cap(?:ture)?|snap\s+screen)/i,
        /^capture\s+(?:the\s+)?screen/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'screenshot-clipboard',
      patterns: [
        /^screenshot\s+(?:to\s+)?clipboard/i,
        /^copy\s+(?:the\s+)?screen/i,
      ],
      extract: () => ({}),
    },
    // ── Notifications ──
    {
      intent: 'notify',
      patterns: [
        /^(?:send\s+(?:a\s+)?)?notif(?:y|ication)\s+(.+)/i,
        // "alert" only — "remind me ..." belongs to the timer module (timed reminders).
        /^alert\s+(?:me\s+)?(.+)/i,
      ],
      extract: (match) => ({ message: match[1] }),
    },
    // ── Web / URL ──
    {
      intent: 'web-search',
      patterns: [
        /^(?:search|google|look up|search for)\s+(.+)/i,
        /^(?:web\s+)?search\s+(?:for\s+)?(.+)/i,
      ],
      extract: (match) => ({ query: match[1] }),
    },
    {
      intent: 'open-url',
      patterns: [
        /^(?:open|go to|navigate to|browse)\s+(https?:\/\/\S+)/i,
        /^(?:open|go to|navigate to|browse)\s+(\S+\.(?:com|org|net|io|dev|ai|co|me|app|edu|gov)\S*)/i,
        // Bare URL (e.g. "youtube.com" by itself)
        /^((?:https?:\/\/)?\S+\.(?:com|org|net|io|dev|ai|co|me|app|edu|gov)\S*)$/i,
      ],
      extract: (match) => ({ url: match[1] }),
    },
    // ── Shell Command ──
    {
      intent: 'shell',
      patterns: [
        /^(?:run|exec(?:ute)?|shell)\s+(.+)/i,
        /^\$\s*(.+)/i,
      ],
      extract: (match) => ({ command: match[1] }),
    },
    // ── Type / Keyboard ──
    {
      intent: 'type-text',
      patterns: [
        /^type\s+(.+)/i,
        /^(?:key)?press\s+([\w+]+)/i,
      ],
      extract: (match) => ({ text: match[1] }),
    },
    // ── Say / Announce ──
    {
      intent: 'say-text',
      patterns: [
        /^say\s+(.+)/i,
        // "read X" is NOT included — it collides with "read my screen/whatsapp/page/email".
        /^(?:speak|announce)\s+(.+)/i,
      ],
      extract: (match) => ({ text: match[1] }),
    },
    // ── Eject ──
    {
      intent: 'eject',
      patterns: [
        /^eject(?:\s+(.+))?/i,
      ],
      extract: (match) => ({ disk: match[1] || 'all' }),
    },
    // ── Show Desktop ──
    {
      intent: 'show-desktop',
      patterns: [
        /^(?:show\s+)?desktop/i,
        /^(?:hide|minimize)\s+(?:all\s+)?windows/i,
      ],
      extract: () => ({}),
    },
    // ── Shutdown / Restart ──
    {
      intent: 'shutdown',
      patterns: [
        /^(?:shut\s*down|power\s+off)\s*(?:the\s+)?(?:computer|mac)?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'restart',
      patterns: [
        /^restart\s*(?:the\s+)?(?:computer|mac)?$/i,
        /^reboot/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      // Volume
      case 'volume-set': return this.setVolume(parseInt(command.args.level, 10));
      case 'volume-up': return this.adjustVolume(10);
      case 'volume-down': return this.adjustVolume(-10);
      case 'mute': return this.setMute(true);
      case 'unmute': return this.setMute(false);
      case 'volume-get': return this.getVolume();
      // Brightness
      case 'brightness-set': return this.setBrightness(parseInt(command.args.level, 10));
      case 'brightness-up': return this.adjustBrightness(0.1);
      case 'brightness-down': return this.adjustBrightness(-0.1);
      // Dark mode
      case 'dark-mode-on': return this.setDarkMode(true);
      case 'dark-mode-off': return this.setDarkMode(false);
      case 'dark-mode-toggle': return this.toggleDarkMode();
      // DND
      case 'dnd-on': return this.setDnd(true);
      case 'dnd-off': return this.setDnd(false);
      // Sleep / Lock
      case 'sleep': return this.sleepMac();
      case 'lock': return this.lockScreen();
      case 'screensaver': return this.startScreensaver();
      // Trash
      case 'empty-trash': return this.emptyTrash();
      // WiFi
      case 'wifi-on': return this.setWifi(true);
      case 'wifi-off': return this.setWifi(false);
      case 'wifi-status': return this.getWifiStatus();
      // Bluetooth
      case 'bluetooth-on': return this.setBluetooth(true);
      case 'bluetooth-off': return this.setBluetooth(false);
      // Screenshot
      case 'screenshot': return this.takeScreenshot(false);
      case 'screenshot-clipboard': return this.takeScreenshot(true);
      // Notifications
      case 'notify': return this.sendNotification(command.args.message);
      // Web
      case 'web-search': return this.webSearch(command.args.query);
      case 'open-url': return this.openUrl(command.args.url);
      // Shell
      case 'shell': return this.runShell(command.args.command);
      // Type
      case 'type-text': return this.typeText(command.args.text);
      // Say
      case 'say-text': return this.sayText(command.args.text);
      // Eject
      case 'eject': return this.ejectDisk(command.args.disk);
      // Show desktop
      case 'show-desktop': return this.showDesktop();
      // Power
      case 'shutdown': return this.shutdown();
      case 'restart': return this.restart();
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  // ── Volume ──
  private async setVolume(level: number): Promise<CommandResult> {
    const clamped = Math.max(0, Math.min(100, level));
    const prevVol = parseInt(await osascript('output volume of (get volume settings)'), 10) || 50;
    await osascript(`set volume output volume ${clamped}`);
    pushUndo({
      description: `Set volume to ${clamped}% (was ${prevVol}%)`,
      module: 'system-control',
      undo: async () => { await osascript(`set volume output volume ${prevVol}`); return true; },
    });
    return { success: true, message: `Volume set to ${clamped}%` };
  }

  private async adjustVolume(delta: number): Promise<CommandResult> {
    const current = await osascript('output volume of (get volume settings)');
    const currentVol = parseInt(current, 10) || 50;
    const newVol = Math.max(0, Math.min(100, currentVol + delta));
    await osascript(`set volume output volume ${newVol}`);
    pushUndo({
      description: `Volume ${delta > 0 ? 'up' : 'down'} to ${newVol}% (was ${currentVol}%)`,
      module: 'system-control',
      undo: async () => { await osascript(`set volume output volume ${currentVol}`); return true; },
    });
    return { success: true, message: `Volume ${delta > 0 ? 'up' : 'down'} → ${newVol}%` };
  }

  private async setMute(muted: boolean): Promise<CommandResult> {
    await osascript(`set volume output muted ${muted}`);
    pushUndo({
      description: muted ? 'Muted volume' : 'Unmuted volume',
      module: 'system-control',
      undo: async () => { await osascript(`set volume output muted ${!muted}`); return true; },
    });
    return { success: true, message: muted ? 'Muted' : 'Unmuted' };
  }

  private async getVolume(): Promise<CommandResult> {
    const vol = await osascript('output volume of (get volume settings)');
    const muted = await osascript('output muted of (get volume settings)');
    return {
      success: true,
      message: `Volume: ${vol}%${muted === 'true' ? ' (muted)' : ''}`,
    };
  }

  // ── Brightness ──
  private async setBrightness(level: number): Promise<CommandResult> {
    const clamped = Math.max(0, Math.min(100, level));
    const fraction = (clamped / 100).toFixed(2);

    // Try brightness CLI tool first (brew install brightness)
    const toolCheck = await run('which brightness 2>/dev/null');
    if (toolCheck.exitCode === 0) {
      await run(`brightness ${fraction}`);
      return { success: true, message: `Brightness set to ${clamped}%` };
    }

    // Fallback: simulate brightness key presses to approximate level
    // Key code 107 = brightness down (F1), 113 = brightness up (F2)
    const steps = Math.round(clamped / 6.25); // macOS has ~16 brightness steps
    for (let i = 0; i < 16; i++) {
      await run('osascript -e \'tell application "System Events" to key code 107\'');
    }
    for (let i = 0; i < steps; i++) {
      await run('osascript -e \'tell application "System Events" to key code 113\'');
    }
    return { success: true, message: `Brightness set to ~${clamped}%` };
  }

  private async adjustBrightness(delta: number): Promise<CommandResult> {
    // Key code 113 = brightness up (F2), 107 = brightness down (F1)
    const keyCode = delta > 0 ? 113 : 107;
    const steps = Math.max(1, Math.abs(Math.round(delta * 16)));
    for (let i = 0; i < steps; i++) {
      await run(`osascript -e 'tell application "System Events" to key code ${keyCode}'`);
    }
    return { success: true, message: `Brightness ${delta > 0 ? 'increased' : 'decreased'}` };
  }

  // ── Dark Mode ──
  private async setDarkMode(on: boolean): Promise<CommandResult> {
    await osascript(
      `tell application "System Events" to tell appearance preferences to set dark mode to ${on}`
    );
    pushUndo({
      description: `Dark mode ${on ? 'enabled' : 'disabled'}`,
      module: 'system-control',
      undo: async () => {
        await osascript(`tell application "System Events" to tell appearance preferences to set dark mode to ${!on}`);
        return true;
      },
    });
    return { success: true, message: `Dark mode ${on ? 'enabled' : 'disabled'}` };
  }

  private async toggleDarkMode(): Promise<CommandResult> {
    const current = await osascript(
      'tell application "System Events" to tell appearance preferences to get dark mode'
    );
    const isOn = current.trim() === 'true';
    return this.setDarkMode(!isOn);
  }

  // ── Do Not Disturb ──
  private async setDnd(on: boolean): Promise<CommandResult> {
    // macOS Monterey+ uses Focus system. Toggle via shortcuts or defaults.
    if (on) {
      await run('shortcuts run "Turn On Focus" 2>/dev/null || defaults -currentHost write com.apple.notificationcenterui doNotDisturb -boolean true && killall NotificationCenter 2>/dev/null');
    } else {
      await run('shortcuts run "Turn Off Focus" 2>/dev/null || defaults -currentHost write com.apple.notificationcenterui doNotDisturb -boolean false && killall NotificationCenter 2>/dev/null');
    }
    return { success: true, message: `Do Not Disturb ${on ? 'enabled' : 'disabled'}` };
  }

  // ── Sleep / Lock ──
  private async sleepMac(): Promise<CommandResult> {
    await run('pmset sleepnow');
    return { success: true, message: 'Putting Mac to sleep...' };
  }

  private async lockScreen(): Promise<CommandResult> {
    await run('osascript -e \'tell application "System Events" to keystroke "q" using {command down, control down}\'');
    return { success: true, message: 'Screen locked' };
  }

  private async startScreensaver(): Promise<CommandResult> {
    await run('open -a ScreenSaverEngine');
    return { success: true, message: 'Screensaver started' };
  }

  // ── Trash ──
  private async emptyTrash(): Promise<CommandResult> {
    await osascript(
      'tell application "Finder" to empty trash'
    );
    return { success: true, message: 'Trash emptied' };
  }

  // ── WiFi ──
  private async setWifi(on: boolean): Promise<CommandResult> {
    const iface = (await run('networksetup -listallhardwareports | awk \'/Wi-Fi/{getline; print $2}\'')).stdout.trim() || 'en0';
    await run(`networksetup -setairportpower ${iface} ${on ? 'on' : 'off'}`);
    return { success: true, message: `WiFi ${on ? 'enabled' : 'disabled'}` };
  }

  private async getWifiStatus(): Promise<CommandResult> {
    const iface = (await run('networksetup -listallhardwareports | awk \'/Wi-Fi/{getline; print $2}\'')).stdout.trim() || 'en0';
    const power = (await run(`networksetup -getairportpower ${iface}`)).stdout.trim();
    const isOn = power.includes('On');
    if (!isOn) return { success: true, message: 'WiFi is off' };
    const ssid = (await run('/System/Library/PrivateFrameworks/Apple80211.framework/Resources/airport -I | awk \'/ SSID:/{print $2}\'')).stdout.trim();
    return { success: true, message: `WiFi is on — connected to "${ssid || 'unknown'}"` };
  }

  // ── Bluetooth ──
  private async setBluetooth(on: boolean): Promise<CommandResult> {
    // Try blueutil first (brew install blueutil), then fallback to defaults
    const hasBlueutil = (await run('which blueutil 2>/dev/null')).exitCode === 0;
    if (hasBlueutil) {
      await run(`blueutil --power ${on ? '1' : '0'}`);
    } else {
      // Fallback: toggle via System Events
      await run(`defaults write /Library/Preferences/com.apple.Bluetooth ControllerPowerState -int ${on ? 1 : 0} 2>/dev/null && killall -HUP blued 2>/dev/null`);
    }
    return { success: true, message: `Bluetooth ${on ? 'enabled' : 'disabled'}` };
  }

  // ── Screenshot ──
  private async takeScreenshot(toClipboard: boolean): Promise<CommandResult> {
    if (toClipboard) {
      await run('screencapture -c');
      return { success: true, message: 'Screenshot copied to clipboard' };
    }
    const desktopPath = `~/Desktop/screenshot-${Date.now()}.png`;
    await run(`screencapture ${desktopPath}`);
    return { success: true, message: `Screenshot saved to Desktop` };
  }

  // ── Notifications ──
  private async sendNotification(message: string): Promise<CommandResult> {
    await osascript(`display notification "${message.replace(/"/g, '\\"')}" with title "JARVIS"`);
    return { success: true, message: `Notification sent: "${message}"` };
  }

  // ── Web ──
  private async webSearch(query: string): Promise<CommandResult> {
    const encoded = encodeURIComponent(query);
    await run(`open "https://www.google.com/search?q=${encoded}"`);
    return { success: true, message: `Searching for "${query}"` };
  }

  private async openUrl(url: string): Promise<CommandResult> {
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    await run(`open "${fullUrl}"`);
    return { success: true, message: `Opening ${fullUrl}` };
  }

  // ── Shell ──
  private async runShell(command: string): Promise<CommandResult> {
    const result = await run(command, { timeout: 30000 });
    const output = (result.stdout || result.stderr).trim();
    if (result.exitCode !== 0) {
      return { success: false, message: output || `Command failed (exit ${result.exitCode})` };
    }
    return { success: true, message: output || 'Done' };
  }

  // ── Type / Keyboard ──
  private async typeText(text: string): Promise<CommandResult> {
    // Check if it's a key press (like "enter", "escape", "cmd+c")
    const keyMap: Record<string, string> = {
      'enter': 'return', 'return': 'return', 'escape': 'escape', 'esc': 'escape',
      'tab': 'tab', 'space': 'space', 'delete': 'delete', 'backspace': 'delete',
      'up': 'up arrow', 'down': 'down arrow', 'left': 'left arrow', 'right': 'right arrow',
    };

    // Handle modifier+key combos like "cmd+c", "ctrl+alt+delete"
    if (/^[\w+]+$/.test(text) && text.includes('+')) {
      const parts = text.toLowerCase().split('+');
      const key = parts.pop()!;
      const modifiers = parts.map(m => {
        if (m === 'cmd' || m === 'command') return 'command down';
        if (m === 'ctrl' || m === 'control') return 'control down';
        if (m === 'alt' || m === 'option') return 'option down';
        if (m === 'shift') return 'shift down';
        return '';
      }).filter(Boolean).join(', ');
      await osascript(`tell application "System Events" to keystroke "${key}" using {${modifiers}}`);
      return { success: true, message: `Pressed ${text}` };
    }

    // Single key press
    const mapped = keyMap[text.toLowerCase()];
    if (mapped) {
      await osascript(`tell application "System Events" to key code ${this.keyNameToCode(mapped)}`);
      return { success: true, message: `Pressed ${text}` };
    }

    // Type text string
    const escaped = text.replace(/"/g, '\\"');
    await osascript(`tell application "System Events" to keystroke "${escaped}"`);
    return { success: true, message: `Typed "${text}"` };
  }

  private keyNameToCode(name: string): number {
    const codes: Record<string, number> = {
      'return': 36, 'escape': 53, 'tab': 48, 'space': 49, 'delete': 51,
      'up arrow': 126, 'down arrow': 125, 'left arrow': 123, 'right arrow': 124,
    };
    return codes[name] || 36;
  }

  // ── Say ──
  private async sayText(text: string): Promise<CommandResult> {
    await run(`say "${text.replace(/"/g, '\\"')}"`);
    return { success: true, message: `Said: "${text}"` };
  }

  // ── Eject ──
  private async ejectDisk(disk: string): Promise<CommandResult> {
    if (disk === 'all') {
      await osascript('tell application "Finder" to eject (every disk whose ejectable is true)');
      return { success: true, message: 'All external disks ejected' };
    }
    await run(`diskutil eject "${disk}"`);
    return { success: true, message: `Ejected ${disk}` };
  }

  // ── Show Desktop ──
  private async showDesktop(): Promise<CommandResult> {
    // F11 or Mission Control gesture — use key code
    await osascript('tell application "System Events" to key code 103'); // F11
    return { success: true, message: 'Showing desktop' };
  }

  // ── Shutdown / Restart ──
  private async shutdown(): Promise<CommandResult> {
    await osascript('tell application "System Events" to shut down');
    return { success: true, message: 'Shutting down...' };
  }

  private async restart(): Promise<CommandResult> {
    await osascript('tell application "System Events" to restart');
    return { success: true, message: 'Restarting...' };
  }

  getHelp(): string {
    return [
      '  System Control — full Mac control',
      '    volume <0-100>       Set volume',
      '    volume up/down       Adjust volume',
      '    mute / unmute        Toggle mute',
      '    brightness <n>       Set brightness',
      '    dark mode on/off     Toggle dark mode',
      '    dnd on/off           Do Not Disturb',
      '    wifi on/off          Toggle WiFi',
      '    wifi                 WiFi status',
      '    bluetooth on/off     Toggle Bluetooth',
      '    screenshot           Take screenshot to Desktop',
      '    screenshot clipboard Copy screen to clipboard',
      '    search <query>       Google search',
      '    open <url>           Open URL in browser',
      '    notify <msg>         Send notification',
      '    run <command>        Run shell command',
      '    type <text>          Type text / press keys',
      '    say <text>           Speak text aloud',
      '    eject                Eject external disks',
      '    desktop              Show desktop',
      '    sleep / lock         Sleep or lock Mac',
      '    shutdown / restart   Power control',
      '    empty trash          Empty the Trash',
    ].join('\n');
  }
}
