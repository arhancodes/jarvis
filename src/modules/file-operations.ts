import * as os from 'os';
import * as path from 'path';
import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { run } from '../utils/shell.js';

function resolvePath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

export class FileOperationsModule implements JarvisModule {
  name = 'file-ops' as const;
  description = 'Search, open, move, copy, and delete files and folders';

  patterns: PatternDefinition[] = [
    {
      intent: 'search',
      patterns: [
        // Local file search — but NOT "search the web" / "find research papers"
        // (those belong to browser-control / research, reached on fall-through).
        /^(?:search|find|locate)\s+(?!(?:the\s+web|online|google)\b)(?!(?:me\s+)?(?:some\s+)?(?:research|academic|papers?|articles?|info(?:rmation)?\s+(?:on|about))\b)(?:for\s+)?(?:files?\s+)?(?:named?\s+)?["']?(.+?)["']?$/i,
        /^(?:where(?:'?s| is))\s+(?:my\s+|the\s+)?(.+)/i,
        /^(?:look for)\s+(?:the\s+)?file\s+(.+)/i,
      ],
      extract: (match) => ({ query: match[1].trim() }),
    },
    {
      intent: 'open-folder',
      patterns: [
        /^open\s+(?:folder|directory|dir)\s+(.+)/i,
        // "open my downloads folder", "open the projects directory"
        /^open\s+(?:the\s+|my\s+)?(.+?)\s+(?:folder|directory|dir)$/i,
        /^(?:show|reveal)\s+(?:me\s+)?(?:in\s+finder\s+)?(~?\/\S+)/i,
        /^reveal\s+(?:in\s+finder\s+)?(.+)/i,
        /^open\s+(~?\/.+)/i,
        /^open\s+(~[^\s]*)/i,
      ],
      extract: (match) => ({ path: match[1].trim() }),
    },
    {
      intent: 'move',
      patterns: [
        /^move\s+(.+?)\s+to\s+(.+)/i,
        /^mv\s+(.+?)\s+(.+)/i,
      ],
      extract: (match) => ({ source: match[1].trim(), destination: match[2].trim() }),
    },
    {
      intent: 'copy',
      patterns: [
        /^copy\s+(.+?)\s+to\s+(.+)/i,
        /^cp\s+(.+?)\s+(.+)/i,
        /^duplicate\s+(.+?)\s+to\s+(.+)/i,
      ],
      extract: (match) => ({ source: match[1].trim(), destination: match[2].trim() }),
    },
    {
      intent: 'delete',
      patterns: [
        /^(?:delete|remove|trash)\s+(.+)/i,
        /^rm\s+(.+)/i,
      ],
      extract: (match) => ({ path: match[1].trim() }),
    },
    {
      intent: 'list-dir',
      patterns: [
        /^ls\s+(.+)/i,
        /^(?:what(?:'?s| is)\s+in)\s+(.+)/i,
        /^(?:list|show)\s+(?:me\s+)?what(?:'?s| is)\s+(?:in|inside)\s+(.+)/i,
        /^(?:list|show)\s+(?:me\s+)?(?:the\s+)?(?:files?|contents?)\s+(?:in|of)\s+(.+)/i,
        /^(?:list|show)\s+(?:the\s+)?(?:contents\s+of\s+)?(~?\/\S+)/i,
      ],
      extract: (match) => ({ path: match[1].trim() }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'search': return this.search(command.args.query);
      case 'open-folder': return this.openFolder(command.args.path);
      case 'move': return this.moveFile(command.args.source, command.args.destination);
      case 'copy': return this.copyFile(command.args.source, command.args.destination);
      case 'delete': return this.deleteFile(command.args.path);
      case 'list-dir': return this.listDir(command.args.path);
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private async search(query: string): Promise<CommandResult> {
    // Use Spotlight (mdfind) for fast search
    const result = await run(`mdfind -name "${query}" -onlyin ~ 2>/dev/null | head -20`);
    if (result.stdout) {
      const files = result.stdout.split('\n').filter(Boolean);
      const list = files.map(f => `    ${f}`).join('\n');
      return { success: true, message: `Found ${files.length} result(s):\n${list}`, data: files };
    }

    // Fallback to find
    const fallback = await run(`find ~ -name "*${query}*" -maxdepth 4 2>/dev/null | head -20`);
    if (fallback.stdout) {
      const files = fallback.stdout.split('\n').filter(Boolean);
      const list = files.map(f => `    ${f}`).join('\n');
      return { success: true, message: `Found ${files.length} result(s):\n${list}`, data: files };
    }

    return { success: true, message: `No files found matching "${query}"` };
  }

  private async openFolder(p: string): Promise<CommandResult> {
    const resolved = resolvePath(p);
    const result = await run(`open "${resolved}"`);
    if (result.exitCode === 0) {
      return { success: true, message: `Opened ${resolved} in Finder` };
    }
    return { success: false, message: `Could not open "${resolved}": ${result.stderr}` };
  }

  private async moveFile(source: string, dest: string): Promise<CommandResult> {
    const src = resolvePath(source);
    const dst = resolvePath(dest);

    // Check source exists
    const check = await run(`test -e "${src}" && echo exists`);
    if (!check.stdout.includes('exists')) {
      return { success: false, message: `Source not found: ${src}` };
    }

    const result = await run(`mv "${src}" "${dst}"`);
    if (result.exitCode === 0) {
      return { success: true, message: `Moved ${src} → ${dst}` };
    }
    return { success: false, message: `Move failed: ${result.stderr}` };
  }

  private async copyFile(source: string, dest: string): Promise<CommandResult> {
    const src = resolvePath(source);
    const dst = resolvePath(dest);

    const check = await run(`test -e "${src}" && echo exists`);
    if (!check.stdout.includes('exists')) {
      return { success: false, message: `Source not found: ${src}` };
    }

    const result = await run(`cp -r "${src}" "${dst}"`);
    if (result.exitCode === 0) {
      return { success: true, message: `Copied ${src} → ${dst}` };
    }
    return { success: false, message: `Copy failed: ${result.stderr}` };
  }

  private async deleteFile(p: string): Promise<CommandResult> {
    const resolved = resolvePath(p);

    const check = await run(`test -e "${resolved}" && echo exists`);
    if (!check.stdout.includes('exists')) {
      return { success: false, message: `File not found: ${resolved}` };
    }

    // Move to Trash using Finder (recoverable)
    const escapedPath = resolved.replace(/'/g, "'\\''");
    const result = await run(
      `osascript -e 'tell application "Finder" to delete POSIX file "${escapedPath}"'`
    );
    if (result.exitCode === 0) {
      return { success: true, message: `Moved to Trash: ${resolved}` };
    }
    return { success: false, message: `Delete failed: ${result.stderr}` };
  }

  private async listDir(p: string): Promise<CommandResult> {
    const resolved = resolvePath(p);
    const result = await run(`ls -lah "${resolved}"`);
    if (result.exitCode === 0) {
      return { success: true, message: `Contents of ${resolved}:\n${result.stdout}` };
    }
    return { success: false, message: `Could not list "${resolved}": ${result.stderr}` };
  }

  getHelp(): string {
    return [
      '  File Operations — manage files and folders',
      '    search <name>          Search for files (uses Spotlight)',
      '    open folder <path>     Open a folder in Finder',
      '    move <src> to <dest>   Move a file or folder',
      '    copy <src> to <dest>   Copy a file or folder',
      '    delete <path>          Move file to Trash',
      '    ls <path>              List directory contents',
    ].join('\n');
  }
}
