import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { run } from '../utils/shell.js';
import { fmt } from '../utils/formatter.js';
import { isLLMAvailable, llmStreamChat, llmVision } from '../utils/llm.js';
import { conversationEngine } from '../core/conversation-engine.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync, readFileSync } from 'fs';
import { createLogger } from '../utils/logger.js';

const log = createLogger('screen-awareness');

// ── Screen Awareness Module ──
// OCR-based screen reading using macOS Vision framework.
// Supports: raw OCR, AI summaries, screen Q&A, typing suggestions,
// and screen-aware conversational mode.

/**
 * Capture screenshot and run OCR. Exported so other modules can use it.
 */
export async function captureScreenText(): Promise<string> {
  const tmpFile = join(tmpdir(), `jarvis-ocr-${Date.now()}.png`);

  try {
    const capture = await run(`screencapture -x "${tmpFile}"`, { timeout: 5000 });
    if (capture.exitCode !== 0) {
      throw new Error('Failed to capture screenshot');
    }

    // macOS Vision framework OCR
    const visionResult = await run(
      `swift -e '
import Vision
import AppKit
let img = NSImage(contentsOfFile: "${tmpFile}")!
let cgImg = img.cgImage(forProposedRect: nil, context: nil, hints: nil)!
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
try VNImageRequestHandler(cgImage: cgImg).perform([req])
let text = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\\n")
print(text)
'`,
      { timeout: 15000 },
    );

    if (visionResult.exitCode === 0 && visionResult.stdout.trim()) {
      return visionResult.stdout.trim();
    }

    // Fallback: Tesseract
    const tesseractCheck = await run('which tesseract 2>/dev/null');
    if (tesseractCheck.exitCode === 0) {
      const tessResult = await run(`tesseract "${tmpFile}" stdout 2>/dev/null`, { timeout: 15000 });
      if (tessResult.exitCode === 0 && tessResult.stdout.trim()) {
        return tessResult.stdout.trim();
      }
    }

    throw new Error('OCR failed. macOS Vision could not read the screen.');
  } finally {
    try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch (err) { log.debug('Failed to clean up OCR temp file', err); }
  }
}

/**
 * Capture a screenshot and return it as base64 PNG for Claude vision.
 * Downscaled to 1568px (Claude's optimal max) so it's small and fast — no OCR
 * pass needed. Exported so other modules can reuse the vision path.
 */
export async function captureScreenImage(): Promise<{ data: string; mediaType: string }> {
  const tmpFile = join(tmpdir(), `jarvis-shot-${Date.now()}.png`);
  try {
    const capture = await run(`screencapture -x "${tmpFile}"`, { timeout: 5000 });
    if (capture.exitCode !== 0 || !existsSync(tmpFile)) {
      throw new Error('Failed to capture screenshot');
    }
    // Downscale so the largest side is 1568px — keeps the image small (faster
    // upload) without losing detail Claude would use. sips is built into macOS.
    await run(`sips -Z 1568 "${tmpFile}" >/dev/null 2>&1`, { timeout: 5000 });
    const data = readFileSync(tmpFile).toString('base64');
    return { data, mediaType: 'image/png' };
  } finally {
    try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch (err) { log.debug('Failed to clean up screenshot temp file', err); }
  }
}

export class ScreenAwarenessModule implements JarvisModule {
  name = 'screen-awareness' as const;
  description = 'Read and understand screen content via OCR';

