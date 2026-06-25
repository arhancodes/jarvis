import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { llmStreamChat } from '../utils/llm.js';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fmt } from '../utils/formatter.js';
import { speak, isVoiceEnabled } from '../utils/voice-output.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, '..', '..', 'config', 'research-reports');

// ── Unified Research Module ──
// One module for ALL research: academic papers, web, local files, comparisons.
// Depth is automatic — "research X" does standard, "deep research X" does multi-hop.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Paper {
  title: string;
  authors: string[];
  abstract: string;
  year: number;
  url: string;
  citations?: number;
  source: 'arxiv' | 'semantic-scholar';
}

interface WebSource {
  title: string;
  url: string;
  snippet: string;
}

interface ResearchRound {
  query: string;
  papers: Paper[];
  webSources: WebSource[];
  synthesis: string;
  gaps: string[];
}

// ---------------------------------------------------------------------------
// Sources — arXiv
// ---------------------------------------------------------------------------

async function searchArxiv(query: string, max = 15): Promise<Paper[]> {
  try {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${max}&sortBy=relevance&sortOrder=descending`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return [];
    const xml = await resp.text();

    const papers: Paper[] = [];
    for (const entry of xml.split('<entry>').slice(1)) {
      const title = extractXml(entry, 'title')?.replace(/\s+/g, ' ').trim();
      const abstract = extractXml(entry, 'summary')?.replace(/\s+/g, ' ').trim();
      const published = extractXml(entry, 'published');
      const year = published ? parseInt(published.slice(0, 4), 10) : 0;
      const linkMatch = entry.match(/<id>(.*?)<\/id>/);
      const link = linkMatch ? linkMatch[1].trim() : '';
      const authors: string[] = [];
      for (const m of entry.matchAll(/<author>\s*<name>(.*?)<\/name>/g)) {
        authors.push(m[1].trim());
      }
      if (title && abstract) {
        papers.push({ title, authors, abstract, year, url: link, source: 'arxiv' });
      }
    }
    return papers;
  } catch { return []; }
}

function extractXml(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Sources — Semantic Scholar
// ---------------------------------------------------------------------------

async function searchSemanticScholar(query: string, max = 15): Promise<Paper[]> {
  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${max}&fields=title,authors,abstract,year,citationCount,url`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'JARVIS/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as { data?: Array<{
      title?: string; authors?: Array<{ name: string }>; abstract?: string;
      year?: number; citationCount?: number; url?: string;
    }> };
    if (!data.data) return [];
    return data.data
      .filter(p => p.title && p.abstract)
      .map(p => ({
        title: p.title!, authors: (p.authors || []).map(a => a.name),
        abstract: (p.abstract || '').replace(/\s+/g, ' ').trim(),
        year: p.year || 0, url: p.url || '', citations: p.citationCount,
        source: 'semantic-scholar' as const,
      }));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Sources — Web (DuckDuckGo)
// ---------------------------------------------------------------------------

async function webSearch(query: string): Promise<WebSource[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'JARVIS/1.0 Research Agent' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const sources: WebSource[] = [];
    const re = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null && sources.length < 8) {
      let href = match[1];
      const title = stripHtml(match[2]).trim();
      const snippet = stripHtml(match[3]).trim();
      if (href.includes('uddg=')) {
        const u = href.match(/uddg=([^&]+)/);
        if (u) href = decodeURIComponent(u[1]);
      }
      if (title && snippet) sources.push({ title, url: href, snippet });
    }
    return sources;
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Sources — Local files (mdfind + grep)
// ---------------------------------------------------------------------------

async function localSearch(query: string): Promise<WebSource[]> {
  const sources: WebSource[] = [];
  const sanitized = query.replace(/["`$\\]/g, '');
  try {
    const results = execSync(`mdfind "${sanitized}" 2>/dev/null | head -8`, {
      timeout: 10000, encoding: 'utf-8',
    }).trim();
    if (results) {
      for (const filePath of results.split('\n').filter(Boolean).slice(0, 5)) {
        const snippet = readFileSnippet(filePath);
        if (snippet) {
          sources.push({ title: filePath.split('/').pop() || filePath, url: filePath, snippet });
        }
      }
    }
  } catch { /* mdfind not available */ }
  return sources;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
}

function readFileSnippet(filePath: string, maxLines = 15): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const stat = execSync(`stat -f%z "${filePath}" 2>/dev/null || stat -c%s "${filePath}" 2>/dev/null`, {
      encoding: 'utf-8', timeout: 3000,
    }).trim();
    const size = parseInt(stat, 10);
    if (isNaN(size) || size > 500_000 || size === 0) return null;
    return readFileSync(filePath, 'utf-8').split('\n').slice(0, maxLines).join('\n').trim().slice(0, 800);
  } catch { return null; }
}

