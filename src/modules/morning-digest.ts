import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { llmStreamChat } from '../utils/llm.js';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { configPath } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('morning-digest');
const CONFIG_PATH = configPath('morning-digest.json');

// ── Morning Digest Module ──
// Comprehensive daily briefing that gathers weather, calendar, email,
// news, system status, and insights into a spoken JARVIS-style narrative.

interface DigestConfig {
  sections: string[];
  location: string;
  autoTime: string | null;
  quickSections: string[];
}

interface BriefingData {
  weather?: string;
  calendar?: string;
  email?: string;
  news?: string;
  system?: string;
  insights?: string;
}

function loadConfig(): DigestConfig {
  const defaults: DigestConfig = {
    sections: ['weather', 'calendar', 'email', 'news', 'system', 'insights'],
    location: 'auto',
    autoTime: null,
    quickSections: ['weather', 'calendar', 'email'],
  };
  try {
    if (existsSync(CONFIG_PATH)) {
      const data = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      return { ...defaults, ...data };
    }
  } catch (err) { log.debug('Failed to load digest config, using defaults', err); }
  return defaults;
}

function saveConfig(config: DigestConfig): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('Failed to save morning-digest config:', (err as Error).message);
  }
}

// ── Data Gatherers ──

async function getWeather(location: string): Promise<string> {
  try {
    // Use Open-Meteo (free, no key) via IP geolocation or configured location
    let lat: number, lon: number, city: string;

    if (location && location !== 'auto') {
      const geoResp = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!geoResp.ok) throw new Error('Geocoding failed');
      const geoData = await geoResp.json() as { results?: Array<{ latitude: number; longitude: number; name: string }> };
      if (!geoData.results?.[0]) throw new Error(`Location "${location}" not found`);
      lat = geoData.results[0].latitude;
      lon = geoData.results[0].longitude;
      city = geoData.results[0].name;
    } else {
      const ipResp = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(5000) });
      if (!ipResp.ok) throw new Error('IP geolocation failed');
      const ipData = await ipResp.json() as { loc: string; city: string };
      const parts = ipData.loc.split(',').map(Number);
      lat = parts[0];
      lon = parts[1];
      city = ipData.city;
    }

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`Weather API error: ${resp.status}`);

    const data = await resp.json() as {
      current_weather: { temperature: number; windspeed: number; weathercode: number };
    };

    const WMO: Record<number, string> = {
      0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
      45: 'foggy', 48: 'rime fog', 51: 'light drizzle', 53: 'moderate drizzle',
      55: 'dense drizzle', 61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
      71: 'slight snow', 73: 'moderate snow', 75: 'heavy snow', 80: 'rain showers',
      95: 'thunderstorm', 96: 'thunderstorm with hail',
    };

    const w = data.current_weather;
    const desc = WMO[w.weathercode] || 'unknown conditions';
    return `${Math.round(w.temperature)}°F, ${desc} in ${city}. Wind: ${Math.round(w.windspeed)} mph.`;
  } catch (err) {
    throw new Error(`Weather unavailable: ${(err as Error).message}`);
  }
}

async function getCalendarSummary(): Promise<string> {
  try {
    // Try macOS Calendar via AppleScript
    const script = `
      tell application "Calendar"
        set today to current date
        set tomorrow to today + 1 * days
        set eventList to ""
        set eventCount to 0
        repeat with cal in calendars
          repeat with evt in (every event of cal whose start date >= today and start date < tomorrow)
            set eventCount to eventCount + 1
            set eventList to eventList & (summary of evt) & " at " & time string of (start date of evt) & "; "
          end repeat
        end repeat
        return (eventCount as string) & " events today: " & eventList
      end tell
    `;
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 10000,
      encoding: 'utf-8',
    }).trim();
    return result || 'No calendar events found for today.';
  } catch {
    return 'Calendar not accessible. You may need to grant Calendar permissions.';
  }
}

