import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { fmt } from '../utils/formatter.js';

// ── Site Monitor Module ──
// Monitors Arhan's products and services. Groups related endpoints
// into logical services so status is reported per-product, not per-URL.

interface Endpoint {
  url: string;
  label: string;
}

interface Service {
  /** Short name for voice output (e.g. "Trade Buddy") */
  name: string;
  /** What this service is, for context */
  description: string;
  /** Endpoints to check — ALL must be up for the service to be "up" */
  endpoints: Endpoint[];
}

const SERVICES: Service[] = [
  {
    name: 'Trade Buddy',
    description: 'stock trading companion app',
    endpoints: [
      { url: 'https://mytradebuddy.com', label: 'mytradebuddy.com' },
    ],
  },
  {
    name: 'Website',
    description: 'personal portfolio site',
    endpoints: [
      { url: 'https://arhan.dev', label: 'arhan.dev' },
    ],
  },
  {
    name: 'FRIDAY',
    description: 'AI assistant web app',
    endpoints: [
      { url: 'https://friday.arhan.dev', label: 'friday.arhan.dev' },
    ],
  },
  {
    name: 'Rewoven',
    description: 'sustainable fashion app',
    endpoints: [
      { url: 'https://rewovenapp.com', label: 'rewovenapp.com' },
    ],
  },
  {
    name: 'JARVIS',
    description: 'AI assistant web interface',
    endpoints: [
      { url: 'https://jarvis.arhan.dev', label: 'jarvis.arhan.dev' },
    ],
  },
];

interface EndpointResult {
  label: string;
  online: boolean;
  status: number | null;
  latency: number;
}

interface ServiceResult {
  name: string;
  description: string;
  online: boolean;
  endpoints: EndpointResult[];
}

async function checkEndpoint(ep: Endpoint): Promise<EndpointResult> {
  const start = Date.now();

  for (const method of ['HEAD', 'GET'] as const) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      const resp = await fetch(ep.url, {
        method,
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'JARVIS/2.1 StatusCheck' },
      });

      clearTimeout(timer);
      return { label: ep.label, online: resp.status < 400, status: resp.status, latency: Date.now() - start };
    } catch {
      if (method === 'HEAD') continue; // retry with GET
      return { label: ep.label, online: false, status: null, latency: Date.now() - start };
    }
  }

  return { label: ep.label, online: false, status: null, latency: Date.now() - start };
}

async function checkService(service: Service): Promise<ServiceResult> {
  const results = await Promise.all(service.endpoints.map(checkEndpoint));
  const allUp = results.every(r => r.online);
  return { name: service.name, description: service.description, online: allUp, endpoints: results };
}

// ── Aliases for fuzzy matching ──
const SERVICE_ALIASES: Record<string, string> = {
  'trade buddy': 'Trade Buddy',
  'tradebuddy': 'Trade Buddy',
  'mytradebuddy': 'Trade Buddy',
  'trading': 'Trade Buddy',
  'website': 'Website',
  'portfolio': 'Website',
  'arhan.dev': 'Website',
  'arhan': 'Website',
  'friday': 'FRIDAY',
  'rewoven': 'Rewoven',
  'jarvis': 'JARVIS',
};

function findService(query: string): Service | undefined {
  const lower = query.toLowerCase().trim();

  // Direct alias match
  for (const [alias, name] of Object.entries(SERVICE_ALIASES)) {
    if (lower.includes(alias)) {
      return SERVICES.find(s => s.name === name);
    }
  }

  // Fuzzy: substring match on service name
  return SERVICES.find(s => s.name.toLowerCase().includes(lower));
}

export class SiteMonitorModule implements JarvisModule {
  name = 'site-monitor' as const;
  description = 'Check if your sites and apps are online';

