import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';

// ── Weather & News Module ──
// Weather: Open-Meteo API (free, no key)
// News: Google News RSS (free, no key)

// WMO weather codes → human descriptions
const WMO_CODES: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'foggy', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'moderate drizzle', 55: 'dense drizzle',
  61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
  71: 'slight snow', 73: 'moderate snow', 75: 'heavy snow',
  77: 'snow grains', 80: 'slight rain showers', 81: 'moderate rain showers',
  82: 'violent rain showers', 85: 'slight snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with slight hail', 99: 'thunderstorm with heavy hail',
};

interface GeoLocation {
  lat: number;
  lon: number;
  city: string;
  cachedAt: number;
}

let locationCache: GeoLocation | null = null;
const LOCATION_CACHE_MS = 3600000; // 1 hour

export class WeatherNewsModule implements JarvisModule {
  name = 'weather-news' as const;
  description = 'Get current weather and news headlines';

  patterns: PatternDefinition[] = [
    {
      intent: 'weather',
      patterns: [
        /^(?:what(?:'?s| is) the )?weather(?:\s+(?:in|for|at)\s+(.+))?$/i,
        /^(?:how(?:'?s| is) the )?weather(?:\s+(?:in|for|at)\s+(.+))?$/i,
        /^weather\s+(?:in|for|at)\s+(.+)/i,
        /^weather$/i,
        /^(?:what(?:'?s| is) (?:the )?)?(?:temperature|temp)(?:\s+(?:in|for|at)\s+(.+))?$/i,
        /^(?:is it|will it)\s+(?:going to\s+)?(?:rain|snow|sunny|cold|hot|warm)/i,
      ],
      extract: (match) => ({ location: (match[1] || '').trim() }),
    },
    {
      intent: 'forecast',
      patterns: [
        /^forecast(?:\s+(?:in|for|at)\s+(.+))?$/i,
        /^(?:what(?:'?s| is) the )?forecast/i,
      ],
      extract: (match) => ({ location: (match[1] || '').trim() }),
    },
    {
      intent: 'news',
      patterns: [
        /^(?:(?:what(?:'?s| is)|show(?:\s+me)?)\s+(?:the\s+|in\s+the\s+)?)?news(?:\s+(?:about|on|for)\s+(.+))?$/i,
        /^headlines?(?:\s+(?:about|on|for)\s+(.+))?$/i,
        /^(?:top|latest)\s+(?:news|headlines?)(?:\s+(?:about|on|for)\s+(.+))?$/i,
      ],
      extract: (match) => ({ topic: (match[1] || match[2] || '').trim() }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'weather':
      case 'forecast':
        return this.getWeather(command.args.location);
      case 'news':
        return this.getNews(command.args.topic);
      default:
        return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  // ── Weather (Open-Meteo API) ──

  private async getLocation(city?: string): Promise<{ lat: number; lon: number; name: string }> {
    if (city) {
      // Geocode city name via Open-Meteo geocoding API
      const resp = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (resp.ok) {
        const data = await resp.json() as { results?: Array<{ latitude: number; longitude: number; name: string }> };
        if (data.results?.[0]) {
          const r = data.results[0];
          return { lat: r.latitude, lon: r.longitude, name: r.name };
        }
      }
      throw new Error(`Could not find location "${city}"`);
    }

    // Auto-detect via IP geolocation
    if (locationCache && Date.now() - locationCache.cachedAt < LOCATION_CACHE_MS) {
      return { lat: locationCache.lat, lon: locationCache.lon, name: locationCache.city };
    }

    const resp = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error('Could not detect location');
    const data = await resp.json() as { loc: string; city: string };
    const [lat, lon] = data.loc.split(',').map(Number);
    locationCache = { lat, lon, city: data.city, cachedAt: Date.now() };
    return { lat, lon, name: data.city };
  }

  private async getWeather(city: string): Promise<CommandResult> {
    try {
      const loc = await this.getLocation(city || undefined);
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current_weather=true&temperature_unit=fahrenheit&wind_speed_unit=mph`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) throw new Error(`Weather API error: ${resp.status}`);

      const data = await resp.json() as {
        current_weather: { temperature: number; windspeed: number; weathercode: number };
      };

      const w = data.current_weather;
      const desc = WMO_CODES[w.weathercode] || 'unknown';
      const tempC = Math.round((w.temperature - 32) * 5 / 9);

      const message = `Weather in ${loc.name}: ${Math.round(w.temperature)}°F (${tempC}°C), ${desc}. Wind: ${Math.round(w.windspeed)} mph.`;
      return { success: true, message };
    } catch (err) {
      return { success: false, message: `Weather error: ${(err as Error).message}` };
    }
  }

  // ── News (Google News RSS) ──

  async getTopHeadlines(topic?: string, count = 5): Promise<string[]> {
    const url = topic
      ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US`
      : 'https://news.google.com/rss?hl=en-US&gl=US';

    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`News feed error: ${resp.status}`);

    const xml = await resp.text();
    // Extract <title> inside <item> elements
    const items = xml.split('<item>').slice(1);
    const headlines: string[] = [];

    for (const item of items) {
      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
      if (titleMatch) {
        const title = (titleMatch[1] || titleMatch[2]).trim();
        if (title && !title.includes('Google News')) {
          headlines.push(title);
          if (headlines.length >= count) break;
        }
      }
    }

    return headlines;
  }

  private async getNews(topic: string): Promise<CommandResult> {
    try {
      const headlines = await this.getTopHeadlines(topic || undefined);
      if (headlines.length === 0) {
        return { success: true, message: 'No news headlines found.' };
      }

      const topicLabel = topic ? ` about "${topic}"` : '';
      const list = headlines.map((h, i) => `    ${i + 1}. ${h}`).join('\n');

      // Voice-friendly: strip " - Source" from each headline, just read the titles
      const voiceHeadlines = headlines.map(h => h.replace(/\s*[-–—]\s*[^-–—]+$/, '').trim());
      const voiceText = `Here are the top headlines${topicLabel}. ${voiceHeadlines.join('. ')}.`;

      return { success: true, message: `Top headlines${topicLabel}:\n${list}`, voiceMessage: voiceText };
    } catch (err) {
      return { success: false, message: `News error: ${(err as Error).message}` };
    }
  }

  getHelp(): string {
    return [
      '  Weather & News — free, no API keys needed',
      '    weather               Current weather (auto-detect location)',
      '    weather in <city>     Weather for a specific city',
      '    news                  Top headlines',
      '    news about <topic>    Headlines on a specific topic',
    ].join('\n');
  }
}
