import * as readline from 'readline';
import { exec } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { registry } from './core/registry.js';
import { parse, splitChainedCommands } from './core/parser.js';
import { execute } from './core/executor.js';
import { fmt } from './utils/formatter.js';
import { recordCommand, getHistory, searchHistory, getLastCommand, flushHistory, clearHistory } from './core/history.js';
import { setLast, getSessionInfo, setVar, getAllVars } from './core/context.js';
import { AppLauncherModule } from './modules/app-launcher.js';
import { ScriptRunnerModule } from './modules/script-runner.js';
import { SystemMonitorModule } from './modules/system-monitor.js';
import { FileOperationsModule } from './modules/file-operations.js';
import { SystemControlModule } from './modules/system-control.js';
import { TimerModule } from './modules/timer.js';
import { ProcessManagerModule } from './modules/process-manager.js';
import { ClipboardModule } from './modules/clipboard.js';
import { WindowManagerModule } from './modules/window-manager.js';
import { MediaControlModule } from './modules/media-control.js';
import { WorkflowModule } from './modules/workflow.js';
import { PersonalityModule, getStartupGreeting } from './modules/personality.js';
import { AIChatModule } from './modules/ai-chat.js';
import { SmartAssistModule, tryNaturalLanguageMapping, getSuggestions, isLikelyCommandAttempt } from './modules/smart-assist.js';
import { WeatherNewsModule } from './modules/weather-news.js';
import { SmartRoutinesModule } from './modules/smart-routines.js';
import { ScreenAwarenessModule } from './modules/screen-awareness.js';
import { ResearchModule } from './modules/research.js';
import { BrowserControlModule } from './modules/browser-control.js';
import { WhatsAppModule } from './modules/whatsapp.js';
import { SiteMonitorModule } from './modules/site-monitor.js';
import { ScreenInteractModule } from './modules/screen-interact.js';
import { SchedulerModule } from './modules/scheduler.js';
import { ConversionsModule } from './modules/conversions.js';
import { DossierModule } from './modules/dossier.js';
import { closeAll as closeAllBrowsers } from './utils/browser-manager.js';
import { voiceInput } from './voice/voice-input.js';
import { VoiceAssistant } from './voice/voice-assistant.js';
import { reportBoot, reportCommand, reportShutdown, reportVoice, reportSidecar, reportWhatsApp, reportModel } from './utils/status-reporter.js';
import { getLLMConfig } from './utils/llm.js';
import { speak, isVoiceEnabled, stopSpeaking } from './utils/voice-output.js';
import { conversationEngine } from './core/conversation-engine.js';
import { loadMemory, flushMemory } from './core/memory.js';
import { startWatchServer, stopWatchServer } from './watch/ws-server.js';
import { startAIMBridge, stopAIMBridge, broadcastStatusViaAIM } from './watch/aim-bridge.js';
import { IS_MAC } from './utils/platform.js';
import { setAIMStatusBroadcast } from './utils/status-reporter.js';
import { startBreachMonitor, stopBreachMonitor, getBreachStatus, runManualCheck } from './utils/breach-monitor.js';
import { startNetworkGuardian, stopNetworkGuardian, getNetworkDevices, trustDevice, runManualScan } from './utils/network-guardian.js';
import { startThreatMonitor, stopThreatMonitor } from './utils/threat-monitor.js';
import { CommsStackModule } from './modules/comms-stack.js';
import { DevAgentModule } from './modules/dev-agent.js';
import { ComputerControlModule } from './modules/computer-control.js';
import { DesktopControlModule } from './modules/desktop-control.js';
import { YouTubeToolsModule } from './modules/youtube-tools.js';
import { FlightFinderModule } from './modules/flight-finder.js';
import { startBackgroundIntelligence, stopBackgroundIntelligence, learnCommand } from './utils/background-intelligence.js';
import { EmailModule } from './modules/email.js';
import { CalendarModule } from './modules/calendar.js';
import { SpotifyModule } from './modules/spotify.js';
import { SmartHomeModule } from './modules/smart-home.js';
import { FileIntelligenceModule } from './modules/file-intelligence.js';
import { CodingAgentModule } from './modules/coding-agent.js';
import { SelfImproveModule } from './modules/self-improve.js';
import MultiAgentModule from './modules/multi-agent.js';
import ApiOrchestratorModule from './modules/api-orchestrator.js';
import { MorningDigestModule } from './modules/morning-digest.js';
import { initIntelligence, recordTrace, shouldSuggestAutomation } from './intelligence/index.js';
import DataConnectorsModule from './modules/data-connectors.js';
import { configPath, readJsonConfig, projectPath } from './utils/config.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('jarvis');