async function getEmailSummary(): Promise<string> {
  try {
    // Try macOS Mail via AppleScript
    const script = `
      tell application "Mail"
        set unreadCount to unread count of inbox
        set msgs to ""
        set msgList to (messages of inbox whose read status is false)
        set topCount to 0
        repeat with msg in msgList
          if topCount < 3 then
            set msgs to msgs & "- " & subject of msg & " (from " & sender of msg & "); "
            set topCount to topCount + 1
          end if
        end repeat
        return (unreadCount as string) & " unread emails. Top: " & msgs
      end tell
    `;
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 10000,
      encoding: 'utf-8',
    }).trim();
    return result || 'No unread emails.';
  } catch {
    return 'Email not accessible. Mail app may not be configured.';
  }
}

async function getNewsHeadlines(): Promise<string> {
  try {
    const url = 'https://news.google.com/rss?hl=en-US&gl=US';
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`News feed error: ${resp.status}`);

    const xml = await resp.text();
    const items = xml.split('<item>').slice(1);
    const headlines: string[] = [];

    for (const item of items) {
      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
      if (titleMatch) {
        const title = (titleMatch[1] || titleMatch[2]).trim();
        if (title && !title.includes('Google News')) {
          // Strip source suffix for cleaner reading
          headlines.push(title.replace(/\s*[-–—]\s*[^-–—]+$/, '').trim());
          if (headlines.length >= 3) break;
        }
      }
    }

    return headlines.length > 0
      ? `Top headlines: ${headlines.join('. ')}.`
      : 'No news headlines available.';
  } catch (err) {
    throw new Error(`News unavailable: ${(err as Error).message}`);
  }
}

async function getSystemStatus(): Promise<string> {
  try {
    const parts: string[] = [];

    // Battery
    try {
      const battery = execSync('pmset -g batt', { timeout: 5000, encoding: 'utf-8' });
      const battMatch = battery.match(/(\d+)%/);
      const chargingMatch = battery.match(/(charging|discharging|charged)/i);
      if (battMatch) {
        parts.push(`Battery: ${battMatch[1]}%${chargingMatch ? ` (${chargingMatch[1]})` : ''}`);
      }
    } catch (err) { log.debug('Battery check failed', err); }

    // Disk space
    try {
      const df = execSync("df -h / | tail -1", { timeout: 5000, encoding: 'utf-8' });
      const dfParts = df.trim().split(/\s+/);
      if (dfParts.length >= 5) {
        parts.push(`Disk: ${dfParts[3]} available (${dfParts[4]} used)`);
      }
    } catch (err) { log.debug('Disk check failed', err); }

    // Uptime
    try {
      const uptime = execSync('uptime', { timeout: 5000, encoding: 'utf-8' }).trim();
      const upMatch = uptime.match(/up\s+(.+?),\s+\d+\s+user/);
      if (upMatch) {
        parts.push(`Uptime: ${upMatch[1].trim()}`);
      }
    } catch (err) { log.debug('Uptime check failed', err); }

    return parts.length > 0 ? parts.join('. ') + '.' : 'System status unavailable.';
  } catch (err) {
    log.debug('System status check failed', err);
    return 'System status unavailable.';
  }
}

async function getLearningInsights(): Promise<string> {
  try {
    // Check if we have any habit/pattern data
    const habitsPath = configPath('habits.json');
    if (existsSync(habitsPath)) {
      const habits = JSON.parse(readFileSync(habitsPath, 'utf-8'));
      if (habits && typeof habits === 'object') {
        const keys = Object.keys(habits);
        if (keys.length > 0) {
          return `I've tracked ${keys.length} behavioral patterns. Your most frequent activities are noted.`;
        }
      }
    }
    return 'No usage patterns tracked yet. I will learn your habits over time.';
  } catch (err) {
    log.debug('Failed to load learning insights', err);
    return 'Insights module not yet active.';
  }
}

// ── Briefing Compiler ──

async function gatherBriefing(sections: string[], location: string): Promise<BriefingData> {
  const data: BriefingData = {};

  const tasks: Promise<void>[] = [];

  if (sections.includes('weather')) {
    tasks.push(getWeather(location).then(w => { data.weather = w; }).catch(e => { data.weather = (e as Error).message; }));
  }
  if (sections.includes('calendar')) {
    tasks.push(getCalendarSummary().then(c => { data.calendar = c; }).catch(e => { data.calendar = (e as Error).message; }));
  }
  if (sections.includes('email')) {
    tasks.push(getEmailSummary().then(e => { data.email = e; }).catch(err => { data.email = (err as Error).message; }));
  }
  if (sections.includes('news')) {
    tasks.push(getNewsHeadlines().then(n => { data.news = n; }).catch(e => { data.news = (e as Error).message; }));
  }
  if (sections.includes('system')) {
    tasks.push(getSystemStatus().then(s => { data.system = s; }).catch(e => { data.system = (e as Error).message; }));
  }
  if (sections.includes('insights')) {
    tasks.push(getLearningInsights().then(i => { data.insights = i; }).catch(e => { data.insights = (e as Error).message; }));
  }

  await Promise.allSettled(tasks);
  return data;
}

