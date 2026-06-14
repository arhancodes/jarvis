import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { fmt } from '../utils/formatter.js';
import { isLLMAvailable, llmStreamChat, FAST_MODEL } from '../utils/llm.js';
import { createLogger } from '../utils/logger.js';
import {
  sendWhatsApp,
  recentInbound,
  waStatus,
  isWhatsAppConnected,
  repairWhatsApp,
} from '../utils/whatsapp-baileys.js';
import { resolveContactNumber, clearContactCache } from '../utils/contacts.js';

const log = createLogger('whatsapp');

// ── WhatsApp Module ──
// Sends/reads WhatsApp via the in-process Baileys socket (multi-device protocol
// over WebSocket — no browser). A send is one socket call (<1s). The connection
// is opened once at boot and persists for the session; auth is scanned once.

export class WhatsAppModule implements JarvisModule {
  name = 'whatsapp' as const;
  description = 'Send and read WhatsApp messages';

  patterns: PatternDefinition[] = [
    {
      intent: 'login',
      patterns: [
        /^whatsapp\s+(?:login|connect|setup|link|pair)$/i,
        /^(?:connect|link|setup)\s+whatsapp$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'send',
      patterns: [
        /^(?:send\s+)?(?:a\s+)?whatsapp\s+(?:to\s+)?(.+?)[\s:]+(?:saying\s+|message\s+)?["']?(.+?)["']?$/i,
        /^(?:message|text|whatsapp)\s+(.+?)\s+(?:on\s+whatsapp\s+)?(?:saying|:)\s*["']?(.+?)["']?$/i,
        /^(?:send\s+(?:a\s+)?(?:message|text)\s+(?:to\s+)?)(.+?)\s+(?:on\s+whatsapp\s+)?(?:saying|:)\s*["']?(.+?)["']?$/i,
        /^(?:tell|ask)\s+(.+?)\s+(?:on\s+whatsapp\s+)?(?:that|to|:)\s*["']?(.+?)["']?$/i,
        // "send a message to <name> on whatsapp <msg>" — strip platform specifier
        /^send\s+(?:a\s+)?(?:message|text)\s+to\s+(.+?)\s+on\s+whatsapp\s+(.+)$/i,
        /^(?:message|text)\s+(.+?)\s+on\s+whatsapp\s+(.+)$/i,
        // Simple: "message <name> <msg>" or "text <name> <msg>"
        /^(?:message|text|whatsapp)\s+(\S+)\s+["']?(.+?)["']?$/i,
        /^send\s+(?:a\s+)?(?:message|text)\s+to\s+(\S+)\s+["']?(.+?)["']?$/i,
      ],
      extract: (match) => ({
        contact: match[1].trim().replace(/\s+on\s+whatsapp$/i, '').trim(),
        message: match[2].trim().replace(/^on\s+whatsapp\s+/i, '').trim(),
      }),
    },
    {
      intent: 'read',
      patterns: [
        /^(?:read|check|show)\s+(?:my\s+)?whatsapp(?:\s+messages?)?$/i,
        /^whatsapp\s+(?:messages?|unread|inbox)$/i,
        /^(?:any|do\s+i\s+have(?:\s+any)?)\s+(?:new\s+)?(?:whatsapp\s+)?messages?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'status',
      patterns: [/^whatsapp\s+status$/i],
      extract: () => ({}),
    },
    {
      intent: 'close',
      patterns: [
        /^(?:close|disconnect)\s+whatsapp$/i,
        /^whatsapp\s+(?:close|disconnect)$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'login':   return this.login();
      case 'send':    return this.send(command.args.contact, command.args.message, command.raw);
      case 'read':    return this.read();
      case 'status':  return this.status();
      case 'close':   return this.close();
      default:
        return { success: false, message: `Unknown WhatsApp action: ${command.action}` };
    }
  }

  private async login(): Promise<CommandResult> {
    if (isWhatsAppConnected()) {
      return {
        success: true,
        message: 'WhatsApp is already connected. Send with: message <name> <message>',
      };
    }

    // Force a fresh pairing cycle — the QR prints to the JARVIS console.
    process.stdout.write(fmt.dim('  Requesting WhatsApp pairing QR...\n'));
    try {
      clearContactCache(); // a re-pair may switch accounts; drop stale lookups
      await repairWhatsApp();
      return {
        success: true,
        message: 'Scan the QR code printed in the JARVIS console with your phone (WhatsApp → Linked Devices). Auth is saved after the first scan.',
        voiceMessage: 'Scan the WhatsApp QR code in the console.',
      };
    } catch (err) {
      return { success: false, message: `WhatsApp pairing failed: ${(err as Error).message}` };
    }
  }

  /**
   * Detect if the message is a task instruction (e.g. "explaining what inflation is")
   * rather than a literal message to send. Quoted messages are always literal.
   */
  private isTaskInstruction(msg: string, raw: string): boolean {
    if (/["']/.test(raw) && (raw.includes(`"${msg}"`) || raw.includes(`'${msg}'`) || raw.includes(`"${msg}`) || raw.includes(`'${msg}`))) {
      return false;
    }
    return /^(?:explaining|telling|describing|asking|summarizing|informing|writing|reminding|updating|letting|giving|sending|sharing|forwarding|congratulating|thanking|apologizing|inviting|notifying|warning|complimenting)/i.test(msg);
  }

  private async send(contact: string, message: string, raw: string): Promise<CommandResult> {
    if (!contact || !message) {
      return { success: false, message: 'Usage: send whatsapp to <contact>: <message>' };
    }

    if (!isWhatsAppConnected()) {
      return {
        success: false,
        message: 'WhatsApp is not connected. Run "whatsapp login" and scan the QR code first.',
      };
    }

    // Resolve the contact to a number FIRST so a resolution failure short-circuits
    // cheaply — before spending a (multi-second) LLM compose call.
    const number = await resolveContactNumber(contact);
    if (!number) {
      return {
        success: false,
        message: `Could not find a phone number for "${contact}". Add it to config/whatsapp-contacts.json (e.g. {"${contact}": "+1234567890"}) or save it in macOS Contacts.`,
      };
    }

    // Smart message: if it looks like a task instruction, compose with the fast model.
    let finalMessage = message;
    if (this.isTaskInstruction(message, raw)) {
      try {
        if (await isLLMAvailable()) {
          process.stdout.write(fmt.dim('  Composing message...\n'));
          const prompt = `Write a short, casual WhatsApp message to ${contact} that does the following: ${message}.\nOutput ONLY the message text. No quotes, no labels, no explanation.`;
          const generated = await llmStreamChat(
            [{ role: 'user', content: prompt }],
            'You are a helpful assistant.',
            () => {},
            { model: FAST_MODEL },
          );
          if (generated?.trim()) {
            finalMessage = generated.trim();
            console.log(fmt.dim(`  [composed] "${finalMessage}"`));
          }
        }
      } catch (err) {
        log.debug('AI not available for message composition, sending literally', err);
      }
    }

    try {
      await sendWhatsApp(number, finalMessage);
      return {
        success: true,
        message: `WhatsApp message sent to ${contact}: "${finalMessage}"`,
        voiceMessage: `Message sent to ${contact}.`,
      };
    } catch (err) {
      return { success: false, message: `Failed to send WhatsApp: ${(err as Error).message}` };
    }
  }

  private async read(): Promise<CommandResult> {
    if (!isWhatsAppConnected()) {
      return {
        success: false,
        message: 'WhatsApp is not connected. Run "whatsapp login" and scan the QR code first.',
      };
    }

    const msgs = recentInbound(24, 10);
    if (msgs.length === 0) {
      return { success: true, message: 'No recent WhatsApp messages.', voiceMessage: 'No new WhatsApp messages.' };
    }

    const lines = msgs.map((m) => {
      const who = m.pushName || m.from.replace(/@.*/, '');
      return `  ${who}: ${m.text.slice(0, 120)}`;
    });

    const senders = [...new Set(msgs.map((m) => m.pushName || m.from.replace(/@.*/, '')))];
    const voiceMsg = `You have ${msgs.length} recent WhatsApp message${msgs.length === 1 ? '' : 's'} from ${senders.slice(0, 3).join(', ')}.`;

    return {
      success: true,
      message: `Recent WhatsApp messages:\n\n${lines.join('\n')}`,
      voiceMessage: voiceMsg,
    };
  }

  private async status(): Promise<CommandResult> {
    const s = waStatus();
    const human: Record<string, string> = {
      idle: 'Not started.',
      connecting: 'Connecting...',
      qr: 'Waiting for QR scan — check the console.',
      open: 'Connected.',
      closed: 'Disconnected (will auto-reconnect).',
    };
    return { success: true, message: `WhatsApp: ${human[s.state] ?? s.state}` };
  }

  private async close(): Promise<CommandResult> {
    // The Baileys socket is meant to live for the whole session; there's no
    // browser to close. Report state rather than tearing down the connection.
    return {
      success: true,
      message: 'WhatsApp runs over a persistent connection — nothing to close. Session stays linked.',
    };
  }

  getHelp(): string {
    return [
      '  WhatsApp',
      '    whatsapp login              Connect WhatsApp (scan QR in console)',
      '    send whatsapp to <name>: <msg>  Send a message (instant)',
      '    whatsapp <name>: <msg>      Send (shorthand)',
      '    read whatsapp               Show recent messages',
      '    whatsapp status             Connection status',
    ].join('\n');
  }
}