import { EnergyMonitorModule } from './modules/energy-monitor.js';
import { SandboxRunnerModule } from './modules/sandbox-runner.js';
import { discoverGeneratedModules, bootModules } from './core/registry.js';
import { loadPluginsFromConfig } from './core/plugin-loader.js';
import { startSidecar, stopSidecar } from './utils/rust-bridge.js';
import { popUndo, peekUndo, listUndoStack } from './core/undo-stack.js';
import { homedir } from 'os';
import { join as joinPath } from 'path';
import qrcodeTerminal from 'qrcode-terminal';
import { startWhatsApp } from './utils/whatsapp-baileys.js';

function getAliasPath(): string { return configPath('aliases.json'); }
function getStartupPath(): string { return configPath('startup.json'); }

interface StartupConfig {
  commands: string[];
  greeting: boolean;
}

function printBanner(): void {
  console.log(fmt.banner(`
       ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗
       ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝
       ██║███████║██████╔╝██║   ██║██║███████╗
  ██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║
  ╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║
   ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝`));
  console.log(fmt.info('Just A Rather Very Intelligent System — v2.1.0'));
  console.log(fmt.dim(`  ${registry.getAll().length} modules loaded | ${new Date().toLocaleDateString()}`));
  console.log(fmt.info('Type "help" for commands, "exit" to quit.\n'));
}

function printHelp(): void {
  console.log(fmt.heading('Available Commands'));
  for (const mod of registry.getAll()) {
    console.log(mod.getHelp());
    console.log('');
  }
  console.log('  Meta Commands');
  console.log('    help                Show this help message');
  console.log('    help <module>       Module-specific help');
  console.log('    alias <n> = <cmd>   Create a command alias');
  console.log('    aliases             List all aliases');
  console.log('    voice / listen      Enter voice command mode');
  console.log('    voice on            Start always-on voice assistant');
  console.log('    voice off           Stop voice assistant');
  console.log('    voice aware on/off  Only respond when addressed (on) vs always (off)');
  console.log('    voice status        Voice assistant status');
  console.log('    watch on            Start screen monitoring');
  console.log('    watch off           Stop screen monitoring');
  console.log('    watch status        Screen watcher status');
  console.log('    history             Show command history');
  console.log('    history search <q>  Search command history');
  console.log('    !!                  Repeat last command');
  console.log('    set <var> = <val>   Set a variable');
  console.log('    vars                Show all variables');
  console.log('    uptime              Session info');
  console.log('    startup add <cmd>   Auto-run command on boot');
  console.log('    startup list        List startup commands');
  console.log('    startup clear       Clear startup commands');
  console.log('    cmd1 && cmd2        Chain commands');
  console.log('    exit / quit / shutdown  Exit JARVIS');
  console.log('');
  console.log('  Breach Monitor (always-on)');
  console.log('    breach status       Show monitored domains & recent alerts');
  console.log('    breach check        Force a manual security scan now');
  console.log('');
  console.log('  Network Guardian (always-on)');
  console.log('    network devices     List all known devices on your network');
  console.log('    network scan        Force a manual network scan now');
  console.log('    trust device <mac>  Trust a device so it stops triggering alerts');
  console.log('');
}