  patterns: PatternDefinition[] = [
    {
      intent: 'check-all',
      patterns: [
        /^(?:site|sites|app|apps)\s+status$/i,
        /^(?:check|are)\s+(?:my\s+)?(?:sites?|apps?|services?|products?)\s+(?:online|up|running|status|working|live)/i,
        /^status\s+(?:check|report)$/i,
        /^(?:are\s+)?(?:all\s+)?(?:my\s+)?(?:sites?|apps?|services?|products?)\s+(?:up|online|working|running)/i,
        /^(?:how\s+are|what(?:'?s| is)\s+the\s+status\s+of)\s+(?:my\s+)?(?:sites?|apps?|services?|products?|everything)/i,
        /^(?:system|service|product)\s+status$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'check-one',
      patterns: [
        // Only treat as a site check when the subject looks like a site/host —
        // contains a dot (domain) or is explicitly "site/app/service/url X".
        /^(?:is|check)\s+((?:https?:\/\/)?[\w-]+\.[\w.-]+\S*)\s+(?:online|up|running|working|live|down)/i,
        /^(?:is|check)\s+(?:my\s+)?(?:site|website|app|service|server|api|url)\s+(.+?)\s+(?:online|up|running|working|live|down)/i,
        /^(?:check|ping|status\s+of)\s+((?:https?:\/\/)?[\w-]+\.[\w.-]+\S*)$/i,
        /^(?:check|ping|status\s+of)\s+(?:my\s+)?(?:site|website|app|service|server|api|url)\s+(.+)/i,
      ],
      extract: (match) => ({ site: match[1].trim() }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'check-all': return this.checkAll();
      case 'check-one': return this.checkOne(command.args.site);
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private async checkAll(): Promise<CommandResult> {
    console.log(fmt.dim('  [status] Checking all services...'));

    const results = await Promise.all(SERVICES.map(checkService));

    // Build detailed display output
    const lines: string[] = [];
    const upServices: string[] = [];
    const downServices: string[] = [];

    for (const r of results) {
      const icon = r.online ? '\u2705' : '\u274C';
      const status = r.online ? 'up' : 'DOWN';

      if (r.endpoints.length === 1) {
        const ep = r.endpoints[0];
        const detail = ep.online ? `${ep.latency}ms` : (ep.status ? `HTTP ${ep.status}` : 'unreachable');
        lines.push(`  ${icon} ${r.name} — ${status} (${detail})`);
      } else {
        // Multi-endpoint service (like Rewoven)
        const epDetails = r.endpoints.map(ep => {
          const epIcon = ep.online ? '\u2713' : '\u2717';
          const detail = ep.online ? `${ep.latency}ms` : (ep.status ? `HTTP ${ep.status}` : 'unreachable');
          return `      ${epIcon} ${ep.label}: ${detail}`;
        });
        lines.push(`  ${icon} ${r.name} — ${status}`);
        lines.push(...epDetails);
      }

      if (r.online) upServices.push(r.name);
      else downServices.push(r.name);
    }

    // Summary line
    if (downServices.length === 0) {
      lines.push('\n  All systems operational.');
    } else {
      lines.push(`\n  ${downServices.join(', ')} ${downServices.length === 1 ? 'is' : 'are'} down.`);
    }

    // Voice-friendly summary: "Trade Buddy up. Website up. FRIDAY up. Rewoven down. Rewoven is down."
    const voiceParts = results.map(r => `${r.name}, ${r.online ? 'up' : 'down'}`);
    const voiceSuffix = downServices.length === 0
      ? 'All systems operational.'
      : `${downServices.join(' and ')} ${downServices.length === 1 ? 'is' : 'are'} down.`;

    return { success: true, message: lines.join('\n'), voiceMessage: `${voiceParts.join('. ')}. ${voiceSuffix}` };
  }

  private async checkOne(siteName: string): Promise<CommandResult> {
    const service = findService(siteName);

    if (service) {
      console.log(fmt.dim(`  [status] Checking ${service.name}...`));
      const result = await checkService(service);
      const icon = result.online ? '\u2705' : '\u274C';

      if (result.endpoints.length === 1) {
        const ep = result.endpoints[0];
        const detail = ep.online ? `${ep.latency}ms` : (ep.status ? `HTTP ${ep.status}` : 'unreachable');
        const msg = `${icon} ${result.name} — ${result.online ? 'up' : 'DOWN'} (${detail})`;
        return { success: true, message: msg, voiceMessage: `${result.name} is ${result.online ? 'up' : 'down'}.` };
      }

      // Multi-endpoint
      const lines = [`${icon} ${result.name} — ${result.online ? 'up' : 'DOWN'}`];
      for (const ep of result.endpoints) {
        const epIcon = ep.online ? '\u2713' : '\u2717';
        const detail = ep.online ? `${ep.latency}ms` : (ep.status ? `HTTP ${ep.status}` : 'unreachable');
        lines.push(`    ${epIcon} ${ep.label}: ${detail}`);
      }

      const downEps = result.endpoints.filter(e => !e.online);
      const voice = downEps.length === 0
        ? `${result.name} is up on all platforms.`
        : `${result.name} is down on ${downEps.map(e => e.label).join(' and ')}.`;

      return { success: true, message: lines.join('\n'), voiceMessage: voice };
    }

    // Unknown service — try as arbitrary URL
    const url = siteName.startsWith('http') ? siteName : `https://${siteName}`;
    console.log(fmt.dim(`  [status] Checking ${url}...`));
    const ep = await checkEndpoint({ url, label: siteName });
    const icon = ep.online ? '\u2705' : '\u274C';
    const detail = ep.online ? `${ep.latency}ms` : (ep.status ? `HTTP ${ep.status}` : 'unreachable');

    return {
      success: true,
      message: `${icon} ${siteName} — ${ep.online ? 'up' : 'DOWN'} (${detail})`,
      voiceMessage: `${siteName} is ${ep.online ? 'up' : 'down'}.`,
    };
  }

  getHelp(): string {
    return [
      '  Site Monitor — check if your sites & apps are online',
      '    site status              Check all services',
      '    check my sites           Check all services',
      '    is Trade Buddy online    Check specific service',
      '    check FRIDAY             Check specific service',
      '    check rewoven            Check app store listings',
    ].join('\n');
  }
}
