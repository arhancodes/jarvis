import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { run } from '../utils/shell.js';
import { getRunningApps, activateApp, quitApp } from '../utils/osascript.js';
import { spawn } from 'child_process';

export class AppLauncherModule implements JarvisModule {
  name = 'app-launcher' as const;
  description = 'Open, close, switch between, and list running applications';

  patterns: PatternDefinition[] = [
    {
      intent: 'open',
      patterns: [
        // Exclude URLs (anything with .com/.org/.net/.io etc.) — those go to system-control open-url
        /^open\s+(?!https?:\/\/)(?!\S+\.(?:com|org|net|io|dev|ai|co|me|app|edu|gov)\b)(.+)/i,
        /^launch\s+(.+)/i,
        /^start\s+(.+)/i,
        /^(?:can you |please )?open\s+(?!https?:\/\/)(?!\S+\.(?:com|org|net|io|dev|ai|co|me|app|edu|gov)\b)(.+?)(?:\s+please)?$/i,
        /^(?:fire up|bring up)\s+(.+)/i,
        /^(planner)$/i,
      ],
      extract: (match) => ({ appName: match[1].trim() }),
    },
    {
      intent: 'close',
      patterns: [
        /^close\s+(.+)/i,
        /^quit\s+(.+)/i,
        // "kill <app>" but NOT "kill port 3000" / "kill the node processes" —
        // those belong to process-manager (registered later, reached on fall-through).
        /^kill\s+(?!.*\bport\s+\d)(?!.*\bprocess(?:es)?\b)(.+)/i,
        /^(?:shut down|exit)\s+(.+)/i,
      ],
      // Drop a trailing reason clause: "chrome it's frozen" -> "chrome".
      extract: (match) => ({
        appName: match[1].trim()
          .replace(/\s+(?:it'?s|its|cause|because|since|coz|cuz)\b.*$/i, '')
          .replace(/\s*[-–,].*$/, '')
          .trim(),
      }),
    },
    {
      intent: 'switch',
      patterns: [
        /^switch\s+to\s+(.+)/i,
        // "go to <app>" but NOT "go to github.com" (a URL → browser-control).
        /^go\s+to\s+(?!\S+\.\w{2,})(.+)/i,
        /^focus\s+(?:on\s+)?(.+)/i,
      ],
      extract: (match) => ({ appName: match[1].trim() }),
    },
    {
      intent: 'list',
      patterns: [
        /^(?:list|show|what)\s*(?:are\s+)?(?:the\s+)?(?:running\s+)?apps/i,
        /^(?:what(?:'?s| is) (?:running|open))/i,
        /^running\s+apps/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'open': return this.openApp(command.args.appName);
      case 'close': return this.closeApp(command.args.appName);
      case 'switch': return this.switchApp(command.args.appName);
      case 'list': return this.listApps();
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  // Aliases: keyword → path or app name
  private readonly aliases: Record<string, string> = {};

  // Dev projects: keyword → { dir, command, url }
  private readonly devProjects: Record<string, { dir: string; cmd: string; url: string }> = {
    'planner': {
      dir: '/Users/arhanharchandani/Downloads/everyday',
      cmd: 'npm run dev',
      url: 'http://localhost:3000',
    },
  };

  private async openApp(name: string): Promise<CommandResult> {
    // Check dev projects first (e.g. "open planner" → npm run dev + open browser)
    const project = this.devProjects[name.toLowerCase()];
    if (project) {
      // Start dev server in background (detached so it survives independently)
      const child = spawn('npm', ['run', 'dev'], {
        cwd: project.dir,
        detached: true,
        stdio: 'ignore',
        shell: true,
      });
      child.unref();
      // Wait for server to start, then open browser
      await new Promise(resolve => setTimeout(resolve, 4000));
      await run(`open "${project.url}"`);
      return { success: true, message: `Started ${name} dev server and opened ${project.url}` };
    }

    // Check aliases
    const alias = this.aliases[name.toLowerCase()];
    if (alias) {
      const result = await run(`open "${alias}"`);
      if (result.exitCode === 0) {
        return { success: true, message: `Opened ${name}` };
      }
      return { success: false, message: `Could not open ${name} (${alias})` };
    }

    const result = await run(`open -a "${name}"`);
    if (result.exitCode === 0) {
      return { success: true, message: `Opened ${name}` };
    }
    // Try fuzzy match against /Applications
    const lsResult = await run('ls /Applications');
    const apps = lsResult.stdout.split('\n').filter(a => a.endsWith('.app'));
    const match = apps.find(a => a.toLowerCase().includes(name.toLowerCase()));
    if (match) {
      const appName = match.replace('.app', '');
      const retry = await run(`open -a "${appName}"`);
      if (retry.exitCode === 0) {
        return { success: true, message: `Opened ${appName}` };
      }
    }
    return { success: false, message: `Could not find app "${name}"` };
  }

  private async closeApp(name: string): Promise<CommandResult> {
    try {
      await quitApp(name);
      return { success: true, message: `Closed ${name}` };
    } catch {
      return { success: false, message: `Could not close "${name}". Is it running?` };
    }
  }

  private async switchApp(name: string): Promise<CommandResult> {
    try {
      await activateApp(name);
      return { success: true, message: `Switched to ${name}` };
    } catch {
      return { success: false, message: `Could not switch to "${name}". Is it running?` };
    }
  }

  private async listApps(): Promise<CommandResult> {
    const apps = await getRunningApps();
    const list = apps.map(a => `    • ${a}`).join('\n');
    return { success: true, message: `Running applications:\n${list}`, data: apps };
  }

  getHelp(): string {
    return [
      '  App Launcher — manage applications',
      '    open <app>       Open an application (e.g. "open Safari")',
      '    close <app>      Quit an application (e.g. "close Slack")',
      '    switch to <app>  Bring app to front (e.g. "switch to Chrome")',
      '    list apps        Show all running applications',
    ].join('\n');
  }
}
