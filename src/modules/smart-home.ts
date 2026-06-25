import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { llmStreamChat } from '../utils/llm.js';
import { fmt } from '../utils/formatter.js';
import { configPath } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('smart-home');
const CONFIG_PATH = configPath('homekit-shortcuts.json');

interface ShortcutMapping {
  [naturalName: string]: string; // natural name -> actual shortcut name
}

interface HomeKitConfig {
  shortcuts: ShortcutMapping;
  scenes: ShortcutMapping;
  lastUpdated: string;
}

function loadConfig(): HomeKitConfig {
  if (existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as HomeKitConfig;
    } catch (err) {
      log.warn('Failed to parse homekit config', err);
    }
  }
  return { shortcuts: {}, scenes: {}, lastUpdated: '' };
}

function saveConfig(config: HomeKitConfig): void {
  config.lastUpdated = new Date().toISOString();
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[smart-home] Failed to save config:', (err as Error).message);
  }
}

function getAvailableShortcuts(): string[] {
  try {
    const output = execSync('shortcuts list', { encoding: 'utf-8', timeout: 10000 });
    return output.split('\n').map(s => s.trim()).filter(Boolean);
  } catch (err) {
    log.debug('Failed to list shortcuts', err);
    return [];
  }
}

function runShortcut(name: string, input?: string): string {
  try {
    const inputArg = input ? ` -i "${input.replace(/"/g, '\\"')}"` : '';
    const output = execSync(`shortcuts run "${name.replace(/"/g, '\\"')}"${inputArg}`, {
      encoding: 'utf-8',
      timeout: 30000,
    });
    return output.trim();
  } catch (err) {
    throw new Error(`Failed to run shortcut "${name}": ${(err as Error).message}`);
  }
}

export class SmartHomeModule implements JarvisModule {
  name = 'smart-home' as const;
  description = 'Control HomeKit devices and scenes via macOS Shortcuts';

