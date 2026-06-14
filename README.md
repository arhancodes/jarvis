# J.A.R.V.I.S.

**Just A Rather Very Intelligent System**

A macOS AI assistant with voice control, screen awareness, browser automation, and connection across Apple Watch and iPhone via [AIM](https://github.com/arhancodes/aim)

```
       ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗
       ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝
       ██║███████║██████╔╝██║   ██║██║███████╗
  ██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║
  ╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║
   ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝
```


## Docs

https://jarvis.arhan.dev/docs


## Quick Start

```bash
cd ~/Downloads/jarvis
npm install
npm run dev
```

Say "Jarvis" to activate voice control, or type commands directly

---

## Features

| Category | Capabilities |
|----------|-------------|
| **45+ modules** | All original modules plus: email, calendar, Spotify API, smart home (HomeKit), file intelligence, coding agent, deep research, morning digest, data connectors, energy monitor, multi-agent, API orchestrator, sandbox runner, comms stack, dossier, computer control, desktop control, YouTube tools, flight finder, dev agent, self-improve |
| **Intelligence layer** | Trace-driven learning, TF-IDF memory search, route prediction, habit detection, context injection |
| **Rust sidecar** | Native Rust binary for sub-millisecond vector search, fuzzy matching (Levenshtein), and trace analytics |
| **Plugin system** | @RegisterModule() decorator, hot-reload, external plugin packages |
| **Security monitoring** | Always-on breach monitor, network guardian, threat detection |
| **Conversational AI** | Multi-turn conversations powered by Claude API — streams responses, executes actions mid-conversation, remembers context |
| **Voice assistant** | Always-on wake word detection ("Jarvis"), on-device speech recognition, text-to-speech responses via Edge TTS or ElevenLabs |
| **Screen awareness** | Claude-vision screen reading — sees the screenshot directly (no OCR), understanding layout, buttons, and content; OCR fallback offline |
| **Screen interaction** | Process selected text with AI — paraphrase, rewrite, fix grammar, translate |
| **Browser automation** | Read a URL with fetch + Claude (no browser, seconds faster), plus full Playwright control — navigate, search, click, fill forms, screenshots |
| **WhatsApp** | Instant sub-second messaging over the multi-device protocol (Baileys) — no browser; scan a QR once to link |
| **Smart routines** | Voice-triggered routines like "good morning" and "good night" that chain multiple actions |
| **Multi-device** | Apple Watch and iPhone apps connect via AIM (Advanced Idea Mechanics) WebSocket relay |
| **Menubar app** | Native macOS menubar icon showing JARVIS status, voice state, and last command |
| **Command chaining** | `battery && cpu && disk` — run multiple commands in sequence |
| **Fuzzy matching** | Typo tolerance via Levenshtein distance — `baterry` still works |
| **Variables** | `$HOME`, `$DATE`, `$TIME`, custom `$vars` |
| **Command history** | Persistent across sessions, searchable, `!!` to repeat last |
| **Aliases** | Create shortcuts for any command |
| **Workflows** | Multi-step automations saved and replayable |
| **Scheduling** | Cron-style recurring tasks (`every 5 min run battery`) |
| **macOS Shortcuts** | Run and list Shortcuts.app shortcuts directly |
| **Startup commands** | Auto-run commands on launch |

---

## Voice Assistant

JARVIS has an always-on voice assistant with wake word detection. Say "Jarvis" and it starts listening

```
jarvis> voice on
  ✓ Voice assistant started. Say "Jarvis" to activate.

  [voice] Wake word detected, listening...
  [voice] Hello sir, how can I help?

  🗣  "open Safari"
  ✓ Opened Safari

  🗣  "what's my battery"
  ✓ Battery: 60%

  🗣  "good night"
  (runs good night routine — lowers volume, enables DND, locks screen)
```

Uses Apple's SFSpeechRecognizer for on-device speech recognition and Edge TTS/ElevenLabs for spoken responses

> Requires macOS 13+ with Xcode Command Line Tools (`xcode-select --install`).

---

## Conversation Engine

JARVIS uses a multi-turn conversation engine that understands context, executes actions mid-conversation, and remembers facts across sessions

```
jarvis> turn on dark mode and set volume to 30

  [action] dark mode on
  ✓ Dark mode enabled
  [action] volume 30
  ✓ Volume set to 30%
  Done — dark mode is on and volume is at 30%.

jarvis> what's on my screen right now?

  I can see you have VS Code open with a TypeScript file...

jarvis> remember that my project deadline is March 20th

  ✓ Noted — I'll remember your project deadline is March 20th.
```

Powered by Claude, the conversation engine detects `[ACTION:]` tags in responses and executes them in real time, supports `[REMEMBER:]` for persistent memory, and maintains full conversation context.

---

## All Commands

### App Launcher

```
jarvis> open Safari
  ✓ Opened Safari

jarvis> close Slack
  ✓ Closed Slack

jarvis> switch to Chrome
  ✓ Switched to Chrome

jarvis> list apps
  ✓ Running applications:
    • Finder
    • Google Chrome
    • Terminal
```

| Command | What it does |
|---------|-------------|
| `open <app>` | Launch an application |
| `close <app>` / `quit <app>` | Quit an application |
| `switch to <app>` | Bring app to front |
| `list apps` / `apps` | List running applications |

### Browser Control

```
jarvis> summarize stripe.com
  ✓ (reads the page with fetch + Claude — no browser — and summarizes it)

jarvis> browse youtube.com
  ✓ Navigated to https://youtube.com

jarvis> search "TypeScript tutorials"
  ✓ Searched Google for "TypeScript tutorials"

jarvis> read this page
  ✓ (extracts content from the open browser page)

jarvis> screenshot
  ✓ Screenshot saved to jarvis-screenshot-1710432000.png
```

Reading a URL uses **fetch + Claude extraction — no browser launch**, so it's seconds faster; it falls back to a real browser only for JS-heavy pages. Interactive automation (navigate, click, fill, screenshot) runs on Playwright.

| Command | What it does |
|---------|-------------|
| `read <url>` / `summarize <url>` | Read & summarize a page with fetch + Claude (no browser; browser fallback for JS-heavy pages) |
| `browse <url>` / `go to <url>` | Open a URL in the browser |
| `search <query>` | Google search |
| `read this page` | Extract content from the open browser page |
| `click <element>` | Click an element on the page |
| `fill <field> with <value>` | Fill a form field |
| `screenshot` | Take a browser screenshot |

### Script Runner

```
jarvis> $ git status
  ✓ On branch main, nothing to commit

jarvis> run ls -la
  ✓ (full directory listing)
```

Dangerous commands (`rm -rf /`, `sudo rm`, `mkfs`, `dd`, `fork bombs`, `chmod 777`, etc.) are automatically blocked

| Command | What it does |
|---------|-------------|
| `$ <command>` | Run a shell command |
| `run <command>` / `exec <command>` | Run a shell command |
| `shell <command>` | Run a shell command |

### System Monitor

```
jarvis> cpu
  ✓ CPU: Apple M3
    Cores: 8
    Usage: 25.3% user, 21.4% sys, 53.3% idle

jarvis> battery
  ✓ Battery: 60%
    State: charging
    Remaining: 2:34

jarvis> status
  ─── JARVIS SYSTEM REPORT ───
  (full CPU + Memory + Disk + Battery + Network dashboard)
```

| Command | What it shows |
|---------|--------------|
| `cpu` / `processor` | CPU model, cores, usage |
| `memory` / `ram` | Total, used, free RAM |
| `disk` / `storage` / `space` | Disk usage and available space |
| `battery` | Charge %, state, time remaining |
| `network` / `wifi` / `ip` | Local IP, WiFi SSID |
| `status` | All of the above in one report |

### File Operations

```
jarvis> search package.json
  ✓ Found 5 result(s)

jarvis> open folder ~/Downloads
  ✓ Opened /Users/you/Downloads in Finder

jarvis> delete ~/Desktop/junk.txt
  ✓ Moved to Trash: /Users/you/Desktop/junk.txt
```

File search uses Spotlight (`mdfind`) for instant results. Delete moves files to Trash 

| Command | What it does |
|---------|-------------|
| `search <name>` | Spotlight file search |
| `open folder <path>` | Open in Finder |
| `move <src> to <dest>` | Move file/folder |
| `copy <src> to <dest>` | Copy file/folder |
| `delete <path>` | Move to Trash |
| `ls <path>` | List directory |

### System Control

```
jarvis> volume 50
  ✓ Volume set to 50%

jarvis> dark mode on
  ✓ Dark mode enabled

jarvis> lock
  ✓ Screen locked
```

| Command | What it does |
|---------|-------------|
| `volume <0-100>` | Set volume |
| `volume up` / `volume down` | Adjust by 10% |
| `mute` / `unmute` | Toggle mute |
| `brightness <0-100>` | Set brightness |
| `brighter` / `dimmer` | Adjust brightness |
| `dark mode` / `light mode` | Toggle dark mode |
| `dnd on` / `dnd off` | Do Not Disturb |
| `sleep` / `lock` | Sleep or lock screen |
| `screensaver` | Start screensaver |
| `empty trash` | Empty the Trash |
| `shutdown` / `restart` | Power controls |

### Timers & Reminders

```
jarvis> timer 5 min
  ✓ Timer #1 set for 5m (fires at 3:45:00 PM)

jarvis> remind me in 1 hour to push code
  ✓ Reminder #1 set: "push code" in 1h (at 4:40:00 PM)

jarvis> stopwatch
  ✓ Stopwatch started! Type "stopwatch" again to stop.
```

When timers fire, you get a notification with sound + a terminal alert

Time formats: `30s`, `5 min`, `1h30m`, `2.5 hours`, `1:30`, or just a bare number (assumed minutes)

| Command | What it does |
|---------|-------------|
| `timer <duration>` | Set a countdown |
| `remind me in <time> to <msg>` | Reminder with notification |
| `alarm <time>` | Set alarm (e.g. `7:00 am`) |
| `stopwatch` | Start/stop stopwatch |
| `timers` | List active timers |
| `cancel timer <#>` | Cancel specific timer |
| `cancel all timers` | Cancel everything |

### Process Manager

```
jarvis> top cpu
  ✓ Top CPU processes:
    1. Google Chrome Helper  — 45.2%
    2. node                  — 12.1%

jarvis> port 3000
  ✓ Port 3000: node (PID 12345)

jarvis> kill node
  ✓ Killed process: node
```

| Command | What it does |
|---------|-------------|
| `top cpu` / `top memory` | Show top resource consumers |
| `kill <name>` | Kill a process by name |
| `kill pid <pid>` | Kill a process by PID |
| `port <number>` | Show what's using a port |
| `kill port <number>` | Kill process on a port |
| `find process <name>` | Search for a running process |
| `ps` | List all foreground processes |

### Clipboard Manager

```
jarvis> paste
  ✓ Clipboard: (current clipboard contents)

jarvis> clips
  ✓ Clipboard history:
    #1  Hello world
    #2  npm install

jarvis> paste #2
  ✓ Pasted from history: npm install
```

| Command | What it does |
|---------|-------------|
| `copy <text>` | Copy text to clipboard |
| `paste` / `clipboard` | Show current clipboard |
| `clips` / `clip history` | Show clipboard history (last 50) |
| `paste #<n>` | Paste from history by index |
| `clip search <query>` | Search clipboard history |
| `clip clear` | Clear clipboard history |

### Window Manager

```
jarvis> tile Safari left
  ✓ Tiled Safari to left

jarvis> tile Chrome right
  ✓ Tiled Chrome to right

jarvis> Safari and Chrome side by side
  ✓ Arranged Safari and Chrome side by side

jarvis> fullscreen Terminal
  ✓ Maximized Terminal
```

| Command | What it does |
|---------|-------------|
| `tile <app> left/right` | Tile to half of screen |
| `tile <app> top/bottom` | Tile to top/bottom half |
| `fullscreen <app>` / `maximize <app>` | Maximize window |
| `center <app>` | Center window on screen |
| `resize <app> 800x600` | Resize to dimensions |
| `minimize <app>` | Minimize all windows |
| `<app> and <app> side by side` | Arrange two apps side by side |
| `windows` | List all open windows |

### Media Control (Spotify & Apple Music)

```
jarvis> play
  ✓ Playing (Spotify)

jarvis> now playing
  ✓ ▶ Bohemian Rhapsody
    by Queen
    on A Night at the Opera

jarvis> next
  ✓ ▶ Don't Stop Me Now

jarvis> play "Daft Punk"
  ✓ Searching Spotify for "Daft Punk"
```

Auto-detects whether Spotify or Apple Music is running

| Command | What it does |
|---------|-------------|
| `play` / `resume` | Start/resume playback |
| `pause` | Pause playback |
| `next` / `skip` | Next track |
| `prev` / `back` | Previous track |
| `play/pause` | Toggle play/pause |
| `now playing` / `np` | Show current track |
| `play <song/artist>` | Search and play on Spotify |
| `playlist <name>` | Play a playlist |
| `shuffle` / `shuffle off` | Toggle shuffle |
| `repeat` | Toggle repeat |

### Screen Awareness

```
jarvis> what's on my screen
  ✓ (Claude vision reads the screenshot directly and describes it)

jarvis> summarize my screen
  ✓ (2-3 sentence summary of the current screen)

jarvis> read screen
  ✓ (extracts all visible text via OCR)
```

Reads your screen with **Claude vision** — it sees the screenshot directly (one call, no OCR step), so it understands layout, buttons, and content, not just text. Screenshots are downscaled to 1568px for speed. OCR (macOS Vision / Tesseract) stays as an offline fallback, and the conversation engine can inject screen context into conversations for context-aware responses.

### Screen Interaction

```
jarvis> paraphrase this
  (paraphrases selected text using AI)

jarvis> fix grammar
  (fixes grammar in selected text)

jarvis> translate to Spanish
  (translates selected text)
```

Processes currently selected text with AI for rewriting, grammar fixes, translation, and more.

### WhatsApp

```
jarvis> whatsapp login
  ✓ Scan the QR code in the console once — auth persists after that

jarvis> message mom running late
  ✓ Message sent to mom

jarvis> whatsapp dad: call me
  ✓ Message sent to dad

jarvis> read whatsapp
  ✓ Recent messages: ...
```

Sends WhatsApp messages over the **multi-device protocol (Baileys)** — a persistent in-process socket, **no browser**, so sends are sub-second instead of 7–15s. Scan a QR code once to link; auth is saved to `~/.jarvis/whatsapp-auth` and reconnects silently afterward. Contact names resolve to numbers via `config/whatsapp-contacts.json` or macOS Contacts.

### Weather & News

```
jarvis> weather
  ✓ Current weather: 72°F, Sunny

jarvis> news
  ✓ Top headlines: ...
```

Get current weather conditions and top news headlines.

### Smart Routines

```
jarvis> good morning
  ✓ Running morning routine...
    Volume set to 40%
    Here's your weather...
    Here are today's headlines...

jarvis> good night
  ✓ Running night routine...
    Do Not Disturb enabled
    Volume set to 10%
    Screen locked
```

Voice-triggered routines that chain multiple actions together.

### Conversions

```
jarvis> convert 5 miles to km
  ✓ 5 miles = 8.045 km

jarvis> time in Tokyo
  ✓ Tokyo: 2:30 AM (JST, +9:00)
```

Unit conversions and timezone lookups — always accurate, no LLM needed.

### Site Monitor

```
jarvis> check if google.com is up
  ✓ google.com is UP (200 OK, 45ms)

jarvis> monitor mysite.com every 5 min
  ✓ Monitoring mysite.com every 5 minutes
```

Check if websites and services are online, with optional recurring monitoring.

### Workflows & Automation

```
jarvis> create workflow morning: battery && cpu && volume 30
  ✓ Workflow "morning" created with 3 steps

jarvis> workflow morning
  Running workflow "morning" (3 steps)...

jarvis> every 5 min run battery
  ✓ Scheduled #1: "battery" every 5m

jarvis> shortcut "Toggle Dark Mode"
  ✓ Shortcut "Toggle Dark Mode" executed
```

| Command | What it does |
|---------|-------------|
| `create workflow <name>: step1 && step2` | Create a workflow |
| `workflow <name>` | Run a saved workflow |
| `workflows` | List all workflows |
| `delete workflow <name>` | Delete a workflow |
| `shortcut <name>` | Run a macOS Shortcut |
| `shortcuts` | List macOS Shortcuts |
| `every <interval> run <cmd>` | Schedule a recurring command |
| `scheduled` / `cron` | List scheduled tasks |
| `cancel scheduled <#>` | Cancel a scheduled task |

### AI Chat

```
jarvis> ask what is recursion
  Recursion is a programming technique where a function calls itself...

jarvis> summarize ~/code/main.py
  This file implements a REST API server with 3 endpoints...

jarvis> explain package.json
  This is a Node.js project configuration file...

```

Uses Claude API for responses. If the API is unavailable, all other JARVIS features still work normally.

| Command | What it does |
|---------|-------------|
| `ask <question>` / `ai <prompt>` | Chat with AI |
| `summarize <file or topic>` | Summarize a file or topic |
| `explain <file or topic>` | Explain code or a concept |
| `clear chat` / `new conversation` | Reset conversation history |
| `ai status` | Check LLM connection |

### JARVIS Personality

```
jarvis> hello
  ✓ Good morning, sir. All systems operational. How may I assist you?

jarvis> tell me a joke
  ✓ Why do programmers prefer dark mode? Because light attracts bugs.

jarvis> who are you
  ✓ I'm JARVIS -- Just A Rather Very Intelligent System. I have 45+ modules
    loaded and can manage your apps, files, system, media, browser, and more.
```

Time-aware greetings, tech jokes, system-aware mood responses, and existential philosophy.

### Smart Assist

```
jarvis> show me heaviest processes
  ✓ (automatically maps to "top cpu" via NLU)

jarvis> what can I do
  ✓ Try something new:
    - cpu
    - open <app>
    - timer <duration>
    - browse <url>
    - ask <question>

jarvis> top commands
  ✓ Your most used commands:
    1. battery (15x)
    2. cpu (12x)
    3. volume 50 (8x)
```

### Research

```
jarvis> research quantum computing
  ✓ 15 papers analyzed (8 arXiv, 12 Semantic Scholar)
  Report saved to config/research-reports/...

jarvis> deep research transformer architectures
  ✓ Deep research complete: 4 rounds, 28 papers

jarvis> compare React vs Vue
  ✓ Comparison complete with table and recommendation

jarvis> quick research latest iPhone
  ✓ Quick web lookup complete
```

| Command | What it does |
|---------|-------------|
| `research <topic>` | Academic + web research (arXiv, Semantic Scholar, DuckDuckGo) |
| `deep research <topic>` | Multi-hop investigation with follow-up rounds |
| `quick research <topic>` | Fast web-only lookup |
| `compare X vs Y` | Side-by-side comparison with recommendation |
| `search docs for <topic>` | Search local files only |
| `research status` | Check module status |

### Intelligence Layer

```
jarvis> (runs automatically in background)
  Trace recording: every command logged with timing and context
  Route prediction: suggests modules based on usage patterns
  Habit detection: identifies your daily routines
  Memory search: hybrid TF-IDF + Rust vector search
```

JARVIS learns from your usage. Every command is recorded as a trace with timing, context (time of day, active app, voice mode), and result. The learning engine analyzes these traces to detect habits, predict what you'll do next, and suggest automations.

### Rust Sidecar

```
jarvis> (starts automatically on boot)
  [rust-bridge] Sidecar ready
  Vector search: <1ms memory retrieval
  Fuzzy match: Rust-accelerated Levenshtein
  Trace analytics: single-pass stats over 5000+ traces
```

A compiled Rust binary (`rust-sidecar/`) that accelerates performance-critical operations. Falls back gracefully to TypeScript when unavailable.

| Capability | Endpoint | What it does |
|-----------|----------|-------------|
| Vector search | `/search` | Sub-millisecond semantic memory retrieval |
| Fuzzy matching | `/fuzzy-match` | Rust Levenshtein for typo correction |
| Trace analytics | `/trace-analytics` | Comprehensive usage statistics |
| Habit detection | `/detect-habits` | Pattern recognition across trace history |

---

## Multi-Device Support

JARVIS connects to Apple Watch and iPhone via [AIM](https://github.com/arhancodes/aim)

| Device | What it does |
|--------|-------------|
| **Mac** | Full JARVIS experience — CLI, voice, menubar, screen awareness |
| **iPhone** | Send commands and receive responses via companion app |
| **Apple Watch** | Quick commands from your wrist, haptic feedback |

The menubar app shows JARVIS status at a glance

---

## Command Chaining

Run multiple commands in sequence with `&&` or `;`:

```
jarvis> battery && cpu && disk
  ✓ Battery: 85% ...
  ✓ CPU: Apple M3 ...
  ✓ Disk: 45% used ...

jarvis> open Safari; open Chrome; tile Safari left; tile Chrome right
```

## Variables

Built-in variables expand automatically:

```
jarvis> $ echo $HOME
  ✓ /Users/you

jarvis> set mydir = ~/Projects
  ✓ Variable $mydir set

jarvis> open folder $mydir
  ✓ Opened /Users/you/Projects in Finder
```

| Variable | Value |
|----------|-------|
| `$HOME` | Home directory |
| `$USER` | Username |
| `$DATE` | Today's date (YYYY-MM-DD) |
| `$TIME` | Current time (HH:MM:SS) |
| `$NOW` | Full timestamp |
| `$PWD` | Current directory |
| `$UPTIME` | Session uptime |

## Command History

Persistent across sessions:

```
jarvis> history
  Recent commands:
    1. battery
    2. volume 50
    3. open Safari

jarvis> !!
  (repeats last command)

jarvis> history search volume
  Matches: volume 50, volume up, ...
```

| Command | What it does |
|---------|-------------|
| `history` | Show recent commands |
| `history <n>` | Show last n commands |
| `!!` | Repeat last command |
| `history search <query>` | Search command history |
| `history clear` | Clear all history |

## Aliases

Create shortcuts for frequently used commands:

```
jarvis> alias deploy = run npm run build && npm run deploy
  ✓ Alias created: "deploy" → "run npm run build && npm run deploy"

jarvis> deploy
  (runs the aliased command)

jarvis> aliases
  chrome → open Google Chrome
  safari → open Safari
  stats  → status
  vol    → volume
```

## Startup Commands

Auto-run commands every time JARVIS launches:

```
jarvis> startup add battery
jarvis> startup add volume
jarvis> startup list
  1. battery
  2. volume
```

## Fuzzy Matching & Typo Tolerance

JARVIS uses Levenshtein distance to handle typos. If your input is within an edit distance of 2 from a known keyword, it still works:

```
jarvis> baterry
  ✓ Battery: 85% ...

jarvis> neetwork
  ✓ Network: 192.168.1.5, WiFi: MyNetwork
```

---

## Architecture

```
User Input → Variable Expansion → Alias Expansion → Pattern Parser → Executor → Module
                                                          ↓                        ↓
                                                    Keyword Fallback    AppleScript / shell / LLM
                                                          ↓
                                                    Fuzzy Match (Rust/Levenshtein)
                                                          ↓
                                                    NLU Mapping (natural language)
                                                          ↓
                                                    Intelligence Layer (traces, prediction, context)
                                                          ↓
                                                    Conversation Engine (Claude API)
```

The core parser uses **no AI/LLM** — it's a seven-phase engine:

1. **Variable expansion** — `$HOME`, `$DATE`, custom `$vars`
2. **Alias expansion** — user-defined shortcuts
3. **"open" disambiguation** — detects if target is app or file path
4. **Regex pattern matching** — each module declares regex patterns; first match wins (confidence 1.0)
5. **Keyword fallback** — exact keyword match (confidence 0.6), then Levenshtein fuzzy match (confidence 0.4)
6. **NLU mapping** — natural language phrases mapped to existing commands (confidence 0.5)
7. **Conversation engine** — if nothing matches, treats input as natural language and routes to the conversational AI

### Project Structure

```
jarvis/
├── bin/jarvis.ts                  # Entry point
├── rust-sidecar/
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs              # HTTP server (actix-web) — vector search, fuzzy, traces
│       ├── vector.rs            # Cosine similarity vector index
│       ├── embeddings.rs        # TF-IDF text embedder (384-dim)
│       ├── fuzzy.rs             # Levenshtein distance + batch matching
│       └── traces.rs            # Trace analytics + habit detection
├── config/
│   ├── aliases.json               # User command shortcuts
│   ├── startup.json               # Auto-run on boot
│   ├── workflows.json             # Saved workflows
│   └── scheduled-tasks.json       # Recurring tasks
├── src/
│   ├── index.ts                   # REPL loop, wires everything together
│   ├── mac-client.ts              # Thin client for VPS mode
│   ├── core/
│   │   ├── types.ts               # Shared interfaces (45+ module types)
│   │   ├── parser.ts              # 7-phase NL parser + fuzzy matching
│   │   ├── registry.ts            # Module registry
│   │   ├── executor.ts            # Dispatches to modules
│   │   ├── conversation-engine.ts # Multi-turn AI with action execution
│   │   ├── memory.ts              # Persistent memory and conversation context
│   │   ├── capabilities.ts        # System prompt builder for AI
│   │   ├── history.ts             # Persistent command history
│   │   └── context.ts             # Session state + variable expansion
│   ├── intelligence/
│   │   ├── index.ts               # Barrel exports + initialization
│   │   ├── trace-store.ts         # Command trace recording (capped at 5000)
│   │   ├── router-policy.ts       # Route suggestion + next-command prediction
│   │   ├── learning-engine.ts     # Habit detection + failure analysis
│   │   ├── memory-index.ts        # TF-IDF search + hybrid Rust vector search
│   │   ├── context-engine.ts      # Context injection for LLM prompts
│   │   └── energy-tracker.ts      # Operation energy/cost tracking
│   ├── modules/                   # 45+ modules (see table below)
│   ├── utils/
│   │   ├── shell.ts               # Safe child_process wrapper + deny-list
│   │   ├── osascript.ts           # AppleScript helpers
│   │   ├── formatter.ts           # Chalk colored terminal output
│   │   ├── llm.ts                 # LLM provider (Claude API)
│   │   ├── browser-manager.ts     # Playwright browser lifecycle
│   │   ├── voice-output.ts        # TTS via Edge TTS / ElevenLabs
│   │   ├── platform.ts            # OS detection (macOS / Linux)
│   │   ├── mac-proxy.ts           # Remote command proxy for VPS mode
│   │   └── status-reporter.ts     # Status file + AIM broadcast
│   ├── voice/
│   │   ├── voice-assistant.ts     # Wake word + speech recognition + conversation
│   │   └── voice-input.ts         # macOS Speech Recognition via Swift
│   └── watch/
│       ├── aim-bridge.ts          # AIM WebSocket bridge for multi-device
│       └── ws-server.ts           # WebSocket server for Watch connectivity
├── menubar/
│   ├── JarvisMenubar.swift        # Native macOS menubar app
│   └── start-menubar.sh           # Menubar launcher
├── watch/JarvisWatch/             # Xcode project for Watch + iPhone apps
├── package.json
└── tsconfig.json
```

### 45+ Modules

| Module | File | Description |
|--------|------|-------------|
| App Launcher | `app-launcher.ts` | Open, close, switch between, and list applications |
| Script Runner | `script-runner.ts` | Run shell commands with safety deny-list |
| System Monitor | `system-monitor.ts` | CPU, memory, disk, battery, and network info |
| File Operations | `file-operations.ts` | Search, move, copy, and delete files |
| System Control | `system-control.ts` | Volume, brightness, dark mode, DND, sleep, lock |
| Timers | `timer.ts` | Timers, reminders, alarms, and stopwatch |
| Process Manager | `process-manager.ts` | Kill processes, find resource hogs, check ports |
| Clipboard | `clipboard.ts` | Copy, paste, and clipboard history |
| Window Manager | `window-manager.ts` | Tile, resize, fullscreen, and arrange windows |
| Media Control | `media-control.ts` | Spotify and Apple Music control |
| Workflows | `workflow.ts` | Multi-step workflows and macOS Shortcuts |
| Personality | `personality.ts` | Greetings, jokes, and conversation |
| AI Chat | `ai-chat.ts` | Chat with Claude, summarize, explain |
| Smart Assist | `smart-assist.ts` | NLU mapping, suggestions, and usage analytics |
| Browser Control | `browser-control.ts` | Full browser automation via Playwright |
| WhatsApp | `whatsapp.ts` | Send and read WhatsApp messages |
| Screen Awareness | `screen-awareness.ts` | OCR-based screen reading |
| Screen Interaction | `screen-interact.ts` | AI-powered text processing on selections |
| Screen Watcher | `screen-watcher.ts` | Continuous screen monitoring |
| Smart Routines | `smart-routines.ts` | Voice-triggered routines (morning, night) |
| Weather & News | `weather-news.ts` | Current weather and top headlines |
| Research | `research.ts` | Academic paper research |
| Site Monitor | `site-monitor.ts` | Website uptime checking |
| Conversions | `conversions.ts` | Unit and timezone conversions |
| Scheduler | `scheduler.ts` | Recurring task scheduling |
| Email | `email.ts` | Gmail via Google API |
| Calendar | `calendar.ts` | Google Calendar integration |
| Spotify | `spotify.ts` | Spotify Web API — play, search, playlists |
| Smart Home | `smart-home.ts` | HomeKit control via macOS Shortcuts |
| File Intelligence | `file-intelligence.ts` | Advanced file analysis and search |
| Coding Agent | `coding-agent.ts` | Autonomous code generation and git |
| Self-Improve | `self-improve.ts` | Generates and hot-reloads its own modules |
| Multi-Agent | `multi-agent.ts` | Parallel task execution via Promise.allSettled |
| API Orchestrator | `api-orchestrator.ts` | Call any API via natural language |
| Morning Digest | `morning-digest.ts` | Daily briefing — weather, calendar, email, news |
| Data Connectors | `data-connectors.ts` | Slack, Notion, Apple Health, Strava |
| Deep Research | `deep-research.ts` | Multi-hop research with citations |
| Energy Monitor | `energy-monitor.ts` | Track operation energy and LLM costs |
| Sandbox Runner | `sandbox-runner.ts` | Docker-sandboxed code execution |
| Comms Stack | `comms-stack.ts` | Unified communications hub |
| Dossier | `dossier.ts` | Person/company intelligence profiles |
| Computer Control | `computer-control.ts` | Full desktop automation |
| Desktop Control | `desktop-control.ts` | Window and desktop management |
| YouTube Tools | `youtube-tools.ts` | YouTube search and playback |
| Flight Finder | `flight-finder.ts` | Flight search and price tracking |
| Dev Agent | `dev-agent.ts` | Development workflow automation |

## Dependencies

**Runtime:**

- [`chalk`](https://github.com/chalk/chalk) — terminal colors
- [`ws`](https://github.com/websockets/ws) — WebSocket client for AIM
- [`playwright`](https://playwright.dev) — browser automation
- [`@elevenlabs/elevenlabs-js`](https://github.com/elevenlabs/elevenlabs-js) — voice synthesis (optional)
- [`dotenv`](https://github.com/motdotla/dotenv) — environment variables
- [`actix-web`](https://actix.rs) — Rust HTTP server (sidecar)

**Dev only:**

- `typescript` — compiler
- `tsx` — run .ts files directly in dev
- `@types/node` — Node.js type definitions

Everything else is Node.js built-ins (`readline`, `child_process`, `os`, `fs`) and macOS native tools (`osascript`, `mdfind`, `pmset`, `open`, `pbcopy`/`pbpaste`, `lsof`, `shortcuts`).

## Requirements

- **macOS** (tested on macOS 14+ Sonoma, Apple Silicon)
- **Node.js 20+**
- **Xcode Command Line Tools** (for voice commands): `xcode-select --install`
- **Claude API key**: set in `config/llm-config.json`
- **Rust** (optional, for sidecar): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`

## Build & Install

```bash
# Development (uses tsx, no build step)
npm run dev

# Production build
npm run build
npm start

# Build Rust sidecar (optional — JARVIS works without it)
cd rust-sidecar && cargo build --release

# Install globally (makes 'jarvis' available everywhere)
npm link
jarvis
```
