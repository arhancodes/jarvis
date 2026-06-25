import * as os from 'os';
import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { run } from '../utils/shell.js';
import { fmt } from '../utils/formatter.js';

export class SystemMonitorModule implements JarvisModule {
  name = 'system-monitor' as const;
  description = 'Display CPU, memory, disk, battery, and network information';

  patterns: PatternDefinition[] = [
    {
      intent: 'cpu',
      patterns: [
        /^(?:show |check |get )?cpu(?:\s+usage)?$/i,
        /^(?:how(?:'?s| is) (?:the )?)?cpu$/i,
        /^processor$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'memory',
      patterns: [
        /^(?:show |check |get )?(?:memory|mem|ram)(?:\s+usage)?$/i,
        /^(?:how much )?(?:memory|ram)$/i,
        /^(?:is\s+)?(?:my\s+)?(?:laptop|computer|mac|machine|system)\s+(?:running\s+)?(?:low\s+on|out\s+of|short\s+on)\s+(?:memory|ram)/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'disk',
      patterns: [
        /^(?:show |check |get )?disk(?:\s+(?:space|usage))?$/i,
        /^(?:how much )?(?:disk|storage)$/i,
        /^(?:free )?space$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'battery',
      patterns: [
        /^(?:show |check |get )?battery$/i,
        /^(?:how(?:'?s| is) (?:the )?)?battery$/i,
        /^power\s*(?:status)?$/i,
        /^charge$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'network',
      patterns: [
        /^(?:show |check |get )?network$/i,
        /^(?:what(?:'?s| is) )?(?:my )?ip$/i,
        /^(?:show |check )?wifi$/i,
        /^connectivity$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'all',
      patterns: [
        /^(?:system )?(?:status|info|overview|stats)$/i,
        /^(?:show |give me )?(?:a )?(?:full )?(?:system )?report$/i,
        /^how(?:'?s| is)\s+(?:the\s+)?(?:system|computer|machine|laptop|mac)(?:\s+(?:doing|running|holding\s+up))?[?]?$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'cpu': return this.getCpu();
      case 'memory': return this.getMemory();
      case 'disk': return this.getDisk();
      case 'battery': return this.getBattery();
      case 'network': return this.getNetwork();
      case 'all': return this.getAll();
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private async getCpu(): Promise<CommandResult> {
    const cpus = os.cpus();
    const model = cpus[0]?.model ?? 'Unknown';
    const cores = cpus.length;

    const result = await run("top -l 1 -n 0 -s 0 | grep 'CPU usage'");
    let usage = 'Could not read CPU usage';
    if (result.stdout) {
      usage = result.stdout.replace('CPU usage:', '').trim();
    }

    const msg = [
      fmt.label('CPU', model),
      fmt.label('Cores', String(cores)),
      fmt.label('Usage', usage),
    ].join('\n');
    return { success: true, message: msg };
  }

  private async getMemory(): Promise<CommandResult> {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const pct = ((used / total) * 100).toFixed(1);

    const toGB = (b: number) => (b / 1024 / 1024 / 1024).toFixed(1);

    const msg = [
      fmt.label('Total', `${toGB(total)} GB`),
      fmt.label('Used', `${toGB(used)} GB (${pct}%)`),
      fmt.label('Free', `${toGB(free)} GB`),
    ].join('\n');
    return { success: true, message: msg };
  }

  private async getDisk(): Promise<CommandResult> {
    const result = await run('df -h /');
    if (!result.stdout) {
      return { success: false, message: 'Could not read disk info' };
    }

    const lines = result.stdout.split('\n');
    if (lines.length < 2) {
      return { success: false, message: 'Unexpected df output' };
    }

    const parts = lines[1].split(/\s+/);
    const [, size, used, avail, capacity] = parts;

    const msg = [
      fmt.label('Total', size),
      fmt.label('Used', `${used} (${capacity})`),
      fmt.label('Available', avail),
    ].join('\n');
    return { success: true, message: msg };
  }

  private async getBattery(): Promise<CommandResult> {
    const result = await run('pmset -g batt');
    if (!result.stdout) {
      return { success: false, message: 'Could not read battery info (desktop Mac?)' };
    }

    const pctMatch = result.stdout.match(/(\d+)%/);
    const stateMatch = result.stdout.match(/; (charging|discharging|charged|finishing charge)/i);
    const timeMatch = result.stdout.match(/(\d+:\d+) remaining/);

    const pct = pctMatch ? pctMatch[1] + '%' : 'Unknown';
    const state = stateMatch ? stateMatch[1] : 'Unknown';
    const remaining = timeMatch ? timeMatch[1] : 'N/A';

    const msg = [
      fmt.label('Battery', pct),
      fmt.label('State', state),
      fmt.label('Remaining', remaining),
    ].join('\n');
    return { success: true, message: msg };
  }

  private async getNetwork(): Promise<CommandResult> {
    // Find the actual WiFi interface dynamically (not always en0 on newer Macs)
    const ipResult = await run("ifconfig | grep 'inet ' | grep -v 127.0.0.1 | head -1 | awk '{print $2}' 2>/dev/null || echo 'Not connected'");
    const wifiIfResult = await run("networksetup -listallhardwareports | awk '/Wi-Fi/{getline; print $2}' 2>/dev/null || echo 'en0'");
    const wifiIf = wifiIfResult.stdout?.trim() || 'en0';
    const wifiResult = await run(`networksetup -getairportnetwork ${wifiIf} 2>/dev/null || echo 'No WiFi'`);

    const ip = ipResult.stdout || 'Not connected';
    const wifiLine = wifiResult.stdout;
    const ssid = wifiLine.includes('Current Wi-Fi Network')
      ? wifiLine.split(': ').slice(1).join(': ').trim()
      : wifiLine.includes('You are not associated')
        ? 'Not connected'
        : wifiLine;

    const msg = [
      fmt.label('Local IP', ip),
      fmt.label('WiFi', ssid),
    ].join('\n');
    return { success: true, message: msg };
  }

  private async getAll(): Promise<CommandResult> {
    const [cpu, memory, disk, battery, network] = await Promise.all([
      this.getCpu(), this.getMemory(), this.getDisk(),
      this.getBattery(), this.getNetwork(),
    ]);

    const sections = [
      fmt.heading('CPU'), cpu.message,
      fmt.heading('Memory'), memory.message,
      fmt.heading('Disk'), disk.message,
      fmt.heading('Battery'), battery.message,
      fmt.heading('Network'), network.message,
    ].join('\n');

    return { success: true, message: `\n${fmt.banner('  ─── JARVIS SYSTEM REPORT ───')}\n${sections}` };
  }

  getHelp(): string {
    return [
      '  System Monitor — system information',
      '    cpu              Show CPU info and usage',
      '    memory / ram     Show memory usage',
      '    disk / space     Show disk usage',
      '    battery          Show battery status',
      '    network / ip     Show network info',
      '    status           Full system report',
    ].join('\n');
  }
}