async function compileBriefing(data: BriefingData, quick: boolean): Promise<string> {
  const dataParts: string[] = [];

  if (data.weather) dataParts.push(`Weather: ${data.weather}`);
  if (data.calendar) dataParts.push(`Calendar: ${data.calendar}`);
  if (data.email) dataParts.push(`Email: ${data.email}`);
  if (data.news) dataParts.push(`News: ${data.news}`);
  if (data.system) dataParts.push(`System: ${data.system}`);
  if (data.insights) dataParts.push(`Insights: ${data.insights}`);

  if (dataParts.length === 0) {
    return 'Good morning, sir. I was unable to gather any briefing data at this time. All sources appear to be unavailable.';
  }

  const now = new Date();
  const timeOfDay = now.getHours() < 12 ? 'morning' : now.getHours() < 17 ? 'afternoon' : 'evening';

  const systemPrompt = `You are JARVIS, a sophisticated AI assistant. Compile the following raw data into a natural, spoken ${quick ? 'quick 15-second' : 'concise 30-second'} briefing. Address the user as "sir". Start with "Good ${timeOfDay}, sir." Be conversational but efficient. Do not use bullet points or formatting — this will be spoken aloud. If any section mentions "unavailable" or "not accessible", skip it gracefully without drawing attention to the failure. End with a brief, helpful suggestion or offer.`;

  const userMessage = `Here is the raw briefing data to compile into a spoken narrative:\n\n${dataParts.join('\n')}`;

  let fullResponse = '';
  try {
    fullResponse = await llmStreamChat(
      [{ role: 'user', content: userMessage }],
      systemPrompt,
      () => { /* we collect the full response, not streaming to console */ },
    );
  } catch (err) {
    log.warn('LLM unavailable for briefing compilation', err);
    fullResponse = `Good ${timeOfDay}, sir. ` + dataParts.join(' ') + ' Let me know how I can help.';
  }

  return fullResponse;
}

// ── Module Class ──

export class MorningDigestModule implements JarvisModule {
  name = 'morning-digest' as const;
  description = 'Comprehensive daily briefing with weather, calendar, email, news, system status, and insights';