function handleAlias(input: string): boolean {
  const aliasMatch = input.match(/^alias\s+(\S+)\s*=\s*(.+)/i);
  if (aliasMatch) {
    const [, name, command] = aliasMatch;
    const aliasPath = getAliasPath();
    let aliases: Record<string, string> = {};
    try { aliases = JSON.parse(readFileSync(aliasPath, 'utf-8')); } catch (err) { log.debug('No existing aliases file', err); }
    aliases[name.toLowerCase()] = command.trim();
    writeFileSync(aliasPath, JSON.stringify(aliases, null, 2) + '\n');
    console.log(fmt.success(`Alias created: "${name}" → "${command.trim()}"`));
    return true;
  }

  if (/^aliases$/i.test(input)) {
    const aliasPath = getAliasPath();
    try {
      const aliases = JSON.parse(readFileSync(aliasPath, 'utf-8')) as Record<string, string>;
      const entries = Object.entries(aliases);
      if (entries.length === 0) {
        console.log(fmt.info('No aliases defined.'));
      } else {
        console.log(fmt.heading('Aliases'));
        for (const [key, val] of entries) {
          console.log(fmt.label(key, val));
        }
      }
    } catch (err) {
      log.debug('Could not read aliases', err);
      console.log(fmt.info('No aliases defined.'));
    }
    return true;
  }

  // Delete alias
  const delMatch = input.match(/^(?:delete|remove)\s+alias\s+(\S+)/i);
  if (delMatch) {
    const aliasPath = getAliasPath();
    let aliases: Record<string, string> = {};
    try { aliases = JSON.parse(readFileSync(aliasPath, 'utf-8')); } catch (err) { log.debug('No existing aliases file', err); }
    const key = delMatch[1].toLowerCase();
    if (key in aliases) {
      delete aliases[key];
      writeFileSync(aliasPath, JSON.stringify(aliases, null, 2) + '\n');
      console.log(fmt.success(`Alias "${key}" removed`));
    } else {
      console.log(fmt.warn(`Alias "${key}" not found`));
    }
    return true;
  }

  return false;
}

function handleStartup(input: string): boolean {
  const addMatch = input.match(/^startup\s+add\s+(.+)/i);
  if (addMatch) {
    const cmd = addMatch[1].trim();
    const startupPath = getStartupPath();
    let config: StartupConfig = { commands: [], greeting: true };
    try { config = JSON.parse(readFileSync(startupPath, 'utf-8')); } catch (err) { log.debug('No existing startup config', err); }
    config.commands.push(cmd);
    writeFileSync(startupPath, JSON.stringify(config, null, 2) + '\n');
    console.log(fmt.success(`Startup command added: "${cmd}"`));
    return true;
  }

  if (/^startup\s+list$/i.test(input)) {
    const startupPath = getStartupPath();
    try {
      const config = JSON.parse(readFileSync(startupPath, 'utf-8')) as StartupConfig;
      if (config.commands.length === 0) {
        console.log(fmt.info('No startup commands configured.'));
      } else {
        console.log(fmt.heading('Startup Commands'));
        config.commands.forEach((cmd, i) => { console.log(`    ${i + 1}. ${cmd}`); });
      }
    } catch (err) {
      log.debug('Could not read startup config', err);
      console.log(fmt.info('No startup commands configured.'));
    }
    return true;
  }

  if (/^startup\s+clear$/i.test(input)) {
    const startupPath = getStartupPath();
    writeFileSync(startupPath, JSON.stringify({ commands: [], greeting: true }, null, 2) + '\n');
    console.log(fmt.success('Startup commands cleared.'));
    return true;
  }

  const removeMatch = input.match(/^startup\s+remove\s+(\d+)/i);
  if (removeMatch) {
    const idx = parseInt(removeMatch[1], 10) - 1;
    const startupPath = getStartupPath();
    let config: StartupConfig = { commands: [], greeting: true };
    try { config = JSON.parse(readFileSync(startupPath, 'utf-8')); } catch (err) { log.debug('No existing startup config', err); }
    if (idx >= 0 && idx < config.commands.length) {
      const removed = config.commands.splice(idx, 1)[0];
      writeFileSync(startupPath, JSON.stringify(config, null, 2) + '\n');
      console.log(fmt.success(`Removed startup command: "${removed}"`));
    } else {
      console.log(fmt.error(`Invalid index: ${idx + 1}`));
    }
    return true;
  }

  return false;
}

