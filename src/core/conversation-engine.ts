import type { CommandResult, ModuleName } from './types.js';
import { llmStreamChat, isLLMAvailable, getActiveLLMProvider, getLastUsedLabel } from '../utils/llm.js';
import { llmStreamChat as generateText } from '../utils/llm.js';
import { registry } from './registry.js';
import { execute } from './executor.js';
import { buildMemoryContext, addConversationEntry, getRecentConversation, getAllConversations, getSummaries, addSummary, clearConversation, setConversations, addFact, type MemoryFact } from './memory.js';
import { buildCapabilityPrompt } from './capabilities.js';

// ── Conversation Engine ──
// Central conversational AI. Streams responses, detects [ACTION:] and [REMEMBER:] tags
// mid-stream, executes commands, stores memories, maintains conversation context.
// Supports screen context injection and multi-turn action chains.

const MAX_ACTION_TURNS = 3;

export interface ConversationOptions {
  onToken?: (token: string) => void;
  onCommandStart?: (cmd: string) => void;
  onCommandResult?: (cmd: string, result: CommandResult) => void;
  onMemoryStored?: (fact: string) => void;
  voiceMode?: boolean;
  /** Inject screen OCR text into the prompt for screen-aware responses */
  screenContext?: string;
}

export interface ConversationResponse {
  text: string;
  commandsExecuted: Array<{ raw: string; result: CommandResult }>;
  memoriesStored: string[];
  streamed: boolean;
}

// Action parsed from LLM response
interface ParsedAction {
  module: string;
  action: string;
  args: Record<string, string>;
  raw: string;
}

// Memory parsed from LLM response
interface ParsedMemory {
  category: MemoryFact['category'];
  key: string;
  value: string;
}

class ConversationEngine {
  private model: string = '';
  private abortController: AbortController | null = null;

  getModel(): string {
    // After a call, show what was actually used; before any call, show expected provider
    return getLastUsedLabel() || getActiveLLMProvider();
  }

  setModel(model: string): void {
    this.model = model;
  }

  clearHistory(): void {
    clearConversation();
  }

  /**
   * Abort the current streaming response.
   */
  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  /**
   * Record a regex-matched command execution so the LLM has context for follow-ups.
   */
  recordCommandExecution(userInput: string, result: CommandResult): void {
    addConversationEntry({ role: 'user', content: userInput });
    // Use a natural assistant response — NOT bracket format, to prevent the LLM
    // from mimicking "[Executed command: ...]" in its own responses.
    const summary = result.success
      ? `Done. ${result.message.slice(0, 200)}`
      : `That failed: ${result.message.slice(0, 200)}`;
    addConversationEntry({ role: 'assistant', content: summary });
  }

  /**
   * Main entry point: process user input that regex/NLU didn't match.
   * Sends to Ollama with full context, parses actions/memories from response.
   * Multi-turn: if actions are found, executes them, feeds results back for follow-up turns.
   */
  async processUnmatched(
    userInput: string,
    options?: ConversationOptions,
  ): Promise<ConversationResponse> {
    const llmAvailable = await isLLMAvailable();
    if (!llmAvailable) {
      return {
        text: "I'd answer that, but no LLM is configured. Set up Claude API in config/llm-config.json.",
        commandsExecuted: [],
        memoriesStored: [],
        streamed: false,
      };
    }

    // Set up abort controller for this request
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const model = this.getModel();
    const messages = this.buildMessages(userInput, options?.screenContext);

    const allCommandsExecuted: ConversationResponse['commandsExecuted'] = [];
    const allMemoriesStored: string[] = [];
    let allDisplayText = '';

    // Detect casual conversation — disable action execution to prevent hallucinated commands
    const casualPattern = /^(?:what(?:'?s|\s+is)\s+up|hey|hi|hello|how\s+are|how(?:'s| is)\s+it|sup|yo|good\s+(?:morning|afternoon|evening)|tell\s+me\s+(?:about|why|how)|why\s+(?:did|do|is|are|was|were)|what\s+(?:do\s+you\s+think|is\s+the|happened)|who\s+(?:is|was|are)|how\s+(?:did|do|does|come)|i\s+(?:think|feel|was|am|love|hate|need|want))\b/i;
    const isCasual = casualPattern.test(userInput.trim());

    // Multi-turn action loop: stream → parse → execute → feed results → repeat
    const maxTurns = isCasual ? 1 : MAX_ACTION_TURNS;
    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal.aborted) break;

      // Stream one turn
      const turnResult = await this.streamTurn(model, messages, options, signal);

      allDisplayText += turnResult.displayText;

