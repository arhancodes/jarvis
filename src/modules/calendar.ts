import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { llmStreamChat } from '../utils/llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = join(__dirname, '..', '..', 'config');
const tokensPath = join(configDir, 'google-tokens.json');
const credentialsPath = join(configDir, 'google-credentials.json');

interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expiry_date?: number;
}

interface GoogleCredentials {
  installed?: { client_id: string; client_secret: string; redirect_uris: string[] };
  web?: { client_id: string; client_secret: string; redirect_uris: string[] };
}

function getAuthClient() {
  if (!existsSync(credentialsPath)) {
    throw new Error('Google credentials not found. Place google-credentials.json in config/.');
  }
  if (!existsSync(tokensPath)) {
    throw new Error('Google Calendar not configured. Run the OAuth setup.');
  }

  const creds: GoogleCredentials = JSON.parse(readFileSync(credentialsPath, 'utf-8'));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web || {};
  if (!client_id || !client_secret) {
    throw new Error('Invalid google-credentials.json format.');
  }

  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
  const tokens: GoogleTokens = JSON.parse(readFileSync(tokensPath, 'utf-8'));
  oauth2.setCredentials(tokens);

  oauth2.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    writeFileSync(tokensPath, JSON.stringify(merged, null, 2));
  });

  return oauth2;
}

