/**
 * Routing trace harness — registers every module in the SAME order as
 * src/index.ts, then runs parse() on a list of inputs and prints the routing
 * decision as JSON. NO side effects are executed (we never call execute()).
 *
 * Usage:
 *   tsx tools/trace-route.ts "what's the weather" "ps" "10 miles to km"
 *   echo '["cmd one","cmd two"]' | tsx tools/trace-route.ts --stdin
 */
import { registry } from '../src/core/registry.js';
import { parse } from '../src/core/parser.js';

import { AppLauncherModule } from '../src/modules/app-launcher.js';
import { ScriptRunnerModule } from '../src/modules/script-runner.js';
import { SystemMonitorModule } from '../src/modules/system-monitor.js';
import { FileOperationsModule } from '../src/modules/file-operations.js';
import { SystemControlModule } from '../src/modules/system-control.js';
import { TimerModule } from '../src/modules/timer.js';
import { ProcessManagerModule } from '../src/modules/process-manager.js';
import { ClipboardModule } from '../src/modules/clipboard.js';
import { WindowManagerModule } from '../src/modules/window-manager.js';
import { MediaControlModule } from '../src/modules/media-control.js';
import { WorkflowModule } from '../src/modules/workflow.js';
import { ConversionsModule } from '../src/modules/conversions.js';
import { PersonalityModule } from '../src/modules/personality.js';
import { AIChatModule } from '../src/modules/ai-chat.js';
import { SmartAssistModule } from '../src/modules/smart-assist.js';
import { WeatherNewsModule } from '../src/modules/weather-news.js';
import { SmartRoutinesModule } from '../src/modules/smart-routines.js';
import { ScreenAwarenessModule } from '../src/modules/screen-awareness.js';
import { ResearchModule } from '../src/modules/research.js';
import { BrowserControlModule } from '../src/modules/browser-control.js';
import { WhatsAppModule } from '../src/modules/whatsapp.js';
import { CommsStackModule } from '../src/modules/comms-stack.js';
import { SiteMonitorModule } from '../src/modules/site-monitor.js';
import { ScreenInteractModule } from '../src/modules/screen-interact.js';
import { DossierModule } from '../src/modules/dossier.js';
import { DevAgentModule } from '../src/modules/dev-agent.js';
import { ComputerControlModule } from '../src/modules/computer-control.js';
import { DesktopControlModule } from '../src/modules/desktop-control.js';
import { YouTubeToolsModule } from '../src/modules/youtube-tools.js';
import { FlightFinderModule } from '../src/modules/flight-finder.js';
import { EmailModule } from '../src/modules/email.js';
import { CalendarModule } from '../src/modules/calendar.js';
import { SpotifyModule } from '../src/modules/spotify.js';
import { SmartHomeModule } from '../src/modules/smart-home.js';
import { FileIntelligenceModule } from '../src/modules/file-intelligence.js';
import { CodingAgentModule } from '../src/modules/coding-agent.js';
import { SelfImproveModule } from '../src/modules/self-improve.js';
import MultiAgentModule from '../src/modules/multi-agent.js';
import ApiOrchestratorModule from '../src/modules/api-orchestrator.js';
import { MorningDigestModule } from '../src/modules/morning-digest.js';
import DataConnectorsModule from '../src/modules/data-connectors.js';
import { EnergyMonitorModule } from '../src/modules/energy-monitor.js';
import { SandboxRunnerModule } from '../src/modules/sandbox-runner.js';

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
registry.register(MultiAgentModule as any);
registry.register(ApiOrchestratorModule as any);
registry.register(new MorningDigestModule());
registry.register(DataConnectorsModule as any);
registry.register(new EnergyMonitorModule());
registry.register(new SandboxRunnerModule());

async function main() {
  let inputs: string[] = [];
  if (process.argv.includes('--stdin')) {
    const raw = await new Promise<string>((res) => {
      let buf = '';
      process.stdin.on('data', (d) => (buf += d));
      process.stdin.on('end', () => res(buf));
    });
    try { inputs = JSON.parse(raw); } catch { inputs = raw.split('\n').filter(Boolean); }
  } else {
    inputs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  }

  const out: any[] = [];
  for (const input of inputs) {
    try {
      const r = await parse(input);
      out.push(r
        ? { input, module: r.module, action: r.action, confidence: r.confidence, args: r.args }
        : { input, module: null, action: null, confidence: 0, note: 'no match → conversation AI' });
    } catch (e) {
      out.push({ input, error: (e as Error).message });
    }
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}

main();