  patterns: PatternDefinition[] = [
    {
      intent: 'toggle',
      patterns: [
        /^turn\s+(on|off)\s+(?:the\s+)?(.+)$/i,
        /^switch\s+(on|off)\s+(?:the\s+)?(.+)$/i,
        /^(on|off)\s+(?:the\s+)?(.+)$/i,
      ],
      extract: (match) => ({ state: match[1].toLowerCase(), device: match[2].trim() }),
    },
    {
      intent: 'set',
      patterns: [
        /^set\s+(?:the\s+)?(?!(?:an?\s+)?(?:reminder|alarm|timer|countdown)\b)(.+?)\s+to\s+(.+)$/i,
        /^(?:change|adjust)\s+(?:the\s+)?(.+?)\s+to\s+(.+)$/i,
      ],
      extract: (match) => ({ device: match[1].trim(), value: match[2].trim() }),
    },
    {
      intent: 'toggle',
      patterns: [
        /^dim\s+(?:the\s+)?(.+?)(?:\s+to\s+(\d+))?$/i,
      ],
      extract: (match) => ({
        device: match[1].trim(),
        state: 'dim',
        value: match[2] || '50',
      }),
    },
    {
      intent: 'toggle',
      patterns: [
        /^lights?\s+(on|off|dim)$/i,
        /^(on|off)\s+lights?$/i,
      ],
      extract: (match) => ({ device: 'lights', state: match[1].toLowerCase() }),
    },
    {
      intent: 'scene',
      patterns: [
        /^(?:activate\s+)?scene\s+(.+)$/i,
        /^(?:set\s+)?(?:the\s+)?scene\s+(?:to\s+)?(.+)$/i,
        /^movie\s+night$/i,
        /^good\s+(?:morning|night|evening)$/i,
        /^bedtime$/i,
      ],
      extract: (match, raw) => ({ scene: match[1]?.trim() || raw.trim() }),
    },
    {
      intent: 'status',
      patterns: [
        /^home\s+status$/i,
        /^smart\s+home\s+status$/i,
        /^house\s+status$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'list',
      patterns: [
        /^list\s+(?:smart\s+home\s+)?(?:devices|shortcuts|scenes)$/i,
        /^(?:show|get)\s+(?:available\s+)?(?:devices|shortcuts|scenes)$/i,
        /^smart\s+home\s+list$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'smart-command',
      patterns: [
        /^smart\s+home\s+(.+)$/i,
      ],
      extract: (match) => ({ query: match[1].trim() }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'toggle': return this.handleToggle(command);
      case 'set': return this.handleSet(command);
      case 'scene': return this.handleScene(command);
      case 'list': return this.handleList();
      case 'status': return this.handleStatus();
      case 'smart-command': return this.handleSmartCommand(command);
      default: return { success: false, message: `Unknown smart home action: ${command.action}` };
    }
  }

  private async resolveShortcut(userQuery: string, available: string[]): Promise<string | null> {
    const config = loadConfig();

    // Check direct mapping first
    const lowerQuery = userQuery.toLowerCase();
    for (const [natural, shortcut] of Object.entries({ ...config.shortcuts, ...config.scenes })) {
      if (lowerQuery.includes(natural.toLowerCase())) {
        return shortcut;
      }
    }

    // Check exact match in available shortcuts
    const exact = available.find(s => s.toLowerCase() === lowerQuery);
    if (exact) return exact;

    // Check partial match
    const partial = available.find(s => s.toLowerCase().includes(lowerQuery) || lowerQuery.includes(s.toLowerCase()));
    if (partial) return partial;

    // Use LLM to fuzzy match
    if (available.length === 0) return null;

    try {
      const result = await llmStreamChat(
        [{ role: 'user', content: `The user wants to control: "${userQuery}"\n\nAvailable shortcuts:\n${available.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nWhich shortcut best matches? Reply with ONLY the exact shortcut name, or "NONE" if no match.` }],
        'You are a smart home assistant. Match user intent to available HomeKit shortcuts. Reply with only the exact shortcut name or "NONE".',
        () => {},
      );

      const matched = result.trim();
      if (matched !== 'NONE' && available.includes(matched)) {
        // Cache the mapping
        config.shortcuts[userQuery.toLowerCase()] = matched;
        saveConfig(config);
        return matched;
      }
    } catch (err) {
      log.debug('LLM unavailable for shortcut resolution', err);
    }

    return null;
  }

  private async handleToggle(command: ParsedCommand): Promise<CommandResult> {
    const { device, state } = command.args;
    const available = getAvailableShortcuts();

    if (available.length === 0) {
      return {
        success: false,
        message: fmt.error('No macOS Shortcuts found. Create HomeKit shortcuts in the Shortcuts app first.'),
        voiceMessage: 'No shortcuts found. Please create HomeKit shortcuts in the Shortcuts app.',
      };
    }

    // Try to find a shortcut matching "Turn On/Off <device>" or "<device> On/Off"
    const searchTerms = [
      `Turn ${state} ${device}`,
      `${device} ${state}`,
      `${state} ${device}`,
      device,
    ];

    let matchedShortcut: string | null = null;
    for (const term of searchTerms) {
      matchedShortcut = await this.resolveShortcut(term, available);
      if (matchedShortcut) break;
    }

    if (!matchedShortcut) {
      return {
        success: false,
        message: [
          fmt.error(`No shortcut found for "${device}"`),
          fmt.info('Create a Shortcut in the Shortcuts app that controls this device.'),
          fmt.info(`Tip: Name it "Turn On ${device}" or "Turn Off ${device}"`),
        ].join('\n'),
        voiceMessage: `I couldn't find a shortcut for ${device}. Create one in the Shortcuts app.`,
      };
    }

    try {
      runShortcut(matchedShortcut);
      const msg = fmt.success(`${device} turned ${state} (via "${matchedShortcut}")`);
      return {
        success: true,
        message: msg,
        voiceMessage: `${device} turned ${state}.`,
      };
    } catch (err) {
      return {
        success: false,
        message: fmt.error(`Failed to run shortcut "${matchedShortcut}": ${(err as Error).message}`),
      };
    }
  }

  private async handleSet(command: ParsedCommand): Promise<CommandResult> {
    const { device, value } = command.args;
    const available = getAvailableShortcuts();

    if (available.length === 0) {
      return {
        success: false,
        message: fmt.error('No macOS Shortcuts found.'),
        voiceMessage: 'No shortcuts available.',
      };
    }

    const searchTerms = [
      `Set ${device}`,
      `${device} ${value}`,
      device,
    ];

    let matchedShortcut: string | null = null;
    for (const term of searchTerms) {
      matchedShortcut = await this.resolveShortcut(term, available);
      if (matchedShortcut) break;
    }

    if (!matchedShortcut) {
      return {
        success: false,
        message: [
          fmt.error(`No shortcut found for "${device}"`),
          fmt.info(`Create a Shortcut that accepts input to set ${device}.`),
        ].join('\n'),
        voiceMessage: `No shortcut found for ${device}.`,
      };
    }

    try {
      runShortcut(matchedShortcut, value);
      return {
        success: true,
        message: fmt.success(`${device} set to ${value} (via "${matchedShortcut}")`),
        voiceMessage: `${device} set to ${value}.`,
      };
    } catch (err) {
      return {
        success: false,
        message: fmt.error(`Failed: ${(err as Error).message}`),
      };
    }
  }

  private async handleScene(command: ParsedCommand): Promise<CommandResult> {
    const { scene } = command.args;
    const available = getAvailableShortcuts();

    if (available.length === 0) {
      return {
        success: false,
        message: fmt.error('No macOS Shortcuts found.'),
      };
    }

    const matchedShortcut = await this.resolveShortcut(scene, available);

    if (!matchedShortcut) {
      return {
        success: false,
        message: [
          fmt.error(`No scene shortcut found for "${scene}"`),
          fmt.info('Create a Shortcut that activates this HomeKit scene.'),
        ].join('\n'),
        voiceMessage: `Scene "${scene}" not found.`,
      };
    }

    try {
      runShortcut(matchedShortcut);
      return {
        success: true,
        message: fmt.success(`Scene "${scene}" activated (via "${matchedShortcut}")`),
        voiceMessage: `Scene ${scene} activated.`,
      };
    } catch (err) {
      return {
        success: false,
        message: fmt.error(`Failed to activate scene: ${(err as Error).message}`),
      };
    }
  }

  private async handleList(): Promise<CommandResult> {
    const available = getAvailableShortcuts();
    const config = loadConfig();

    if (available.length === 0) {
      return {
        success: false,
        message: [
          fmt.error('No macOS Shortcuts found.'),
          fmt.info('Open the Shortcuts app and create shortcuts for your HomeKit devices.'),
        ].join('\n'),
      };
    }

    // Filter to likely HomeKit-related shortcuts
    const homeKeywords = ['light', 'lamp', 'fan', 'thermostat', 'lock', 'door', 'garage',
      'scene', 'home', 'turn on', 'turn off', 'heating', 'cooling', 'blinds', 'curtain',
      'plug', 'switch', 'sensor', 'camera', 'alarm', 'morning', 'night', 'bedtime'];
    const homeShortcuts = available.filter(s =>
      homeKeywords.some(k => s.toLowerCase().includes(k))
    );

    const displayList = homeShortcuts.length > 0 ? homeShortcuts : available;
    const label = homeShortcuts.length > 0 ? 'HomeKit-related shortcuts' : 'All available shortcuts';

    const mappings = Object.entries(config.shortcuts);
    const mappingSection = mappings.length > 0
      ? '\n' + fmt.heading('Saved Mappings') + mappings.map(([k, v]) => fmt.label(k, v)).join('\n')
      : '';

    const msg = [
      fmt.heading(label),
      ...displayList.map(s => `  - ${s}`),
      mappingSection,
      '',
      fmt.info(`${available.length} total shortcuts available`),
    ].join('\n');

    return { success: true, message: msg };
  }

  private async handleStatus(): Promise<CommandResult> {
    const available = getAvailableShortcuts();
    const config = loadConfig();

    const lines = [
      fmt.heading('Smart Home Status'),
      fmt.label('Shortcuts Available', String(available.length)),
      fmt.label('Saved Mappings', String(Object.keys(config.shortcuts).length)),
      fmt.label('Saved Scenes', String(Object.keys(config.scenes).length)),
    ];

    if (config.lastUpdated) {
      lines.push(fmt.label('Config Last Updated', config.lastUpdated));
    }

    if (available.length === 0) {
      lines.push('');
      lines.push(fmt.warn('No shortcuts found. Create HomeKit shortcuts in the Shortcuts app.'));
    }

    return { success: true, message: lines.join('\n') };
  }

  private async handleSmartCommand(command: ParsedCommand): Promise<CommandResult> {
    const { query } = command.args;
    const available = getAvailableShortcuts();

    if (available.length === 0) {
      return {
        success: false,
        message: fmt.error('No macOS Shortcuts found.'),
      };
    }

    try {
      let response = '';
      const result = await llmStreamChat(
        [{
          role: 'user',
          content: `The user said: "${query}"\n\nAvailable HomeKit shortcuts:\n${available.join('\n')}\n\nDetermine which shortcut to run and any input to pass. Reply in JSON format:\n{"shortcut": "exact name", "input": "optional input value", "explanation": "what this will do"}\n\nIf no shortcut matches, reply:\n{"shortcut": null, "explanation": "why no match"}`,
        }],
        'You are a smart home controller. Match user intent to HomeKit shortcuts. Always reply with valid JSON.',
        (token) => { response += token; },
      );

      try {
        const parsed = JSON.parse(result) as { shortcut: string | null; input?: string; explanation: string };

        if (!parsed.shortcut) {
          return {
            success: false,
            message: [
              fmt.error('Could not match your request to a shortcut.'),
              fmt.info(parsed.explanation),
            ].join('\n'),
          };
        }

        runShortcut(parsed.shortcut, parsed.input);
        return {
          success: true,
          message: [
            fmt.success(parsed.explanation),
            fmt.dim(`  Ran: "${parsed.shortcut}"`),
          ].join('\n'),
          voiceMessage: parsed.explanation,
        };
      } catch (err) {
        log.warn('Failed to parse LLM response for smart home command', err);
        return {
          success: false,
          message: fmt.error('Failed to parse LLM response for smart home command.'),
        };
      }
    } catch (err) {
      return {
        success: false,
        message: fmt.error(`Smart command failed: ${(err as Error).message}`),
      };
    }
  }

  getHelp(): string {
    return [
      '  Smart Home — HomeKit control via macOS Shortcuts',
      '    turn on/off <device>   Toggle a device',
      '    set <device> to <val>  Set a device value',
      '    dim <device> [to N]    Dim lights',
      '    scene <name>           Activate a scene',
      '    list devices            List available shortcuts',
      '    home status             Show smart home status',
      '    smart home <query>     LLM-assisted command',
    ].join('\n');
  }
}
