import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { run } from '../utils/shell.js';
import { fmt } from '../utils/formatter.js';

interface ActiveTimer {
  id: number;
  label: string;
  endsAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

let nextId = 1;
const activeTimers: Map<number, ActiveTimer> = new Map();

function parseTimeString(str: string): number | null {
  // "5 min", "30 seconds", "1 hour", "1h30m", "90s", "2.5 hours", "1:30",
  // "an hour", "a minute" (article -> 1)
  const s = str.toLowerCase().trim()
    .replace(/\b(?:an?|one)\s+(hour|hr|min(?:ute)?|sec(?:ond)?)/gi, '1 $1');

  // Handle "1:30" format (min:sec)
  const colonMatch = s.match(/^(\d+):(\d+)$/);
  if (colonMatch) {
    return parseInt(colonMatch[1], 10) * 60 + parseInt(colonMatch[2], 10);
  }

  // Handle compound "1h30m", "1h 30m", "2m30s"
  let totalSeconds = 0;
  const compoundRegex = /(\d+(?:\.\d+)?)\s*(h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)/gi;
  let compoundMatch;
  let foundAny = false;
  while ((compoundMatch = compoundRegex.exec(s)) !== null) {
    foundAny = true;
    const val = parseFloat(compoundMatch[1]);
    const unit = compoundMatch[2].charAt(0).toLowerCase();
    if (unit === 'h') totalSeconds += val * 3600;
    else if (unit === 'm') totalSeconds += val * 60;
    else totalSeconds += val;
  }
  if (foundAny) return Math.round(totalSeconds);

  // Handle bare number (assume minutes)
  const bareNum = s.match(/^(\d+(?:\.\d+)?)$/);
  if (bareNum) return Math.round(parseFloat(bareNum[1]) * 60);

  return null;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function notifyUser(title: string, message: string): void {
  // macOS notification + terminal bell
  run(`osascript -e 'display notification "${message}" with title "${title}" sound name "Glass"'`);
  process.stdout.write('\x07'); // terminal bell
  console.log(`\n${fmt.banner(`  🔔 ${title}`)}`);
  console.log(fmt.success(message));
  console.log(fmt.prompt());
}

export class TimerModule implements JarvisModule {
  name = 'timer' as const;
  description = 'Set timers, countdowns, and reminders with macOS notifications';

  patterns: PatternDefinition[] = [
    // ── Timer ──
    {
      intent: 'set-timer',
      patterns: [
        /^(?:set\s+)?(?:a\s+)?timer\s+(?:for\s+)?(.+)/i,
        /^countdown\s+(.+)/i,
      ],
      extract: (match) => ({ time: match[1].trim() }),
    },
    // ── Reminder (duration, time-first): "remind me in 5 min to call mom" ──
    {
      intent: 'set-reminder',
      patterns: [
        /^remind\s+(?:me\s+)?in\s+(.+?)\s+(?:to\s+)(.+)/i,
        /^reminder\s+in\s+(.+?)\s+(?:to\s+)(.+)/i,
      ],
      extract: (match) => ({ time: match[1].trim(), message: match[2].trim() }),
    },
    // ── Reminder (duration, message-first): "remind me to call mom in 20 minutes" ──
    {
      intent: 'set-reminder',
      patterns: [
        /^remind\s+(?:me\s+)?(?:to\s+)?(.+?)\s+in\s+(\d+(?:\.\d+)?\s*(?:h(?:ours?|rs?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)|(?:an?|one)\s+(?:hour|minute|min|second|sec))$/i,
        /^(?:set\s+)?(?:a\s+)?reminder\s+(?:to\s+)?(.+?)\s+in\s+(\d+(?:\.\d+)?\s*(?:h(?:ours?|rs?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)|(?:an?|one)\s+(?:hour|minute|min|second|sec))$/i,
      ],
      extract: (match) => ({ time: match[2].trim(), message: match[1].trim() }),
    },
    // ── Reminder at specific time: "remind me at 4:45 to join class" ──
    {
      intent: 'set-reminder-at',
      patterns: [
        /^remind\s+(?:me\s+)?at\s+(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\s+(?:to\s+)(.+)/i,
        /^(?:set\s+)?(?:a\s+)?reminder\s+(?:at\s+|for\s+)?(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\s+(?:to\s+)(.+)/i,
        // message-first: "remind me to submit the report at 4pm"
        /^remind\s+(?:me\s+)?to\s+(.+?)\s+at\s+(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))$/i,
        /^(?:set\s+)?(?:a\s+)?reminder\s+(?:at\s+|for\s+)?(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))$/i,
      ],
      extract: (match, raw) => {
        // The message-first pattern captures (message, time); the others (time, message).
        if (/^remind\s+(?:me\s+)?to\b/i.test(raw) && /\bat\s+\d/i.test(raw)) {
          return { time: match[2].trim(), message: match[1].trim() };
        }
        return { time: match[1].trim(), message: match[2]?.trim() || '' };
      },
    },
    // ── Alarm (fixed time) ──
    {
      intent: 'set-alarm',
      patterns: [
        /^(?:set\s+)?(?:an?\s+)?alarm\s+(?:for\s+|at\s+)?(\d{1,2}:\d{2}\s*(?:am|pm)?)/i,
        /^wake\s+(?:me\s+)?(?:up\s+)?(?:at\s+)?(\d{1,2}:\d{2}\s*(?:am|pm)?)/i,
      ],
      extract: (match) => ({ time: match[1].trim() }),
    },
    // ── Stopwatch ──
    {
      intent: 'stopwatch-start',
      patterns: [
        /^(?:start\s+)?stopwatch/i,
      ],
      extract: () => ({}),
    },
    // ── List / Cancel ──
    {
      intent: 'list-timers',
      patterns: [
        /^(?:list|show|active)\s+timers/i,
        /^timers$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'cancel-timer',
      patterns: [
        /^(?:cancel|stop|clear|remove)\s+timer\s+(?:#?\s*)?(\d+)/i,
        /^(?:cancel|stop|clear)\s+(?:all\s+)?timers$/i,
      ],
      extract: (match) => ({ id: match[1] || 'all' }),
    },
  ];

  private stopwatchStart: number | null = null;

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'set-timer': return this.setTimer(command.args.time);
      case 'set-reminder': return this.setReminder(command.args.time, command.args.message);
      case 'set-reminder-at': return this.setReminderAt(command.args.time, command.args.message);
      case 'set-alarm': return this.setAlarm(command.args.time);
      case 'stopwatch-start': return this.startStopwatch();
      case 'list-timers': return this.listTimers();
      case 'cancel-timer': return this.cancelTimer(command.args.id);
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private setTimer(timeStr: string): CommandResult {
    const seconds = parseTimeString(timeStr);
    if (!seconds || seconds <= 0) {
      return { success: false, message: `Could not parse time: "${timeStr}". Try "5 min", "30s", "1h30m", etc.` };
    }

    const id = nextId++;
    const label = `Timer #${id}`;
    const endsAt = Date.now() + seconds * 1000;

    const timeout = setTimeout(() => {
      notifyUser('⏰ Timer Done!', `${label} — ${formatDuration(seconds)} elapsed!`);
      activeTimers.delete(id);
    }, seconds * 1000);

    activeTimers.set(id, { id, label, endsAt, timeout });

    return {
      success: true,
      message: `${label} set for ${formatDuration(seconds)} (fires at ${new Date(endsAt).toLocaleTimeString()})`,
    };
  }

  private setReminder(timeStr: string, message: string): CommandResult {
    const seconds = parseTimeString(timeStr);
    if (!seconds || seconds <= 0) {
      return { success: false, message: `Could not parse time: "${timeStr}". Try "5 min", "1 hour", etc.` };
    }

    const id = nextId++;
    const label = `Reminder #${id}`;
    const endsAt = Date.now() + seconds * 1000;

    const timeout = setTimeout(() => {
      notifyUser('📝 Reminder', message);
      activeTimers.delete(id);
    }, seconds * 1000);

    activeTimers.set(id, { id, label: `${label}: ${message}`, endsAt, timeout });

    return {
      success: true,
      message: `${label} set: "${message}" in ${formatDuration(seconds)} (at ${new Date(endsAt).toLocaleTimeString()})`,
    };
  }

  private setReminderAt(timeStr: string, message: string): CommandResult {
    // Parse absolute time: "4:45", "4:45 pm", "16:30", "4pm", "4 pm"
    const match = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!match) {
      return { success: false, message: `Could not parse time: "${timeStr}". Try "4:45 pm" or "16:00".` };
    }

    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2] ?? '0', 10);
    const ampm = match[3]?.toLowerCase();

    if (ampm === 'pm' && hours !== 12) hours += 12;
    else if (ampm === 'am' && hours === 12) hours = 0;
    else if (!ampm && hours >= 1 && hours <= 12) {
      // No AM/PM specified — pick the nearest future interpretation
      const now = new Date();
      const amTarget = new Date(now);
      amTarget.setHours(hours, minutes, 0, 0);
      const pmTarget = new Date(now);
      pmTarget.setHours(hours === 12 ? 12 : hours + 12, minutes, 0, 0);

      const amFuture = amTarget.getTime() > now.getTime();
      const pmFuture = pmTarget.getTime() > now.getTime();

      if (pmFuture && !amFuture) {
        hours = hours === 12 ? 12 : hours + 12; // PM is next
      } else if (amFuture && !pmFuture) {
        // AM is next, keep hours as-is
      } else if (amFuture && pmFuture) {
        // Both future — pick whichever is sooner (AM)
      } else {
        // Both past — next AM (tomorrow)
      }
    }

    const now = new Date();
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);

    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    const diffMs = target.getTime() - now.getTime();
    const diffSec = Math.round(diffMs / 1000);
    const id = nextId++;
    const label = `Reminder #${id}`;
    const msg = message || `Reminder at ${timeStr}`;

    const timeout = setTimeout(() => {
      notifyUser('📝 Reminder', msg);
      activeTimers.delete(id);
    }, diffMs);

    activeTimers.set(id, { id, label: `${label}: ${msg}`, endsAt: target.getTime(), timeout });

    return {
      success: true,
      message: `${label} set for ${target.toLocaleTimeString()}: "${msg}" (in ${formatDuration(diffSec)})`,
      voiceMessage: `Reminder set for ${target.toLocaleTimeString()}. ${msg}.`,
    };
  }

  private setAlarm(timeStr: string): CommandResult {
    // Parse "3:30 pm", "14:00", "7:00am"
    const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
    if (!match) {
      return { success: false, message: `Could not parse time: "${timeStr}". Try "3:30 pm" or "14:00".` };
    }

    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const ampm = match[3]?.toLowerCase();

    if (ampm === 'pm' && hours !== 12) hours += 12;
    else if (ampm === 'am' && hours === 12) hours = 0;
    else if (!ampm && hours >= 1 && hours <= 12) {
      // No AM/PM specified — pick the nearest future interpretation
      const now = new Date();
      const amTarget = new Date(now);
      amTarget.setHours(hours, minutes, 0, 0);
      const pmTarget = new Date(now);
      pmTarget.setHours(hours === 12 ? 12 : hours + 12, minutes, 0, 0);

      const amFuture = amTarget.getTime() > now.getTime();
      const pmFuture = pmTarget.getTime() > now.getTime();

      if (pmFuture && !amFuture) {
        hours = hours === 12 ? 12 : hours + 12;
      } else if (amFuture && !pmFuture) {
        // AM is next, keep hours as-is
      } else if (amFuture && pmFuture) {
        // Both future — pick whichever is sooner (AM)
      } else {
        // Both past — next AM (tomorrow)
      }
    }

    const now = new Date();
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);

    // If the time has passed today, set for tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    const diffMs = target.getTime() - now.getTime();
    const diffSec = Math.round(diffMs / 1000);

    const id = nextId++;
    const label = `Alarm #${id}`;

    const timeout = setTimeout(() => {
      notifyUser('⏰ ALARM!', `Alarm for ${timeStr}!`);
      // Play sound repeatedly
      run('for i in 1 2 3; do afplay /System/Library/Sounds/Glass.aiff; done');
      activeTimers.delete(id);
    }, diffMs);

    activeTimers.set(id, { id, label, endsAt: target.getTime(), timeout });

    return {
      success: true,
      message: `${label} set for ${target.toLocaleTimeString()} (in ${formatDuration(diffSec)})`,
    };
  }

  private startStopwatch(): CommandResult {
    if (this.stopwatchStart !== null) {
      const elapsed = Math.round((Date.now() - this.stopwatchStart) / 1000);
      this.stopwatchStart = null;
      return { success: true, message: `Stopwatch stopped — elapsed: ${formatDuration(elapsed)}` };
    }
    this.stopwatchStart = Date.now();
    return { success: true, message: 'Stopwatch started! Type "stopwatch" again to stop.' };
  }

  private listTimers(): CommandResult {
    if (activeTimers.size === 0 && this.stopwatchStart === null) {
      return { success: true, message: 'No active timers.' };
    }

    const lines: string[] = [];

    for (const timer of activeTimers.values()) {
      const remaining = Math.max(0, Math.round((timer.endsAt - Date.now()) / 1000));
      lines.push(`    #${timer.id}  ${timer.label}  —  ${formatDuration(remaining)} remaining`);
    }

    if (this.stopwatchStart !== null) {
      const elapsed = Math.round((Date.now() - this.stopwatchStart) / 1000);
      lines.push(`    ⏱  Stopwatch running — ${formatDuration(elapsed)} elapsed`);
    }

    return { success: true, message: `Active timers:\n${lines.join('\n')}` };
  }

  private cancelTimer(idStr: string): CommandResult {
    if (idStr === 'all') {
      for (const timer of activeTimers.values()) {
        clearTimeout(timer.timeout);
      }
      const count = activeTimers.size;
      activeTimers.clear();
      return { success: true, message: `Cancelled ${count} timer(s)` };
    }

    const id = parseInt(idStr, 10);
    const timer = activeTimers.get(id);
    if (!timer) {
      return { success: false, message: `Timer #${id} not found` };
    }

    clearTimeout(timer.timeout);
    activeTimers.delete(id);
    return { success: true, message: `Cancelled ${timer.label}` };
  }

  getHelp(): string {
    return [
      '  Timers & Reminders — time-based automation',
      '    timer <duration>             Set a timer (e.g. "timer 5 min", "timer 1h30m")',
      '    remind me in <t> to <msg>    Set a reminder with message',
      '    remind me at <time> to <msg> Reminder at specific time',
      '    set reminder at 4:45         Reminder at a clock time',
      '    alarm <time>                 Set alarm (e.g. "alarm 7:00 am")',
      '    stopwatch                    Start/stop a stopwatch',
      '    timers                       List active timers',
      '    cancel timer <#>             Cancel a specific timer',
      '    cancel all timers            Cancel all timers',
    ].join('\n');
  }
}
