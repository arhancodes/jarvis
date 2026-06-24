/**
 * Execution-verification harness. Unlike trace-route (routing only), this
 * actually PARSES then EXECUTES each command end-to-end and checks the real
 * CommandResult — proving behavior, not just routing.
 *
 * Side effects are gated: a command is only executed if its routed module:action
 * is on the read-only SAFE_INTENTS allowlist. Anything else is reported as
 * "skipped (not safe to auto-run)" with its routing, so we never send a message,
 * kill a process, launch an app, or change system state during verification.
 *
 * For each executed command it reports voice-safety: a result whose spoken text
 * would exceed 320 chars / 4 lines WITHOUT a voiceMessage is flagged
 * voiceWouldDump=true (the class of bug where JARVIS reads a whole list aloud).
 *
 * Usage:
 *   echo '["battery","cpu","10 miles to km","ps","how are you"]' | tsx tools/exec-verify.ts --stdin
 */
import './_register-modules.js';
import { parse } from '../src/core/parser.js';
import { execute } from '../src/core/executor.js';

// Read-only intents that are safe to execute automatically during verification.
const SAFE_INTENTS = new Set<string>([
  // system-monitor — all read-only
  'system-monitor:battery', 'system-monitor:cpu', 'system-monitor:memory',
  'system-monitor:disk', 'system-monitor:network', 'system-monitor:uptime',
  'system-monitor:all-stats', 'system-monitor:stats', 'system-monitor:temperature',
  // process-manager — read-only subset (NOT kill-*)
  'process-manager:list-processes', 'process-manager:top-cpu',
  'process-manager:top-memory', 'process-manager:find-process',
  'process-manager:port-check',
  // conversions — pure math + read-only live-rate / clock lookups
  'conversions:unit', 'conversions:currency', 'conversions:timezone',
  'conversions:calculate', 'conversions:math', 'conversions:current-time',
  // personality — banter + local time, read-only
  'personality:mood', 'personality:greeting', 'personality:identity',
  'personality:thanks', 'personality:capabilities', 'personality:joke',
  'personality:time', 'personality:date',
  // ai status — read-only
  'ai-chat:ai-status',
  // clipboard read
  'clipboard:get', 'clipboard:read', 'clipboard:show',
]);

function voiceText(r: any): string {
  if (r.voiceMessage) return r.voiceMessage;
  if (r.streamed) return '(streamed to screen)';
  return r.message || '';
}

async function main() {
  let inputs: string[] = [];
  if (process.argv.includes('--stdin')) {
    const raw = await new Promise<string>((res) => {
      let buf = '';
      process.stdin.on('data', (d) => (buf += d));
      process.stdin.on('end', () => res(buf));
    });
    try { inputs = JSON.parse(raw); } catch { inputs = raw.split('\n').filter(Boolean); }
  } else {
    inputs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  }

  const out: any[] = [];
  for (const input of inputs) {
    const cmd = await parse(input);
    if (!cmd) {
      out.push({ input, routed: null, executed: false, note: 'no match → conversation AI (Claude)' });
      continue;
    }
    const key = `${cmd.module}:${cmd.action}`;
    if (!SAFE_INTENTS.has(key)) {
      out.push({ input, routed: key, args: cmd.args, executed: false, note: 'skipped (not on read-only allowlist)' });
      continue;
    }
    try {
      const r = await execute(cmd);
      const spoken = voiceText(r);
      const lineCount = (r.message || '').split('\n').length;
      const wouldDump = !r.voiceMessage && !r.streamed && ((r.message || '').length > 320 || lineCount > 4);
      out.push({
        input,
        routed: key,
        executed: true,
        success: r.success,
        hasVoiceMessage: !!r.voiceMessage,
        msgChars: (r.message || '').length,
        msgLines: lineCount,
        voiceWouldDump: wouldDump,
        spokenPreview: spoken.slice(0, 140),
      });
    } catch (e) {
      out.push({ input, routed: key, executed: true, success: false, error: (e as Error).message });
    }
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}

main();
