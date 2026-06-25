import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { getBrowser, closeBrowser, isOpen } from '../utils/browser-manager.js';
import { fmt } from '../utils/formatter.js';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from '../utils/logger.js';
import { fetchAndExtract } from '../utils/web-extract.js';
import { llmStreamChat, FAST_MODEL } from '../utils/llm.js';

const log = createLogger('browser-control');

// ── Browser Control Module ──
// Browse websites, Google search, read pages, click, fill forms, screenshot.
// Uses Playwright with persistent context.

const PROFILE = 'browser';

export class BrowserControlModule implements JarvisModule {
  name = 'browser-control' as const;
  description = 'Control a browser — browse, search, read pages, click, fill, screenshot';

  patterns: PatternDefinition[] = [
    {
      intent: 'browse',
      patterns: [
        // "browse https://tradebuddy.com", "go to https://..."
        /^(?:browse|navigate|go\s+to|visit|check\s+out|open\s+(?:the\s+)?(?:website|site|url|page)?)\s+(?:my\s+|the\s+|our\s+)?(https?:\/\/.+)/i,
        // "browse tradebuddy.com", "browse my tradebuddy.com and tell me..."
        /^(?:browse|navigate|go\s+to|visit|check\s+out|open\s+(?:the\s+)?(?:website|site|url|page)?)\s+(?:my\s+|the\s+|our\s+)?((?:www\.)?[\w.-]+\.\w{2,}(?:\/\S*)?)/i,
      ],
      extract: (match) => {
        // Strip trailing "and ..." so "tradebuddy.com and tell me" → "tradebuddy.com"
        const url = match[1].trim().replace(/\s+and\s+.*/i, '').replace(/\s+then\s+.*/i, '');
        return { url };
      },
    },
    {
      intent: 'google',
      patterns: [
        /^(?:google|search(?:\s+(?:for|the\s+web|online))?)\s+(.+)/i,
        /^(?:look\s+up|find\s+(?:online|on\s+the\s+web))\s+(.+)/i,
      ],
      extract: (match) => ({ query: match[1].trim() }),
    },
    {
      // Read/summarize a URL DIRECTLY — fetch + Claude extract, no browser launch.
      // Matches only when a domain/URL is present, so "read page" still hits read-page below.
      intent: 'read-url',
      patterns: [
        /^(?:read|summari[sz]e|get)\s+(https?:\/\/\S+)$/i,
        /^(?:read|summari[sz]e)\s+((?:www\.)?[\w-]+\.\w{2,}\S*)$/i,
        /^what\s+does\s+(https?:\/\/\S+|(?:www\.)?[\w-]+\.\w{2,}\S*)\s+say(?:\s+about\s+(.+))?$/i,
        // A read/summarize verb anywhere followed by a URL: "summarize this
        // article https://..." / "read nytimes.com and give me the gist".
        /^(?:read|summari[sz]e|get|tldr|give\s+me\s+(?:the\s+)?(?:gist|summary)\s+of)\b.*?(https?:\/\/\S+|(?:www\.)?[\w-]+\.(?:com|org|net|io|dev|ai|co|edu|gov|news|uk)\b\S*)/i,
      ],
      extract: (match) => ({ url: match[1].trim(), question: (match[2] || '').trim() }),
    },
    {
      intent: 'read-page',
      patterns: [
        /^(?:read|extract|get)\s+(?:the\s+)?page$/i,
        /^what(?:'?s| is)\s+on\s+(?:the|this)\s+page$/i,
        /^read\s+(?:the\s+)?(?:web\s*)?page$/i,
        /^page\s+(?:content|text)$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'click',
      patterns: [
        /^click\s+(?:on\s+)?["'](.+)["']$/i,
        /^click\s+(?:on\s+)?(.+)/i,
      ],
      extract: (match) => ({ target: match[1].trim() }),
    },
    {
      intent: 'fill',
      patterns: [
        /^(?:fill|type|enter|input)\s+["'](.+?)["']\s+(?:with|=|:)\s+["']?(.+?)["']?$/i,
        /^(?:fill|type|enter|input)\s+(.+?)\s+(?:with|=|:)\s+(.+)/i,
      ],
      extract: (match) => ({ selector: match[1].trim(), value: match[2].trim() }),
    },
    {
      intent: 'screenshot',
      patterns: [
        /^(?:(?:take\s+(?:a\s+)?)?screenshot|capture\s+(?:the\s+)?page|snap\s+(?:the\s+)?page)$/i,
        /^(?:browser\s+)?screenshot$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'close',
      patterns: [
        /^close\s+(?:the\s+)?browser$/i,
        /^browser\s+close$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'browse':      return this.browse(command.args.url);
      case 'google':      return this.google(command.args.query);
      case 'read-url':    return this.readUrl(command.args.url, command.args.question);
      case 'read-page':   return this.readPage();
      case 'click':       return this.click(command.args.target);
      case 'fill':        return this.fill(command.args.selector, command.args.value);
      case 'screenshot':  return this.screenshot();
      case 'close':       return this.close();
      default:
        return { success: false, message: `Unknown browser action: ${command.action}` };
    }
  }

  /**
   * Read/summarize a URL directly with fetch + Claude — no browser launch (fast).
   * Falls back to a real browser only for JS-heavy / blocked pages.
   */
  private async readUrl(url: string, question?: string): Promise<CommandResult> {
    if (!url.startsWith('http')) url = `https://${url}`;
    const instruction = question?.trim()
      ? question.trim()
      : 'Summarize this page: what is it, and the key points. 3-5 sentences.';

    process.stdout.write(fmt.dim(`  Reading ${url}...\n`));
    const result = await fetchAndExtract(url, instruction);
    if (result.ok && result.text) {
      return { success: true, message: result.text, voiceMessage: result.text };
    }

    // Fall back to a real browser for JS-rendered / blocked pages
    log.debug(`fetch+extract failed (${result.error}) — falling back to browser`);
    process.stdout.write(fmt.dim('  (needs a browser — launching...)\n'));
    try {
      const { page } = await getBrowser(PROFILE);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.body.innerText.slice(0, 8000));
      const extract = await llmStreamChat(
        [{ role: 'user', content: `${instruction}\n\nPage content:\n${text}` }],
        'You extract and summarize web pages concisely. No markdown headers.',
        () => {},
        { model: FAST_MODEL, maxTokens: 1024 },
      );
      return { success: true, message: extract.trim(), voiceMessage: extract.trim() };
    } catch (err) {
      return { success: false, message: `Could not read ${url}: ${(err as Error).message}` };
    }
  }

  private async browse(url: string): Promise<CommandResult> {
    if (!url.startsWith('http')) url = `https://${url}`;
    process.stdout.write(fmt.dim(`  Navigating to ${url}...\n`));

    try {
      const { page } = await getBrowser(PROFILE);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const title = await page.title();
      return { success: true, message: `Opened: ${title}\n  URL: ${page.url()}` };
    } catch (err) {
      return { success: false, message: `Failed to navigate: ${(err as Error).message}` };
    }
  }

  private async google(query: string): Promise<CommandResult> {
    process.stdout.write(fmt.dim(`  Searching Google for "${query}"...\n`));

    try {
      const { page } = await getBrowser(PROFILE);
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Extract top results
      const results = await page.evaluate(() => {
        const items: Array<{ title: string; url: string; snippet: string }> = [];
        const els = document.querySelectorAll('div.g');
        for (let i = 0; i < Math.min(els.length, 5); i++) {
          const el = els[i];
          const titleEl = el.querySelector('h3');
          const linkEl = el.querySelector('a');
          const snippetEl = el.querySelector('[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"]');
          if (titleEl && linkEl) {
            items.push({
              title: titleEl.textContent || '',
              url: linkEl.getAttribute('href') || '',
              snippet: snippetEl?.textContent?.slice(0, 150) || '',
            });
          }
        }
        return items;
      });

      if (results.length === 0) {
        return { success: true, message: `No results extracted for "${query}". Page loaded — try "read page" for raw content.` };
      }

      const lines = results.map((r, i) =>
        `  ${i + 1}. ${r.title}\n     ${r.url}\n     ${r.snippet}`
      );
      return {
        success: true,
        message: `Google results for "${query}":\n\n${lines.join('\n\n')}`,
        data: results,
      };
    } catch (err) {
      return { success: false, message: `Search failed: ${(err as Error).message}` };
    }
  }

  private async readPage(): Promise<CommandResult> {
    if (!isOpen(PROFILE)) {
      return { success: false, message: 'No browser page open. Use "browse <url>" first.' };
    }

    try {
      const { page } = await getBrowser(PROFILE);
      const url = page.url();
      const title = await page.title();

      const text = await page.evaluate(() => {
        // Remove scripts, styles, nav, footer
        const remove = document.querySelectorAll('script, style, nav, footer, header, [role="navigation"], [role="banner"]');
        remove.forEach(el => el.remove());
        return document.body.innerText;
      });

      // Truncate for readability
      const cleaned = text
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .trim()
        .slice(0, 3000);

      const truncated = cleaned.length >= 3000 ? '\n  ... (truncated — page has more content)' : '';

      return {
        success: true,
        message: `Page: ${title}\nURL: ${url}\n\n${cleaned}${truncated}`,
        data: { title, url, text: cleaned },
      };
    } catch (err) {
      return { success: false, message: `Failed to read page: ${(err as Error).message}` };
    }
  }

  private async click(target: string): Promise<CommandResult> {
    if (!isOpen(PROFILE)) {
      return { success: false, message: 'No browser page open. Use "browse <url>" first.' };
    }

    try {
      const { page } = await getBrowser(PROFILE);

      // Try by visible text first
      try {
        await page.getByText(target, { exact: false }).first().click({ timeout: 5000 });
        const title = await page.title();
        return { success: true, message: `Clicked "${target}" — now on: ${title}` };
      } catch (err) {
        log.debug('Text click failed, trying CSS selector', err);
      }

      // Try as CSS selector
      try {
        await page.click(target, { timeout: 5000 });
        const title = await page.title();
        return { success: true, message: `Clicked element "${target}" — now on: ${title}` };
      } catch (err) {
        log.debug('CSS selector click failed, trying role', err);
      }

      // Try as button/link text
      try {
        const el = page.getByRole('link', { name: target }).or(page.getByRole('button', { name: target }));
        await el.first().click({ timeout: 5000 });
        const title = await page.title();
        return { success: true, message: `Clicked "${target}" — now on: ${title}` };
      } catch (err) {
        log.debug('Role-based click failed', err);
        return { success: false, message: `Could not find "${target}" on the page.` };
      }
    } catch (err) {
      return { success: false, message: `Click failed: ${(err as Error).message}` };
    }
  }

  private async fill(selector: string, value: string): Promise<CommandResult> {
    if (!isOpen(PROFILE)) {
      return { success: false, message: 'No browser page open. Use "browse <url>" first.' };
    }

    try {
      const { page } = await getBrowser(PROFILE);

      // Try as placeholder text first
      try {
        await page.getByPlaceholder(selector, { exact: false }).first().fill(value);
        return { success: true, message: `Filled "${selector}" with "${value}"` };
      } catch (err) { log.debug('Placeholder fill failed, trying label', err); }

      // Try as label
      try {
        await page.getByLabel(selector, { exact: false }).first().fill(value);
        return { success: true, message: `Filled "${selector}" with "${value}"` };
      } catch (err) { log.debug('Label fill failed, trying CSS', err); }

      // Try as CSS selector
      await page.fill(selector, value, { timeout: 5000 });
      return { success: true, message: `Filled "${selector}" with "${value}"` };
    } catch (err) {
      return { success: false, message: `Fill failed: ${(err as Error).message}` };
    }
  }

  private async screenshot(): Promise<CommandResult> {
    if (!isOpen(PROFILE)) {
      return { success: false, message: 'No browser page open. Use "browse <url>" first.' };
    }

    try {
      const { page } = await getBrowser(PROFILE);
      const filename = `jarvis-screenshot-${Date.now()}.png`;
      const filepath = join(homedir(), 'Desktop', filename);
      await page.screenshot({ path: filepath, fullPage: false });
      return { success: true, message: `Screenshot saved: ${filepath}` };
    } catch (err) {
      return { success: false, message: `Screenshot failed: ${(err as Error).message}` };
    }
  }

  private async close(): Promise<CommandResult> {
    if (!isOpen(PROFILE)) {
      return { success: true, message: 'Browser is not open.' };
    }
    await closeBrowser(PROFILE);
    return { success: true, message: 'Browser closed.' };
  }

  getHelp(): string {
    return [
      '  Browser Control',
      '    browse <url>              Open a website',
      '    google <query>            Google search + top results',
      '    read page                 Extract text from current page',
      '    click "<text>"            Click element by text or selector',
      '    fill "<field>" with "<v>" Fill a form field',
      '    screenshot                Save screenshot to Desktop',
      '    close browser             Close the browser',
    ].join('\n');
  }
}