function handleMeta(input: string): boolean {
  // History
  if (/^history$/i.test(input)) {
    const entries = getHistory(20);
    if (entries.length === 0) {
      console.log(fmt.info('No command history yet.'));
    } else {
      console.log(fmt.heading('Command History (last 20)'));
      entries.forEach((e, i) => {
        const ts = new Date(e.timestamp).toLocaleTimeString();
        const icon = e.success ? '✓' : '✗';
        console.log(`    ${icon} [${ts}] ${e.command}`);
      });
    }
    return true;
  }

  const histSearchMatch = input.match(/^history\s+search\s+(.+)/i);
  if (histSearchMatch) {
    const results = searchHistory(histSearchMatch[1]);
    if (results.length === 0) {
      console.log(fmt.info(`No history matching "${histSearchMatch[1]}"`));
    } else {
      console.log(fmt.heading('Search Results'));
      results.forEach(e => {
        const ts = new Date(e.timestamp).toLocaleTimeString();
        console.log(`    [${ts}] ${e.command}`);
      });
    }
    return true;
  }

  if (/^clear\s+history$/i.test(input)) {
    clearHistory();
    console.log(fmt.success('Command history cleared.'));
    return true;
  }

  // Variables
  const setMatch = input.match(/^set\s+(\w+)\s*=\s*(.+)/i);
  if (setMatch) {
    setVar(setMatch[1], setMatch[2].trim());
    console.log(fmt.success(`$${setMatch[1]} = "${setMatch[2].trim()}"`));
    return true;
  }

  if (/^vars$/i.test(input)) {
    const vars = getAllVars();
    if (vars.size === 0) {
      console.log(fmt.info('No variables set. Use: set <name> = <value>'));
    } else {
      console.log(fmt.heading('Variables'));
      for (const [key, val] of vars) {
        console.log(fmt.label(`$${key}`, val));
      }
    }
    return true;
  }

  // Uptime
  if (/^uptime$/i.test(input)) {
    const info = getSessionInfo();
    const mins = Math.floor(info.uptime / 60);
    const secs = info.uptime % 60;
    console.log(fmt.label('Session', `${mins}m ${secs}s`));
    console.log(fmt.label('Commands', String(info.commandCount)));
    return true;
  }

  return false;
}

async function runStartupCommands(): Promise<void> {
  const startupPath = getStartupPath();
  try {
    const config = JSON.parse(readFileSync(startupPath, 'utf-8')) as StartupConfig;
    if (config.commands.length > 0) {
      console.log(fmt.dim('  Running startup commands...'));
      for (const cmd of config.commands) {
        console.log(fmt.dim(`  → ${cmd}`));
        const parsed = await parse(cmd);
        if (parsed) {
          const result = await execute(parsed);
          if (result.success) console.log(fmt.success(result.message));
          else console.log(fmt.error(result.message));
        }
      }
      console.log('');
    }
  } catch (err) { log.debug('No startup config or failed to run', err); }
}