  patterns: PatternDefinition[] = [
    {
      intent: 'briefing',
      patterns: [
        /^(?:good\s*)?morning\s+briefing$/i,
        /^daily\s+(?:digest|briefing)$/i,
        /^(?:what(?:'s| is|s)\s+)?my\s+day\s+look\s+like/i,
        /^brief\s+me$/i,
        /^what\s+did\s+i\s+miss/i,
        /^(?:full\s+)?briefing$/i,
        /^morning\s+digest$/i,
        /^daily\s+report$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'quick',
      patterns: [
        /^quick\s+(?:briefing|update|brief|digest)$/i,
        /^(?:give\s+me\s+a?\s*)?quick\s+(?:morning\s+)?(?:update|briefing)$/i,
        /^(?:what(?:'?s| is)\s+)?(?:the\s+)?quick\s+(?:rundown|summary)$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'configure',
      patterns: [
        /^(?:configure|customize|set(?:\s*up)?)\s+(?:my\s+)?briefing(?:\s+settings)?$/i,
        /^briefing\s+(?:settings|config(?:uration)?)$/i,
        /^(?:change|update)\s+(?:my\s+)?briefing\s+(?:sections|preferences)$/i,
      ],
      extract: (match, raw) => {
        const sectionsMatch = raw.match(/(?:include|add|enable)\s+(\w+(?:\s*,\s*\w+)*)/i);
        const removeMatch = raw.match(/(?:exclude|remove|disable)\s+(\w+(?:\s*,\s*\w+)*)/i);
        return {
          add: sectionsMatch ? sectionsMatch[1] : '',
          remove: removeMatch ? removeMatch[1] : '',
        };
      },
    },
    {
      intent: 'schedule',
      patterns: [
        /^schedule\s+(?:my\s+)?(?:morning\s+)?briefing(?:\s+(?:at|for)\s+(.+))?$/i,
        /^(?:set|change)\s+(?:auto[- ]?)?briefing\s+time(?:\s+(?:to|at)\s+(.+))?$/i,
      ],
      extract: (match) => ({ time: (match[1] || '').trim() }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'briefing':
        return this.runBriefing(false);
      case 'quick':
        return this.runBriefing(true);
      case 'configure':
        return this.configure(command.args);
      case 'schedule':
        return this.scheduleBriefing(command.args.time);
      default:
        return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private async runBriefing(quick: boolean): Promise<CommandResult> {
    const config = loadConfig();
    const sections = quick ? config.quickSections : config.sections;

    const data = await gatherBriefing(sections, config.location);
    const narrative = await compileBriefing(data, quick);

    return {
      success: true,
      message: narrative,
      voiceMessage: narrative,
      data: { sections: Object.keys(data), quick, raw: data },
    };
  }

  private configure(args: Record<string, string>): CommandResult {
    const config = loadConfig();
    const allSections = ['weather', 'calendar', 'email', 'news', 'system', 'insights'];

    if (args.add) {
      const toAdd = args.add.split(',').map(s => s.trim().toLowerCase()).filter(s => allSections.includes(s));
      for (const s of toAdd) {
        if (!config.sections.includes(s)) config.sections.push(s);
      }
    }

    if (args.remove) {
      const toRemove = args.remove.split(',').map(s => s.trim().toLowerCase());
      config.sections = config.sections.filter(s => !toRemove.includes(s));
    }

    if (!args.add && !args.remove) {
      // Show current config
      return {
        success: true,
        message: [
          'Morning Digest Configuration:',
          `  Full briefing sections: ${config.sections.join(', ')}`,
          `  Quick briefing sections: ${config.quickSections.join(', ')}`,
          `  Location: ${config.location}`,
          `  Auto-briefing time: ${config.autoTime || 'not set'}`,
          '',
          `  Available sections: ${allSections.join(', ')}`,
          '  Say "configure briefing include news,system" or "configure briefing exclude insights"',
        ].join('\n'),
        voiceMessage: `Your briefing includes ${config.sections.join(', ')}. Auto-briefing is ${config.autoTime ? 'set for ' + config.autoTime : 'not scheduled'}.`,
      };
    }

    saveConfig(config);
    return {
      success: true,
      message: `Briefing updated. Active sections: ${config.sections.join(', ')}`,
      voiceMessage: `Done. Your briefing now includes ${config.sections.join(', ')}.`,
    };
  }

  private scheduleBriefing(time: string): CommandResult {
    const config = loadConfig();

    if (!time) {
      if (config.autoTime) {
        return {
          success: true,
          message: `Auto-briefing is set for ${config.autoTime}. Say "schedule briefing at 7:30am" to change.`,
          voiceMessage: `Your auto-briefing is set for ${config.autoTime}.`,
        };
      }
      return {
        success: true,
        message: 'No auto-briefing scheduled. Say "schedule briefing at 7:30am" to set one.',
        voiceMessage: 'No auto-briefing is scheduled. Tell me a time and I will set one up.',
      };
    }

    config.autoTime = time;
    saveConfig(config);

    return {
      success: true,
      message: `Auto-briefing scheduled for ${time} daily. I'll deliver your briefing automatically.`,
      voiceMessage: `Done, sir. I'll deliver your morning briefing at ${time} every day.`,
    };
  }

  getHelp(): string {
    return [
      '  Morning Digest — comprehensive daily briefing',
      '    morning briefing       Full briefing (weather, calendar, email, news, system, insights)',
      '    daily digest           Same as morning briefing',
      '    brief me               Same as morning briefing',
      '    quick briefing         Quick 30-second update (weather, calendar, email)',
      '    what did i miss        Full briefing',
      '    configure briefing     View/change briefing sections',
      '    schedule briefing      Set auto-briefing time',
    ].join('\n');
  }
}
