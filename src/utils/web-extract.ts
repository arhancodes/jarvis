// ---------------------------------------------------------------------------
// Fetch + Claude extract — read a web page WITHOUT launching a browser
// ---------------------------------------------------------------------------
// For READING pages (static / server-rendered content), a plain fetch() plus
// Claude extraction is seconds faster than booting Chromium via Playwright.
// Returns ok:false for JS-heavy / blocked pages so callers can fall back to a
// real browser when needed.

import { createLogger } from './logger.js';
import { llmStreamChat, FAST_MODEL } from './llm.js';

const log = createLogger('web-extract');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Strip HTML down to readable text. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|article|section|br)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ExtractResult {
  ok: boolean;
  text?: string; // Claude's extraction/answer
  raw?: string; // the stripped page text
  error?: string;
}

/**
 * Fetch a URL and extract information with Claude — no browser.
 * @param instruction what to pull out / answer about the page.
 */
export async function fetchAndExtract(url: string, instruction: string): Promise<ExtractResult> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const html = await res.text();
    const text = htmlToText(html);
    // Very little text usually means a JS-rendered page — let the caller use a browser.
    if (text.length < 200) return { ok: false, error: 'thin content (likely JS-rendered)' };

    const extract = await llmStreamChat(
      [
        {
          role: 'user',
          content: `${instruction}\n\nPage content from ${url}:\n\n${text.slice(0, 30000)}`,
        },
      ],
      'You extract and summarize web page content accurately and concisely. No markdown headers, no preamble.',
      () => {},
      { model: FAST_MODEL, maxTokens: 1024 },
    );

    log.debug(`Extracted ${url} via fetch (no browser)`);
    return { ok: true, text: extract.trim(), raw: text };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
