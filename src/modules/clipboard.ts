import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { run } from '../utils/shell.js';

interface ClipboardEntry {
  text: string;
  timestamp: number;
}

const MAX_HISTORY = 50;
const clipHistory: ClipboardEntry[] = [];

export class ClipboardModule implements JarvisModule {
  name = 'clipboard' as const;
  description = 'Clipboard manager — copy, paste, history, and search';

  patterns: PatternDefinition[] = [
    {
      intent: 'copy',
      patterns: [
        /^(?:copy|clip)\s+["'](.+?)["']/i,
        /^(?:copy|clip)\s+(.+)/i,
      ],
      extract: (match) => ({ text: match[1].trim() }),
    },
    {
      intent: 'paste',
      patterns: [
        /^paste$/i,
        /^(?:show|get|what(?:'?s| is)\s+(?:in\s+)?(?:the\s+)?)?clipboard$/i,
        /^pbpaste$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'paste-nth',
      patterns: [
        /^paste\s+#?\s*(\d+)/i,
        /^clip(?:board)?\s+#?\s*(\d+)/i,
      ],
      extract: (match) => ({ index: match[1] }),
    },
    {
      intent: 'clip-history',
      patterns: [
        /^clip(?:board)?\s+history/i,
        /^(?:show\s+)?(?:copy|clip)\s+history/i,
        /^(?:recent\s+)?clips/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'clip-search',
      patterns: [
        /^clip(?:board)?\s+search\s+(.+)/i,
        /^search\s+clip(?:board|s)?\s+(?:for\s+)?(.+)/i,
      ],
      extract: (match) => ({ query: match[1].trim() }),
    },
    {
      intent: 'clip-clear',
      patterns: [
        /^(?:clear|empty)\s+clip(?:board)?(?:\s+history)?/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'copy': return this.copyText(command.args.text);
      case 'paste': return this.pasteText();
      case 'paste-nth': return this.pasteNth(parseInt(command.args.index, 10));
      case 'clip-history': return this.showHistory();
      case 'clip-search': return this.searchClipboard(command.args.query);
      case 'clip-clear': return this.clearHistory();
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private async copyText(text: string): Promise<CommandResult> {
    // Copy to system clipboard via pbcopy
    const result = await run(`echo "${text.replace(/"/g, '\\"')}" | pbcopy`);
    if (result.exitCode === 0) {
      this.addToHistory(text);
      return { success: true, message: `Copied to clipboard: "${text.length > 60 ? text.slice(0, 60) + '...' : text}"` };
    }
    return { success: false, message: 'Failed to copy to clipboard' };
  }

  private async pasteText(): Promise<CommandResult> {
    const result = await run('pbpaste');
    const text = result.stdout;
    if (!text) {
      return { success: true, message: 'Clipboard is empty' };
    }
    this.addToHistory(text);
    const display = text.length > 200 ? text.slice(0, 200) + '...' : text;
    return { success: true, message: `Clipboard contents:\n    ${display}`, data: text };
  }

  private pasteNth(index: number): CommandResult {
    if (index < 1 || index > clipHistory.length) {
      return { success: false, message: `No clipboard entry #${index}. History has ${clipHistory.length} entries.` };
    }
    const entry = clipHistory[clipHistory.length - index];
    // Copy it back to clipboard
    run(`echo "${entry.text.replace(/"/g, '\\"')}" | pbcopy`);
    return { success: true, message: `Restored to clipboard: "${entry.text.length > 60 ? entry.text.slice(0, 60) + '...' : entry.text}"` };
  }

  private showHistory(): CommandResult {
    if (clipHistory.length === 0) {
      return { success: true, message: 'Clipboard history is empty' };
    }
    const lines = clipHistory.slice(-10).reverse().map((entry, i) => {
      const age = this.timeAgo(entry.timestamp);
      const preview = entry.text.length > 50 ? entry.text.slice(0, 50) + '...' : entry.text;
      return `    #${i + 1}  ${preview}  (${age})`;
    });
    return { success: true, message: `Clipboard history (most recent first):\n${lines.join('\n')}` };
  }

  private searchClipboard(query: string): CommandResult {
    const lower = query.toLowerCase();
    const matches = clipHistory.filter(e => e.text.toLowerCase().includes(lower));
    if (matches.length === 0) {
      return { success: true, message: `No clipboard entries matching "${query}"` };
    }
    const lines = matches.slice(-10).reverse().map((entry, i) => {
      const preview = entry.text.length > 50 ? entry.text.slice(0, 50) + '...' : entry.text;
      return `    ${i + 1}. ${preview}`;
    });
    return { success: true, message: `Found ${matches.length} match(es):\n${lines.join('\n')}` };
  }

  private clearHistory(): CommandResult {
    clipHistory.length = 0;
    return { success: true, message: 'Clipboard history cleared' };
  }

  private addToHistory(text: string): void {
    // Don't add duplicates of the last entry
    if (clipHistory.length > 0 && clipHistory[clipHistory.length - 1].text === text) return;
    clipHistory.push({ text, timestamp: Date.now() });
    if (clipHistory.length > MAX_HISTORY) clipHistory.shift();
  }

  private timeAgo(ts: number): string {
    const seconds = Math.round((Date.now() - ts) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    return `${Math.round(seconds / 3600)}h ago`;
  }

  getHelp(): string {
    return [
      '  Clipboard Manager — copy, paste, and history',
      '    copy <text>            Copy text to clipboard',
      '    paste                  Show clipboard contents',
      '    paste #3               Restore clipboard entry #3',
      '    clips                  Show clipboard history',
      '    clip search <query>    Search clipboard history',
      '    clear clipboard        Clear clipboard history',
    ].join('\n');
  }
}