function formatEvent(event: { summary?: string | null; start?: { dateTime?: string | null; date?: string | null }; end?: { dateTime?: string | null; date?: string | null }; location?: string | null }): string {
  const summary = event.summary || '(no title)';
  const startRaw = event.start?.dateTime || event.start?.date || '';
  const endRaw = event.end?.dateTime || event.end?.date || '';

  let timeStr: string;
  if (event.start?.dateTime) {
    const start = new Date(startRaw);
    const end = new Date(endRaw);
    timeStr = `${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else {
    timeStr = 'All day';
  }

  let line = `${timeStr} — ${summary}`;
  if (event.location) line += ` (${event.location})`;
  return line;
}

export class CalendarModule implements JarvisModule {
  name = 'calendar' as const;
  description = 'View and manage Google Calendar events';

  patterns: PatternDefinition[] = [
    {
      intent: 'today',
      patterns: [
        /^(?:what(?:'?s| is) )?(?:on )?(?:my )?(?:calendar|schedule|agenda) (?:for )?today$/i,
        /^(?:today(?:'s)? )?(?:calendar|schedule|events?|agenda)$/i,
        /^what(?:'?s| is) (?:on )?(?:my )?(?:calendar|schedule) (?:today)?$/i,
        /^(?:my )?schedule$/i,
        /^what(?:'?s| is) on (?:my )?calendar$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'upcoming',
      patterns: [
        /^(?:upcoming|this week(?:'s)?|next (?:few )?(?:days?|week)) (?:events?|calendar|schedule|meetings?)$/i,
        /^(?:show |list )?upcoming (?:events?|meetings?)$/i,
        /^(?:what(?:'?s| is) )?coming up(?: (?:this|next) week)?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'next',
      patterns: [
        /^(?:what(?:'?s| is) )?(?:my )?next (?:event|meeting|appointment)$/i,
        /^next (?:event|meeting|appointment|on (?:my )?calendar)$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'create',
      patterns: [
        /^(?:create|add|schedule|set up|book|make) (?:an? )?(?:event|meeting|appointment|calendar entry)(?: (?:for|about|called|named|:))?\s*(.*)$/i,
        /^schedule (.+)$/i,
      ],
      extract: (match, raw) => ({ description: match[1] || '', raw }),
    },
    {
      intent: 'delete',
      patterns: [
        /^(?:delete|remove|cancel) (?:the )?(?:event|meeting|appointment) (?:called |named )?["']?(.+?)["']?$/i,
        /^cancel (?:my )?(?:meeting |event )?(?:with |about |called |named )?["']?(.+?)["']?$/i,
      ],
      extract: (match) => ({ query: match[1] || '' }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    try {
      switch (command.action) {
        case 'today': return await this.getToday();
        case 'upcoming': return await this.getUpcoming();
        case 'next': return await this.getNext();
        case 'create': return await this.createEvent(command.args);
        case 'delete': return await this.deleteEvent(command.args);
        default: return { success: false, message: `Unknown calendar action: ${command.action}` };
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('not configured') || msg.includes('not found')) {
        return { success: false, message: msg };
      }
      return { success: false, message: `Calendar error: ${msg}` };
    }
  }

  private async getToday(): Promise<CommandResult> {
    const auth = getAuthClient();
    const cal = google.calendar({ version: 'v3', auth });

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items || [];
    if (events.length === 0) {
      return { success: true, message: 'No events scheduled for today.' };
    }

    const lines = events.map((e, i) => `${i + 1}. ${formatEvent(e)}`);
    return { success: true, message: `Today's events (${events.length}):\n\n${lines.join('\n')}` };
  }

  private async getUpcoming(): Promise<CommandResult> {
    const auth = getAuthClient();
    const cal = google.calendar({ version: 'v3', auth });

    const now = new Date();
    const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: weekLater.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20,
    });

    const events = res.data.items || [];
    if (events.length === 0) {
      return { success: true, message: 'No upcoming events in the next 7 days.' };
    }

    let currentDate = '';
    const lines: string[] = [];
    for (const e of events) {
      const dateStr = new Date(e.start?.dateTime || e.start?.date || '').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      if (dateStr !== currentDate) {
        currentDate = dateStr;
        lines.push(`\n${dateStr}:`);
      }
      lines.push(`  ${formatEvent(e)}`);
    }

    return { success: true, message: `Upcoming events (next 7 days):${lines.join('\n')}` };
  }

  private async getNext(): Promise<CommandResult> {
    const auth = getAuthClient();
    const cal = google.calendar({ version: 'v3', auth });

    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 1,
    });

    const event = res.data.items?.[0];
    if (!event) {
      return { success: true, message: 'No upcoming events.' };
    }

    const startRaw = event.start?.dateTime || event.start?.date || '';
    const start = new Date(startRaw);
    const now = new Date();
    const diffMs = start.getTime() - now.getTime();
    const diffMins = Math.round(diffMs / 60000);

    let timeUntil: string;
    if (diffMins < 1) timeUntil = 'now';
    else if (diffMins < 60) timeUntil = `in ${diffMins} minutes`;
    else if (diffMins < 1440) timeUntil = `in ${Math.round(diffMins / 60)} hours`;
    else timeUntil = `in ${Math.round(diffMins / 1440)} days`;

    return {
      success: true,
      message: `Next event: ${event.summary || '(no title)'} — ${formatEvent(event)} (${timeUntil})`,
      voiceMessage: `Your next event is ${event.summary || 'untitled'}, ${timeUntil}.`,
    };
  }

  private async createEvent(args: Record<string, string>): Promise<CommandResult> {
    const auth = getAuthClient();
    const cal = google.calendar({ version: 'v3', auth });
    const description = args.description || args.raw || '';

    if (!description) {
      return { success: false, message: 'Please describe the event you want to create.' };
    }

    const now = new Date();
    const parsed = await llmStreamChat(
      [{
        role: 'user',
        content: `Parse this event description into JSON. Current date/time: ${now.toISOString()}\n\nDescription: "${description}"\n\nReturn a JSON object with these fields:\n- summary: string (event title)\n- startDateTime: ISO 8601 string\n- endDateTime: ISO 8601 string (default 1 hour after start)\n- location: string or null\n- description: string or null\n\nReturn ONLY valid JSON, no markdown or explanation.`,
      }],
      'You parse natural language event descriptions into structured JSON. Always return valid JSON.',
      () => {},
    );

    let eventData: { summary: string; startDateTime: string; endDateTime: string; location?: string | null; description?: string | null };
    try {
      const cleaned = parsed.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      eventData = JSON.parse(cleaned);
    } catch {
      return { success: false, message: 'Could not parse event details. Try being more specific (e.g., "meeting with Bob tomorrow at 3pm").' };
    }

    const event = await cal.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: eventData.summary,
        start: { dateTime: eventData.startDateTime },
        end: { dateTime: eventData.endDateTime },
        location: eventData.location || undefined,
        description: eventData.description || undefined,
      },
    });

    const created = event.data;
    return {
      success: true,
      message: `Event created: ${created.summary}\n${formatEvent({ summary: created.summary, start: created.start, end: created.end, location: created.location })}`,
    };
  }

  private async deleteEvent(args: Record<string, string>): Promise<CommandResult> {
    const auth = getAuthClient();
    const cal = google.calendar({ version: 'v3', auth });
    const query = args.query || '';

    if (!query) {
      return { success: false, message: 'Please specify which event to delete.' };
    }

    const now = new Date();
    const weekLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: weekLater.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      q: query,
    });

    const events = res.data.items || [];
    if (events.length === 0) {
      return { success: false, message: `No upcoming event found matching "${query}".` };
    }

    const target = events[0];
    await cal.events.delete({
      calendarId: 'primary',
      eventId: target.id!,
    });

    return { success: true, message: `Deleted event: ${target.summary || '(no title)'}` };
  }

  getHelp(): string {
    return [
      '  Calendar (Google) — view and manage calendar events',
      '    today / my schedule    Show today\'s events',
      '    upcoming              Next 7 days of events',
      '    next meeting          Show next upcoming event',
      '    create event <desc>   Create a new event',
      '    cancel <event name>   Delete an event',
    ].join('\n');
  }
}
