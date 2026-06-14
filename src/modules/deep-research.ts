import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { llmStreamChat } from '../utils/llm.js';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, '..', '..', 'config', 'research-reports');

// ── Deep Research Agent ──
// Multi-hop research with citations across web and local documents.
// Breaks queries into sub-questions, searches iteratively, synthesizes with citations.

interface ResearchSource {
  title: string;
  url?: string;
  snippet: string;
  type: 'web' | 'local' | 'document';
}

interface ResearchRound {
  query: string;
  sources: ResearchSource[];
  synthesis: string;
  gaps: string[];
}

// ── Web Search via DuckDuckGo HTML ──

async function webSearch(query: string): Promise<ResearchSource[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'JARVIS/1.0 Research Agent' },
    });
    if (!resp.ok) return [];
    const html = await resp.text();

    const sources: ResearchSource[] = [];

    // Extract result blocks: each result has class "result__a" for title/link
    // and "result__snippet" for snippet text
    const resultPattern = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let match: RegExpExecArray | null;

    while ((match = resultPattern.exec(html)) !== null && sources.length < 5) {
      let href = match[1];
      const title = stripHtml(match[2]).trim();
      const snippet = stripHtml(match[3]).trim();

      // DuckDuckGo wraps URLs in a redirect; extract the actual URL
      if (href.includes('uddg=')) {
        const uddgMatch = href.match(/uddg=([^&]+)/);
        if (uddgMatch) href = decodeURIComponent(uddgMatch[1]);
      }

      if (title && snippet) {
        sources.push({ title, url: href, snippet, type: 'web' });
      }
    }

    // Fallback: simpler pattern if the above didn't match
    if (sources.length === 0) {
      const simplePattern = /<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetPattern = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      const titles: string[] = [];
      const snippets: string[] = [];

      let m: RegExpExecArray | null;
      while ((m = simplePattern.exec(html)) !== null && titles.length < 5) {
        titles.push(stripHtml(m[1]).trim());
      }
      while ((m = snippetPattern.exec(html)) !== null && snippets.length < 5) {
        snippets.push(stripHtml(m[1]).trim());
      }

      for (let i = 0; i < Math.min(titles.length, snippets.length); i++) {
        if (titles[i] && snippets[i]) {
          sources.push({ title: titles[i], snippet: snippets[i], type: 'web' });
        }
      }
    }

    return sources;
  } catch (err) {
    console.error('[deep-research] Web search failed:', (err as Error).message);
    return [];
  }
}

// ── Local Search via mdfind + grep ──

