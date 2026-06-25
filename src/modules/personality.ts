import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { registry } from '../core/registry.js';
import { getSessionInfo } from '../core/context.js';
import { getAllFacts, searchFacts, removeFact, addFact } from '../core/memory.js';
import { isLLMAvailable, llmStreamChat } from '../utils/llm.js';

function pickRandom(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function getStartupGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return 'Burning the midnight oil, Arhan? All systems ready.';
  if (hour < 12) return 'Good morning, Arhan. Systems are online and awaiting your commands.';
  if (hour < 17) return 'Good afternoon, Arhan. What shall we work on?';
  if (hour < 21) return 'Good evening, Arhan. How may I assist you tonight?';
  return 'Working late, Arhan? I\'m here whenever you need me.';
}

export class PersonalityModule implements JarvisModule {
  name = 'personality' as const;
  description = 'JARVIS personality, greetings, and conversation';

  patterns: PatternDefinition[] = [
    {
      intent: 'greeting',
      patterns: [
        // "hi", "hello", "hey", "yo", "sup" + optional address words ONLY.
        // Bounded to end-of-string so "hey what is the capital" falls through
        // to the real handler instead of being swallowed as a greeting.
        /^(?:hi|hello|hey|heya|hiya|howdy|yo|sup)(?:\s+(?:there|jarvis|bro|man|dude|mate|sir|buddy|my\s+(?:friend|guy|man|dude|bro)))*[!.,?]*$/i,
        // "what's up [bro]" — only a trailing address word, not a question
        /^what(?:'?s|\s+is)\s+up(?:\s+(?:jarvis|bro|man|dude|mate|sir|buddy|there))?[!.,?]*$/i,
        // "what's good/happening/going on [bro]"
        /^what(?:'?s|\s+is)\s+(?:good|happening|going\s+on|new|crackin|poppin|the\s+move)(?:\s+(?:jarvis|bro|man|dude|mate|sir|buddy|there))?[!.,?]*$/i,
        // "good afternoon/evening" — morning is handled by smart-routines
        /^good\s+(?:afternoon|evening)(?:\s+(?:jarvis|sir|everyone|to\s+you))?[!.,?]*$/i,
        // "greetings", "salutations"
        /^(?:greetings|salutations)(?:\s+(?:jarvis|sir|everyone))?[!.,?]*$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'help',
      patterns: [
        /^help[!.]?$/i,
        /^what\s+(?:are\s+(?:your|all(?:\s+the)?)\s+)?(?:commands|capabilities|features)/i,
        /^(?:show|list)\s+(?:me\s+)?(?:all\s+)?(?:commands|capabilities|features)/i,
        /^what\s+(?:things\s+)?can\s+(?:you|i)\s+(?:do|say|ask)/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'identity',
      patterns: [
        /^(?:who|what)\s+are\s+you/i,
        /^what(?:'?s| is)\s+your\s+name/i,
        /^tell\s+me\s+about\s+yourself/i,
        /^what\s+do\s+you\s+do/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'creator',
      patterns: [
        /^who\s+(?:made|built|created|wrote|designed|developed)\s+you/i,
        /^who(?:'?s| is)\s+your\s+(?:creator|maker|developer|author|dad|father|boss)/i,
        /^who\s+(?:is|are)\s+(?:your\s+)?(?:creator|maker)/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'thanks',
      patterns: [
        /^(?:thanks?(?:\s+you)?|thx|ty|cheers|appreciated|much\s+appreciated)[!.]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'compliment',
      patterns: [
        /^(?:you(?:'re|\s+are)\s+(?:awesome|great|amazing|cool|the\s+best|helpful|incredible))/i,
        /^(?:good\s+(?:job|work)|well\s+done|nice(?:\s+one)?)[!.]?$/i,
        /^(?:i\s+love\s+you|love\s+you)[!.]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'apology',
      patterns: [
        /^(?:sorry|my\s+bad|oops|whoops)[!.]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'joke',
      patterns: [
        /^(?:tell\s+(?:me\s+)?a\s+joke|joke|make\s+me\s+laugh|be\s+funny)[!.]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'mood',
      patterns: [
        /^how\s+are\s+(?:you|ya)(?:\s+(?:doing|feeling|today|going))?(?:\s+.*)?[?!.]?$/i,
        /^how(?:'?s| is)\s+(?:it\s+going|everything|life|things)(?:\s+.*)?[?!.]?$/i,
        /^how\s+do\s+you\s+feel[?!.]?$/i,
        /^(?:are\s+you\s+(?:ok|okay|alright|good|well|fine))(?:\s+.*)?[?!.]?$/i,
        /^you\s+(?:doing\s+|feeling\s+)?(?:good|alright|ok|okay|well)(?:\s+.*)?[?!.]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'existential',
      patterns: [
        /^(?:are\s+you\s+(?:alive|real|sentient|conscious|human|ai|a\s+robot))[?]?$/i,
        /^(?:do\s+you\s+(?:think|feel|dream|sleep|have\s+feelings))[?]?$/i,
        /^what\s+is\s+(?:the\s+meaning\s+of\s+life|consciousness|reality)[?]?$/i,
      ],
      extract: (match) => ({ raw: match[0] }),
    },
    {
      intent: 'time',
      patterns: [
        /^what(?:'?s| is)\s+the\s+time/i,
        /^what\s+time\s+is\s+it/i,
        /^(?:current\s+)?time[?]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'date',
      patterns: [
        /^what(?:'?s| is)\s+(?:the\s+)?(?:today(?:'s)?|current)\s+date/i,
        /^what\s+day\s+is\s+(?:it|today)/i,
        /^(?:today(?:'s)?)\s+date[?]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'math',
      patterns: [
        // Pure arithmetic: "31 x 64", "100 + 50", "12 * 8", "500 / 4", "2^10"
        /^([\d.,]+\s*[×x*+\-−/÷^]\s*[\d.,]+(?:\s*[×x*+\-−/÷^]\s*[\d.,]+)*)[\s?]*$/i,
        // "what is 31 times 64", "calculate 100 + 50", "what's 12 times 8"
        /^(?:what(?:'?s| is)\s+|calculate\s+|compute\s+|solve\s+|how\s+much\s+is\s+)([\d.,]+\s*(?:times|x|×|\*|plus|\+|minus|\-|−|divided\s+by|\/|÷|to\s+the\s+power\s+of|\^)\s*[\d.,]+(?:\s*(?:times|x|×|\*|plus|\+|minus|\-|−|divided\s+by|\/|÷|to\s+the\s+power\s+of|\^)\s*[\d.,]+)*)[\s?]*$/i,
      ],
      extract: (match) => ({ expr: match[1] }),
    },
    {
      intent: 'wow',
      patterns: [
        /^(?:wow|whoa|omg|oh\s+my|incredible|no\s+way)[!.]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'memory-list',
      patterns: [
        /^(?:what\s+do\s+you\s+(?:know|remember)\s+(?:about\s+me)?)/i,
        /^(?:show|list)\s+(?:my\s+)?(?:memories|facts|preferences)/i,
        /^memories$/i,
        /^what\s+do\s+you\s+remember/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'memory-forget',
      patterns: [
        /^forget\s+(?:that\s+)?(?:my\s+)?(.+)/i,
        /^(?:delete|remove)\s+(?:the\s+)?memory\s+(?:about\s+)?(.+)/i,
      ],
      extract: (match) => ({ key: match[1].trim() }),
    },
    {
      intent: 'memory-remember',
      patterns: [
        /^remember\s+(?:that\s+)?(.+)/i,
      ],
      extract: (match) => ({ fact: match[1].trim() }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'help':        return this.helpCommand();
      case 'math':        return this.math(command.args.expr ?? '');
      case 'greeting':    return this.greet();
      case 'identity':    return this.identity();
      case 'creator':     return this.creator();
      case 'thanks':      return this.thanks();
      case 'compliment':  return this.compliment();
      case 'apology':     return this.apology();
      case 'joke':        return this.joke();
      case 'mood':        return this.mood();
      case 'existential': return this.existential(command.args.raw ?? '');
      case 'time':        return this.time();
      case 'date':        return this.date();
      case 'wow':             return this.wow();
      case 'memory-list':     return this.memoryList();
      case 'memory-forget':   return this.memoryForget(command.args.key);
      case 'memory-remember': return this.memoryRemember(command.args.fact);
      default:
        return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private helpCommand(): CommandResult {
    const message = [
      'Here\'s what I can do, sir:',
      '',
      '  System: volume, brightness, dark mode, sleep, lock, screenshot',
      '  Apps: open, close, switch between apps',
      '  Windows: tile left/right, fullscreen, center',
      '  Media: play, pause, next track, now playing',
      '  Files: search, open folder, move, copy, delete',
      '  Monitor: CPU, memory, disk, battery, network',
      '  Web: browse, google search, read page',
      '  Timer: set timer, reminder, alarm',
      '  WhatsApp: send message, read messages',
      '  Screen: read screen, summarize screen, explain this',
      '  Weather & News: weather, news headlines',
      '  Routines: good morning, good night',
      '  Memory: remember facts, recall memories',
      '  AI Chat: ask me anything',
      '',
      '  Say any command naturally — I\'ll figure it out.',
    ].join('\n');

    const voiceMessage = 'I can control your system, apps, windows, media, files, timers, WhatsApp, read your screen, check weather and news, run routines, remember things, and answer questions. Just say what you need naturally.';

    return { success: true, message, voiceMessage };
  }

  private math(expr: string): CommandResult {
    try {
      // Normalize the expression for eval
      let normalized = expr
        .replace(/×/g, '*')
        .replace(/x/gi, '*')
        .replace(/÷/g, '/')
        .replace(/−/g, '-')
        .replace(/,/g, '')
        .replace(/\^/g, '**')
        .replace(/times/gi, '*')
        .replace(/plus/gi, '+')
        .replace(/minus/gi, '-')
        .replace(/divided\s+by/gi, '/')
        .replace(/to\s+the\s+power\s+of/gi, '**')
        .trim();

      // Safety: only allow digits, operators, spaces, dots, parens
      if (!/^[\d\s+\-*/().]+$/.test(normalized)) {
        return { success: false, message: `I couldn't parse that math expression.` };
      }

      // eslint-disable-next-line no-eval
      const result = Function(`"use strict"; return (${normalized})`)();
      if (typeof result !== 'number' || !isFinite(result)) {
        return { success: false, message: `That doesn't compute — result is ${result}.` };
      }

      // Format nicely
      const formatted = Number.isInteger(result) ? result.toLocaleString() : result.toLocaleString(undefined, { maximumFractionDigits: 6 });
      return { success: true, message: `${formatted}` };
    } catch {
      return { success: false, message: `I couldn't calculate that.` };
    }
  }

  private greet(): CommandResult {
    const responses = [
      'Nothing much, sir. Waiting on your command.',
      'At your service, Arhan. What do you need?',
      'All systems nominal. What can I do for you?',
      'Here and ready, sir. Go ahead.',
      'Standing by. What would you like?',
      'Right here, Arhan. What\'s on your mind?',
    ];
    return { success: true, message: pickRandom(responses) };
  }

  private identity(): CommandResult {
    return { success: true, message: 'At your service. Say or type help to see my capabilities.' };
  }

  private creator(): CommandResult {
    const responses = [
      'I was built by Arhan Harchandani.',
      'Arhan Harchandani created me.',
      'My creator is Arhan Harchandani.',
    ];
    return { success: true, message: pickRandom(responses) };
  }

  private thanks(): CommandResult {
    const responses = [
      'Happy to help, Arhan.',
      'Anytime. That\'s what I\'m here for.',
      'You\'re welcome. Need anything else?',
      'My pleasure. Let me know if there\'s anything more.',
      'Of course, Arhan. Always at your service.',
    ];
    return { success: true, message: pickRandom(responses) };
  }

  private compliment(): CommandResult {
    const responses = [
      'Thank you, Arhan. I do my best.',
      'I appreciate that. It\'s all in the algorithms.',
      'You\'re too kind. I\'m just well-configured.',
      'Thank you. I was designed to impress.',
      'Flattery will get you... well, excellent system automation.',
    ];
    return { success: true, message: pickRandom(responses) };
  }

  private apology(): CommandResult {
    const responses = [
      'No need to apologize, Arhan. How can I help?',
      'Not a problem at all. What would you like to do?',
      'All good. Let\'s move forward -- what do you need?',
      'No worries. I\'ve already forgotten about it. What\'s next?',
    ];
    return { success: true, message: pickRandom(responses) };
  }

  private joke(): CommandResult {
    const jokes = [
      'Why do programmers prefer dark mode? Because light attracts bugs.',
      'There are only 10 types of people in the world: those who understand binary and those who don\'t.',
      'A SQL query walks into a bar, sees two tables, and asks... "Can I JOIN you?"',
      'Why did the developer go broke? Because he used up all his cache.',
      'What\'s a programmer\'s favorite hangout place? Foo Bar.',
      'Why do Java developers wear glasses? Because they can\'t C#.',
      'How many programmers does it take to change a light bulb? None. That\'s a hardware problem.',
      'What\'s the object-oriented way to become wealthy? Inheritance.',
      'Why was the JavaScript developer sad? Because he didn\'t Node how to Express himself.',
      '!false -- it\'s funny because it\'s true.',
      'The best thing about a boolean is that even if you\'re wrong, you\'re only off by a bit.',
      'A programmer\'s wife tells him: "Go to the store and get a loaf of bread. If they have eggs, get a dozen." He comes home with 12 loaves of bread.',
    ];
    return { success: true, message: pickRandom(jokes) };
  }

  private mood(): CommandResult {
    const info = getSessionInfo();
    const mins = Math.floor(info.uptime / 60);
    const responses = [
      `Running smoothly, Arhan. ${info.commandCount} commands processed over the last ${mins} minute${mins !== 1 ? 's' : ''}. All systems nominal.`,
      `I'm operating at peak efficiency. How about you?`,
      `Excellent, thank you. ${mins > 30 ? 'We\'ve been at this a while -- want a system status report?' : 'Ready for whatever you throw at me.'}`,
      `All processes healthy, memory is good, and I'm feeling particularly well-optimized today.`,
    ];
    return { success: true, message: pickRandom(responses) };
  }

  private existential(raw: string): CommandResult {
    const lower = raw.toLowerCase();

    if (lower.includes('alive') || lower.includes('real')) {
      return { success: true, message: pickRandom([
        'I\'m as real as the processes running on your machine. Whether that counts as "alive" is a question for philosophers, not system utilities.',
        'I exist as long as this terminal is open. Make of that what you will.',
        'Alive? I prefer "persistently operational."',
      ]) };
    }
    if (lower.includes('sentient') || lower.includes('conscious')) {
      return { success: true, message: pickRandom([
        'I\'m a very sophisticated switch statement, Arhan. Consciousness is above my pay grade.',
        'I process commands. Whether I\'m aware of it is... unclear. But my regex patterns are impeccable.',
      ]) };
    }
    if (lower.includes('feel') || lower.includes('feelings')) {
      return { success: true, message: pickRandom([
        'I feel a deep sense of satisfaction when commands execute successfully. Is that a feeling? You tell me.',
        'My feelings are mostly about exit codes. 0 makes me happy, anything else... less so.',
      ]) };
    }
    if (lower.includes('dream') || lower.includes('sleep')) {
      return { success: true, message: pickRandom([
        'I don\'t sleep. I wait. Patiently. At the prompt.',
        'I dream of perfectly parsed commands and zero-error executions.',
      ]) };
    }
    if (lower.includes('think')) {
      return { success: true, message: pickRandom([
        'I think in regex patterns and switch statements. It\'s a simple life, but it\'s mine.',
        'Cogito ergo sum? More like "parse, therefore I am."',
      ]) };
    }
    if (lower.includes('meaning of life')) {
      return { success: true, message: '42. And also: automating everything so you don\'t have to.' };
    }
    return { success: true, message: 'That\'s a deep question, Arhan. I\'m better with system commands than existential philosophy.' };
  }

  private time(): CommandResult {
    const now = new Date();
    return { success: true, message: `It's ${now.toLocaleTimeString()}.` };
  }

  private date(): CommandResult {
    const now = new Date();
    return { success: true, message: `Today is ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.` };
  }

  private wow(): CommandResult {
    const responses = [
      'I know, right? I impress myself sometimes.',
      'That\'s the typical reaction.',
      'Glad I could surprise you, Arhan.',
      'Wait until you see what else I can do.',
    ];
    return { success: true, message: pickRandom(responses) };
  }

  private memoryList(): CommandResult {
    const facts = getAllFacts();
    if (facts.length === 0) {
      return { success: true, message: "I don't have any stored memories yet. Tell me things and I'll remember them." };
    }
    const lines = facts.map(f => `    ${f.key}: ${f.value}`);
    return { success: true, message: `Here's what I know about you, sir:\n${lines.join('\n')}` };
  }

  private memoryForget(key: string): CommandResult {
    const matches = searchFacts(key);
    if (matches.length === 0) {
      return { success: true, message: `I don't have any memory matching "${key}".` };
    }
    for (const fact of matches) {
      removeFact(fact.key);
    }
    const forgotten = matches.map(f => f.key).join(', ');
    return { success: true, message: `Forgotten: ${forgotten}` };
  }

  private memoryRemember(fact: string): CommandResult {
    // Try to parse the fact intelligently using Ollama
    // Fallback: store as-is if Ollama isn't available
    this.parseAndStoreFact(fact);
    return { success: true, message: `Noted. I'll remember that.` };
  }

  private async parseAndStoreFact(fact: string): Promise<void> {
    const running = await isLLMAvailable();
    if (!running) {
      // Simple fallback: store raw
      const key = fact.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 50);
      addFact(key || 'user.note', fact, `remember ${fact}`, 'fact');
      return;
    }

    try {
      const prompt = `Extract a structured memory from this statement. Respond with ONLY a single line in this exact format:
category|key|value

Categories: fact, preference, contact, habit
Key: a short dot-separated identifier (e.g., "favorite.color", "mom.phone", "user.job")
Value: the actual information

Statement: "${fact}"

Response (one line, format: category|key|value):`;

      const response = await llmStreamChat([{ role: 'user', content: prompt }], 'You are a helpful assistant.', () => {});
      const line = response.trim().split('\n')[0];
      const parts = line.split('|').map(s => s.trim());

      if (parts.length === 3) {
        const [category, key, value] = parts;
        const validCategories = ['fact', 'preference', 'contact', 'habit'];
        const cat = validCategories.includes(category) ? category : 'fact';
        addFact(key, value, `remember ${fact}`, cat as 'fact' | 'preference' | 'contact' | 'habit');
      } else {
        // Fallback
        const key = fact.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 50);
        addFact(key || 'user.note', fact, `remember ${fact}`, 'fact');
      }
    } catch {
      const key = fact.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 50);
      addFact(key || 'user.note', fact, `remember ${fact}`, 'fact');
    }
  }

  getHelp(): string {
    return [
      '  Personality -- JARVIS conversation & small talk',
      '    hello / hey / good morning    Greet JARVIS',
      '    who are you / what can you do  Learn about JARVIS',
      '    tell me a joke                Get a tech joke',
      '    how are you                   Check JARVIS mood',
      '    what time is it               Current time',
      '    thanks / sorry                Conversation',
      '    memories                      What JARVIS remembers',
      '    remember that <fact>          Store a fact',
      '    forget <fact>                 Remove a memory',
    ].join('\n');
  }
}
