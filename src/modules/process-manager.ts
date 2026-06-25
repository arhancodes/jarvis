import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { run } from '../utils/shell.js';
import { fmt } from '../utils/formatter.js';

export class ProcessManagerModule implements JarvisModule {
  name = 'process-manager' as const;
  description = 'Kill processes, find resource hogs, check ports, and monitor activity';

  patterns: PatternDefinition[] = [
    {
      // Must precede kill-process so "kill port 3000" frees the port instead of
      // trying to terminate a process literally named "port 3000".
      intent: 'kill-port',
      patterns: [
        /^kill\s+(?:whatever(?:'?s| is)\s+on\s+)?port\s+(\d+)/i,
        /^free\s+(?:up\s+)?port\s+(\d+)/i,
      ],
      extract: (match) => ({ port: match[1] }),
    },
    {
      intent: 'kill-process',
      patterns: [
        // "kill all the node processes" / "kill the chrome processes" -> node/chrome
        /^kill\s+(?:all\s+(?:the\s+)?|the\s+)?(.+?)\s+process(?:es)?$/i,
        /^kill\s+(?:process\s+)?(?:named?\s+)?["']?(.+?)["']?$/i,
        /^(?:force\s+)?kill\s+(.+)/i,
        /^killall\s+(.+)/i,
      ],
      extract: (match) => ({ name: match[1].trim() }),
    },
    {
      intent: 'top-cpu',
      patterns: [
        /^(?:top|show)\s+(?:(\d+)\s+)?(?:cpu|processor)\s+(?:hogs?|processes|consumers)/i,
        /^(?:show|list)\s+(?:me\s+)?(?:the\s+)?(?:top\s+)?cpu\s+(?:hogs?|consumers|processes)/i,
        /^(?:what(?:'?s| is)\s+)?(?:using|eating|hogging)\s+(?:the\s+)?cpu/i,
        /^cpu\s+hogs?/i,
      ],
      extract: (match) => ({ count: match[1] || '5' }),
    },
    {
      intent: 'top-memory',
      patterns: [
        /^(?:top|show)\s+(?:(\d+)\s+)?(?:memory|mem|ram)\s+(?:hogs?|processes|consumers)/i,
        /^(?:what(?:'?s| is)\s+)?(?:using|eating|hogging)\s+(?:the\s+)?(?:memory|ram)/i,
        /^(?:memory|ram)\s+hogs?/i,
      ],
      extract: (match) => ({ count: match[1] || '5' }),
    },
    {
      intent: 'port-check',
      patterns: [
        /^(?:what(?:'?s| is)?\s+)?(?:using|on)\s+port\s+(\d+)/i,
        /^port\s+(\d+)/i,
        /^(?:check|show)\s+port\s+(\d+)/i,
        /^(?:who(?:'?s| is)?\s+)?(?:listening\s+on|using|on)\s+(?:port\s+)?(\d+)/i,
      ],
      extract: (match) => ({ port: match[1] }),
    },
    {
      intent: 'find-process',
      patterns: [
        /^(?:find|search)\s+process\s+(.+)/i,
        /^pgrep\s+(.+)/i,
        // "check if spotify is running", "check whether docker is running" -> spotify/docker
        /^check\s+(?:if|whether)\s+(.+?)\s+(?:is\s+)?running\b.*$/i,
        /^is\s+(.+?)\s+running\??$/i,                          // "is spotify running"
        // "<app> is running" / "<app> running" — bounded to ≤3 words so filler
        // clauses ("can you check if spotify is running") fall through to the
        // filler-stripped retry instead of being captured wholesale.
        /^((?:[\w.\-]+\s+){0,2}[\w.\-]+)\s+is\s+running\??$/i,  // "google chrome is running"
        /^([\w.\-]+)\s+running\??$/i,                          // "spotify running"
      ],
      extract: (match) => ({ name: match[1].trim() }),
    },
    {
      intent: 'list-processes',
      patterns: [
        /^(?:list|show|all)\s+processes/i,
        /^ps$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'kill-process': return this.killProcess(command.args.name);
      case 'top-cpu': return this.topProcesses('cpu', parseInt(command.args.count, 10));
      case 'top-memory': return this.topProcesses('mem', parseInt(command.args.count, 10));
      case 'port-check': return this.checkPort(command.args.port);
      case 'kill-port': return this.killPort(command.args.port);
      case 'find-process': return this.findProcess(command.args.name);
      case 'list-processes': return this.listProcesses();
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private async killProcess(name: string): Promise<CommandResult> {
    // Try by name first
    const result = await run(`pkill -f "${name}" 2>/dev/null`);
    if (result.exitCode === 0) {
      return { success: true, message: `Killed processes matching "${name}"` };
    }
    // Try by exact name
    const result2 = await run(`killall "${name}" 2>/dev/null`);
    if (result2.exitCode === 0) {
      return { success: true, message: `Killed all "${name}" processes` };
    }
    return { success: false, message: `No processes found matching "${name}"` };
  }

  private async topProcesses(sortBy: 'cpu' | 'mem', count: number): Promise<CommandResult> {
    const flag = sortBy === 'cpu' ? '-o cpu' : '-o rss';
    const label = sortBy === 'cpu' ? 'CPU' : 'Memory';
    const result = await run(
      `ps aux --sort=${flag === '-o cpu' ? '-%cpu' : '-%mem'} 2>/dev/null | head -${count + 1} || ` +
      `ps -eo pid,pcpu,pmem,comm -r 2>/dev/null | head -${count + 1}`
    );

    if (!result.stdout) {
      // macOS ps doesn't support --sort, use different approach
      const macResult = await run(
        sortBy === 'cpu'
          ? `ps -Ao pid,pcpu,pmem,comm -r | head -${count + 1}`
          : `ps -Ao pid,pcpu,pmem,comm -m | head -${count + 1}`
      );
      if (macResult.stdout) {
        return { success: true, message: `Top ${count} by ${label}:\n${macResult.stdout}`, voiceMessage: `The top ${count} processes by ${label} are on your screen, sir.` };
      }
      return { success: false, message: 'Could not retrieve process list' };
    }

    return { success: true, message: `Top ${count} by ${label}:\n${result.stdout}`, voiceMessage: `The top ${count} processes by ${label} are on your screen, sir.` };
  }

  private async checkPort(port: string): Promise<CommandResult> {
    const result = await run(`lsof -i :${port} -P -n 2>/dev/null | head -10`);
    if (!result.stdout || result.stdout.split('\n').length <= 1) {
      return { success: true, message: `Port ${port} is free (nothing listening)` };
    }
    return { success: true, message: `Port ${port} is in use:\n${result.stdout}` };
  }

  private async killPort(port: string): Promise<CommandResult> {
    const result = await run(`lsof -ti :${port} 2>/dev/null`);
    if (!result.stdout) {
      return { success: true, message: `Port ${port} is already free` };
    }
    const pids = result.stdout.split('\n').filter(Boolean);
    for (const pid of pids) {
      await run(`kill -9 ${pid} 2>/dev/null`);
    }
    return { success: true, message: `Killed ${pids.length} process(es) on port ${port}` };
  }

  private async findProcess(name: string): Promise<CommandResult> {
    const result = await run(`pgrep -fl "${name}" 2>/dev/null`);
    if (!result.stdout) {
      return { success: true, message: `"${name}" is not running` };
    }
    const lines = result.stdout.split('\n').filter(Boolean);
    return {
      success: true,
      message: `Found ${lines.length} process(es) matching "${name}":\n${lines.map(l => `    ${l}`).join('\n')}`,
    };
  }

  private async listProcesses(): Promise<CommandResult> {
    const result = await run('ps -Ao pid,pcpu,pmem,comm -r | head -21');
    return {
      success: true,
      message: `Running processes (top 20):\n${result.stdout}`,
      voiceMessage: 'The top running processes are on your screen, sir.',
    };
  }

  getHelp(): string {
    return [
      '  Process Manager — manage system processes',
      '    kill <name>            Kill process by name',
      '    cpu hogs               Top 5 CPU consumers',
      '    memory hogs            Top 5 memory consumers',
      '    top 10 cpu hogs        Top N CPU consumers',
      '    port <number>          Check what\'s using a port',
      '    kill port <number>     Kill process on a port',
      '    is <name> running      Check if process is running',
      '    ps                     List top processes',
    ].join('\n');
  }
}
