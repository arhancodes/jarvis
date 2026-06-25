import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition, ModuleName } from '../core/types.js';
import { levenshtein } from '../core/parser.js';
import { getHistory } from '../core/history.js';
import { fmt } from '../utils/formatter.js';

// ── Command examples for suggestion scoring ──
const COMMAND_EXAMPLES: Array<{ label: string; keywords: string[]; module: string }> = [
  // System Monitor
  { label: 'cpu', keywords: ['cpu', 'processor', 'usage', 'load'], module: 'system-monitor' },
  { label: 'memory', keywords: ['memory', 'ram', 'usage', 'free'], module: 'system-monitor' },
  { label: 'disk', keywords: ['disk', 'storage', 'space', 'drive'], module: 'system-monitor' },
  { label: 'battery', keywords: ['battery', 'charge', 'power', 'energy'], module: 'system-monitor' },
  { label: 'network', keywords: ['network', 'wifi', 'internet', 'ip', 'connected'], module: 'system-monitor' },
  { label: 'status', keywords: ['status', 'system', 'report', 'overview', 'health'], module: 'system-monitor' },

  // App Launcher
  { label: 'open <app>', keywords: ['open', 'launch', 'start', 'app', 'application'], module: 'app-launcher' },
  { label: 'close <app>', keywords: ['close', 'quit', 'kill', 'exit', 'app'], module: 'app-launcher' },
  { label: 'switch to <app>', keywords: ['switch', 'focus', 'activate', 'foreground'], module: 'app-launcher' },
  { label: 'list apps', keywords: ['list', 'apps', 'running', 'active', 'applications'], module: 'app-launcher' },

  // Script Runner
  { label: '$ <command>', keywords: ['shell', 'command', 'run', 'exec', 'terminal', 'bash'], module: 'script-runner' },

  // File Operations
  { label: 'search <name>', keywords: ['search', 'find', 'locate', 'file', 'files'], module: 'file-ops' },
  { label: 'open folder <path>', keywords: ['folder', 'directory', 'finder', 'browse'], module: 'file-ops' },
  { label: 'move <src> to <dest>', keywords: ['move', 'rename', 'relocate'], module: 'file-ops' },
  { label: 'copy <src> to <dest>', keywords: ['copy', 'duplicate', 'clone'], module: 'file-ops' },
  { label: 'delete <path>', keywords: ['delete', 'remove', 'trash', 'discard'], module: 'file-ops' },

  // System Control
  { label: 'volume <0-100>', keywords: ['volume', 'sound', 'audio', 'loud', 'quiet'], module: 'system-control' },
  { label: 'mute / unmute', keywords: ['mute', 'unmute', 'silent', 'silence'], module: 'system-control' },
  { label: 'brightness <0-100>', keywords: ['brightness', 'screen', 'bright', 'dim', 'display'], module: 'system-control' },
  { label: 'dark mode', keywords: ['dark', 'mode', 'theme', 'light', 'appearance'], module: 'system-control' },
  { label: 'sleep / lock', keywords: ['sleep', 'lock', 'screen', 'away', 'secure'], module: 'system-control' },

  // Timers
  { label: 'timer <duration>', keywords: ['timer', 'countdown', 'minutes', 'seconds'], module: 'timer' },
  { label: 'remind me in <time> to <msg>', keywords: ['remind', 'reminder', 'notification', 'alert', 'remember'], module: 'timer' },
  { label: 'alarm <time>', keywords: ['alarm', 'wake', 'alert', 'ring'], module: 'timer' },
  { label: 'stopwatch', keywords: ['stopwatch', 'chrono', 'elapsed', 'timing'], module: 'timer' },

  // Process Manager
  { label: 'top cpu / top memory', keywords: ['top', 'processes', 'heavy', 'hog', 'consuming'], module: 'process-manager' },
  { label: 'kill <process>', keywords: ['kill', 'stop', 'end', 'terminate', 'process'], module: 'process-manager' },
  { label: 'port <number>', keywords: ['port', 'listening', 'bound', 'server'], module: 'process-manager' },

  // Clipboard
  { label: 'copy <text>', keywords: ['copy', 'clipboard', 'clip'], module: 'clipboard' },
  { label: 'paste', keywords: ['paste', 'clipboard', 'contents'], module: 'clipboard' },
  { label: 'clips', keywords: ['clips', 'clipboard', 'history', 'copied'], module: 'clipboard' },

  // Window Manager
  { label: 'tile <app> left/right', keywords: ['tile', 'window', 'split', 'half', 'side'], module: 'window-manager' },
  { label: 'fullscreen <app>', keywords: ['fullscreen', 'maximize', 'expand', 'full'], module: 'window-manager' },
  { label: 'center <app>', keywords: ['center', 'middle', 'window'], module: 'window-manager' },

  // Media Control
  { label: 'play / pause', keywords: ['play', 'pause', 'music', 'song', 'track'], module: 'media-control' },
  { label: 'next / skip', keywords: ['next', 'skip', 'forward', 'track'], module: 'media-control' },
  { label: 'now playing', keywords: ['now', 'playing', 'current', 'song', 'track', 'music'], module: 'media-control' },

  // Workflow
  { label: 'create workflow <name>: steps', keywords: ['workflow', 'automation', 'chain', 'sequence'], module: 'workflow' },
  { label: 'shortcut <name>', keywords: ['shortcut', 'shortcuts', 'siri', 'automation'], module: 'workflow' },
  { label: 'every <interval> run <cmd>', keywords: ['schedule', 'every', 'recurring', 'cron', 'repeat'], module: 'workflow' },

  // AI Chat
  { label: 'ask <question>', keywords: ['ask', 'ai', 'chat', 'question', 'answer'], module: 'ai-chat' },
  { label: 'summarize <file>', keywords: ['summarize', 'summary', 'tldr', 'overview'], module: 'ai-chat' },
  { label: 'explain <file>', keywords: ['explain', 'code', 'understand', 'describe'], module: 'ai-chat' },
  { label: 'ai status', keywords: ['models', 'llm', 'ai', 'claude'], module: 'ai-chat' },

  // Personality
  { label: 'hello / hey', keywords: ['hello', 'hi', 'hey', 'greetings', 'morning'], module: 'personality' },
  { label: 'tell me a joke', keywords: ['joke', 'funny', 'laugh', 'humor'], module: 'personality' },

  // Weather & News
  { label: 'weather', keywords: ['weather', 'temperature', 'forecast', 'outside', 'hot', 'cold'], module: 'weather-news' },
  { label: 'weather in <city>', keywords: ['weather', 'temperature', 'forecast', 'city'], module: 'weather-news' },
  { label: 'news', keywords: ['news', 'headlines', 'top', 'stories', 'current'], module: 'weather-news' },
  { label: 'news about <topic>', keywords: ['news', 'headlines', 'about', 'topic'], module: 'weather-news' },

  // Smart Routines
  { label: 'good morning', keywords: ['morning', 'routine', 'start', 'day', 'wake'], module: 'smart-routines' },
  { label: 'good night', keywords: ['night', 'routine', 'sleep', 'bed', 'shutdown'], module: 'smart-routines' },
  { label: 'routines', keywords: ['routines', 'routine', 'list', 'show'], module: 'smart-routines' },

  // Screen Awareness
  { label: 'read screen', keywords: ['screen', 'ocr', 'read', 'text', 'looking'], module: 'screen-awareness' },
  { label: 'summarize screen', keywords: ['screen', 'summarize', 'summary', 'viewing'], module: 'screen-awareness' },

  // Site Monitor
  { label: 'site status', keywords: ['site', 'sites', 'apps', 'online', 'status', 'check', 'running', 'up'], module: 'site-monitor' },
  { label: 'is <site> online', keywords: ['online', 'down', 'check', 'ping', 'running', 'working'], module: 'site-monitor' },

  // Research
  { label: 'research <topic>', keywords: ['research', 'papers', 'academic', 'study', 'investigate'], module: 'research' },
  { label: 'find papers on <topic>', keywords: ['papers', 'articles', 'literature', 'arxiv', 'scholar'], module: 'research' },

  // WhatsApp
  { label: 'send whatsapp to <name>: <msg>', keywords: ['whatsapp', 'message', 'send', 'text', 'chat'], module: 'whatsapp' },
  { label: 'read whatsapp', keywords: ['whatsapp', 'messages', 'unread', 'inbox'], module: 'whatsapp' },
  { label: 'whatsapp login', keywords: ['whatsapp', 'login', 'connect', 'qr'], module: 'whatsapp' },

  // Screen Interact
  { label: 'paraphrase this', keywords: ['paraphrase', 'rephrase', 'this', 'text', 'selection'], module: 'screen-interact' },
  { label: 'rewrite this', keywords: ['rewrite', 'rephrase', 'this', 'text'], module: 'screen-interact' },
  { label: 'fix grammar', keywords: ['fix', 'correct', 'grammar', 'spelling', 'errors'], module: 'screen-interact' },
  { label: 'summarize this', keywords: ['summarize', 'shorten', 'this', 'text', 'selection'], module: 'screen-interact' },
  { label: 'make this formal', keywords: ['formal', 'professional', 'tone', 'formalize'], module: 'screen-interact' },
  { label: 'make this casual', keywords: ['casual', 'informal', 'friendly', 'tone'], module: 'screen-interact' },

  // Browser Control
  { label: 'browse <url>', keywords: ['browse', 'website', 'navigate', 'url', 'web'], module: 'browser-control' },
  { label: 'google <query>', keywords: ['google', 'search', 'look', 'find', 'online'], module: 'browser-control' },
  { label: 'read page', keywords: ['page', 'read', 'extract', 'content', 'text'], module: 'browser-control' },
  { label: 'screenshot', keywords: ['screenshot', 'capture', 'snap', 'page'], module: 'browser-control' },
];

