import { fetch as undiciFetch, Agent } from 'undici';
import { readJsonConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('llm');

// ── LLM Provider (Claude API) ──

// Default models. Sonnet for real conversation; Haiku for short/cheap work
// (message composition, intent classification, yes/no routing).
export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const FAST_MODEL = 'claude-haiku-4-5';

interface LLMConfig {
  provider: string;
  claudeApiKey?: string;
  claudeModel?: string;
}

let config: LLMConfig = {
  provider: 'claude',
  claudeModel: DEFAULT_MODEL,
};

function loadLLMConfig(): void {
  const data = readJsonConfig<LLMConfig>('llm-config.json', {} as LLMConfig);
  config = { ...config, ...data };
}

// Load config on module import
loadLLMConfig();

// Keep-alive connection pool so we don't pay a TLS handshake per message.
// JARVIS is long-lived, so idle connections to the API are kept warm.
//
// NOTE: we must use undici's OWN fetch with an explicit `dispatcher`. The
// userland `undici` package and Node's built-in global `fetch` keep their
// global dispatchers in DIFFERENT slots, so `setGlobalDispatcher` from this
// package would NOT attach to a bare `fetch()` call — it'd be a silent no-op.
// Passing the agent per-call guarantees the keep-alive pool is actually used.
const keepAliveAgent = new Agent({
  keepAliveTimeout: 60_000, // keep idle sockets 60s
  keepAliveMaxTimeout: 600_000,
});

export interface LLMOptions {
  /** Override the model (e.g. FAST_MODEL for cheap work). */
  model?: string;
  /** Cache the system prompt with an ephemeral breakpoint (default: true). */
  cache?: boolean;
  /** Max output tokens (default 4096). Lower = faster completion for short replies. */
  maxTokens?: number;
}

// Anthropic message content blocks (text + images for vision).
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

async function claudeStreamChat(
  messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>,
  systemPrompt: string,
  onToken: (token: string) => void,
  opts: LLMOptions = {},
): Promise<string> {
  if (!config.claudeApiKey) {
    throw new Error('Claude API key not configured. Set claudeApiKey in config/llm-config.json');
  }

  const model = opts.model || config.claudeModel || DEFAULT_MODEL;
  const cache = opts.cache !== false;

  // System prompt as an array with a cache breakpoint. The system prompt is the
  // large, byte-stable part of every call — caching it cuts input cost/latency.
  // Below ~1024 tokens the API simply ignores the breakpoint (no error).
  const system = cache
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
    : systemPrompt;

  const response = await undiciFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.claudeApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 4096,
      system,
      messages,
      stream: true,
    }),
    dispatcher: keepAliveAgent,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error: ${response.status} ${errText}`);
  }

  if (!response.body) throw new Error('No response body from Claude API');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let sseBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });

      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data) as {
            type: string;
            delta?: { type: string; text?: string };
            message?: { usage?: Record<string, number> };
          };

          // Confirm caching is working — logged at debug level only.
          if (parsed.type === 'message_start' && parsed.message?.usage) {
            const u = parsed.message.usage;
            log.debug(
              `usage model=${model} cache_read=${u.cache_read_input_tokens ?? 0} ` +
                `cache_write=${u.cache_creation_input_tokens ?? 0} input=${u.input_tokens ?? 0}`,
            );
          }

          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            fullText += parsed.delta.text;
            onToken(parsed.delta.text);
          }
        } catch {
          // Incomplete JSON — will be completed in next chunk
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullText;
}

let lastUsedLabel = '';

export function getLastUsedLabel(): string {
  return lastUsedLabel;
}

/**
 * Stream a chat completion from Claude.
 * @param opts.model  Override the model (e.g. FAST_MODEL for short/cheap work).
 * @param opts.cache  Cache the system prompt (default true).
 */
export async function llmStreamChat(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemPrompt: string,
  onToken: (token: string) => void,
  opts: LLMOptions = {},
): Promise<string> {
  lastUsedLabel = 'Claude (via API)';
  return claudeStreamChat(messages, systemPrompt, onToken, opts);
}

/** Convenience: one-shot completion on the fast/cheap model (Haiku). */
export async function llmQuick(prompt: string, systemPrompt = 'You are a helpful assistant.'): Promise<string> {
  return claudeStreamChat([{ role: 'user', content: prompt }], systemPrompt, () => {}, {
    model: FAST_MODEL,
  });
}

/**
 * Vision: send one or more base64 images plus a prompt to Claude. Reads images
 * DIRECTLY — no OCR step — so it's both faster (one call) and more accurate
 * (sees layout, buttons, icons). Used for screen reading.
 */
export async function llmVision(
  images: Array<{ data: string; mediaType?: string }>,
  prompt: string,
  systemPrompt = 'You are JARVIS analyzing a screenshot. Be concise and specific.',
  opts: LLMOptions = {},
): Promise<string> {
  const content: ContentBlock[] = [
    ...images.map((im) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: im.mediaType || 'image/png', data: im.data },
    })),
    { type: 'text' as const, text: prompt },
  ];
  lastUsedLabel = 'Claude (vision)';
  return claudeStreamChat([{ role: 'user', content }], systemPrompt, () => {}, opts);
}

let lastPrewarm = 0;
/**
 * Warm the keep-alive TLS socket to the Claude API. Called on wake-word
 * detection so the connection is hot by the time the user finishes speaking,
 * trimming time-to-first-token. Fire-and-forget, debounced, free (no tokens).
 */
export function prewarmLLM(): void {
  if (!config.claudeApiKey) return;
  const now = Date.now();
  if (now - lastPrewarm < 30_000) return;
  lastPrewarm = now;
  undiciFetch('https://api.anthropic.com/v1/models?limit=1', {
    method: 'GET',
    headers: { 'x-api-key': config.claudeApiKey, 'anthropic-version': '2023-06-01' },
    dispatcher: keepAliveAgent,
  })
    .then((r) => { void r.body?.cancel(); })
    .catch(() => {});
}

export async function isLLMAvailable(): Promise<boolean> {
  return !!config.claudeApiKey;
}

export function getActiveLLMProvider(): string {
  return 'Claude (via API)';
}

export function getLLMConfig(): LLMConfig {
  return { ...config };
}

export function setClaudeApiKey(key: string): void {
  config.claudeApiKey = key;
}

export function setLLMProvider(provider: string): void {
  config.provider = provider;
}