function ensureReportsDir(): void {
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
}

function saveReport(topic: string, content: string): string {
  ensureReportsDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  const filePath = join(REPORTS_DIR, `${ts}-${slug}.md`);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function deduplicatePapers(arxiv: Paper[], s2: Paper[]): Paper[] {
  const all: Paper[] = [...arxiv];
  for (const p of s2) {
    const isDupe = all.some(e => e.title.toLowerCase().slice(0, 40) === p.title.toLowerCase().slice(0, 40));
    if (!isDupe) all.push(p);
  }
  all.sort((a, b) => {
    if (a.citations !== undefined && b.citations !== undefined) return b.citations - a.citations;
    return b.year - a.year;
  });
  return all;
}

function formatPapersContext(papers: Paper[]): string {
  return papers.map((p, i) =>
    `[${i + 1}] ${p.title} (${p.year}, ${p.source})${p.citations ? ` — ${p.citations} citations` : ''}\nAuthors: ${p.authors.slice(0, 3).join(', ')}${p.authors.length > 3 ? ' et al.' : ''}\nAbstract: ${p.abstract.slice(0, 400)}`,
  ).join('\n\n');
}

function formatWebContext(sources: WebSource[], prefix = 'W'): string {
  if (sources.length === 0) return '';
  return '\n\nWeb Sources:\n' + sources.map((w, i) => `[${prefix}${i + 1}] ${w.title}: ${w.snippet}`).join('\n');
}

function buildReport(topic: string, body: string, papers: Paper[], webSources: WebSource[], rounds?: number): string {
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const papersSection = papers.map((p, i) =>
    `[${i + 1}] ${p.title} — ${p.authors.slice(0, 3).join(', ')}${p.authors.length > 3 ? ' et al.' : ''} (${p.year}) ${p.url}`,
  ).join('\n');
  const webSection = webSources.length > 0
    ? '\n\n### Web Sources\n\n' + webSources.map((w, i) => `[W${i + 1}] ${w.title} — ${w.url}`).join('\n')
    : '';

  return [
    `# Research: ${topic}`,
    '', `**Generated:** ${timestamp}`,
    `**Papers:** ${papers.length}`, `**Web sources:** ${webSources.length}`,
    rounds ? `**Rounds:** ${rounds}` : '',
    '', '---', '', body, '', '---', '',
    '## Sources', '', '### Academic Papers', '', papersSection, webSection,
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Research Modes
// ---------------------------------------------------------------------------

/** Standard research: one round, academic + web. */
async function standardResearch(topic: string, yearRange?: string, maxPapers?: number): Promise<CommandResult> {
  console.log(fmt.info(`Researching: "${topic}"`));
  console.log(fmt.dim('  Searching arXiv + Semantic Scholar + web...'));

  const limit = maxPapers || 15;
  const [arxiv, s2, web] = await Promise.all([
    searchArxiv(topic, limit), searchSemanticScholar(topic, limit), webSearch(`${topic} research`),
  ]);

  let papers = deduplicatePapers(arxiv, s2);
  if (yearRange) {
    const [from, to] = yearRange.split('-').map(Number);
    if (from && to) papers = papers.filter(p => p.year >= from && p.year <= to);
  }
  papers = papers.slice(0, limit);

  if (papers.length === 0 && web.length === 0) {
    return { success: false, message: `No results found for "${topic}".` };
  }

  console.log(fmt.dim(`  Found ${papers.length} papers, ${web.length} web sources`));

  const synthesis = await llmStreamChat(
    [{ role: 'user', content: `Analyze these research results about "${topic}":\n\n${formatPapersContext(papers)}${formatWebContext(web)}\n\nProvide:\n1. Executive Summary (3-5 sentences)\n2. Key Findings (organized by theme, cite as [N])\n3. Trends\n4. Gaps & Open Questions\n5. Top 5 most important papers and why\n\nUse [N] citations throughout.` }],
    'You are a senior research analyst. Cite sources with [N]. Be thorough.',
    () => {},
  );

  const report = buildReport(topic, synthesis, papers, web);
  const filePath = saveReport(topic, report);

  if (isVoiceEnabled()) {
    const brief = synthesis.split('\n').find(l => l.trim().length > 20)?.slice(0, 200) || `Found ${papers.length} papers on ${topic}`;
    await speak(brief);
  }

  return {
    success: true,
    message: `Research complete: "${topic}"\n  ${papers.length} papers, ${web.length} web sources\n  Report: ${filePath}\n\n${synthesis.split('\n').slice(0, 15).join('\n')}\n\n  Full report: ${filePath}`,
  };
}

/** Deep research: multi-hop with follow-up rounds. */
async function deepResearch(topic: string, maxRounds = 4): Promise<CommandResult> {
  console.log(fmt.info(`Deep research: "${topic}" (up to ${maxRounds} rounds)`));

  const rounds: ResearchRound[] = [];
  const allPapers: Paper[] = [];
  const allWeb: WebSource[] = [];
  let currentQueries = [topic];

  for (let round = 0; round < maxRounds; round++) {
    console.log(fmt.dim(`  Round ${round + 1}/${maxRounds}...`));

    for (const query of currentQueries) {
      const [arxiv, s2, web, local] = await Promise.all([
        searchArxiv(query, 10), searchSemanticScholar(query, 10),
        webSearch(query), localSearch(query),
      ]);
      const papers = deduplicatePapers(arxiv, s2).slice(0, 10);
      const webSources = [...web, ...local];

      allPapers.push(...papers);
      allWeb.push(...webSources);

      if (papers.length === 0 && webSources.length === 0) {
        rounds.push({ query, papers: [], webSources: [], synthesis: `No sources found for "${query}".`, gaps: [] });
        continue;
      }

      const synthesis = await llmStreamChat(
        [{ role: 'user', content: `Synthesize these sources about "${query}":\n\n${formatPapersContext(papers)}${formatWebContext(webSources)}\n\nProvide a thorough synthesis using [N] citation notation. At the end, list 1-2 knowledge gaps (prefix each with "GAP:").` }],
        'You are a meticulous research analyst. Always cite sources using [N]. Identify gaps.',
        () => {},
      );

      const gaps: string[] = [];
      for (const line of synthesis.split('\n')) {
        const gm = line.match(/^GAP:\s*(.+)/i);
        if (gm) gaps.push(gm[1].trim());
      }

      rounds.push({ query, papers, webSources, synthesis, gaps });
    }

    // Determine follow-up queries from gaps
    if (round < maxRounds - 1) {
      const allGaps = rounds.flatMap(r => r.gaps).filter(Boolean);
      if (allGaps.length === 0) break;

      const followUp = await llmStreamChat(
        [{ role: 'user', content: `Research so far on "${topic}" identified these gaps:\n${allGaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}\n\nPick the 1-2 most important and turn them into search queries. Return ONLY the queries, one per line.` }],
        'Return only search queries, one per line.',
        () => {},
      );
      currentQueries = followUp.split('\n').map(q => q.replace(/^\d+[.)]\s*/, '').trim()).filter(q => q.length > 3).slice(0, 2);
      if (currentQueries.length === 0) break;
    }
  }

  // Final compilation
  const roundSummaries = rounds.map((r, i) => `### Round ${i + 1}: "${r.query}"\n\n${r.synthesis}\n\n---`).join('\n\n');

  const finalSynthesis = await llmStreamChat(
    [{ role: 'user', content: `You performed ${rounds.length} rounds of research on "${topic}":\n\n${roundSummaries}\n\nCompile a final report with:\n1. Executive summary\n2. Key findings by theme\n3. Uncertainties/conflicts\n4. Conclusion\n5. Sources list\n\nMaintain [N] citations.` }],
    'You are a senior analyst compiling a final research report. Be comprehensive.',
    () => {},
  );

  // Deduplicate accumulated papers
  const uniquePapers = deduplicatePapers(allPapers, []);
  const report = buildReport(topic, finalSynthesis, uniquePapers, allWeb, rounds.length);
  const filePath = saveReport(`deep-${topic}`, report);

  if (isVoiceEnabled()) {
    await speak(`Deep research on "${topic}" is complete. ${uniquePapers.length} papers across ${rounds.length} rounds.`);
  }

  return {
    success: true,
    message: `Deep research complete: "${topic}"\n  ${rounds.length} rounds, ${uniquePapers.length} papers, ${allWeb.length} web sources\n  Report: ${filePath}\n\n${finalSynthesis.split('\n').slice(0, 15).join('\n')}\n\n  Full report: ${filePath}`,
  };
}

/** Quick research: one round, web only, no academic papers. */
async function quickResearch(topic: string): Promise<CommandResult> {
  console.log(fmt.info(`Quick lookup: "${topic}"`));

  const [web, local] = await Promise.all([webSearch(topic), localSearch(topic)]);
  const sources = [...web, ...local];

  if (sources.length === 0) {
    return { success: true, message: `No results found for "${topic}".` };
  }

  const sourcesText = sources.map((s, i) => `[${i + 1}] ${s.title}: ${s.snippet}`).join('\n\n');
  const summary = await llmStreamChat(
    [{ role: 'user', content: `Summarize these findings about "${topic}":\n\n${sourcesText}\n\nUse [N] citations. Be concise.` }],
    'Concise research summary with citations.',
    () => {},
  );

  const report = `# Quick Research: ${topic}\n\n${summary}\n\n## Sources\n\n${sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n')}\n`;
  const filePath = saveReport(`quick-${topic}`, report);

  if (isVoiceEnabled()) await speak(summary.split('\n')[0]?.slice(0, 200) || `Here's what I found about ${topic}`);

  return { success: true, message: `${summary}\n\nReport: ${filePath}` };
}

/** Compare two or more items. */
async function compareItems(items: string[]): Promise<CommandResult> {
  console.log(fmt.info(`Comparing: ${items.join(' vs ')}`));

  const itemReports: Array<{ item: string; findings: string }> = [];
  for (const item of items) {
    const web = await webSearch(item);
    const sourcesText = web.map((s, i) => `[${i + 1}] ${s.title}: ${s.snippet}`).join('\n\n');
    const findings = await llmStreamChat(
      [{ role: 'user', content: `Summarize key facts about "${item}":\n\n${sourcesText || 'No sources.'}\n\nFocus on: features, pros, cons, pricing, performance.` }],
      'Concise analyst summary.',
      () => {},
    );
    itemReports.push({ item, findings });
  }

  const comparison = await llmStreamChat(
    [{ role: 'user', content: `Compare:\n\n${itemReports.map(r => `## ${r.item}\n${r.findings}`).join('\n\n')}\n\nProduce:\n1. Comparison table (markdown)\n2. Pros and cons for each\n3. Recommendation with rationale` }],
    'Clear, balanced comparison analyst. Use markdown tables.',
    () => {},
  );

  const report = `# Comparison: ${items.join(' vs ')}\n\n${comparison}\n`;
  const filePath = saveReport(`compare-${items.join('-vs-')}`, report);

  if (isVoiceEnabled()) await speak(`Comparison of ${items.join(' versus ')} is complete.`);

  return { success: true, message: `${comparison}\n\nReport: ${filePath}` };
}

/** Search local files only. */
async function localOnly(topic: string): Promise<CommandResult> {
  const results = await localSearch(topic);
  if (results.length === 0) return { success: true, message: `No local documents found for "${topic}".` };

  const sourcesText = results.map((s, i) => `[${i + 1}] ${s.title} (${s.url}): ${s.snippet}`).join('\n\n');
  const summary = await llmStreamChat(
    [{ role: 'user', content: `Summarize these local findings about "${topic}":\n\n${sourcesText}\n\nCite with [N].` }],
    'Research assistant summarizing local documents.',
    () => {},
  );

  const report = `# Local Search: ${topic}\n\n${summary}\n\n## Sources\n\n${results.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n')}\n`;
  const filePath = saveReport(`local-${topic}`, report);

  return { success: true, message: `${summary}\n\nReport: ${filePath}` };
}

// ---------------------------------------------------------------------------
// Module Definition
// ---------------------------------------------------------------------------

export class ResearchModule implements JarvisModule {
  name = 'research' as const;
  description = 'Research anything — academic papers, web, local files, comparisons';

  patterns: PatternDefinition[] = [
    // Deep research (multi-hop)
    {
      intent: 'deep',
      patterns: [
        /^deep\s+(?:research|dive)\s+(?:on\s+|into\s+)?(.+?)(?:\s+thoroughly)?$/i,
        /^(?:do\s+)?(?:a\s+)?deep\s+(?:dive|research)\s+(?:on|into)\s+(.+)$/i,
        /^research\s+(.+?)\s+(?:in\s+depth|thoroughly|deeply)$/i,
        /^investigate\s+(.+?)\s+(?:thoroughly|deeply|in\s+depth)$/i,
      ],
      extract: (match) => ({ topic: (match[1] || '').trim() }),
    },
    // Quick research
    {
      intent: 'quick',
      patterns: [
        /^quick(?:ly)?\s+(?:research|look\s+up|search|look)\s+(.+)$/i,
        /^look\s+up\s+(.+)$/i,
        // "find me some research papers on X", "find articles about Y"
        /^(?:find|get|search\s+for)\s+(?:me\s+)?(?:some\s+)?(?:research|academic|scientific)?\s*(?:papers?|articles?|studies|literature|info(?:rmation)?)\s+(?:on|about|regarding|for)\s+(.+)$/i,
      ],
      extract: (match) => ({ topic: (match[1] || '').trim() }),
    },
    // Local file search
    {
      intent: 'local',
      patterns: [
        /^search\s+(?:local\s+)?(?:docs?|files?)\s+(?:for\s+)?(.+)$/i,
        /^find\s+in\s+(?:my\s+)?files?\s+(.+)$/i,
        /^local\s+(?:search|research)\s+(.+)$/i,
      ],
      extract: (match) => ({ topic: (match[1] || '').trim() }),
    },
    // Compare
    {
      intent: 'compare',
      patterns: [
        /^compare\s+(.+?)\s+(?:vs\.?|versus|or|and)\s+(.+)$/i,
        /^which\s+is\s+better\s+(.+?)\s+(?:vs\.?|or)\s+(.+)$/i,
      ],
      extract: (match) => ({ items: `${(match[1] || '').trim()}|||${(match[2] || '').trim()}` }),
    },
    // Standard research (catch-all — must be last)
    {
      intent: 'research',
      patterns: [
        /^(?:research|investigate|study)\s+(.+)/i,
        /^(?:find|search(?:\s+for)?|look\s+up)\s+(?:papers?|research|articles?|studies)\s+(?:on|about|for|regarding)\s+(.+)/i,
        /^(?:academic|paper|literature)\s+search\s+(.+)/i,
      ],
      extract: (match, raw) => {
        const topic = (match[1] || match[2] || '').trim();
        const yearMatch = topic.match(/(\d{4})\s*[-–]\s*(\d{4})/);
        const years = yearMatch ? `${yearMatch[1]}-${yearMatch[2]}` : '';
        const cleanTopic = topic.replace(/(\d{4})\s*[-–]\s*(\d{4})/, '').replace(/\s+/g, ' ').trim();
        const maxMatch = cleanTopic.match(/(?:--?max\s+|max\s+)(\d+)/i);
        const max = maxMatch ? maxMatch[1] : '';
        const finalTopic = cleanTopic.replace(/(?:--?max\s+|max\s+)\d+/i, '').trim();
        return { topic: finalTopic, years, max };
      },
    },
    // Status
    {
      intent: 'status',
      patterns: [/^research\s+status$/i],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    const { action, args } = command;

    if (action === 'status') {
      return {
        success: true,
        message: [
          'Research module: ready',
          '  Sources: arXiv, Semantic Scholar, DuckDuckGo, local files (mdfind)',
          '  Modes: research, deep research, quick, local, compare',
          `  Reports: ${REPORTS_DIR}`,
        ].join('\n'),
      };
    }

    if (action === 'compare') {
      const items = (args.items || '').split('|||').map(s => s.trim()).filter(Boolean);
      if (items.length < 2) return { success: false, message: 'Specify at least two items: compare X vs Y' };
      return compareItems(items);
    }

    const topic = args.topic;
    if (!topic) return { success: false, message: 'What should I research? Usage: research <topic>' };

    if (isVoiceEnabled()) await speak(`Researching ${topic}. This may take a moment.`);

    switch (action) {
      case 'deep':
        return deepResearch(topic);
      case 'quick':
        return quickResearch(topic);
      case 'local':
        return localOnly(topic);
      case 'research':
      default:
        return standardResearch(topic, args.years || undefined, args.max ? parseInt(args.max, 10) : undefined);
    }
  }

  getHelp(): string {
    return [
      '  Research',
      '    research <topic>              Standard research (papers + web)',
      '    research <topic> 2020-2025    Filter by year range',
      '    research <topic> max 30       Limit paper count',
      '    deep research <topic>         Multi-hop deep investigation',
      '    investigate <topic> thoroughly Same as deep research',
      '    quick research <topic>        Fast web-only lookup',
      '    look up <topic>               Same as quick',
      '    search docs for <topic>       Local files only',
      '    compare X vs Y                Side-by-side comparison',
      '    research status               Check module status',
    ].join('\n');
  }
}