export function boot(): void {
  // Register all modules
  registry.register(new AppLauncherModule());
  registry.register(new ScriptRunnerModule());
  registry.register(new SystemMonitorModule());
  registry.register(new FileOperationsModule());
  registry.register(new SystemControlModule());
  registry.register(new TimerModule());
  registry.register(new ProcessManagerModule());
  registry.register(new ClipboardModule());
  registry.register(new WindowManagerModule());
  registry.register(new MediaControlModule());
  registry.register(new WorkflowModule());
  const scheduler = new SchedulerModule();
  registry.register(scheduler);
  registry.register(new ConversionsModule());
  registry.register(new PersonalityModule());
  registry.register(new AIChatModule());
  registry.register(new SmartAssistModule());
  registry.register(new WeatherNewsModule());
  registry.register(new SmartRoutinesModule());
  registry.register(new ScreenAwarenessModule());
  registry.register(new ResearchModule());
  registry.register(new BrowserControlModule());
  registry.register(new WhatsAppModule());
  registry.register(new CommsStackModule());
  registry.register(new SiteMonitorModule());
  registry.register(new ScreenInteractModule());
  registry.register(new DossierModule());
  registry.register(new DevAgentModule());
  registry.register(new ComputerControlModule());
  registry.register(new DesktopControlModule());
  registry.register(new YouTubeToolsModule());
  registry.register(new FlightFinderModule());
  registry.register(new EmailModule());
  registry.register(new CalendarModule());
  registry.register(new SpotifyModule());
  registry.register(new SmartHomeModule());
  registry.register(new FileIntelligenceModule());
  registry.register(new CodingAgentModule());
  registry.register(new SelfImproveModule());
  registry.register(MultiAgentModule);
  registry.register(ApiOrchestratorModule);
  registry.register(new MorningDigestModule());
  registry.register(DataConnectorsModule);

  registry.register(new EnergyMonitorModule());
  registry.register(new SandboxRunnerModule());

  // Discover generated modules and plugins
  discoverGeneratedModules().catch(() => {});
  loadPluginsFromConfig().catch(() => {});

  // Initialize persistent memory
  loadMemory();

  // Initialize intelligence layer (trace-driven learning, memory index, routing)
  initIntelligence();

  // Report the active model to the menubar
  try { reportModel(getLLMConfig().claudeModel || ''); } catch { /* non-critical */ }

  // Start Rust sidecar for fast vector search (non-blocking, falls back to TS)
  startSidecar()
    .then((ready) => reportSidecar(!!ready))
    .catch((err) => { log.warn('Sidecar startup failed', err); reportSidecar(false); });

  // Open the persistent WhatsApp connection (Baileys). First run prints a QR to
  // scan; auth persists to ~/.jarvis/whatsapp-auth so later boots reconnect silently.
  startWhatsApp({
    authDir: joinPath(homedir(), '.jarvis', 'whatsapp-auth'),
    onQR: (qr) => {
      console.log(fmt.dim('\n  [whatsapp] Scan this QR with WhatsApp → Linked Devices:\n'));
      qrcodeTerminal.generate(qr, { small: true });
    },
    onState: (connected) => reportWhatsApp(connected),
  }).catch((err) => log.warn('WhatsApp startup failed', err));

  // Restore persisted scheduled tasks
  scheduler.restore();

  // Voice assistant only on Mac (VPS has no microphone)
  let voiceAssistant: VoiceAssistant | null = null;
  if (IS_MAC) {
    voiceAssistant = new VoiceAssistant();
  }

  // Report to menubar
  reportBoot(registry.getAll().length);

  // Wire up AIM status broadcasting
  setAIMStatusBroadcast(broadcastStatusViaAIM);

  // Start Apple Watch server (local network — Mac only, VPS uses AIM)
  if (IS_MAC) {
    startWatchServer();
  }

  // Start AIM bridge (on VPS: connects to localhost AIM as 'server')
  // (on Mac: connects to remote VPS AIM as 'mac' — if configured)
  startAIMBridge();

  // Start always-on background services
  startBreachMonitor();
  startNetworkGuardian();
  startThreatMonitor();
  if (IS_MAC) startBackgroundIntelligence();

  // Auto-launch menubar app (Mac only)
  if (IS_MAC) {
    const menubarScript = projectPath('menubar', 'start-menubar.sh');
    if (existsSync(menubarScript)) {
      exec(`bash "${menubarScript}"`, { cwd: projectPath('menubar') });
    }
  }

  printBanner();
  console.log(fmt.info(getStartupGreeting()));
  runStartupCommands();

  // On Linux VPS: no TTY, so skip readline and run as a headless daemon.
  // JARVIS stays alive via AIM bridge (WebSocket keep-alive).
  if (!IS_MAC) {
    console.log(fmt.info('Running in VPS daemon mode — commands via AIM only.'));

    // Keep process alive
    const keepAlive = setInterval(() => {}, 60000);

    const cleanup = () => {
      clearInterval(keepAlive);
      scheduler.stopAll();
      stopBreachMonitor();
      stopNetworkGuardian();
      stopThreatMonitor();
      stopBackgroundIntelligence();
      stopSidecar();
      stopAIMBridge();
      flushHistory();
      flushMemory();
      reportShutdown();
      console.log(fmt.info('JARVIS VPS daemon shutting down.'));
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGHUP', cleanup);
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: fmt.prompt(),
  });

  let processing = false;
  let closing = false;
  const lines: string[] = [];

  async function processLine(input: string): Promise<void> {
    if (!input) return;

    // Exit
    if (/^(exit|quit|bye|q|shut\s*down|shut\s+yourself\s+down|power\s+off|go\s+to\s+sleep)$/i.test(input)) {
      if (isVoiceEnabled()) {
        await speak('Goodbye sir. Shutting down.');
      }
      stopSpeaking();
      voiceAssistant?.stop();
      scheduler.stopAll();
      stopBreachMonitor();
      stopNetworkGuardian();
      stopThreatMonitor();
      stopBackgroundIntelligence();
      stopSidecar();

      await closeAllBrowsers();
      flushHistory();
      flushMemory();
      reportShutdown();
      console.log(fmt.info('Goodbye, sir.\n'));
      process.exit(0);
    }

    // Help
    if (/^help$/i.test(input)) { printHelp(); return; }

    // Module-specific help
    const helpMatch = input.match(/^help\s+(.+)/i);
    if (helpMatch) {
      const modName = helpMatch[1].toLowerCase();
      const mod = registry.getAll().find(m =>
        m.name === modName || m.name.includes(modName) || m.description.toLowerCase().includes(modName)
      );
      if (mod) console.log(mod.getHelp());
      else console.log(fmt.warn(`Unknown module: "${helpMatch[1]}"`));
      return;
    }

    // Repeat last command
    if (input === '!!') {
      const last = getLastCommand();
      if (last) {
        console.log(fmt.dim(`  → ${last}`));
        await processLine(last);
      } else {
        console.log(fmt.warn('No previous command.'));
      }
      return;
    }

    // Undo
    if (/^undo$/i.test(input)) {
      const result = await popUndo();
      console.log(result.success ? fmt.success(result.message) : fmt.warn(result.message));
      return;
    }
    if (/^undo\s+(list|stack|history)$/i.test(input)) {
      const items = listUndoStack();
      if (items.length === 0) {
        console.log(fmt.info('Undo stack is empty.'));
      } else {
        console.log(fmt.heading('Undo Stack'));
        for (const item of items) {
          console.log(fmt.label(item.description, `${item.module} — ${item.age}`));
        }
      }
      return;
    }

    // Meta commands
    if (handleAlias(input)) return;
    if (handleStartup(input)) return;
    if (handleMeta(input)) return;

    // Always-on voice assistant
    if (/^voice\s+on$/i.test(input)) {
      if (voiceAssistant?.isRunning()) {
        console.log(fmt.info('Voice assistant is already running.'));
        return;
      }
      try {
        console.log(fmt.info('Starting voice assistant... Say "Jarvis" to activate.'));
        await voiceAssistant?.start();
        reportVoice(true);
        console.log(fmt.success('Voice assistant is now listening. Say "Jarvis" followed by a command.'));
      } catch (err) {
        console.log(fmt.error(`Failed to start voice assistant: ${(err as Error).message}`));
      }
      return;
    }

    if (/^voice\s+off$/i.test(input)) {
      if (!voiceAssistant?.isRunning()) {
        console.log(fmt.info('Voice assistant is not running.'));
        return;
      }
      voiceAssistant?.stop();
      reportVoice(false);
      console.log(fmt.success('Voice assistant stopped.'));
      return;
    }

    if (/^voice\s+aware\s+(on|off)$/i.test(input)) {
      const on = /on$/i.test(input);
      voiceAssistant?.setAwareness(on);
      console.log(fmt.success(
        on
          ? 'Conversational awareness ON — JARVIS only responds when you actually address it.'
          : 'Conversational awareness OFF — JARVIS responds to every command after the wake word.',
      ));
      return;
    }

    if (/^voice\s+status$/i.test(input)) {
      const watcher = voiceAssistant?.getScreenWatcher();
      console.log(fmt.label('Voice Assistant', voiceAssistant?.isRunning() ? 'active (listening)' : 'inactive'));
      console.log(fmt.label('Awareness', voiceAssistant?.getAwareness() ? 'on (responds only when addressed)' : 'off'));
      console.log(fmt.label('Screen Watcher', watcher?.isActive() ? 'active (monitoring)' : 'inactive'));
      return;
    }

    // Screen watcher controls
    if (/^watch\s+on$/i.test(input)) {
      const watcher = voiceAssistant?.getScreenWatcher();
      if (!watcher) {
        console.log(fmt.info('Screen watcher not available on this platform.'));
        return;
      }
      if (watcher.isActive()) {
        console.log(fmt.info('Screen watcher is already running.'));
        return;
      }
      watcher.start(
        () => true, // CLI mode — no voice state to guard, always allow
        async (text) => {
          console.log(fmt.info(`[watch] ${text}`));
          if (isVoiceEnabled()) await speak(text);
        },
      );
      console.log(fmt.success('Screen watcher started.'));
      return;
    }

    if (/^watch\s+off$/i.test(input)) {
      const watcher = voiceAssistant?.getScreenWatcher();
      if (!watcher || !watcher.isActive()) {
        console.log(fmt.info('Screen watcher is not running.'));
        return;
      }
      watcher.stop();
      console.log(fmt.success('Screen watcher stopped.'));
      return;
    }

    if (/^watch\s+status$/i.test(input)) {
      const watcher = voiceAssistant?.getScreenWatcher();
      console.log(fmt.label('Screen Watcher', watcher?.isActive() ? 'active (monitoring)' : 'inactive'));
      return;
    }

    // ── Breach Monitor commands ──
    if (/^breach\s+status$/i.test(input)) {
      console.log(getBreachStatus());
      return;
    }
    if (/^breach\s+check$/i.test(input) || /^breach\s+scan$/i.test(input)) {
      console.log(fmt.info('Running breach monitor scan...'));
      const result = await runManualCheck();
      console.log(result);
      return;
    }

    // ── Network Guardian commands ──
    if (/^network\s+devices$/i.test(input) || /^network\s+status$/i.test(input) || /^network\s+scan$/i.test(input)
        || /unknown\s+devices?/i.test(input) || /new\s+devices?/i.test(input) || /who'?s?\s+on\s+(my\s+)?(net|wifi)/i.test(input)
        || /any\s+devices?/i.test(input) || /scan\s+(my\s+)?network/i.test(input) || /network\s+intruders?/i.test(input)) {
      if (/scan$/i.test(input) || /unknown|new|intruder|any\s+device|who/i.test(input)) {
        console.log(fmt.info('Scanning network...'));
        const result = await runManualScan();
        console.log(result);
      } else {
        console.log(getNetworkDevices());
      }
      return;
    }
    const trustMatch = input.match(/^trust\s+device\s+([0-9a-f:]+)(?:\s+(.+))?$/i);
    if (trustMatch) {
      const result = trustDevice(trustMatch[1], trustMatch[2]);
      console.log(fmt.success(result));
      return;
    }

    // Voice mode (blocking, legacy)
    if (/^(?:voice|listen|voice\s+mode|start\s+listening)$/i.test(input)) {
      const available = await voiceInput.isAvailable();
      if (!available) {
        console.log(fmt.error('Voice input not available. Requires macOS with Xcode Command Line Tools.'));
        return;
      }
      await voiceInput.startContinuous(async (text) => {
        const parsed = await parse(text);
        if (parsed) {
          const result = await execute(parsed);
          setLast(parsed, result);
          recordCommand(text, result);
          if (result.success) console.log(fmt.success(result.message));
          else console.log(fmt.error(result.message));
        } else {
          console.log(fmt.warn(`Didn't understand: "${text}"`));
        }
      });
      return;
    }

    // ── Command chaining: split on && and ; ──
    const commands = splitChainedCommands(input);
    if (commands.length > 1) {
      for (const cmd of commands) {
        await processLine(cmd);
      }
      return;
    }

    // Parse and execute
    let parsed = await parse(input);

    // NLU fallback: try natural language mapping if regex/keyword parsing failed
    if (!parsed) {
      parsed = tryNaturalLanguageMapping(input);
    }

    if (!parsed) {
      // Check if this looks like a failed command attempt vs. genuine conversation
      if (isLikelyCommandAttempt(input)) {
        const suggestions = getSuggestions(input);
        if (suggestions.length > 0) {
          console.log(fmt.warn(`I didn't understand "${input}". Did you mean:`));
          for (const s of suggestions) {
            console.log(fmt.suggestion(s));
          }
          console.log(fmt.dim('  Type "help" for all commands, or prefix with "ask" to chat with AI.'));
        } else {
          console.log(fmt.warn(`I didn't understand "${input}". Type "help" for available commands.`));
        }
        return;
      }

      // Genuine conversation — route to AI engine (Claude)
      try {
        process.stdout.write(fmt.dim(`  [${conversationEngine.getModel()}]\n`));
        process.stdout.write('  ');
        const response = await conversationEngine.processUnmatched(input, {
          onToken: (token) => process.stdout.write(token),
          onCommandStart: (cmd) => {
            process.stdout.write('\n');
            console.log(fmt.dim(`  [executing: ${cmd}]`));
          },
          onCommandResult: (_cmd, result) => {
            if (result.success) {
              if (!result.streamed) console.log(fmt.success(result.message));
            } else {
              console.log(fmt.error(result.message));
            }
          },
          onMemoryStored: (fact) => {
            console.log(fmt.dim(`  [remembered: ${fact}]`));
          },
        });
        process.stdout.write('\n\n');
        recordCommand(input, { success: true, message: response.text, streamed: true });
        return;
      } catch (err) {
        log.warn('AI conversation engine failed', err);
        const suggestions = getSuggestions(input);
        if (suggestions.length > 0) {
          console.log(fmt.warn(`I didn't understand "${input}". Did you mean:`));
          for (const s of suggestions) {
            console.log(fmt.suggestion(s));
          }
          console.log(fmt.dim('  Type "help" for all commands.'));
        } else {
          console.log(fmt.warn(`I didn't understand "${input}". Type "help" for available commands.`));
        }
        return;
      }
    }

    reportCommand(input);
    const startTime = Date.now();
    const result = await execute(parsed);
    const latencyMs = Date.now() - startTime;
    setLast(parsed, result);
    recordCommand(input, result);
    learnCommand(input);
    // Keep conversation engine aware for follow-up context
    conversationEngine.recordCommandExecution(input, result);

    // Record trace for intelligence layer
    recordTrace({
      timestamp: Date.now(),
      input,
      module: parsed.module,
      action: parsed.action,
      args: parsed.args,
      result: { success: result.success, message: result.message.slice(0, 500), latencyMs },
      context: {
        timeOfDay: (() => { const h = new Date().getHours(); return h < 6 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night'; })(),
        dayOfWeek: new Date().getDay(),
        voiceMode: isVoiceEnabled(),
      },
    });

    if (result.success) {
      if (!result.streamed) console.log(fmt.success(result.message));

      // Check if this command is part of a repeated sequence worth automating
      const automation = shouldSuggestAutomation(input);
      if (automation?.suggest) {
        console.log(fmt.dim(`  [intelligence] You often run: ${automation.routine.join(' → ')}`));
        console.log(fmt.dim(`  [intelligence] Create a workflow? → create workflow routine: ${automation.routine.join(' && ')}`));
      }
    } else {
      console.log(fmt.error(result.message));
    }
  }

  async function drain(): Promise<void> {
    if (processing) return;
    processing = true;
    while (lines.length > 0) {
      const line = lines.shift()!;
      await processLine(line);
      if (!closing) rl.prompt();
    }
    processing = false;
    if (closing) {
      stopSpeaking();
      voiceAssistant?.stop();
      scheduler.stopAll();
      stopBreachMonitor();
      stopNetworkGuardian();
      stopThreatMonitor();
      stopBackgroundIntelligence();
      stopSidecar();

      closeAllBrowsers().catch(() => {});
      flushHistory();
      flushMemory();
      stopWatchServer();
      stopAIMBridge();
      reportShutdown();
      console.log(fmt.info('\nGoodbye, sir.\n'));
      process.exit(0);
    }
  }

  rl.prompt();

  rl.on('line', (line) => {
    lines.push(line.trim());
    drain();
  });

  rl.on('close', () => {
    closing = true;
    stopSpeaking();
    voiceAssistant?.stop();
    scheduler.stopAll();
    stopBreachMonitor();
    stopNetworkGuardian();
    stopBackgroundIntelligence();
    stopSidecar();
    stopWatchServer();
    closeAllBrowsers().catch(() => {});
    if (!processing) {
      flushHistory();
      flushMemory();
      reportShutdown();
      console.log(fmt.info('\nGoodbye, sir.\n'));
      process.exit(0);
    }
  });
}
