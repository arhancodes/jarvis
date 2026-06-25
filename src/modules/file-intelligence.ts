import { execSync } from 'child_process';
import { existsSync, statSync, readdirSync } from 'fs';
import { join, basename, extname } from 'path';
import { homedir } from 'os';
import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { llmStreamChat } from '../utils/llm.js';
import { fmt } from '../utils/formatter.js';

function safeExec(cmd: string, timeout = 15000): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout, maxBuffer: 10 * 1024 * 1024 }).trim();
  } catch (err) {
    const error = err as { stderr?: string; message?: string };
    throw new Error(error.stderr || error.message || 'Command failed');
  }
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function formatDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export class FileIntelligenceModule implements JarvisModule {
  name = 'file-intelligence' as const;
  description = 'Smart file search using Spotlight, find, and grep with LLM assistance';

  patterns: PatternDefinition[] = [
    {
      intent: 'search',
      patterns: [
        /^find\s+(?:that\s+)?(?:file|document|pdf|image|photo|video|spreadsheet|presentation)s?\s+(?:about\s+|named\s+|called\s+)?(.+)$/i,
        /^find\s+files?\s+(.+)$/i,
        /^search\s+(?:for\s+)?files?\s+(.+)$/i,
        /^locate\s+(.+)$/i,
      ],
      extract: (match) => ({ query: match[1].trim() }),
    },
    {
      intent: 'recent-downloads',
      patterns: [
        /^recent\s+downloads?$/i,
        /^(?:show|list|get)\s+(?:my\s+)?recent\s+downloads?$/i,
        /^(?:what(?:'?s| is)\s+in\s+)?(?:my\s+)?downloads?$/i,
        /^latest\s+downloads?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'content-search',
      patterns: [
        /^search\s+(?:for\s+)?(.+?)\s+in\s+files?$/i,
        /^(?:grep|find)\s+(?:for\s+)?["']?(.+?)["']?\s+in\s+(?:files?\s+)?(?:in\s+)?(.+)$/i,
        /^content\s+search\s+(.+)$/i,
      ],
      extract: (match) => ({
        query: match[1].trim(),
        directory: match[2]?.trim() || '.',
      }),
    },
    {
      intent: 'large-files',
      patterns: [
        /^large\s+files?(?:\s+in\s+(.+))?$/i,
        /^(?:find|show|list)\s+large\s+files?(?:\s+in\s+(.+))?$/i,
        /^big\s+files?(?:\s+in\s+(.+))?$/i,
        /^(?:what(?:'?s| is)\s+)?taking\s+(?:up\s+)?space(?:\s+in\s+(.+))?$/i,
      ],
      extract: (match) => ({ directory: match[1]?.trim() || homedir() }),
    },
    {
      intent: 'duplicates',
      patterns: [
        /^duplicate\s+files?(?:\s+in\s+(.+))?$/i,
        /^find\s+duplicates?(?:\s+in\s+(.+))?$/i,
        /^(?:show|list)\s+duplicate\s+files?(?:\s+in\s+(.+))?$/i,
      ],
      extract: (match) => ({ directory: match[1]?.trim() || homedir() }),
    },
    {
      intent: 'smart-find',
      patterns: [
        /^smart\s+find\s+(.+)$/i,
        /^find\s+that\s+(.+)$/i,
        /^(?:i\s+)?(?:need|want)\s+(?:to\s+find\s+)?(?:that\s+)?(.+)$/i,
      ],
      extract: (match) => ({ query: match[1].trim() }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'search': return this.handleSearch(command);
      case 'recent-downloads': return this.handleRecentDownloads();
      case 'content-search': return this.handleContentSearch(command);
      case 'large-files': return this.handleLargeFiles(command);
      case 'duplicates': return this.handleDuplicates(command);
      case 'smart-find': return this.handleSmartFind(command);
      default: return { success: false, message: `Unknown file intelligence action: ${command.action}` };
    }
  }

  private async handleSearch(command: ParsedCommand): Promise<CommandResult> {
    const { query } = command.args;

    // Detect file type hints from the query
    const typeMap: Record<string, string> = {
      pdf: 'kMDItemContentType == "com.adobe.pdf"',
      image: 'kMDItemContentTypeTree == "public.image"',
      photo: 'kMDItemContentTypeTree == "public.image"',
      video: 'kMDItemContentTypeTree == "public.movie"',
      document: 'kMDItemContentTypeTree == "public.content"',
      spreadsheet: 'kMDItemContentType == "org.openxmlformats.spreadsheetml.sheet" || kMDItemContentType == "com.microsoft.excel.xls"',
      presentation: 'kMDItemContentType == "org.openxmlformats.presentationml.presentation" || kMDItemContentType == "com.microsoft.powerpoint.ppt"',
    };

    let typeFilter = '';
    const lowerQuery = query.toLowerCase();
    for (const [keyword, filter] of Object.entries(typeMap)) {
      if (lowerQuery.includes(keyword)) {
        typeFilter = filter;
        break;
      }
    }

    // Clean the search query (remove type keywords)
    const cleanQuery = query.replace(/\b(pdf|image|photo|video|document|spreadsheet|presentation)s?\b/gi, '').trim();

    try {
      let results: string;
      if (typeFilter && cleanQuery) {
        results = safeExec(`mdfind '${typeFilter} && kMDItemTextContent == "*${cleanQuery.replace(/'/g, "\\'")}*"cd || kMDItemDisplayName == "*${cleanQuery.replace(/'/g, "\\'")}*"cd' 2>/dev/null | head -20`);
      } else if (typeFilter) {
        results = safeExec(`mdfind '${typeFilter}' 2>/dev/null | head -20`);
      } else {
        results = safeExec(`mdfind '${cleanQuery.replace(/'/g, "\\'")}' 2>/dev/null | head -20`);
      }

      if (!results) {
        return {
          success: true,
          message: fmt.info(`No files found matching "${query}"`),
          voiceMessage: `No files found for ${query}.`,
        };
      }

      const files = results.split('\n').filter(Boolean);
      const fileEntries = files.map(f => {
        try {
          const stats = statSync(f);
          return `  ${basename(f)} ${fmt.dim(`(${formatFileSize(stats.size)}, ${formatDate(stats.mtime)})`)}\n    ${fmt.dim(f)}`;
        } catch {
          return `  ${basename(f)}\n    ${fmt.dim(f)}`;
        }
      });

      return {
        success: true,
        message: [
          fmt.heading(`Search results for "${query}"`),
          ...fileEntries,
          '',
          fmt.info(`${files.length} file(s) found`),
        ].join('\n'),
        voiceMessage: `Found ${files.length} files matching ${query}.`,
        data: files,
      };
    } catch (err) {
      return {
        success: false,
        message: fmt.error(`Search failed: ${(err as Error).message}`),
      };
    }
  }

  private async handleRecentDownloads(): Promise<CommandResult> {
    const downloadsDir = join(homedir(), 'Downloads');

    if (!existsSync(downloadsDir)) {
      return { success: false, message: fmt.error('Downloads folder not found.') };
    }

    try {
      const entries = readdirSync(downloadsDir)
        .filter(f => !f.startsWith('.'))
        .map(f => {
          const fullPath = join(downloadsDir, f);
          try {
            const stats = statSync(fullPath);
            return { name: f, path: fullPath, size: stats.size, mtime: stats.mtime, isDir: stats.isDirectory() };
          } catch {
            return null;
          }
        })
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .slice(0, 20);

      if (entries.length === 0) {
        return {
          success: true,
          message: fmt.info('Downloads folder is empty.'),
          voiceMessage: 'Your downloads folder is empty.',
        };
      }

      const lines = entries.map(e => {
        const icon = e.isDir ? '📁' : this.getFileIcon(e.name);
        return `  ${icon} ${e.name} ${fmt.dim(`(${formatFileSize(e.size)}, ${formatDate(e.mtime)})`)}`;
      });

      return {
        success: true,
        message: [
          fmt.heading('Recent Downloads'),
          ...lines,
          '',
          fmt.info(`${entries.length} items shown`),
        ].join('\n'),
        voiceMessage: `You have ${entries.length} recent items in Downloads. The most recent is ${entries[0].name}.`,
        data: entries.map(e => e.path),
      };
    } catch (err) {
      return {
        success: false,
        message: fmt.error(`Failed to read Downloads: ${(err as Error).message}`),
      };
    }
  }

  private async handleContentSearch(command: ParsedCommand): Promise<CommandResult> {
    const { query, directory } = command.args;
    const searchDir = directory === '.' ? homedir() : directory;

    if (!existsSync(searchDir)) {
      return { success: false, message: fmt.error(`Directory not found: ${searchDir}`) };
    }

    try {
      // Use grep -rl for content search, excluding hidden dirs and common large dirs
      const excludes = '--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.cache --exclude-dir=Library';
      const results = safeExec(
        `grep -rl ${excludes} --include='*.txt' --include='*.md' --include='*.py' --include='*.js' --include='*.ts' --include='*.json' --include='*.yaml' --include='*.yml' --include='*.csv' --include='*.html' --include='*.css' --include='*.swift' --include='*.java' --include='*.go' --include='*.rs' --include='*.c' --include='*.cpp' --include='*.h' '${query.replace(/'/g, "\\'")}' "${searchDir}" 2>/dev/null | head -20`,
        30000,
      );

      if (!results) {
        return {
          success: true,
          message: fmt.info(`No files containing "${query}" found in ${searchDir}`),
          voiceMessage: `No files contain "${query}".`,
        };
      }

      const files = results.split('\n').filter(Boolean);
      const fileEntries = files.map(f => {
        try {
          // Get a preview of the matching line
          const preview = safeExec(`grep -m 1 '${query.replace(/'/g, "\\'")}' "${f}" 2>/dev/null | head -1`);
          const trimmed = preview.length > 80 ? preview.substring(0, 77) + '...' : preview;
          return `  ${basename(f)}\n    ${fmt.dim(f)}\n    ${fmt.dim(trimmed)}`;
        } catch {
          return `  ${basename(f)}\n    ${fmt.dim(f)}`;
        }
      });

      return {
        success: true,
        message: [
          fmt.heading(`Files containing "${query}"`),
          ...fileEntries,
          '',
          fmt.info(`${files.length} file(s) found`),
        ].join('\n'),
        voiceMessage: `Found ${files.length} files containing "${query}".`,
        data: files,
      };
    } catch (err) {
      return {
        success: false,
        message: fmt.error(`Content search failed: ${(err as Error).message}`),
      };
    }
  }

  private async handleLargeFiles(command: ParsedCommand): Promise<CommandResult> {
    const directory = command.args.directory || homedir();

    if (!existsSync(directory)) {
      return { success: false, message: fmt.error(`Directory not found: ${directory}`) };
    }

    try {
      // Find files larger than 100MB
      const results = safeExec(
        `find "${directory}" -maxdepth 3 -type f -size +100M -not -path "*/Library/*" -not -path "*/.Trash/*" -not -path "*/.*" 2>/dev/null | head -20`,
        30000,
      );

      if (!results) {
        // Try with a lower threshold
        const smallerResults = safeExec(
          `find "${directory}" -maxdepth 3 -type f -size +50M -not -path "*/Library/*" -not -path "*/.Trash/*" -not -path "*/.*" 2>/dev/null | head -20`,
          30000,
        );

        if (!smallerResults) {
          return {
            success: true,
            message: fmt.info(`No large files (>50MB) found in ${directory}`),
            voiceMessage: 'No large files found.',
          };
        }

        return this.formatLargeFiles(smallerResults, directory, '50MB');
      }

      return this.formatLargeFiles(results, directory, '100MB');
    } catch (err) {
      return {
        success: false,
        message: fmt.error(`Large file search failed: ${(err as Error).message}`),
      };
    }
  }

  private formatLargeFiles(results: string, directory: string, threshold: string): CommandResult {
    const files = results.split('\n').filter(Boolean);
    const fileInfo = files.map(f => {
      try {
        const stats = statSync(f);
        return { path: f, name: basename(f), size: stats.size };
      } catch {
        return null;
      }
    })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => b.size - a.size);

    const totalSize = fileInfo.reduce((sum, f) => sum + f.size, 0);

    const lines = fileInfo.map(f =>
      `  ${f.name} ${fmt.dim(`(${formatFileSize(f.size)})`)}\n    ${fmt.dim(f.path)}`
    );

    return {
      success: true,
      message: [
        fmt.heading(`Large files (>${threshold}) in ${directory}`),
        ...lines,
        '',
        fmt.info(`${fileInfo.length} file(s), total: ${formatFileSize(totalSize)}`),
      ].join('\n'),
      voiceMessage: `Found ${fileInfo.length} large files totalling ${formatFileSize(totalSize)}.`,
      data: fileInfo,
    };
  }

  private async handleDuplicates(command: ParsedCommand): Promise<CommandResult> {
    const directory = command.args.directory || join(homedir(), 'Downloads');

    if (!existsSync(directory)) {
      return { success: false, message: fmt.error(`Directory not found: ${directory}`) };
    }

    try {
      // Find files, compute md5 hashes, find duplicates
      // Only check files up to 500MB to avoid hanging
      const output = safeExec(
        `find "${directory}" -maxdepth 2 -type f -size +0c -size -500M -not -path "*/.*" 2>/dev/null | while read f; do md5 -q "$f" 2>/dev/null | tr -d '\\n'; echo "  $f"; done | sort | uniq -d -w 32 2>/dev/null | head -30`,
        60000,
      );

      if (!output) {
        // Alternative: find by name + size duplication
        const sizeOutput = safeExec(
          `find "${directory}" -maxdepth 2 -type f -not -path "*/.*" -printf '%s %p\\n' 2>/dev/null | sort -n | uniq -D -w 10 | head -30 || find "${directory}" -maxdepth 2 -type f -not -path "*/.*" 2>/dev/null | xargs -I{} stat -f '%z %N' {} 2>/dev/null | sort -n | awk 'seen[$1]++{print}' | head -30`,
          30000,
        );

        if (!sizeOutput) {
          return {
            success: true,
            message: fmt.info(`No obvious duplicates found in ${directory}`),
            voiceMessage: 'No duplicate files found.',
          };
        }
      }

      // Parse the md5 output: "hash  filepath"
      const lines = output.split('\n').filter(Boolean);
      const groups: Record<string, string[]> = {};
      for (const line of lines) {
        const hash = line.substring(0, 32).trim();
        const path = line.substring(34).trim();
        if (hash && path) {
          if (!groups[hash]) groups[hash] = [];
          groups[hash].push(path);
        }
      }

      const dupGroups = Object.values(groups).filter(g => g.length > 1);

      if (dupGroups.length === 0) {
        return {
          success: true,
          message: fmt.info(`No duplicates found in ${directory}`),
          voiceMessage: 'No duplicate files found.',
        };
      }

      const resultLines: string[] = [fmt.heading(`Duplicate files in ${directory}`)];
      for (const group of dupGroups) {
        resultLines.push('');
        for (const f of group) {
          try {
            const stats = statSync(f);
            resultLines.push(`  ${basename(f)} ${fmt.dim(`(${formatFileSize(stats.size)})`)}`);
            resultLines.push(`    ${fmt.dim(f)}`);
          } catch {
            resultLines.push(`  ${basename(f)}`);
            resultLines.push(`    ${fmt.dim(f)}`);
          }
        }
      }

      resultLines.push('');
      resultLines.push(fmt.info(`${dupGroups.length} group(s) of duplicates found`));

      return {
        success: true,
        message: resultLines.join('\n'),
        voiceMessage: `Found ${dupGroups.length} groups of duplicate files.`,
        data: dupGroups,
      };
    } catch (err) {
      return {
        success: false,
        message: fmt.error(`Duplicate search failed: ${(err as Error).message}`),
      };
    }
  }

  private async handleSmartFind(command: ParsedCommand): Promise<CommandResult> {
    const { query } = command.args;

    try {
      let generatedCmd = '';
      await llmStreamChat(
        [{
          role: 'user',
          content: `The user wants to find files on their Mac. Their description: "${query}"

Generate the best macOS command to find these files. You can use:
- mdfind (Spotlight) for content/metadata search
- find for path/name/size/date based search
- A combination piped together

Reply with ONLY the shell command, nothing else. The command should:
- Output file paths, one per line
- Limit results to 20 (use head -20)
- Exclude hidden files and Library folders
- Be safe (read-only, no modifications)`,
        }],
        'You are a macOS file search expert. Generate only safe, read-only shell commands. Never include rm, mv, or any destructive commands.',
        (token) => { generatedCmd += token; },
      );

      generatedCmd = generatedCmd.trim();

      // Safety check: reject any destructive commands
      const dangerous = /\b(rm|mv|cp|chmod|chown|dd|mkfs|sudo)\b/i;
      if (dangerous.test(generatedCmd)) {
        return {
          success: false,
          message: fmt.error('Generated command was rejected for safety reasons.'),
        };
      }

      const results = safeExec(generatedCmd, 30000);

      if (!results) {
        return {
          success: true,
          message: [
            fmt.info(`No files found for: "${query}"`),
            fmt.dim(`  Command used: ${generatedCmd}`),
          ].join('\n'),
          voiceMessage: `No files found matching your description.`,
        };
      }

      const files = results.split('\n').filter(Boolean);
      const fileEntries = files.map(f => {
        try {
          const stats = statSync(f);
          return `  ${basename(f)} ${fmt.dim(`(${formatFileSize(stats.size)}, ${formatDate(stats.mtime)})`)}\n    ${fmt.dim(f)}`;
        } catch {
          return `  ${basename(f)}\n    ${fmt.dim(f)}`;
        }
      });

      return {
        success: true,
        message: [
          fmt.heading(`Smart find: "${query}"`),
          fmt.dim(`  Command: ${generatedCmd}`),
          '',
          ...fileEntries,
          '',
          fmt.info(`${files.length} file(s) found`),
        ].join('\n'),
        voiceMessage: `Found ${files.length} files matching your description.`,
        data: files,
      };
    } catch (err) {
      return {
        success: false,
        message: fmt.error(`Smart find failed: ${(err as Error).message}`),
      };
    }
  }

  private getFileIcon(filename: string): string {
    const ext = extname(filename).toLowerCase();
    const iconMap: Record<string, string> = {
      '.pdf': '📄', '.doc': '📝', '.docx': '📝', '.txt': '📝',
      '.xls': '📊', '.xlsx': '📊', '.csv': '📊',
      '.ppt': '📽️', '.pptx': '📽️',
      '.jpg': '🖼️', '.jpeg': '🖼️', '.png': '🖼️', '.gif': '🖼️', '.svg': '🖼️', '.webp': '🖼️',
      '.mp4': '🎬', '.mov': '🎬', '.avi': '🎬', '.mkv': '🎬',
      '.mp3': '🎵', '.wav': '🎵', '.flac': '🎵', '.aac': '🎵',
      '.zip': '📦', '.tar': '📦', '.gz': '📦', '.rar': '📦', '.7z': '📦',
      '.dmg': '💿', '.iso': '💿', '.pkg': '💿',
      '.js': '⚡', '.ts': '⚡', '.py': '🐍', '.swift': '🦅',
      '.html': '🌐', '.css': '🎨', '.json': '🔧',
    };
    return iconMap[ext] || '📄';
  }

  getHelp(): string {
    return [
      '  File Intelligence — smart file search',
      '    find files <query>       Spotlight search for files',
      '    recent downloads         Show recent files in ~/Downloads',
      '    search <text> in files   Search file contents with grep',
      '    large files [in <dir>]   Find large files (>100MB)',
      '    duplicate files [in dir] Find duplicate files by hash',
      '    smart find <description> LLM-assisted file search',
    ].join('\n');
  }
}