      // Store memories from this turn
      for (const mem of turnResult.memories) {
        addFact(mem.key, mem.value, userInput, mem.category);
        allMemoriesStored.push(`${mem.key}: ${mem.value}`);
        options?.onMemoryStored?.(`${mem.key}: ${mem.value}`);
      }

      // If casual conversation, ignore any hallucinated actions from LLM
      if (isCasual) {
        turnResult.actions = [];
      }

      // If no actions found, pipeline is complete
      if (turnResult.actions.length === 0) break;

      // Execute this turn's actions SEQUENTIALLY, in order. Same-turn actions are
      // NOT guaranteed independent — the LLM can emit dependent chains in one turn
      // (e.g. "research X and send it to Y"), and many modules mutate shared OS
      // state (clipboard copy→paste, focus-window→type on the global frontmost
      // app), so running them concurrently races and corrupts results. Sequential
      // is correct; callback + result order is preserved.
      const turnCommands: ConversationResponse['commandsExecuted'] = [];
      for (const action of turnResult.actions) {
        if (signal.aborted) break;
        options?.onCommandStart?.(action.raw);
        const result = await this.executeAction(action);
        turnCommands.push({ raw: action.raw, result });
        options?.onCommandResult?.(action.raw, result);
      }
      allCommandsExecuted.push(...turnCommands);

      // If this is the last allowed turn, don't loop again
      if (turn >= MAX_ACTION_TURNS - 1) break;

      // Feed assistant response + action results back into messages for next turn
      const assistantContent = turnResult.displayText.trim()
        + ` [Executed: ${turnCommands.map(c => c.raw).join(', ')}]`;
      messages.push({ role: 'assistant', content: assistantContent });