  patterns: PatternDefinition[] = [
    {
      // RAW OCR dump (only when explicitly asked for the text) — not for questions.
      intent: 'read-screen',
      patterns: [
        /^read\s+(?:my\s+|the\s+)?screen$/i,
        /^screen\s+(?:text|content|read)$/i,
        /^ocr$/i,
      ],
      extract: () => ({}),
    },
    {
      // Questions about the screen -> concise Claude-vision summary (NOT a raw dump).
      intent: 'summarize-screen',
      patterns: [
        /^summarize\s+(?:my\s+|the\s+)?screen$/i,
        /^what(?:'?s| is)\s+on\s+(?:my\s+|the\s+)?screen$/i,
        /^what\s+am\s+i\s+(?:looking\s+at|viewing|reading)$/i,
        /^(?:what(?:'?s| is)\s+)?(?:happening|going on)\s+(?:on\s+)?(?:my\s+)?screen$/i,
        /^screen\s+summary$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'ask-screen',
      patterns: [
        /^(?:on\s+(?:my\s+)?screen|screen)\s+(.+)/i,
        /^(?:from\s+(?:the\s+)?screen)\s+(.+)/i,
      ],
      extract: (match) => ({ question: match[1].trim() }),
    },
    {
      intent: 'suggest',
      patterns: [
        // Only fire when the user EXPLICITLY references their screen / code / work.
        // Bare "what do you think" is intentionally NOT here — that's a general
        // question and must go to Claude (e.g. "what do you think about Trump").
        /^what\s+do\s+you\s+think\s+(?:of|about)\s+(?:my\s+screen|this\s+(?:code|screen|page|error))\b/i,
        /^(?:any\s+|give\s+me\s+)?(?:thoughts|feedback|suggestions?|input)\s+(?:on|about)\s+(?:my\s+screen|this\s+(?:code|screen|page|error)|what\s+i(?:'m| am)\s+working\s+on)\b/i,
        /^(?:review|check|look\s+at)\s+(?:my\s+screen|this\s+(?:code|screen|page)|what\s+i(?:'m| am)\s+(?:typing|writing|working\s+on|doing))\b/i,
        /^how\s+does\s+(?:my\s+screen|this\s+(?:code|page))\s+look[?]?$/i,
        /^what\s+(?:am\s+i|do\s+you\s+think\s+i(?:'m| am))\s+working\s+on[?]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'screen-question',
      patterns: [
        /^what(?:'s| is)\s+this\s+(?:error|warning|message|notification)[?]?$/i,
        /^what\s+does\s+this\s+(?:mean|say|error\s+mean)[?]?$/i,
        /^why\s+(?:isn't|is\s*n't|is not|won't|can't)\s+(?:this|it)\s+working[?]?$/i,
        /^(?:can\s+you\s+)?(?:explain|read)\s+(?:this|what(?:'s| is)\s+on\s+(?:my\s+)?screen)/i,
        /^what(?:'s| is)\s+(?:wrong|the\s+(?:error|issue|problem))\s+(?:here|with\s+this)[?]?$/i,
        /^(?:debug|fix)\s+this$/i,
      ],
      extract: (match) => ({ question: match[0].trim() }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'read-screen':
        return this.readScreen();
      case 'summarize-screen':
        return this.summarizeScreen();
      case 'ask-screen':
        return this.askAboutScreen(command.args.question);
      case 'suggest':
        return this.suggestFromScreen();
      case 'screen-question':
        return this.screenConversation(command.args.question);
      default:
        return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  // ── Commands ──

  private async readScreen(): Promise<CommandResult> {
    try {
      console.log(fmt.dim('  [screen] Capturing and reading screen...'));
      const text = await captureScreenText();

      if (!text) {
        return { success: false, message: 'No text found on screen.' };
      }

      const truncated = text.length > 2000 ? text.slice(0, 2000) + '\n...(truncated)' : text;
      // Show the full text on screen, but DON'T read the whole dump aloud —
      // speak a short line instead (use "summarize my screen" for a spoken summary).
      return {
        success: true,
        message: `Screen text:\n${truncated}`,
        voiceMessage: 'The screen text is on your terminal, sir. Say "summarize my screen" for a quick rundown.',
      };
    } catch (err) {
      return { success: false, message: `Screen read error: ${(err as Error).message}` };
    }
  }

  private async summarizeScreen(): Promise<CommandResult> {
    return this.analyzeScreen(
      'Briefly summarize what is on this screen in 2-3 sentences. What app or page is the user looking at, and what is the main content?',
    );
  }

  private async askAboutScreen(question: string): Promise<CommandResult> {
    return this.analyzeScreen(question);
  }

  /**
   * Analyze the screen and answer a question. Tries Claude VISION first — one
   * call that reads the screenshot directly (faster, and it sees layout/buttons/
   * icons OCR throws away) — and falls back to OCR -> text LLM if vision fails.
   */
  private async analyzeScreen(question: string): Promise<CommandResult> {
    if (!(await isLLMAvailable())) {
      return { success: false, message: 'Claude API is not configured.' };
    }

    // Vision path (preferred)
    try {
      console.log(fmt.dim('  [screen] Looking at your screen...'));
      const img = await captureScreenImage();
      const answer = await llmVision(
        [img],
        question,
        "You are JARVIS analyzing the user's screen. Answer concisely (2-3 sentences). Be specific about what you see — apps, windows, content, UI elements. No markdown.",
      );
      if (answer?.trim()) {
        return { success: true, message: answer.trim(), voiceMessage: answer.trim() };
      }
    } catch (err) {
      log.debug('Vision screen analysis failed — falling back to OCR', err);
    }

    // OCR fallback
    try {
      const text = await captureScreenText();
      if (!text) {
        return { success: false, message: "I can't see anything readable on your screen." };
      }
      return this.askOllamaAboutScreen(text, question);
    } catch (err) {
      return { success: false, message: `Screen error: ${(err as Error).message}` };
    }
  }

  /**
   * "What do you think?" — Capture screen, detect what user is working on,
   * give intelligent suggestions/feedback using conversation engine (full JARVIS personality).
   */
  private async suggestFromScreen(): Promise<CommandResult> {
    try {
      console.log(fmt.dim('  [screen] Reading what you\'re working on...'));
      const text = await captureScreenText();
      if (!text) {
        return { success: false, message: 'I can\'t see anything on your screen to comment on.' };
      }

      const truncText = text.length > 3000 ? text.slice(0, 3000) : text;

      // Route through conversation engine for full JARVIS personality + memory context
      process.stdout.write(fmt.dim(`  [${conversationEngine.getModel()}]\n`));
      process.stdout.write('  ');

      const response = await conversationEngine.processUnmatched(
        'Look at what I\'m working on and give me your thoughts, suggestions, or feedback. Be specific about what you see.',
        {
          screenContext: truncText,
          onToken: (token) => process.stdout.write(token),
          onCommandStart: (cmd) => {
            process.stdout.write('\n');
            console.log(fmt.dim(`  [executing: ${cmd}]`));
          },
          onCommandResult: (_cmd, result) => {
            if (result.success && !result.streamed) console.log(fmt.success(result.message));
            else if (!result.success) console.log(fmt.error(result.message));
          },
        },
      );

      process.stdout.write('\n\n');
      return { success: true, message: response.text, streamed: true };
    } catch (err) {
      return { success: false, message: `Screen error: ${(err as Error).message}` };
    }
  }

  /**
   * Screen-aware conversation — "what's this error?", "why isn't this working?", "debug this"
   * Captures screen and routes through conversation engine with full context.
   */
  private async screenConversation(question: string): Promise<CommandResult> {
    try {
      console.log(fmt.dim('  [screen] Capturing screen...'));
      const text = await captureScreenText();
      if (!text) {
        return { success: false, message: 'No text found on screen.' };
      }

      const truncText = text.length > 3000 ? text.slice(0, 3000) : text;

      process.stdout.write(fmt.dim(`  [${conversationEngine.getModel()}]\n`));
      process.stdout.write('  ');

      const response = await conversationEngine.processUnmatched(question, {
        screenContext: truncText,
        onToken: (token) => process.stdout.write(token),
        onCommandStart: (cmd) => {
          process.stdout.write('\n');
          console.log(fmt.dim(`  [executing: ${cmd}]`));
        },
        onCommandResult: (_cmd, result) => {
          if (result.success && !result.streamed) console.log(fmt.success(result.message));
          else if (!result.success) console.log(fmt.error(result.message));
        },
      });

      process.stdout.write('\n\n');
      return { success: true, message: response.text, streamed: true };
    } catch (err) {
      return { success: false, message: `Screen error: ${(err as Error).message}` };
    }
  }

  private async askOllamaAboutScreen(screenText: string, question: string): Promise<CommandResult> {
    const llmUp = await isLLMAvailable();
    if (!llmUp) {
      return { success: true, message: `Screen text (Claude API is not configured for summary):\n${screenText.slice(0, 1500)}` };
    }

    const truncText = screenText.length > 3000 ? screenText.slice(0, 3000) : screenText;

    const messages: {role: 'user'|'assistant', content: string}[] = [
      {
        role: 'user',
        content: `${question}\n\nScreen content:\n${truncText}`,
      },
    ];

    try {
      process.stdout.write(fmt.dim(`  [llm]\n`));
      process.stdout.write('  ');

      const fullResponse = await llmStreamChat(messages, 'You are JARVIS, a witty and intelligent AI assistant. Analyze the screen content and answer concisely (2-3 sentences). Be specific about what you see. No markdown.', (token: string) => {
        process.stdout.write(token);
      });

      process.stdout.write('\n\n');
      return { success: true, message: fullResponse.trim(), streamed: true };
    } catch (err) {
      return { success: false, message: `AI error: ${(err as Error).message}` };
    }
  }

  getHelp(): string {
    return [
      '  Screen Awareness — OCR screen reading & AI feedback',
      '    read screen              Read all text on screen',
      '    summarize screen         AI summary of what\'s on screen',
      '    screen <question>        Ask a question about screen content',
      '    what do you think        Get feedback on what you\'re working on',
      '    what\'s this error        AI explains errors/issues on screen',
      '    help me with this        Screen-aware AI assistance',
    ].join('\n');
  }
}