// ── NLU Mappings: natural language phrases → existing commands ──
const NLU_MAPPINGS: Array<{
  patterns: RegExp[];
  module: ModuleName;
  action: string;
  args?: Record<string, string>;
}> = [
  {
    patterns: [
      /(?:show|what(?:'?s| is)|which)\s+(?:process(?:es)?|app(?:s)?)\s+(?:(?:is|are)\s+)?(?:using|eating|consuming|taking)\s+(?:the\s+)?most\s+(?:cpu|processor)/i,
      /(?:heaviest|biggest|top|worst)\s+(?:cpu\s+)?processes/i,
    ],
    module: 'process-manager', action: 'top-cpu',
  },
  {
    patterns: [
      /(?:show|what(?:'?s| is)|which)\s+(?:process(?:es)?|app(?:s)?)\s+(?:(?:is|are)\s+)?(?:using|eating|consuming|taking)\s+(?:the\s+)?most\s+(?:memory|ram)/i,
      /(?:heaviest|biggest|top|worst)\s+memory\s+(?:processes|hogs)/i,
    ],
    module: 'process-manager', action: 'top-memory',
  },
  {
    patterns: [
      /how\s+much\s+(?:memory|ram)\s+(?:am\s+I|is\s+(?:being|my\s+(?:mac|computer)))\s+using/i,
      /(?:memory|ram)\s+(?:usage|consumption)/i,
    ],
    module: 'system-monitor', action: 'memory',
  },
  {
    patterns: [
      /how\s+much\s+(?:disk|storage|drive)\s+(?:space\s+)?(?:do\s+I\s+have|is)\s+(?:left|free|available|remaining)/i,
      /(?:am\s+I|is\s+my\s+disk)\s+running\s+(?:out\s+of|low\s+on)\s+(?:space|storage)/i,
    ],
    module: 'system-monitor', action: 'disk',
  },
  {
    patterns: [
      /(?:am\s+I|is\s+(?:my\s+)?(?:mac|computer))\s+(?:connected|online)/i,
      /do\s+I\s+have\s+(?:wifi|internet|a\s+connection)/i,
      /(?:check|test)\s+(?:my\s+)?(?:internet|network|wifi)\s+(?:connection|connectivity)/i,
    ],
    module: 'system-monitor', action: 'network',
  },
  {
    patterns: [
      /(?:what|which)\s+apps?\s+(?:are|is)\s+(?:open|running|active)/i,
      /(?:show|list)\s+(?:me\s+)?(?:all\s+)?(?:open|running|active)\s+(?:apps?|applications?|programs?)/i,
    ],
    module: 'app-launcher', action: 'list',
  },
  {
    patterns: [
      /(?:shut|turn)\s+(?:down|off)\s+(?:the\s+)?(?:computer|mac|machine|system)/i,
      /power\s+(?:off|down)/i,
    ],
    module: 'system-control', action: 'shutdown',
  },
  {
    patterns: [
      /(?:restart|reboot)\s+(?:the\s+)?(?:computer|mac|machine|system)/i,
    ],
    module: 'system-control', action: 'restart',
  },
  {
    patterns: [
      /(?:put|send)\s+(?:the\s+)?(?:computer|mac|machine|screen)\s+to\s+sleep/i,
      /(?:go\s+to\s+sleep|goodnight)/i,
    ],
    module: 'system-control', action: 'sleep',
  },
  {
    patterns: [
      /(?:how\s+much\s+)?(?:battery|charge|power)\s+(?:do\s+I\s+have|is)\s+(?:left|remaining)/i,
      /(?:is\s+my\s+(?:laptop|mac|macbook))\s+(?:charging|plugged\s+in)/i,
    ],
    module: 'system-monitor', action: 'battery',
  },
  {
    patterns: [
      /(?:turn|set|put)\s+(?:my\s+|the\s+)?(?:volume|sound)\s+(?:up\s+)?(?:to\s+)?(\d+)/i,
      /volume\s+(?:up\s+)?to\s+(\d+)/i,
    ],
    module: 'system-control', action: 'volume-set',
  },
  {
    patterns: [
      /(?:make\s+it|go|turn(?:\s+it)?)\s+(?:louder|up)/i,
      /(?:turn|crank)\s+(?:up\s+)?(?:the\s+)?(?:volume|sound)(?!\s+(?:up\s+)?(?:to\s+)?\d)/i,
      /(?:increase|raise)\s+(?:the\s+)?(?:volume|sound)/i,
      /turn\s+(?:my\s+|the\s+)?(?:volume|sound)\s+up(?!\s+(?:to\s+)?\d)/i,
      /(?:put|set)\s+(?:my\s+|the\s+)?(?:volume|sound)\s+(?:to\s+)?(?:the\s+)?max/i,
    ],
    module: 'system-control', action: 'volume-up',
  },
  {
    patterns: [
      /(?:make\s+it|go|turn(?:\s+it)?)\s+(?:quieter|down)/i,
      /(?:turn|lower)\s+(?:down\s+)?(?:the\s+)?(?:volume|sound)/i,
      /(?:decrease|reduce|lower)\s+(?:the\s+)?(?:volume|sound)/i,
      /turn\s+(?:my\s+|the\s+)?(?:volume|sound)\s+down/i,
    ],
    module: 'system-control', action: 'volume-down',
  },
  {
    patterns: [
      /what(?:'?s| is)\s+(?:currently\s+)?playing/i,
      /what\s+song\s+is\s+(?:this|playing)/i,
      /(?:which|what)\s+track/i,
    ],
    module: 'media-control', action: 'now-playing',
  },
  {
    patterns: [
      /(?:play|skip\s+to)\s+(?:the\s+)?next\s+(?:song|track)/i,
    ],
    module: 'media-control', action: 'next',
  },
  {
    patterns: [
      /(?:stop|pause)\s+(?:the\s+)?music/i,
    ],
    module: 'media-control', action: 'pause',
  },
  {
    patterns: [
      /(?:play|resume|start)\s+(?:the\s+)?music/i,
    ],
    module: 'media-control', action: 'play',
  },
  {
    patterns: [
      /(?:what(?:'?s| is)|check)\s+(?:my\s+)?(?:ip|ip\s+address)/i,
    ],
    module: 'system-monitor', action: 'network',
  },
  {
    patterns: [
      /(?:take\s+out|empty)\s+(?:the\s+)?(?:trash|garbage|bin)/i,
    ],
    module: 'system-control', action: 'empty-trash',
  },
  // ── WiFi / Bluetooth ──
  {
    patterns: [
      /(?:connect|get)\s+(?:me\s+)?(?:to\s+)?(?:the\s+)?(?:internet|wi-?fi|network)/i,
      /(?:i\s+need|give\s+me)\s+(?:internet|wi-?fi)/i,
    ],
    module: 'system-control', action: 'wifi-on',
  },
  {
    patterns: [
      /(?:disconnect|cut|kill)\s+(?:the\s+)?(?:internet|wi-?fi|network)/i,
    ],
    module: 'system-control', action: 'wifi-off',
  },
  {
    patterns: [
      /(?:am\s+i|are\s+we)\s+(?:on|connected\s+to)\s+(?:the\s+)?(?:internet|wi-?fi)/i,
      /(?:what(?:'?s| is)\s+(?:my\s+)?(?:wi-?fi|network|connection))/i,
    ],
    module: 'system-control', action: 'wifi-status',
  },
  // ── Weather & News ──
  {
    patterns: [
      /(?:what(?:'?s| is)\s+(?:the\s+)?weather\s+like)/i,
      /(?:how(?:'?s| is)\s+it)\s+(?:outside|out\s+there)/i,
      /(?:is\s+it|will\s+it\s+be)\s+(?:going\s+to\s+)?(?:rain|snow|cold|hot|warm|sunny)\s+(?:today|tomorrow|tonight)/i,
      /(?:do\s+i\s+need)\s+(?:an?\s+)?(?:umbrella|jacket|coat)/i,
    ],
    module: 'weather-news', action: 'weather',
  },
  {
    patterns: [
      /(?:any|what(?:'?s| is))\s+(?:the\s+)?(?:latest\s+)?news(?:\s+today)?$/i,
      /what(?:'?s| is)\s+(?:going\s+on|happening)\s+(?:in\s+the\s+world|today)/i,
      /(?:give\s+me|tell\s+me)\s+(?:the\s+)?(?:latest\s+)?(?:news|headlines)/i,
    ],
    module: 'weather-news', action: 'news',
  },
  // ── Screen Awareness ──
  {
    patterns: [
      /what(?:'?s| is)\s+(?:on\s+)?(?:my\s+|the\s+)?screen/i,
      /what\s+am\s+i\s+(?:looking\s+at|reading|viewing|seeing)/i,
      /(?:can\s+you\s+)?(?:read|see)\s+(?:my\s+|the\s+)?screen/i,
    ],
    module: 'screen-awareness', action: 'read-screen',
  },
  {
    patterns: [
      /(?:summarize|describe)\s+(?:what(?:'?s| is)\s+(?:on\s+)?)?(?:my\s+|the\s+)?screen/i,
      /(?:tell\s+me)\s+(?:about\s+)?(?:what(?:'?s| is)\s+(?:on\s+)?)?(?:my\s+)?screen/i,
    ],
    module: 'screen-awareness', action: 'summarize-screen',
  },
  // ── Screenshot ──
  {
    patterns: [
      /(?:grab|capture|snap|take)\s+(?:a\s+)?(?:picture|photo|snap)\s+(?:of\s+)?(?:the\s+)?screen/i,
      /(?:screen\s*shot|screen\s*cap)/i,
    ],
    module: 'system-control', action: 'screenshot',
  },
  // ── Show Desktop ──
  {
    patterns: [
      /(?:show|go\s+to|switch\s+to)\s+(?:the\s+)?desktop/i,
      /(?:hide|minimize|clear)\s+(?:all\s+)?(?:the\s+)?windows/i,
    ],
    module: 'system-control', action: 'show-desktop',
  },
  // ── Eject ──
  {
    patterns: [
      /eject\s+(?:all\s+)?(?:the\s+)?(?:external\s+)?(?:drives?|disks?|usb)/i,
    ],
    module: 'system-control', action: 'eject',
  },
  // ── Research ──
  {
    patterns: [
      /(?:find|look\s+up|search\s+for)\s+(?:academic\s+)?(?:papers?|research|articles?|studies)\s+(?:on|about|regarding)\s+(.+)/i,
      /(?:what(?:'?s| is)\s+the\s+latest\s+research\s+on)\s+(.+)/i,
      /(?:i\s+need|get\s+me)\s+(?:papers?|research|articles?)\s+(?:on|about)\s+(.+)/i,
    ],
    module: 'research', action: 'research',
    args: {},
  },
  // ── Conversions (voice-friendly) ──
  {
    patterns: [
      // "tell me the conversion 6 PM IST to GST", "what's the conversion of 6 PM IST to GST"
      /(?:tell\s+me\s+)?(?:the\s+)?conversion\s+(?:of\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+([a-z]{2,5})\s+(?:to|in)\s+([a-z]{2,5})/i,
      // "convert 6 PM IST to GST"
      /convert\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(.+?)\s+(?:to|in)\s+(.+)/i,
    ],
    module: 'conversions', action: 'timezone',
    args: {},
  },
  // ── WhatsApp (voice-friendly) ──
  // IMPORTANT: send patterns MUST come before read patterns so "message <name> <msg>" matches send, not read
  {
    patterns: [
      /(?:send|write)\s+(?:a\s+)?(?:message|text|whatsapp)\s+to\s+(.+?)\s+(?:saying|that\s+says?|:)\s+(.+)/i,
      /(?:message|text|whatsapp)\s+(.+?)\s+(?:saying|:)\s+(.+)/i,
      /(?:tell)\s+(?!me\s)(.+?)\s+(?:on\s+whatsapp\s+)?(?:that|to)\s+(.+)/i,
      // "send a message to <name> on whatsapp <msg>" — natural voice phrasing
      /send\s+(?:a\s+)?(?:message|text)\s+to\s+(.+?)\s+on\s+whatsapp\s+(.+)/i,
      /(?:message|text)\s+(.+?)\s+on\s+whatsapp\s+(.+)/i,
      // Simple: "message <name> <msg>" — name is first word(s) before the message
      /(?:message|text|whatsapp)\s+(\S+)\s+(.+)/i,
      /send\s+(?:a\s+)?(?:message|text)\s+to\s+(\S+)\s+(.+)/i,
    ],
    module: 'whatsapp', action: 'send',
  },
  {
    patterns: [
      // Must NOT match "message <name>" — only match explicit "messages" (plural) or "whatsapp messages" etc.
      /(?:do\s+i\s+have\s+)?(?:any\s+)?(?:new\s+)?whatsapp\s+(?:messages?|texts?)$/i,
      /(?:check|read)\s+(?:my\s+)?(?:whatsapp|messages)$/i,
      /(?:any\s+)?(?:new\s+)?(?:unread\s+)?messages\s+(?:on\s+whatsapp)$/i,
    ],
    module: 'whatsapp', action: 'read',
  },
  // ── Screen Interact (voice-friendly) ──
  {
    patterns: [
      /(?:can\s+you\s+)?paraphrase\s+(?:this|that|it|what\s+i(?:'ve| have)\s+(?:written|typed|selected))/i,
      /(?:rephrase|reword)\s+(?:this|that|it)/i,
    ],
    module: 'screen-interact', action: 'paraphrase',
  },
  {
    patterns: [
      /(?:can\s+you\s+)?(?:rewrite|redo)\s+(?:this|that|it|what\s+i(?:'ve| have)\s+(?:written|typed))/i,
    ],
    module: 'screen-interact', action: 'rewrite',
  },
  {
    patterns: [
      /(?:can\s+you\s+)?(?:fix|correct|check)\s+(?:the\s+)?(?:grammar|spelling|errors?)\s*(?:in\s+)?(?:this|that|here)?/i,
      /(?:is\s+(?:this|the)\s+grammar)\s+(?:correct|right|ok)/i,
    ],
    module: 'screen-interact', action: 'fix-grammar',
  },
  {
    patterns: [
      /(?:can\s+you\s+)?(?:shorten|make\s+(?:this|it)\s+(?:shorter|more\s+concise|briefer?))/i,
    ],
    module: 'screen-interact', action: 'shorten',
  },
  {
    patterns: [
      /(?:can\s+you\s+)?(?:expand|elaborate\s+on|make\s+(?:this|it)\s+(?:longer|more\s+detailed))/i,
    ],
    module: 'screen-interact', action: 'expand',
  },
  {
    patterns: [
      /(?:can\s+you\s+)?(?:make\s+(?:this|it)\s+(?:formal|professional)|formalize\s+(?:this|it))/i,
    ],
    module: 'screen-interact', action: 'formal',
  },
  {
    patterns: [
      /(?:can\s+you\s+)?(?:make\s+(?:this|it)\s+(?:casual|informal|friendly))/i,
    ],
    module: 'screen-interact', action: 'casual',
  },
  // ── Browser (voice-friendly) ──
  {
    patterns: [
      /(?:open|go\s+to|visit|pull\s+up)\s+((?:www\.)?[\w.-]+\.\w{2,}(?:\/\S*)?)/i,
    ],
    module: 'browser-control', action: 'browse',
  },
  {
    patterns: [
      /(?:google|search\s+(?:for|the\s+web\s+for)|look\s+up\s+online)\s+(.+)/i,
    ],
    module: 'browser-control', action: 'google',
  },
  {
    patterns: [
      /(?:what(?:'s| is|does)\s+(?:on\s+)?(?:the|this)\s+(?:web\s*)?page\s+(?:say|show|contain))/i,
    ],
    module: 'browser-control', action: 'read-page',
  },
  // ── Site Monitor ──
  {
    patterns: [
      /(?:are|check)\s+(?:my\s+)?(?:sites?|apps?|services?|products?)\s+(?:online|up|running|working|down)/i,
      /(?:site|app|service|product|system)\s+(?:status|check|report)/i,
      /(?:how\s+are|what(?:'?s| is)\s+the\s+status\s+of)\s+(?:my\s+)?(?:sites?|apps?|services?|products?|everything)/i,
      /(?:is\s+)?everything\s+(?:online|up|running|working)/i,
    ],
    module: 'site-monitor', action: 'check-all',
  },
  {
    patterns: [
      /(?:is|check)\s+(?:trade\s*buddy|mytradebuddy|trading\s+app)\s+(?:online|up|running|working|down)/i,
      /(?:is|check)\s+(?:the\s+)?(?:website|portfolio|arhan\.?dev)\s+(?:online|up|running|working|down)/i,
      /(?:is|check)\s+(?:friday)\s+(?:online|up|running|working|down)/i,
      /(?:is|check)\s+(?:rewoven)\s+(?:online|up|running|working|down|(?:on\s+(?:the\s+)?(?:app\s+)?stores?))/i,
    ],
    module: 'site-monitor', action: 'check-one',
  },
  // ── Screen Awareness (voice-friendly) ──
  {
    patterns: [
      /what\s+do\s+you\s+think/i,
      /(?:any|give\s+me)\s+(?:suggestions?|thoughts?|feedback)/i,
      /how\s+does\s+(?:this|that)\s+look/i,
      /(?:is\s+this|does\s+this\s+look)\s+(?:good|right|ok|correct)/i,
      /(?:review|check|look\s+at)\s+(?:this|what\s+i(?:'m| am)\s+(?:typing|writing|doing|working))/i,
    ],
    module: 'screen-awareness', action: 'suggest',
  },
  {
    patterns: [
      /what(?:'?s| is)\s+this\s+error/i,
      /what\s+does\s+this\s+(?:mean|say)/i,
      /why\s+(?:isn't|won't|can't|doesn't)\s+(?:this|it)\s+work/i,
      /(?:explain|read)\s+(?:this|what(?:'?s| is)\s+on\s+(?:my\s+)?screen)/i,
      /what(?:'?s| is)\s+(?:wrong|the\s+(?:error|issue|problem))/i,
      /(?:debug|fix)\s+this/i,
      /help\s+(?:me\s+)?(?:with\s+)?this/i,
    ],
    module: 'screen-awareness', action: 'screen-question',
  },
];

// ── Exported utility functions (used by index.ts) ──

/**
 * Detect if the input looks like a failed command attempt rather than conversation.
 * If true, we should show suggestions instead of routing to the LLM.
 */
export function isLikelyCommandAttempt(input: string): boolean {
  const lower = input.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(w => w.length >= 2);

  if (words.length === 0) return false;

  // Short imperative phrases starting with command verbs are almost certainly commands
  const commandVerbs = /^(?:check|open|close|show|list|set|turn|play|pause|stop|run|search|find|delete|move|copy|send|read|browse|google|kill|mute|unmute|research|tile|fullscreen|center|ping|restart|reboot|eject|screenshot|switch|launch|quit|status|refresh|clear|enable|disable|toggle|paraphrase|rewrite|rephrase|summarize|shorten|expand|formalize|fix|correct)\b/i;
  if (commandVerbs.test(lower) && words.length <= 8) return true;

  // Check keyword overlap with known commands
  let bestScore = 0;
  for (const example of COMMAND_EXAMPLES) {
    let score = 0;
    for (const word of words) {
      for (const kw of example.keywords) {
        if (word === kw) score += 3;
        else if (kw.startsWith(word) && word.length >= 3) score += 1;
      }
    }
    bestScore = Math.max(bestScore, score);
  }

  // Strong keyword match = likely a command, not conversation
  return bestScore >= 5;
}

export function tryNaturalLanguageMapping(input: string): ParsedCommand | null {
  for (const mapping of NLU_MAPPINGS) {
    for (const pattern of mapping.patterns) {
      if (pattern.test(input)) {
        return {
          module: mapping.module,
          action: mapping.action,
          args: mapping.args ?? {},
          raw: input,
          confidence: 0.5,
        };
      }
    }
  }
  return null;
}

export function getSuggestions(input: string): string[] {
  const lower = input.toLowerCase();
  const words = lower.split(/\s+/).filter(w => w.length >= 2);

  if (words.length === 0) return [];

  const candidates: Array<{ label: string; score: number }> = [];

  for (const example of COMMAND_EXAMPLES) {
    let score = 0;
    for (const word of words) {
      for (const kw of example.keywords) {
        const dist = levenshtein(word, kw);
        if (dist === 0) score += 3;
        else if (dist === 1) score += 2;
        else if (dist === 2 && word.length >= 4) score += 1;
      }
      // Prefix bonus
      for (const kw of example.keywords) {
        if (kw.startsWith(word) && word.length >= 3) score += 1;
      }
    }
    if (score > 0) candidates.push({ label: example.label, score });
  }

  // Deduplicate by label, keeping highest score
  const deduped = new Map<string, number>();
  for (const c of candidates) {
    const existing = deduped.get(c.label) ?? 0;
    if (c.score > existing) deduped.set(c.label, c.score);
  }

  return Array.from(deduped.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label]) => label);
}

// ── Module implementation ──

export class SmartAssistModule implements JarvisModule {
  name = 'smart-assist' as const;
  description = 'Smart suggestions and usage analytics';

  patterns: PatternDefinition[] = [
    {
      intent: 'what-can-i-do',
      patterns: [
        /^what\s+(?:else\s+)?can\s+(?:i|you)\s+do/i,
        /^(?:show|give)\s+(?:me\s+)?suggestions/i,
        /^ideas$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'frequently-used',
      patterns: [
        /^(?:my\s+)?(?:top|frequent|common)\s+commands$/i,
        /^what\s+do\s+I\s+use\s+most/i,
        /^(?:usage|stats|statistics)$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'what-can-i-do':    return this.handleSuggestions();
      case 'frequently-used':  return this.handleFrequentlyUsed();
      default:
        return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private handleSuggestions(): CommandResult {
    const history = getHistory(50);
    const usedModules = new Set<string>();

    for (const entry of history) {
      const lower = entry.command.toLowerCase();
      if (/^(cpu|memory|disk|battery|network|status)/.test(lower)) usedModules.add('system-monitor');
      if (/^(open|close|switch|list\s+apps)/.test(lower)) usedModules.add('app-launcher');
      if (/^(\$|run|exec|shell)/.test(lower)) usedModules.add('script-runner');
      if (/^(search|move|copy|delete|ls|open\s+folder)/.test(lower)) usedModules.add('file-ops');
      if (/^(volume|mute|brightness|dark|sleep|lock)/.test(lower)) usedModules.add('system-control');
      if (/^(timer|remind|alarm|stopwatch)/.test(lower)) usedModules.add('timer');
      if (/^(kill|top|port|ps|find\s+process)/.test(lower)) usedModules.add('process-manager');
      if (/^(copy|paste|clips?)/.test(lower)) usedModules.add('clipboard');
      if (/^(tile|fullscreen|center|resize|minimize|windows)/.test(lower)) usedModules.add('window-manager');
      if (/^(play|pause|next|prev|now\s+playing|shuffle)/.test(lower)) usedModules.add('media-control');
      if (/^(workflow|shortcut|every|scheduled)/.test(lower)) usedModules.add('workflow');
      if (/^(ask|ai|chat|summarize|explain|models)/.test(lower)) usedModules.add('ai-chat');
      if (/^(weather|forecast|news|headlines)/.test(lower)) usedModules.add('weather-news');
      if (/^(good\s+morning|good\s+night|routines?)/.test(lower)) usedModules.add('smart-routines');
      if (/^(read\s+screen|summarize\s+screen|screen|ocr)/.test(lower)) usedModules.add('screen-awareness');
      if (/^(research|find\s+papers|academic\s+search)/.test(lower)) usedModules.add('research');
      if (/^(whatsapp|send\s+whatsapp|message.*whatsapp)/.test(lower)) usedModules.add('whatsapp');
      if (/^(browse|google|read\s+page|screenshot|close\s+browser|go\s+to)/.test(lower)) usedModules.add('browser-control');
    }

    // Suggest commands from modules the user hasn't tried
    const suggestions: string[] = [];
    const unusedExamples = COMMAND_EXAMPLES.filter(ex => !usedModules.has(ex.module));

    if (unusedExamples.length > 0) {
      // Pick up to 5 from unused modules
      const seen = new Set<string>();
      for (const ex of unusedExamples) {
        if (!seen.has(ex.module)) {
          seen.add(ex.module);
          suggestions.push(ex.label);
          if (suggestions.length >= 5) break;
        }
      }
    }

    if (suggestions.length === 0) {
      return { success: true, message: 'You\'ve explored all modules! Try "help" to see every command, or "ask <question>" to chat with AI.' };
    }

    const lines = suggestions.map(s => `    - ${s}`);
    return {
      success: true,
      message: `Try something new:\n${lines.join('\n')}\n\n  Type "help" for the full command list.`,
    };
  }

  private handleFrequentlyUsed(): CommandResult {
    const history = getHistory(500);
    if (history.length === 0) {
      return { success: true, message: 'No command history yet. Start using JARVIS and check back!' };
    }

    // Count command frequencies
    const freq = new Map<string, number>();
    for (const entry of history) {
      const cmd = entry.command.toLowerCase().trim();
      // Normalize to base command (first word or two)
      const base = cmd.split(/\s+/).slice(0, 2).join(' ');
      freq.set(base, (freq.get(base) ?? 0) + 1);
    }

    const sorted = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const lines = sorted.map(([cmd, count], i) => `    ${i + 1}. ${cmd} (${count}x)`);
    return {
      success: true,
      message: `Your most used commands:\n${lines.join('\n')}`,
    };
  }

  getHelp(): string {
    return [
      '  Smart Assist -- suggestions & analytics',
      '    what can I do              Get suggestions',
      '    suggestions                Show command ideas',
      '    top commands               Most used commands',
      '    frequent commands          Usage statistics',
    ].join('\n');
  }
}