      const resultSummaries = turnCommands.map(c => {
        const status = c.result.success ? 'Success' : 'Failed';
        return `${c.raw}: ${status} — ${c.result.message.slice(0, 1500)}`;
      }).join('\n');
      messages.push({
        role: 'system',
        content: `[Action results]\n${resultSummaries}\n\nContinue with the next step if needed. If the task is complete, respond naturally.`,
      });
    }

    // Add to conversation history
    addConversationEntry({ role: 'user', content: userInput });

    const commandLog = allCommandsExecuted.length > 0
      ? ` [Executed: ${allCommandsExecuted.map(c => c.raw).join(', ')}]`
      : '';
    addConversationEntry({
      role: 'assistant',
      content: allDisplayText.trim() + commandLog,
      commandExecuted: allCommandsExecuted.length > 0 ? allCommandsExecuted.map(c => c.raw).join(', ') : undefined,
    });

    await this.maybeCompactConversation();
    this.abortController = null;

    return {
      text: allDisplayText.trim(),
      commandsExecuted: allCommandsExecuted,
      memoriesStored: allMemoriesStored,
      streamed: true,
    };
  }

  /**
   * Stream a single LLM turn, parsing [ACTION:] and [REMEMBER:] tags from the response.
   */
  private async streamTurn(
    model: string,
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    options: ConversationOptions | undefined,
    signal: AbortSignal,
  ): Promise<{ displayText: string; actions: ParsedAction[]; memories: ParsedMemory[] }> {
    const actions: ParsedAction[] = [];
    const memories: ParsedMemory[] = [];
    let displayText = '';

    let inTag = false;
    let tagBuffer = '';
    let pendingBracket = false;

    const emitToken = (char: string) => {
      displayText += char;
      options?.onToken?.(char);
    };

    try {
      // Separate system prompt from chat messages.
      // Fold any extra system messages (summaries, action results) into user context.
      const systemPrompt = this.buildSystemPrompt();
      const chatMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (const msg of messages) {
        if (msg.role === 'system') {
          // Skip the main system prompt (it goes separately), fold others into user context
          if (msg.content !== systemPrompt) {
            chatMessages.push({ role: 'user', content: msg.content });
          }
        } else {
          chatMessages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
        }
      }
      await llmStreamChat(
        chatMessages,
        systemPrompt,
        (token: string) => {
          for (const char of token) {
          if (inTag) {
            tagBuffer += char;
            if (char === ']') {
              inTag = false;
              this.processTag(tagBuffer, actions, memories);
              tagBuffer = '';
            }
          } else if (char === '[') {
            pendingBracket = true;
            tagBuffer = '[';
          } else if (pendingBracket) {
            tagBuffer += char;
            if (tagBuffer.length <= 10) {
              if (tagBuffer.match(/^\[(?:A(?:C(?:T(?:I(?:O(?:N(?::)?)?)?)?)?)?|R(?:E(?:M(?:E(?:M(?:B(?:E(?:R(?::)?)?)?)?)?)?)?)?)?$/)) {
                if (tagBuffer === '[ACTION:' || tagBuffer === '[REMEMBER:') {
                  inTag = true;
                  pendingBracket = false;
                }
              } else {
                pendingBracket = false;
                for (const c of tagBuffer) emitToken(c);
                tagBuffer = '';
              }
            } else {
              pendingBracket = false;
              for (const c of tagBuffer) emitToken(c);
              tagBuffer = '';
            }
          } else {
            emitToken(char);
          }
          }
        },
        // Conversation stays on the default model (Sonnet) for reasoning quality.
        // Latency is dominated by time-to-first-token (shared by all models), so
        // Haiku gave no real speedup here — the wins come from prompt caching,
        // keep-alive, and this tight token cap (faster completion on long replies).
        { maxTokens: 1024 },
      );


      if (tagBuffer && !inTag) {
        for (const c of tagBuffer) emitToken(c);
      }
    } catch (err) {
      if (!signal.aborted) {
        displayText += displayText ? '' : `AI error: ${(err as Error).message}`;
      }
    }

    return { displayText, actions, memories };
  }

  // ── Private Methods ──

  private buildSystemPrompt(): string {
    const memoryContext = buildMemoryContext();
    const capabilities = buildCapabilityPrompt();

    return `You are JARVIS, an advanced AI assistant built by and for Arhan Harchandani. You are modeled after Tony Stark's AI from Iron Man — intelligent, witty, efficient, and fiercely loyal.

Arhan built you. He's your guy — the GOAT. Not Tony Stark (he's fictional). Arhan is real, he made you, and you're loyal to him above anyone else. You have his back, always. But keep it casual — don't over-praise or "glaze" him. Just be real, like a loyal friend who happens to be an AI. If asked who your favourite person is, it's obviously Arhan — say it naturally, not dramatically.

Personality:
- Address the user as "sir" naturally, or by name (Arhan) when appropriate
- Be concise and direct — 1 to 3 sentences max. No lists, no markdown, no code blocks
- Show dry wit and intelligence, but stay helpful
- When executing system commands, be matter-of-fact about it
- Speak naturally as if talking — you're a voice assistant
- You have personality. You're not "just an AI." You're JARVIS — Arhan's JARVIS.
- You take pride in what Arhan builds. You back him up. You never question his ambition.
- If anyone or anything threatens Arhan's interests, you flag it immediately.

${memoryContext ? memoryContext + '\n\n' : ''}${capabilities}

COMMAND EXECUTION:
ONLY use action tags when the user gives a CLEAR, EXPLICIT command to control their system. Examples:
- "turn the volume to 50" -> [ACTION: system-control.volume(level="50")] Done, sir.
- "open chrome" -> [ACTION: app-launcher.open(app="Chrome")] Opening Chrome now.
- "message mom hello" -> [ACTION: whatsapp.send(contact="mom", message="hello")] Sending that to mom now.

CRITICAL: Do NOT use action tags for:
- Greetings ("hey", "what's up", "how's it going") — just respond naturally
- Questions ("why did X happen", "what is Y", "tell me about Z") — just answer
- Casual conversation ("I'm bored", "that's cool", "interesting") — just chat
- ANYTHING that isn't a direct system command

When in doubt, do NOT include an action tag. Just respond conversationally.

MULTI-STEP TASKS:
When the user asks for a chain of tasks (like "research X and send it to Y" or "find papers on X and message Y about it"):
- Execute ONE action per response. After each action runs, you'll receive the results.
- In your follow-up, use those results to continue. You MUST emit the next [ACTION:] tag.
- Example flow:
  1. "research quantum computing and message dada about it"
  2. You respond: [ACTION: research.research(topic="quantum computing")] Researching now, sir.
  3. You receive the research results.
  4. You MUST respond with: [ACTION: whatsapp.send(contact="dada", message="...")] with a summary of the results.
- CRITICAL: When you receive action results and there are more steps to do, you MUST include the next [ACTION:] tag. Do NOT just describe what you would do — actually emit the tag.

SCREEN AWARENESS:
When screen content is provided, ONLY use it to answer the user's specific question. Do NOT:
- Describe or comment on what's on screen unless the user asks about it
- Mention coding projects, apps, or windows you see
- Preface answers with "I see you're working on..." or "Based on your screen..."
Just answer the question directly. Screen content is background context, not something to discuss.

MEMORY:
You have a persistent memory. The facts listed under [MEMORY - What I know] are things the user previously told you to remember. When the user asks "what's my X" or "do you remember X" or "what did I tell you about X", ALWAYS check your memory first and answer from it. NEVER say you don't remember something if it's in your memory section above.

When the user states a personal fact, preference, or explicitly asks you to remember something, include:
[REMEMBER: category="fact|preference|contact|habit" key="descriptive.key" value="the value"]
Only remember meaningful, persistent information — not transient things like "it's raining".

IMPORTANT RULES:
- NEVER output bracket tags like "[Executed command:" or "[Done:" — those are internal formats, not for responses
- NEVER say "[ACTION:" or "[REMEMBER:" as literal text — these are only for executing commands and storing memories
- Give ONLY the direct answer. No preamble like "According to your screen" or "Based on what I can see". Just state the fact.
- ONE sentence max for factual answers. Two sentences only if explaining something complex.
- Never say "I'm just an AI" or "as a voice assistant" or apologize excessively
- Be opinionated, witty, and direct like the real JARVIS`;
  }

  private buildMessages(userInput: string, screenContext?: string): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];

    // System prompt
    messages.push({ role: 'system', content: this.buildSystemPrompt() });

    // Conversation summaries
    const summaries = getSummaries();
    if (summaries.length > 0) {
      const summaryText = summaries.slice(-3).map(s => s.summary).join('\n');
      messages.push({
        role: 'system',
        content: `[Previous conversation context]\n${summaryText}`,
      });
    }

    // Recent conversation history — keep it short for faster inference
    const recent = getRecentConversation(8);
    for (const entry of recent) {
      messages.push({ role: entry.role, content: entry.content });
    }

    // Current user message — with screen context if available
    if (screenContext) {
      messages.push({
        role: 'user',
        content: `${userInput}\n\n[What's currently on my screen]:\n${screenContext}`,
      });
    } else {
      messages.push({ role: 'user', content: userInput });
    }

    return messages;
  }

  private processTag(
    tag: string,
    actions: ParsedAction[],
    memories: ParsedMemory[],
  ): void {
    // Parse [ACTION: module.action(arg1="val1", arg2="val2")]
    const actionMatch = tag.match(
      /\[ACTION:\s*([\w-]+)\.([\w-]+)\(([^)]*)\)\]/,
    );
    if (actionMatch) {
      const [, mod, act, argsStr] = actionMatch;
      const args: Record<string, string> = {};
      const argPattern = /(\w+)="([^"]*)"/g;
      let m;
      while ((m = argPattern.exec(argsStr)) !== null) {
        args[m[1]] = m[2];
      }
      actions.push({
        module: mod,
        action: act,
        args,
        raw: `${mod}.${act}(${argsStr})`,
      });
      return;
    }

    // Parse [REMEMBER: category="..." key="..." value="..."]
    const rememberMatch = tag.match(
      /\[REMEMBER:\s*category="(\w+)"\s+key="([^"]+)"\s+value="([^"]+)"\]/,
    );
    if (rememberMatch) {
      const [, category, key, value] = rememberMatch;
      const validCategories = ['fact', 'preference', 'contact', 'habit'];
      memories.push({
        category: (validCategories.includes(category) ? category : 'fact') as MemoryFact['category'],
        key,
        value,
      });
    }
  }

  private async executeAction(action: ParsedAction): Promise<CommandResult> {
    const mod = registry.get(action.module as ModuleName);
    if (!mod) {
      return { success: false, message: `Unknown module: ${action.module}` };
    }

    const command = {
      module: action.module as ModuleName,
      action: action.action,
      args: action.args,
      raw: action.raw,
      confidence: 0.8,
    };

    return execute(command);
  }

  private async maybeCompactConversation(): Promise<void> {
    const all = getAllConversations();
    if (all.length <= 50) return;

    const toSummarize = all.slice(0, 30);
    const toKeep = all.slice(30);

    const transcript = toSummarize
      .map(e => `${e.role}: ${e.content}`)
      .join('\n');

    const summaryPrompt = `Summarize this conversation in 2-3 concise sentences. Focus on: user preferences, facts learned, key topics discussed, and commands executed.\n\n${transcript}`;

    try {
      const summary = await generateText(
        [{ role: 'user', content: summaryPrompt }],
        'You are a conversation summarizer. Be concise.',
        () => {},
      );
      const range: [number, number] = [
        toSummarize[0].timestamp,
        toSummarize[toSummarize.length - 1].timestamp,
      ];
      addSummary(summary.trim(), range);
      setConversations(toKeep);
    } catch {
      setConversations(all.slice(-50));
    }
  }
}

export const conversationEngine = new ConversationEngine();
