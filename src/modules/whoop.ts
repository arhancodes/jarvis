import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { isWhoopConfigured, hasWhoopCredentials, whoopConnect, getRecovery, getSleep, getStrain } from '../utils/whoop.js';

// ── WHOOP Module ──
// Voice/text access to your WHOOP recovery, sleep and strain via the v2 API.
//   "how's my recovery" · "how did I sleep" · "what's my strain" ·
//   "whoop" / "how's my body" · "should I train today"

export class WhoopModule implements JarvisModule {
  name = 'whoop' as const;
  description = 'WHOOP recovery, sleep and strain — ask how recovered/rested you are';

  patterns: PatternDefinition[] = [
    {
      intent: 'recovery',
      patterns: [
        /^(?:what(?:'?s| is)\s+)?(?:my\s+)?recovery(?:\s+(?:score|today|like))?[?]?$/i,
        /^how\s+(?:recovered|rested)\s+am\s+i[?]?$/i,
        /^(?:am\s+i\s+recovered|how(?:'?s| is)\s+(?:my\s+)?recovery)[?]?$/i,
        /^whoop\s+recovery$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'sleep',
      patterns: [
        /^how\s+did\s+i\s+sleep(?:\s+(?:last\s+night|today))?[?]?$/i,
        /^(?:what(?:'?s| is)\s+)?(?:my\s+)?sleep(?:\s+(?:score|performance|last\s+night))?[?]?$/i,
        /^how(?:'?s| was)\s+(?:my\s+)?sleep[?]?$/i,
        /^whoop\s+sleep$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'strain',
      patterns: [
        /^(?:what(?:'?s| is)\s+)?(?:my\s+)?strain(?:\s+(?:score|today))?[?]?$/i,
        /^how\s+(?:much\s+)?strain(?:\s+have\s+i\s+(?:got|had))?[?]?$/i,
        /^whoop\s+strain$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'should-train',
      patterns: [
        /^should\s+i\s+(?:work\s*out|train|exercise|hit\s+the\s+gym|push\s+(?:hard|it))(?:\s+today)?[?]?$/i,
        /^(?:can|am\s+i\s+(?:good|ok|okay)\s+to)\s+(?:work\s*out|train|exercise)(?:\s+today)?[?]?$/i,
        /^how\s+hard\s+(?:can|should)\s+i\s+(?:go|push|train)(?:\s+today)?[?]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'connect',
      patterns: [
        /^(?:connect|link|authorize|auth|login\s+to|reconnect)\s+whoop$/i,
        /^whoop\s+(?:connect|login|auth(?:orize)?|reconnect)$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'status',
      patterns: [
        /^whoop(?:\s+status)?$/i,
        /^how(?:'?s| is)\s+my\s+body(?:\s+(?:doing|today))?[?]?$/i,
        /^(?:my\s+)?(?:body|biometrics?)\s+status$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    if (command.action === 'connect') return this.connect();

    if (!isWhoopConfigured()) {
      const hint = hasWhoopCredentials()
        ? 'Say “connect whoop” to authorize (opens your browser).'
        : 'Add client_id and client_secret to config/whoop.json first.';
      return {
        success: false,
        message: `WHOOP isn’t connected. ${hint}`,
        voiceMessage: hasWhoopCredentials() ? 'WHOOP needs reconnecting — say connect whoop, sir.' : 'WHOOP isn’t set up yet, sir.',
      };
    }
    try {
      switch (command.action) {
        case 'recovery':     return await this.recovery();
        case 'sleep':        return await this.sleep();
        case 'strain':       return await this.strain();
        case 'should-train': return await this.shouldTrain();
        case 'status':       return await this.status();
        default:             return { success: false, message: `Unknown WHOOP action: ${command.action}` };
      }
    } catch (err) {
      const msg = (err as Error).message;
      // Expired/invalid refresh token -> guide the user to re-authorize.
      if (/refresh failed|HTTP 400|HTTP 401|invalid_grant|invalid_request/i.test(msg)) {
        return {
          success: false,
          message: 'WHOOP needs reauthorizing (token expired). Say “connect whoop” to reconnect.',
          voiceMessage: 'WHOOP needs reconnecting, sir — say connect whoop.',
        };
      }
      return { success: false, message: `WHOOP error: ${msg}`, voiceMessage: 'I couldn’t reach WHOOP just now, sir.' };
    }
  }

  private async connect(): Promise<CommandResult> {
    if (!hasWhoopCredentials()) {
      return { success: false, message: 'Add your WHOOP client_id and client_secret to config/whoop.json first.' };
    }
    try {
      const msg = await whoopConnect();
      return { success: true, message: `✅ ${msg} Try “how's my recovery”.`, voiceMessage: 'WHOOP is connected, sir.' };
    } catch (err) {
      return { success: false, message: `WHOOP connect failed: ${(err as Error).message}`, voiceMessage: 'WHOOP authorization didn’t complete, sir.' };
    }
  }

  private async recovery(): Promise<CommandResult> {
    const r = await getRecovery();
    if (!r) return { success: true, message: 'No scored recovery yet today.', voiceMessage: 'No recovery score yet today, sir.' };
    const band = r.recovery >= 67 ? 'green — well recovered' : r.recovery >= 34 ? 'yellow — moderate' : 'red — take it easy';
    const extra = [r.hrv != null ? `HRV ${r.hrv}ms` : '', r.rhr != null ? `RHR ${r.rhr}bpm` : ''].filter(Boolean).join(', ');
    return {
      success: true,
      message: `❤️ Recovery: ${r.recovery}% (${band})${extra ? `\n  ${extra}` : ''}`,
      voiceMessage: `Your recovery is ${r.recovery} percent, ${band}.${r.hrv != null ? ` HRV ${r.hrv} milliseconds.` : ''}`,
    };
  }

  private async sleep(): Promise<CommandResult> {
    const s = await getSleep();
    if (!s) return { success: true, message: 'No scored sleep yet.', voiceMessage: 'No sleep score yet, sir.' };
    const parts = [
      s.performance != null ? `${s.performance}% performance` : '',
      s.hours != null ? `${s.hours}h in bed` : '',
      s.efficiency != null ? `${s.efficiency}% efficiency` : '',
    ].filter(Boolean);
    return {
      success: true,
      message: `😴 Sleep: ${parts.join(', ')}`,
      voiceMessage: `You slept ${s.hours != null ? `${s.hours} hours` : ''}${s.performance != null ? ` at ${s.performance} percent performance` : ''}, sir.`,
    };
  }

  private async strain(): Promise<CommandResult> {
    const s = await getStrain();
    if (s?.strain == null) return { success: true, message: 'No scored strain yet today.', voiceMessage: 'No strain score yet today, sir.' };
    const band = s.strain >= 18 ? 'all-out' : s.strain >= 14 ? 'strenuous' : s.strain >= 10 ? 'moderate' : 'light';
    return {
      success: true,
      message: `💪 Day strain: ${s.strain} (${band})`,
      voiceMessage: `Your day strain is ${s.strain}, ${band}.`,
    };
  }

  private async shouldTrain(): Promise<CommandResult> {
    const r = await getRecovery();
    if (!r) return { success: true, message: 'No recovery score yet to advise on.', voiceMessage: 'I don’t have a recovery score yet, sir.' };
    let advice: string;
    if (r.recovery >= 67) advice = `You’re ${r.recovery}% recovered — green. Good to push hard today, sir.`;
    else if (r.recovery >= 34) advice = `You’re ${r.recovery}% recovered — yellow. Moderate effort today; don’t redline it.`;
    else advice = `You’re only ${r.recovery}% recovered — red. I’d keep it light or rest today, sir.`;
    return { success: true, message: `❤️ ${advice}`, voiceMessage: advice };
  }

  private async status(): Promise<CommandResult> {
    // Pull all three in parallel for a quick body briefing.
    const [r, s, st] = await Promise.all([
      getRecovery().catch(() => null),
      getSleep().catch(() => null),
      getStrain().catch(() => null),
    ]);
    const lines: string[] = [];
    if (r) lines.push(`❤️ Recovery ${r.recovery}%${r.hrv != null ? ` (HRV ${r.hrv}ms)` : ''}`);
    if (s && s.performance != null) lines.push(`😴 Sleep ${s.performance}%${s.hours != null ? ` / ${s.hours}h` : ''}`);
    if (st && st.strain != null) lines.push(`💪 Strain ${st.strain}`);
    if (lines.length === 0) return { success: true, message: 'No scored WHOOP data yet today.', voiceMessage: 'No WHOOP data yet today, sir.' };
    const voice = [
      r ? `recovery ${r.recovery} percent` : '',
      s && s.performance != null ? `sleep ${s.performance} percent` : '',
      st && st.strain != null ? `strain ${st.strain}` : '',
    ].filter(Boolean).join(', ');
    return { success: true, message: lines.join('\n'), voiceMessage: `Here’s your body, sir: ${voice}.` };
  }

  getHelp(): string {
    return [
      '  WHOOP — recovery, sleep & strain',
      '    recovery / how recovered am I   Today’s recovery %, HRV, RHR',
      '    how did I sleep                 Sleep performance & hours',
      '    strain / what’s my strain       Day strain',
      '    should I train today            Advice from your recovery',
      '    whoop / how’s my body           Combined briefing',
    ].join('\n');
  }
}