async function localSearch(query: string): Promise<ResearchSource[]> {
  const sources: ResearchSource[] = [];
  const sanitized = query.replace(/["`$\\]/g, '');

  try {
    // Use mdfind (Spotlight) for broad local search
    const mdfindResults = execSync(`mdfind "${sanitized}" 2>/dev/null | head -8`, {
      timeout: 10000,
      encoding: 'utf-8',
    }).trim();

    if (mdfindResults) {
      const files = mdfindResults.split('\n').filter(Boolean);
      for (const filePath of files.slice(0, 5)) {
        const snippet = readFileSnippet(filePath);
        if (snippet) {
          const name = filePath.split('/').pop() || filePath;
          sources.push({
            title: name,
            url: filePath,
            snippet,
            type: 'local',
          });
        }
      }
    }
  } catch {
    // mdfind not available or timed out
  }

  // Supplement with grep in common document dirs if we have few results
  if (sources.length < 3) {
    try {
      const home = process.env.HOME || '/Users';
      const dirs = [`${home}/Documents`, `${home}/Desktop`, `${home}/Downloads`];
      for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        try {
          const grepResults = execSync(
            `grep -rl "${sanitized}" "${dir}" --include="*.txt" --include="*.md" --include="*.json" --include="*.csv" 2>/dev/null | head -3`,
            { timeout: 8000, encoding: 'utf-8' },
          ).trim();
          if (grepResults) {
            for (const filePath of grepResults.split('\n').filter(Boolean)) {
              if (sources.some((s) => s.url === filePath)) continue;
              const snippet = readFileSnippet(filePath);
              if (snippet) {
                sources.push({
                  title: filePath.split('/').pop() || filePath,
                  url: filePath,
                  snippet,
                  type: 'local',
                });
              }
              if (sources.length >= 5) break;
            }
          }
        } catch {
          // grep failed for this dir
        }
        if (sources.length >= 5) break;
      }
    } catch {
      // fallback search failed
    }
  }

  return sources;
}

// ── Helpers ──

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

function readFileSnippet(filePath: string, maxLines = 15): string | null {
  try {
    if (!existsSync(filePath)) return null;
    // Skip binary / very large files
    const stat = execSync(`stat -f%z "${filePath}" 2>/dev/null || stat -c%s "${filePath}" 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    const size = parseInt(stat, 10);
    if (isNaN(size) || size > 500_000 || size === 0) return null;

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').slice(0, maxLines);
    return lines.join('\n').trim().slice(0, 800);
  } catch {
    return null;
  }
}

function ensureReportsDir(): void {
  if (!existsSync(REPORTS_DIR)) {
    mkdirSync(REPORTS_DIR, { recursive: true });
  }
}

function saveReport(topic: string, content: string): string {
  ensureReportsDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  const filename = `${timestamp}-${slug}.md`;
  const filePath = join(REPORTS_DIR, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ── Research Loop ──

async function researchLoop(topic: string, maxRounds: number, webEnabled: boolean): Promise<string> {
  const rounds: ResearchRound[] = [];
  const allSources: ResearchSource[] = [];
  let currentQueries = [topic];
  let sourceIndex = 1;

  for (let round = 0; round < maxRounds; round++) {
    for (const query of currentQueries) {
      // Gather sources
      const webResults = webEnabled ? await webSearch(query) : [];
      const localResults = await localSearch(query);
      const roundSources = [...webResults, ...localResults];

      // Number the sources globally
      const numberedSources = roundSources.map((s) => {
        const idx = sourceIndex++;
        allSources.push(s);
        return { idx, ...s };
      });

      if (numberedSources.length === 0) {
        rounds.push({ query, sources: [], synthesis: `No sources found for "${query}".`, gaps: [] });
        continue;
      }

      // Ask LLM to synthesize
      const sourcesText = numberedSources
        .map((s) => `[${s.idx}] ${s.title}${s.url ? ` (${s.url})` : ''}: ${s.snippet}`)
        .join('\n\n');

      const synthesis = await llmStreamChat(
        [
          {
            role: 'user',
            content: `Synthesize these sources about "${query}":\n\n${sourcesText}\n\nProvide a thorough synthesis using [N] citation notation for each claim. At the end, list 1-2 knowledge gaps or follow-up questions that would deepen the research (prefix each with "GAP:").`,
          },
        ],
        'You are a meticulous research analyst. Always cite sources using [N] notation. Be thorough and analytical. Identify what is well-supported vs speculative.',
        () => {},
      );

      // Extract gaps for follow-up
      const gaps: string[] = [];
      for (const line of synthesis.split('\n')) {
        const gapMatch = line.match(/^GAP:\s*(.+)/i);
        if (gapMatch) gaps.push(gapMatch[1].trim());
      }

      rounds.push({ query, sources: roundSources, synthesis, gaps });
    }

    // Determine follow-up queries from gaps (only if more rounds remain)
    if (round < maxRounds - 1) {
      const allGaps = rounds.flatMap((r) => r.gaps).filter(Boolean);
      if (allGaps.length === 0) break; // No gaps, research is complete

      // Use LLM to pick the best follow-up queries
      const followUp = await llmStreamChat(
        [
          {
            role: 'user',
            content: `Based on the research so far about "${topic}", these gaps were identified:\n${allGaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}\n\nPick the 1-2 most important gaps and turn them into concise search queries. Return ONLY the queries, one per line, nothing else.`,
          },
        ],
        'You help plan research by selecting the most impactful follow-up queries. Return only search queries, one per line.',
        () => {},
      );

      currentQueries = followUp
        .split('\n')
        .map((q) => q.replace(/^\d+[.)]\s*/, '').trim())
        .filter((q) => q.length > 3)
        .slice(0, 2);

      if (currentQueries.length === 0) break;
    }
  }

  // Compile final report
  return compileFinalReport(topic, rounds, allSources);
}

async function compileFinalReport(
  topic: string,
  rounds: ResearchRound[],
  allSources: ResearchSource[],
): Promise<string> {
  const roundSummaries = rounds
    .map(
      (r, i) =>
        `### Research Round ${i + 1}: "${r.query}"\n\n${r.synthesis}\n\n---`,
    )
    .join('\n\n');

  const sourcesSection = allSources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.title}${s.url ? ` - ${s.url}` : ''} (${s.type})`,
    )
    .join('\n');

  // Ask LLM to produce the final compiled report
  const finalReport = await llmStreamChat(
    [
      {
        role: 'user',
        content: `You performed ${rounds.length} rounds of research on "${topic}". Here are the round-by-round findings:\n\n${roundSummaries}\n\nFull source list:\n${sourcesSection}\n\nNow compile a final, well-structured research report with:\n1. An executive summary (3-5 sentences)\n2. Key findings organized by theme/section\n3. Areas of uncertainty or conflicting information\n4. Conclusion\n5. Full sources list at the end\n\nMaintain all [N] citations throughout. Be thorough and analytical.`,
      },
    ],
    'You are a senior research analyst compiling a final report. Maintain rigorous citation practices using [N] notation. Be comprehensive yet clear.',
    () => {},
  );

  // Build the markdown report
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const markdown = `# Deep Research: ${topic}\n\n**Generated:** ${timestamp}\n**Rounds:** ${rounds.length}\n**Sources:** ${allSources.length}\n\n---\n\n${finalReport}\n\n---\n\n## Sources\n\n${sourcesSection}\n`;

  return markdown;
}

// ── Compare Action ──

async function compareItems(items: string[]): Promise<string> {
  // Research every item CONCURRENTLY — items are fully independent, so this is
  // ~Nx faster than the old sequential loop. Promise.all preserves input order,
  // so the comparison below is deterministic.
  const itemReports = await Promise.all(
    items.map(async (item) => {
      // web + local search are independent of each other — run them together too
      const [webResults, localResults] = await Promise.all([
        webSearch(item),
        localSearch(item),
      ]);
      const allSources = [...webResults, ...localResults];

      const sourcesText = allSources
        .map((s, i) => `[${i + 1}] ${s.title}: ${s.snippet}`)
        .join('\n\n');

      const findings = await llmStreamChat(
        [
          {
            role: 'user',
            content: `Summarize key facts about "${item}" from these sources:\n\n${sourcesText || 'No sources found.'}\n\nFocus on: features, pros, cons, pricing, performance, and notable aspects.`,
          },
        ],
        'You are a research analyst summarizing findings concisely.',
        () => {},
      );

      return { item, findings };
    }),
  );

  // Produce comparison
  const comparison = await llmStreamChat(
    [
      {
        role: 'user',
        content: `Compare the following items based on the research:\n\n${itemReports.map((r) => `## ${r.item}\n${r.findings}`).join('\n\n')}\n\nProduce:\n1. A comparison table (markdown format) with key dimensions as rows\n2. Pros and cons for each\n3. A recommendation with rationale`,
      },
    ],
    'You are an analyst producing clear, balanced comparisons. Use markdown tables.',
    () => {},
  );

  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  return `# Comparison: ${items.join(' vs ')}\n\n**Generated:** ${timestamp}\n\n${comparison}\n`;
}

// ── Module Definition ──

const patterns: PatternDefinition[] = [
  {
    intent: 'research',
    patterns: [
      /^(?:deep\s+)?research\s+(.+?)(?:\s+thoroughly)?$/i,
      /^investigate\s+(.+)$/i,
      /^(?:do\s+)?(?:a\s+)?deep\s+(?:dive|research)\s+(?:on|into)\s+(.+)$/i,
      /^research\s+(.+?)\s+in\s+depth$/i,
    ],
    extract: (_m, raw) => {
      const topic = raw
        .replace(/^(?:deep\s+)?research\s+/i, '')
        .replace(/^investigate\s+/i, '')
        .replace(/^(?:do\s+)?(?:a\s+)?deep\s+(?:dive|research)\s+(?:on|into)\s+/i, '')
        .replace(/\s+(?:thoroughly|in\s+depth)$/i, '')
        .trim();
      return { topic };
    },
  },
  {
    intent: 'quick',
    patterns: [
      /^quick\s+research\s+(.+)$/i,
      /^(?:quickly\s+)?look\s+up\s+(.+)$/i,
      /^quick\s+(?:look|search)\s+(.+)$/i,
    ],
    extract: (_m, raw) => {
      const topic = raw
        .replace(/^quick(?:ly)?\s+(?:research|look\s+up|look|search)\s+/i, '')
        .trim();
      return { topic };
    },
  },
  {
    intent: 'local',
    patterns: [
      /^search\s+(?:local\s+)?(?:docs?|files?)\s+(?:for\s+)?(.+)$/i,
      /^find\s+in\s+(?:my\s+)?files?\s+(.+)$/i,
      /^local\s+(?:search|research)\s+(.+)$/i,
    ],
    extract: (_m, raw) => {
      const topic = raw
        .replace(/^search\s+(?:local\s+)?(?:docs?|files?)\s+(?:for\s+)?/i, '')
        .replace(/^find\s+in\s+(?:my\s+)?files?\s+/i, '')
        .replace(/^local\s+(?:search|research)\s+/i, '')
        .trim();
      return { topic };
    },
  },
  {
    intent: 'compare',
    patterns: [
      /^compare\s+(.+?)\s+(?:vs\.?|versus|or|and)\s+(.+)$/i,
      /^which\s+is\s+better\s+(.+?)\s+(?:vs\.?|or)\s+(.+)$/i,
      /^(.+?)\s+vs\.?\s+(.+)$/i,
    ],
    extract: (match) => {
      const item1 = (match[1] || '').trim();
      const item2 = (match[2] || '').trim();
      return { items: `${item1}|||${item2}` };
    },
  },
];

const deepResearchModule: JarvisModule = {
  name: 'deep-research',
  description:
    'Multi-hop deep research agent with citations across web and local documents. Breaks queries into sub-questions, iterates, and produces cited reports.',

  patterns,

  async execute(command: ParsedCommand): Promise<CommandResult> {
    const { action, args } = command;

    switch (action) {
      case 'research': {
        const topic = args.topic;
        if (!topic) {
          return { success: false, message: 'Please specify a research topic.' };
        }

        try {
          const report = await researchLoop(topic, 4, true);
          const filePath = saveReport(topic, report);
          return {
            success: true,
            message: `${report}\n\n---\nReport saved to: ${filePath}`,
            voiceMessage: `Deep research on "${topic}" is complete. I found multiple sources across ${4} rounds of investigation. The full report has been saved.`,
            data: { reportPath: filePath },
          };
        } catch (err) {
          return {
            success: false,
            message: `Research failed: ${(err as Error).message}`,
          };
        }
      }

      case 'quick': {
        const topic = args.topic;
        if (!topic) {
          return { success: false, message: 'Please specify a topic to look up.' };
        }

        try {
          const report = await researchLoop(topic, 1, true);
          const filePath = saveReport(topic, report);
          return {
            success: true,
            message: `${report}\n\n---\nReport saved to: ${filePath}`,
            voiceMessage: `Quick research on "${topic}" is done. I found relevant sources and compiled a brief report.`,
            data: { reportPath: filePath },
          };
        } catch (err) {
          return {
            success: false,
            message: `Quick research failed: ${(err as Error).message}`,
          };
        }
      }

      case 'local': {
        const topic = args.topic;
        if (!topic) {
          return { success: false, message: 'Please specify what to search for in local files.' };
        }

        try {
          const results = await localSearch(topic);
          if (results.length === 0) {
            return {
              success: true,
              message: `No local documents found matching "${topic}".`,
              voiceMessage: `I couldn't find any local documents about "${topic}".`,
            };
          }

          const sourcesText = results
            .map((s, i) => `[${i + 1}] ${s.title} (${s.url}): ${s.snippet}`)
            .join('\n\n');

          // Summarize local findings via LLM
          const summary = await llmStreamChat(
            [
              {
                role: 'user',
                content: `Summarize these local document findings about "${topic}":\n\n${sourcesText}\n\nUse [N] citations.`,
              },
            ],
            'You are a research assistant summarizing local document findings. Cite sources with [N] notation.',
            () => {},
          );

          const report = `# Local Research: ${topic}\n\n${summary}\n\n## Sources\n\n${results.map((s, i) => `[${i + 1}] ${s.title} - ${s.url}`).join('\n')}\n`;
          const filePath = saveReport(`local-${topic}`, report);

          return {
            success: true,
            message: `${report}\n\n---\nReport saved to: ${filePath}`,
            voiceMessage: `Found ${results.length} local documents about "${topic}". I've summarized the findings.`,
            data: { reportPath: filePath, sources: results },
          };
        } catch (err) {
          return {
            success: false,
            message: `Local search failed: ${(err as Error).message}`,
          };
        }
      }

      case 'compare': {
        const itemsStr = args.items;
        if (!itemsStr) {
          return { success: false, message: 'Please specify items to compare (e.g., "compare X vs Y").' };
        }

        const items = itemsStr.split('|||').map((s) => s.trim()).filter(Boolean);
        if (items.length < 2) {
          return { success: false, message: 'Please specify at least two items to compare.' };
        }

        try {
          const report = await compareItems(items);
          const filePath = saveReport(`compare-${items.join('-vs-')}`, report);
          return {
            success: true,
            message: `${report}\n\n---\nReport saved to: ${filePath}`,
            voiceMessage: `Comparison of ${items.join(' versus ')} is complete. I've analyzed each option and provided a recommendation.`,
            data: { reportPath: filePath },
          };
        } catch (err) {
          return {
            success: false,
            message: `Comparison failed: ${(err as Error).message}`,
          };
        }
      }

      default:
        return {
          success: false,
          message: `Unknown deep-research action: ${action}`,
        };
    }
  },

  getHelp(): string {
    return [
      'Deep Research Agent - Multi-hop research with citations',
      '',
      'Commands:',
      '  research <topic>     Full deep research (3-5 rounds, web + local)',
      '  investigate <topic>  Same as above',
      '  deep dive on <topic> Same as above',
      '  quick research <X>   Quick 1-round research',
      '  look up <X>          Same as quick research',
      '  search docs for <X>  Search only local documents',
      '  find in my files <X> Same as local search',
      '  compare X vs Y       Compare two or more items',
      '  X vs Y               Same as compare',
      '',
      'Reports are saved to config/research-reports/ as markdown files.',
    ].join('\n');
  },
};

export default deepResearchModule;
