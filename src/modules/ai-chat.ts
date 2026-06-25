import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { llmStreamChat, isLLMAvailable, getActiveLLMProvider } from '../utils/llm.js';
import { fmt } from '../utils/formatter.js';
import { conversationEngine } from '../core/conversation-engine.js';
import { clearConversation, getRecentConversation } from '../core/memory.js';

const MAX_FILE_CHARS = 50_000;

let lastStreamedText = '';

export function getLastStreamedText(): string {
  return lastStreamedText;
}

export function getActiveModel(): string {
  return 'claude';
}

function resolvePath(p: string): string {
  if (p.startsWith('~')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

export class AIChatModule implements JarvisModule {
  name = 'ai-chat' as const;
  description = 'Chat with AI via Claude API';

  patterns: PatternDefinition[] = [
    {
      intent: 'ask',
      patterns: [
        // Exclude "ai status" -> that's the ai-status intent below.
        /^(?:ask|ai|chat)\s+(?!status\b)(.+)/i,
        /^(?:hey\s+)?jarvis[,]?\s+(?:can you|please|could you)\s+(.+)/i,
      ],
      extract: (match) => ({ prompt: (match[1] || match[2]).trim() }),
    },
    {
      intent: 'summarize',
      patterns: [
        // Exclude screen references (-> screen-awareness vision) and bare URLs
        // (-> browser-control read-url, the browserless fetch).
        /^summarize\s+(?:file\s+)?(?!(?:this|that|it|the\s+text|selection|the\s+selection|(?:my\s+|the\s+)?screen|(?:https?:\/\/)?[\w-]+\.(?:com|org|net|io|dev|ai|co|app|gov|edu|me)\S*)\s*$)(.+)/i,
        /^(?:give\s+me\s+a\s+)?summary\s+(?:of\s+)?(?!(?:this|that|it|the\s+text|selection|(?:my\s+|the\s+)?screen)\s*$)(.+)/i,
        /^tldr\s+(.+)/i,
      ],
      extract: (match) => ({ file: (match[1] || match[2] || match[3]).trim() }),
    },
    {
      intent: 'explain',
      patterns: [
        /^explain\s+(?:file\s+)?(?!(?:this|that|it|the\s+text|selection|the\s+selection|(?:my\s+|the\s+)?screen)\s*$)(.+)/i,
        // Exclude screen questions (screen-awareness) and calendar lookups
        // (calendar) — both are registered to handle those more specifically.
        /^what(?:'?s|\s+(?:is|does|are))\s+(?!on\s+(?:my\s+|the\s+)?(?:screen|calendar|schedule|agenda)\b)(?!(?:my\s+|the\s+)?next\s+(?:meeting|event|appointment|class))(.+)/i,
      ],
      extract: (match) => ({ file: (match[1] || match[2]).trim() }),
    },
    {
      intent: 'clear-chat',
      patterns: [
        /^(?:clear|reset)\s+(?:chat|conversation|history)/i,
        /^new\s+conversation/i,
        /^forget\s+(?:everything|conversation)/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'ai-status',
      patterns: [
        /^ai\s+status$/i,
        /^llm\s+status$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'ask':          return this.handleAsk(command.args.prompt);
      case 'summarize':    return this.handleSummarize(command.args.file);
      case 'explain':      return this.handleExplain(command.args.file);
      case 'clear-chat':   return this.handleClearChat();
      case 'ai-status':    return this.handleStatus();
      default:
        return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private async ensureLLM(): Promise<boolean> {
    return isLLMAvailable();
  }

  private llmNotAvailable(): CommandResult {
    return {
      success: false,
      message: 'Claude API is not configured. Set your API key in config/llm-config.json to enable AI features.',
    };
  }

  private async handleAsk(prompt: string): Promise<CommandResult> {
    if (!(await this.ensureLLM())) return this.llmNotAvailable();

    try {
      process.stdout.write(fmt.dim(`  [${conversationEngine.getModel()}]\n`));
      process.stdout.write('  ');

      const response = await conversationEngine.processUnmatched(prompt, {
        onToken: (token) => process.stdout.write(token),
        onCommandStart: (cmd) => {
          process.stdout.write('\n');
          console.log(fmt.dim(`  [executing: ${cmd}]`));
        },
        onCommandResult: (_cmd, result) => {
          if (result.success && !result.streamed) console.log(fmt.success(result.message));
        },
        onMemoryStored: (fact) => {
          console.log(fmt.dim(`  [remembered: ${fact}]`));
        },
      });

      process.stdout.write('\n\n');
      lastStreamedText = response.text;

      return { success: true, message: '', streamed: true };
    } catch (err) {
      return { success: false, message: `AI error: ${(err as Error).message}` };
    }
  }

  private async handleSummarize(target: string): Promise<CommandResult> {
    if (!(await this.ensureLLM())) return this.llmNotAvailable();

    const resolved = resolvePath(target);
    if (existsSync(resolved)) {
      return this.generateFromFile(resolved, 'Summarize the following content concisely. Provide key points and a brief overview:\n\n');
    }
    try {
      process.stdout.write('  ');
      const response = await llmStreamChat(
        [{ role: 'user', content: `Summarize the following topic concisely: ${target}` }],
        'You are a helpful assistant. Be concise.',
        (token) => process.stdout.write(token),
      );
      process.stdout.write('\n\n');
      lastStreamedText = response;
      return { success: true, message: '', streamed: true };
    } catch (err) {
      return { success: false, message: `AI error: ${(err as Error).message}` };
    }
  }

  private async handleExplain(target: string): Promise<CommandResult> {
    if (!(await this.ensureLLM())) return this.llmNotAvailable();

    const resolved = resolvePath(target);
    if (existsSync(resolved)) {
      return this.generateFromFile(resolved, 'Explain the following code. Describe what it does, key patterns used, and anything noteworthy:\n\n');
    }
    try {
      process.stdout.write('  ');
      const response = await llmStreamChat(
        [{ role: 'user', content: `Explain the following clearly and concisely: ${target}` }],
        'You are a helpful assistant. Be clear and concise.',
        (token) => process.stdout.write(token),
      );
      process.stdout.write('\n\n');
      lastStreamedText = response;
      return { success: true, message: '', streamed: true };
    } catch (err) {
      return { success: false, message: `AI error: ${(err as Error).message}` };
    }
  }

  private async generateFromFile(filePath: string, systemPrompt: string): Promise<CommandResult> {
    try {
      let content = readFileSync(filePath, 'utf-8');
      let note = '';
      if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS);
        note = ' (Note: file was truncated to first 50,000 characters)';
      }

      process.stdout.write(fmt.dim(`  [Claude] Processing ${filePath}...${note}\n`));
      process.stdout.write('  ');

      const fullResponse = await llmStreamChat(
        [{ role: 'user', content: systemPrompt + content }],
        'You are a helpful assistant.',
        (token) => { process.stdout.write(token); },
      );

      process.stdout.write('\n\n');
      lastStreamedText = fullResponse;
      return { success: true, message: '', streamed: true };
    } catch (err) {
      return { success: false, message: `AI error: ${(err as Error).message}` };
    }
  }

  private handleClearChat(): CommandResult {
    conversationEngine.clearHistory();
    clearConversation();
    return { success: true, message: 'Conversation history cleared.' };
  }

  private async handleStatus(): Promise<CommandResult> {
    const available = await isLLMAvailable();
    const provider = getActiveLLMProvider();

    return {
      success: true,
      message: [
        `AI Provider: ${provider}`,
        `    Status: ${available ? 'available' : 'not configured'}`,
        `    Conversation: ${getRecentConversation(100).length} messages`,
      ].join('\n'),
    };
  }

  getHelp(): string {
    return [
      '  AI Chat -- Claude API',
      '    ask <question>           Chat with AI',
      '    ai <prompt>              Send a prompt',
      '    summarize <file|topic>   Summarize a file or topic',
      '    explain <file|topic>     Explain code or a concept',
      '    clear chat               Reset conversation',
      '    ai status                Check AI status',
    ].join('\n');
  }
}
