import { spawn, exec, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { run } from '../utils/shell.js';
import { speak, isSpeaking, stopSpeaking, abortSpeech, resetSpeechAbort } from '../utils/voice-output.js';
import { fmt } from '../utils/formatter.js';
import { parse } from '../core/parser.js';
import { execute } from '../core/executor.js';
import { tryNaturalLanguageMapping } from '../modules/smart-assist.js';
import { setLast } from '../core/context.js';
import { recordCommand } from '../core/history.js';
import type { CommandResult } from '../core/types.js';
import { getLastStreamedText } from '../modules/ai-chat.js';
import { reportState, reportCommand, reportSpeaking } from '../utils/status-reporter.js';
import { conversationEngine } from '../core/conversation-engine.js';
import { ScreenWatcher } from '../modules/screen-watcher.js';
import { captureScreenText } from '../modules/screen-awareness.js';
import { llmQuick, prewarmLLM } from '../utils/llm.js';
import { STT_VOCAB_SWIFT, correctTranscript } from './voice-input.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Swift Voice Daemon Source ──
// Continuously listens via SFSpeechRecognizer (on-device), outputs JSON lines to stdout.
// On-device mode: no 1-minute limit, no rate cap. Only restarts on silence timeout (~22s).
// Audio engine stays running across recognition task restarts to avoid error 209.

const VOICE_DAEMON_SWIFT = `
import Foundation
import Speech
import AVFoundation

setbuf(stdout, nil)

class VoiceDaemon {
    let recognizer: SFSpeechRecognizer
    let audioEngine = AVAudioEngine()
    var recognitionTask: SFSpeechRecognitionTask?
    var request: SFSpeechAudioBufferRecognitionRequest?
    var proactiveTimer: DispatchWorkItem?
    var isRunning = true
    var isRestarting = false
    var audioRunning = false
    var useOnDevice = false
    var consecutiveErrors = 0

    init() {
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
        // Use on-device if available, otherwise server-based
        useOnDevice = recognizer.supportsOnDeviceRecognition
        let mode = useOnDevice ? "on-device" : "server"
        printJSON(["type": "info", "message": "Using \\(mode) speech recognition"])
    }

    func start() {
        signal(SIGTERM) { _ in exit(0) }
        signal(SIGINT) { _ in exit(0) }
        startAudioEngine()
        startRecognitionTask()
        RunLoop.current.run()
    }

    // Start audio engine once — keep it running across recognition restarts
    func startAudioEngine() {
        guard !audioRunning else { return }

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
            audioRunning = true
        } catch {
            printJSON(["type": "error", "message": "Audio engine failed: \\(error.localizedDescription)"])
        }
    }

    // Start a new recognition task (audio engine already running)
    func startRecognitionTask() {
        guard isRunning, audioRunning else { return }
        isRestarting = false

        // Clean up previous task
        recognitionTask?.cancel()
        recognitionTask = nil
        proactiveTimer?.cancel()
        proactiveTimer = nil

        let newRequest = SFSpeechAudioBufferRecognitionRequest()
        newRequest.shouldReportPartialResults = true
        newRequest.contextualStrings = ${STT_VOCAB_SWIFT}
        if useOnDevice {
            newRequest.requiresOnDeviceRecognition = true
        }
        self.request = newRequest

        printJSON(["type": "ready"])

        recognitionTask = recognizer.recognitionTask(with: newRequest) { [weak self] result, error in
            guard let self = self else { return }

            if let result = result {
                self.consecutiveErrors = 0
                let text = result.bestTranscription.formattedString
                let isFinal = result.isFinal
                self.printJSON(["type": isFinal ? "final" : "partial", "text": text])

                if isFinal {
                    self.restartRecognition()
                }
            }

            if let error = error as NSError? {
                // 1110 = no speech/silence timeout, 216 = cancelled, 209 = busy, 203 = rate limit, 102 = no assets
                let silentCodes: Set<Int> = [1110, 216, 209, 203, 301, 102]
                if !silentCodes.contains(error.code) {
                    self.printJSON(["type": "error", "message": "\\(error.localizedDescription) (code \\(error.code))"])
                }
                self.consecutiveErrors += 1
                self.restartRecognition()
            }
        }

        // For server-based recognition: proactive restart before Apple's 1-minute limit
        if !useOnDevice {
            proactiveTimer = DispatchWorkItem { [weak self] in
                self?.restartRecognition()
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 50.0, execute: proactiveTimer!)
        }
    }

    // Restart only the recognition task — audio engine stays running
    func restartRecognition() {
        guard isRunning, !isRestarting else { return }
        isRestarting = true

        proactiveTimer?.cancel()
        proactiveTimer = nil
        request?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        request = nil

        let delay = consecutiveErrors > 3 ? min(Double(consecutiveErrors) * 0.5, 5.0) : 0.3

        printJSON(["type": "restart"])

        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.startRecognitionTask()
        }
    }

    func printJSON(_ dict: [String: String]) {
        if let data = try? JSONSerialization.data(withJSONObject: dict),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
    }
}

let semaphore = DispatchSemaphore(value: 0)
var authorized = false

SFSpeechRecognizer.requestAuthorization { status in
    authorized = (status == .authorized)
    semaphore.signal()
}
semaphore.wait()

guard authorized else {
    let errDict: [String: String] = ["type": "error", "message": "Speech recognition not authorized. Enable in System Settings > Privacy > Speech Recognition."]
    if let data = try? JSONSerialization.data(withJSONObject: errDict),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
    exit(1)
}

let daemon = VoiceDaemon()
daemon.start()
`;

// ── Voice Assistant State Machine ──

type AssistantState = 'idle' | 'activated' | 'processing';

interface DaemonMessage {
  type: 'ready' | 'partial' | 'final' | 'restart' | 'error' | 'info';
  text?: string;
  message?: string;
}

export class VoiceAssistant {
  private daemonProcess: ChildProcess | null = null;
  private state: AssistantState = 'idle';
  private ignoreResults = false;
  private activationTimeout: ReturnType<typeof setTimeout> | null = null;
  private commandTimeout: ReturnType<typeof setTimeout> | null = null;
  private restartCount = 0;
  private maxRestarts = 10;
  private running = false;
  private lastPartialText = '';
  private activatedText = '';
  private ignoreStartTime = 0;
  private interrupted = false;
  private screenWatcher = new ScreenWatcher();
  // Conversational awareness: only act when the user is actually addressing
  // JARVIS (a command/question), not when talking ABOUT it. OFF by default —
  // it can mis-reject commands when the on-device STT mangles words, so it's
  // opt-in via "voice aware on" for always-listening-room scenarios.
  private conversationalAwareness = false;

  setAwareness(on: boolean): void { this.conversationalAwareness = on; }
  getAwareness(): boolean { return this.conversationalAwareness; }

  /**
   * External command handler — when set, commands are sent here instead of
   * being processed locally. Used by mac-client.ts to forward commands to VPS.
   */
  private externalCommandHandler: ((text: string) => void) | null = null;

  /**
   * Set an external command handler. When set, voice commands are forwarded
   * to this handler instead of being processed by the local conversation engine.
   */
  onCommand(handler: (text: string) => void): void {
    this.externalCommandHandler = handler;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Called by Mac client when VPS reports idle status.
   * Resets the voice assistant so it can listen for the next wake word.
   */
  resetToIdle(): void {
    this.ignoreResults = false;
    this.state = 'idle';
  }

  async start(): Promise<void> {
    if (this.running) return;

    const ready = await this.ensureDaemon();
    if (!ready) {
      throw new Error('Voice daemon could not be compiled. Ensure Xcode Command Line Tools are installed.');
    }

    this.running = true;
    this.restartCount = 0;
    this.spawnDaemon();

    // Start screen watcher for background awareness
    this.screenWatcher.start(
      () => this.state === 'idle' && !this.ignoreResults,
      (text) => this.proactiveSpeak(text),
    );
  }

  getScreenWatcher(): ScreenWatcher {
    return this.screenWatcher;
  }

  stop(): void {
    this.running = false;
    this.state = 'idle';
    this.screenWatcher.stop();
    if (this.activationTimeout) {
      clearTimeout(this.activationTimeout);
      this.activationTimeout = null;
    }
    if (this.commandTimeout) {
      clearTimeout(this.commandTimeout);
      this.commandTimeout = null;
    }
    if (this.daemonProcess) {
      this.daemonProcess.kill('SIGTERM');
      this.daemonProcess = null;
    }
  }

  // ── Daemon Lifecycle ──

  private async ensureDaemon(): Promise<boolean> {
    const daemonBinary = this.getDaemonPath();
    const voiceDir = dirname(daemonBinary);
    const swiftSource = join(voiceDir, 'voice-daemon.swift');

    // Recompile when the daemon source changes (e.g. updated STT vocabulary).
    const upToDate =
      existsSync(daemonBinary) &&
      existsSync(swiftSource) &&
      readFileSync(swiftSource, 'utf-8') === VOICE_DAEMON_SWIFT;
    if (upToDate) return true;

    if (!existsSync(voiceDir)) mkdirSync(voiceDir, { recursive: true });
    writeFileSync(swiftSource, VOICE_DAEMON_SWIFT);

    console.log(fmt.info('Compiling voice daemon (one-time setup)...'));
    const result = await run(
      `swiftc -O "${swiftSource}" -o "${daemonBinary}" -framework Speech -framework AVFoundation`,
      { timeout: 120000 },
    );

    if (result.exitCode !== 0) {
      console.log(fmt.error(`Failed to compile voice daemon: ${result.stderr}`));
      return false;
    }

    console.log(fmt.success('Voice daemon compiled.'));
    return true;
  }

  private getDaemonPath(): string {
    return join(__dirname, '..', '..', '.voice', 'voice-daemon');
  }

  private spawnDaemon(): void {
    if (!this.running) return;

    const daemonPath = this.getDaemonPath();
    this.daemonProcess = spawn(daemonPath, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Read JSON lines from stdout
    const rl = createInterface({ input: this.daemonProcess.stdout! });
    rl.on('line', (line) => this.handleDaemonMessage(line));

    // Log stderr
    this.daemonProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.log(fmt.dim(`  [voice] ${msg}`));
    });

    // Handle daemon crash
    this.daemonProcess.on('exit', (code) => {
      this.daemonProcess = null;
      if (!this.running) return;

      if (this.restartCount < this.maxRestarts) {
        this.restartCount++;
        console.log(fmt.dim(`  [voice] Daemon restarting (${this.restartCount}/${this.maxRestarts})...`));
        setTimeout(() => this.spawnDaemon(), 1000);
      } else {
        console.log(fmt.error('Voice daemon failed too many times. Use "voice on" to retry.'));
        this.running = false;
      }
    });

    // Reset restart count after stable running for 60s
    setTimeout(() => {
      if (this.running) this.restartCount = 0;
    }, 60000);
  }

  // ── Message Handling ──

  private handleDaemonMessage(line: string): void {
    let msg: DaemonMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Ignore malformed lines
    }

    // During speech: only listen for "Jarvis" wake word to interrupt.
    // 1200ms delay avoids picking up mic echo from the very start of speech.
    // sanitizeForSpeech() already strips "jarvis" from TTS output so
    // self-triggering from JARVIS saying its own name is already blocked.
    if (this.ignoreResults) {
      const elapsed = Date.now() - this.ignoreStartTime;
      const text = msg.text || '';
      // Interrupt on "jarvis" (echo-safe — stripped from TTS) OR a natural stop
      // word. Check BOTH partial and final results so a spoken interrupt isn't
      // missed while a long reply plays. /jarvis/ has no word boundary so a
      // fused transcription ("jarvisstop") still triggers.
      const interruptRe = /jarvis|\b(?:stop|shut\s*up|be\s+quiet|quiet|enough|cancel|never\s*mind|wait)\b/i;
      if (elapsed > 1000 && (msg.type === 'partial' || msg.type === 'final') && interruptRe.test(text)) {
        abortSpeech(); // Kill speech AND prevent modules from re-speaking
        conversationEngine.abort(); // Cancel the stream immediately
        this.ignoreResults = false;
        this.interrupted = true;
        this.state = 'idle';
        console.log(fmt.dim('  [voice] Interrupted.'));
        // If they actually said "jarvis ...", let it pick up as the next command.
        if (/jarvis/i.test(text)) this.handlePartial(text);
      }
      return;
    }

    switch (msg.type) {
      case 'ready':
        // Daemon is listening — only log on first ready
        break;

      case 'partial':
        if (msg.text) this.handlePartial(msg.text);
        break;

      case 'final':
        if (msg.text) this.handleFinal(msg.text);
        break;

      case 'restart':
        // Recognition restarting (50s limit), no action needed
        break;

      case 'info':
        if (msg.message) {
          console.log(fmt.info(msg.message));
        }
        break;

      case 'error':
        if (msg.message) {
          console.log(fmt.dim(`  [voice] ${msg.message}`));
        }
        break;
    }
  }

  private handlePartial(text: string): void {
    if (this.state === 'processing') return;

    if (this.state === 'idle') {
      // Check for wake word in partial results
      if (/\bjarvis\b/i.test(text)) {
        this.state = 'activated';
        this.activatedText = text;
        reportState('activated');
        prewarmLLM(); // warm the API socket while the user finishes speaking

        // Play activation sound
        exec('afplay /System/Library/Sounds/Pop.aiff &');
        console.log(fmt.dim('  [voice] Wake word detected, listening...'));

        // Start the stabilization timer — if the command text after "jarvis"
        // doesn't change for 2 seconds, execute it
        this.resetCommandTimer();

        // Safety timeout: if nothing happens in 10 seconds, go back to idle
        this.activationTimeout = setTimeout(() => {
          if (this.state === 'activated') {
            // Try to execute whatever we have before giving up
            const command = this.extractCommand(this.activatedText);
            if (command) {
              this.processCommand(command);
            } else {
              this.quietReset(); // bare wake word — stay quiet, keep listening (no greeting spam)
            }
          }
        }, 10000);
      }
      return;
    }

    if (this.state === 'activated') {
      // Track evolving partial text while activated
      if (text !== this.activatedText) {
        this.activatedText = text;
        // Reset the stabilization timer — user is still speaking
        this.resetCommandTimer();
      }
    }
  }

  private resetCommandTimer(): void {
    if (this.commandTimeout) clearTimeout(this.commandTimeout);

    // After 1.2 seconds of stable text, execute the command
    this.commandTimeout = setTimeout(() => {
      if (this.state !== 'activated') return;

      // Clear the activation timeout since we're executing
      if (this.activationTimeout) {
        clearTimeout(this.activationTimeout);
        this.activationTimeout = null;
      }

      const command = this.extractCommand(this.activatedText);
      if (command) {
        this.processCommand(command);
      } else {
        // User just said "Jarvis" with nothing after
        this.quietReset(); // bare wake word — stay quiet, keep listening (no greeting spam)
      }
    }, 1200);
  }

  private handleFinal(text: string): void {
    if (this.state === 'processing') return;

    if (this.state === 'idle') {
      // Final result while idle — check if it contains wake word
      if (/\bjarvis\b/i.test(text)) {
        const command = this.extractCommand(text);
        if (command) {
          this.processCommand(command);
        } else {
          this.quietReset(); // bare wake word — stay quiet, keep listening (no greeting spam)
        }
      }
      return;
    }

    if (this.state === 'activated') {
      // We got a final result while activated — execute immediately
      if (this.activationTimeout) {
        clearTimeout(this.activationTimeout);
        this.activationTimeout = null;
      }
      if (this.commandTimeout) {
        clearTimeout(this.commandTimeout);
        this.commandTimeout = null;
      }

      const command = this.extractCommand(text);
      if (command) {
        this.processCommand(command);
      } else {
        this.quietReset(); // bare wake word — stay quiet, keep listening (no greeting spam)
      }
    }
  }

  // ── Helpers ──

  /**
   * Strip the word "jarvis" from text before sending to TTS.
   * Prevents the mic from picking up our own speech and re-triggering the wake word.
   */
  private sanitizeForSpeech(text: string): string {
    return text
      .replace(/\[.*?\]/g, '')           // Strip any [bracket tags] from speech
      .replace(/\bjarvis\b[,.]?\s*/gi, '') // Strip wake word to avoid self-triggering
      .replace(/^\s+/, '')
      .trim();
  }

  // ── Command Extraction & Execution ──

  private extractCommand(text: string): string | null {
    // Strip everything up to and including "jarvis" — including when the STT
    // fuses it to the next word ("jarvisbrowse youtube" -> "browse youtube").
    const cleaned = text.replace(/^.*?jarvis[\s,.:]*/i, '').trim();
    return cleaned ? correctTranscript(cleaned) : null;
  }

  /**
   * Split voice input on natural language connectors like "and then", "then", "and also".
   * e.g. "open Safari and then youtube.com" → ["open Safari", "youtube.com"]
   */
  private splitVoiceCommands(input: string): string[] {
    return input
      .split(/\b(?:and\s+then|then|and\s+also|also)\b/i)
      .map(s => s.trim())
      .filter(Boolean);
  }

  /** Quietly return to listening without speaking (used when not addressed). */
  private quietReset(): void {
    if (this.activationTimeout) { clearTimeout(this.activationTimeout); this.activationTimeout = null; }
    if (this.commandTimeout) { clearTimeout(this.commandTimeout); this.commandTimeout = null; }
    this.activatedText = '';
    this.ignoreResults = false;
    this.state = 'idle';
    reportState('idle');
  }

  /**
   * Conversational awareness — decide if the user is actually addressing JARVIS
   * (a command/question to act on now) versus talking about it or to someone
   * else. Uses the fast model so the gate adds minimal latency.
   */
  private async isAddressed(text: string): Promise<boolean> {
    // Strip "jarvis" even when the STT fuses it to the next word
    // ("jarvisbrowse" -> "browse"), then normalise.
    const clean = text.replace(/jarvis/gi, ' ').replace(/[^\w\s.]/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length < 2) return false; // bare wake word — stay quiet, keep listening

    // FAST PATH: a recognized ACTION command is unambiguously addressed — skip
    // the LLM entirely so real commands stay instant. Excludes ai-chat (questions,
    // the "ai" keyword) and long sentences with an incidental buried keyword
    // (e.g. "...an AI built by...") — those are exactly the conversational cases
    // that cause false activations, so the classifier judges them instead.
    try {
      const parsed = await parse(clean);
      const words = clean.split(/\s+/).length;
      if (parsed && parsed.module !== 'ai-chat') {
        if (parsed.confidence >= 1.0) return true; // exact command pattern
        if (parsed.confidence >= 0.6 && words <= 3) return true; // short keyword command
      }
      // Fail OPEN on anything short and command-shaped: better to answer than to
      // silently swallow a command the STT mangled. Only long, clearly-statement
      // text falls through to the classifier.
      if (words <= 4) return true;
    } catch {
      return true; // parse error — respond rather than drop a possible command
    }

    // Ambiguous / conversational — let the fast model decide.
    try {
      const verdict = await llmQuick(
        `An always-listening assistant named JARVIS heard this in the room: "${text}"\n\n` +
          `Is the user DIRECTLY giving JARVIS a command or asking it a question to act on right now? ` +
          `Answer NO if they are talking to another person, explaining or describing JARVIS, ` +
          `thinking aloud, or it's just a sentence fragment. Reply with ONLY one word: YES or NO.`,
        'You are a strict intent gate for a voice assistant. Output only the single word YES or NO.',
      );
      return /\byes\b/i.test(verdict);
    } catch {
      return true; // fail open — don't drop a real command on a transient error
    }
  }

  private async processCommand(input: string): Promise<void> {
    this.state = 'processing';
    this.interrupted = false;
    this.lastPartialText = '';
    this.activatedText = '';
    if (this.activationTimeout) { clearTimeout(this.activationTimeout); this.activationTimeout = null; }
    if (this.commandTimeout) { clearTimeout(this.commandTimeout); this.commandTimeout = null; }
    reportState('processing');

    // Conversational-awareness gate (local mode): ignore speech that isn't
    // actually directed at JARVIS, so it doesn't interject while you talk
    // about it or to someone else.
    if (this.conversationalAwareness && !this.externalCommandHandler) {
      if (!(await this.isAddressed(input))) {
        console.log(fmt.dim(`  [voice] (heard "${input.slice(0, 48)}" — not for me, staying quiet)`));
        this.quietReset();
        return;
      }
    }

    // If external handler is set (Mac client → VPS mode), send the command
    // externally and go back to listening. VPS handles processing + audio.
    if (this.externalCommandHandler) {
      console.log(fmt.dim(`  [voice] Command: "${input}" → VPS`));
      reportCommand(input);
      this.externalCommandHandler(input);

      // Brief ignore period to avoid picking up our own playback
      this.ignoreResults = true;
      this.ignoreStartTime = Date.now();
      // VPS will play audio on Mac via AIM. Wait a bit then go idle.
      // The status update from VPS ('idle') will be the real signal,
      // but we set a safety timeout.
      setTimeout(() => {
        this.ignoreResults = false;
        this.state = 'idle';
        reportState('idle');
      }, 30000); // 30s max — VPS status update should come sooner

      return;
    }

    // Enable interrupt detection for the entire command execution.
    // Without this, modules that call speak() directly (e.g. site-monitor)
    // can't be interrupted because ignoreResults is false.
    resetSpeechAbort();
    this.ignoreResults = true;
    this.ignoreStartTime = Date.now();

    // Split voice input on "and then" / "then" / "and also"
    const commands = this.splitVoiceCommands(input);

    for (const cmd of commands) {
      if (this.interrupted) break;
      console.log(fmt.dim(`  [voice] Command: "${cmd}"`));
      reportCommand(cmd);

      try {
        // Parse the voice command through the same pipeline as text input
        let parsed = await parse(cmd);
        if (!parsed) parsed = tryNaturalLanguageMapping(cmd);

        // No exact module match — hand it to the conversation engine (Claude).
        // Claude understands messy / mistranscribed phrasing ("browse youtube"
        // -> browse youtube.com, "send mom a message" -> WhatsApp) and either
        // runs the right action via an [ACTION:] tag or just answers. This is
        // far more reliable than canned "I didn't catch that" suggestions.
        if (!parsed) {
          this.ignoreStartTime = Date.now();
          await this.voiceConverse(cmd);
          continue;
        }

        const result = await execute(parsed);
        setLast(parsed, result);
        recordCommand(cmd, result);

        // Keep conversation engine aware for follow-up context
        conversationEngine.recordCommandExecution(cmd, result);

        // Print the result to terminal too
        if (result.success) {
          if (!result.streamed) console.log(fmt.success(result.message));
        } else {
          console.log(fmt.error(result.message));
        }

        // Speak the response — prefer voiceMessage (voice-friendly) over message (visual)
        if (this.interrupted) break;
        let responseText = result.voiceMessage
          || (result.streamed ? (getLastStreamedText() || result.message || '') : result.message);

        // GLOBAL SAFEGUARD: never read a long list/dump aloud. If a handler didn't
        // supply a voice-friendly message and its output is long or multi-line
        // (process lists, schedules, clipboard, search results, OCR, etc.), speak
        // a short summary instead — the full text is already printed to the terminal.
        if (!result.voiceMessage && !result.streamed && responseText) {
          const lineCount = responseText.split('\n').length;
          if (responseText.length > 320 || lineCount > 4) {
            responseText = 'Done, sir — the details are on your screen.';
          }
        }

        if (responseText) {
          this.ignoreStartTime = Date.now();
          await this.speakResponse(responseText);
        }
      } catch (err) {
        console.log(fmt.error(`Voice command error: ${(err as Error).message}`));
        if (!this.interrupted) await this.speakResponse('Something went wrong.');
      }
    }

    // Cooldown before re-enabling mic to avoid self-triggering
    if (!this.interrupted) {
      await new Promise(r => setTimeout(r, 800));
    }

    this.ignoreResults = false;
    this.state = 'idle';
    reportState('idle');
  }

  /**
   * Route to the conversational AI engine with real-time sentence-by-sentence TTS.
   * Streams the response, speaks each sentence as it completes,
   * and can be interrupted by saying "Jarvis".
   */
  private async voiceConverse(prompt: string): Promise<void> {
    const sentenceQueue: string[] = [];
    let buffer = '';
    let streamDone = false;

    // Only inject screen context when the user EXPLICITLY references the screen or
    // on-screen content. Loose words like "this/that/it/see" appear in ordinary
    // questions ("what do you think about it") and must NOT pull in the screen.
    const screenKeywords = /\bscreen\b|\b(?:this|that|the)\s+(?:code|error|bug|page|window|selection|text|file|line|function)\b|\bmy\s+selection\b/i;
    let screenContext: string | undefined;
    if (screenKeywords.test(prompt)) {
      screenContext = this.screenWatcher.getScreenContext();
      if (!screenContext) {
        try {
          const freshOcr = await captureScreenText();
          if (freshOcr) screenContext = freshOcr.slice(0, 2000);
        } catch { /* non-critical */ }
      }
    }

    process.stdout.write(fmt.dim(`  [${conversationEngine.getModel()}]\n`));
    process.stdout.write('  ');

    // Start streaming from conversation engine — fills sentence queue as tokens arrive
    const streamPromise = conversationEngine.processUnmatched(prompt, {
      voiceMode: true,
      ...(screenContext ? { screenContext } : {}),
      onToken: (token: string) => {
        buffer += token;
        process.stdout.write(token);

        const trimmed = buffer.trim();
        const wordCount = trimmed.split(/\s+/).length;

        // Hard sentence boundary: . ! ? (optionally followed by whitespace/newlines)
        if (/[.!?]["'）)]*\s*$/.test(trimmed) && wordCount >= 3) {
          sentenceQueue.push(trimmed);
          buffer = '';
        // Paragraph boundary: double newline
        } else if (/\n\s*\n\s*$/.test(buffer) && wordCount >= 3) {
          sentenceQueue.push(trimmed);
          buffer = '';
        // Soft boundary: comma/semicolon/colon after 7+ words — start speaking sooner
        } else if (/[,;:]\s*$/.test(trimmed) && wordCount >= 7) {
          sentenceQueue.push(trimmed);
          buffer = '';
        // Safety: flush long buffers to avoid text getting stuck
        } else if (wordCount >= 25) {
          sentenceQueue.push(trimmed);
          buffer = '';
        }
      },
      onCommandStart: (cmd) => {
        process.stdout.write('\n');
        console.log(fmt.dim(`  [executing: ${cmd}]`));
      },
      onCommandResult: (_cmd, result) => {
        if (result.success && !result.streamed && result.message) {
          sentenceQueue.push(result.message.slice(0, 200));
        }
      },
    }).then((response) => {
      if (buffer.trim()) sentenceQueue.push(buffer.trim());
      streamDone = true;
      return response;
    }).catch(() => {
      streamDone = true;
    });

    // ignoreResults already true from processCommand — just reset timing for speech
    this.ignoreStartTime = Date.now();
    reportState('speaking');

    // Consume sentence queue: speak each sentence as it arrives.
    // NOTE: do NOT reset ignoreStartTime here — resetting it after each sentence
    // would restart the 2s interrupt window, making it impossible to interrupt.
    while ((!streamDone || sentenceQueue.length > 0) && !this.interrupted) {
      if (sentenceQueue.length > 0) {
        const sentence = this.sanitizeForSpeech(sentenceQueue.shift()!);
        if (sentence) { reportSpeaking(sentence); await speak(sentence); }
        if (this.interrupted) break;
      } else {
        await new Promise(r => setTimeout(r, 20));
      }
    }

    process.stdout.write('\n\n');

    // If interrupted, abort the stream so it doesn't keep generating
    if (this.interrupted) {
      conversationEngine.abort();
    }

    await streamPromise.catch(() => {});
    // ignoreResults cleanup + cooldown handled by processCommand
  }

  private async respondBrief(text: string): Promise<void> {
    this.state = 'processing';
    this.interrupted = false;
    this.lastPartialText = '';
    this.activatedText = '';
    if (this.activationTimeout) { clearTimeout(this.activationTimeout); this.activationTimeout = null; }
    if (this.commandTimeout) { clearTimeout(this.commandTimeout); this.commandTimeout = null; }

    resetSpeechAbort();
    this.ignoreResults = true;
    this.ignoreStartTime = Date.now();

    console.log(fmt.dim(`  [voice] ${text}`));
    await this.speakResponse(text);

    if (!this.interrupted) {
      await new Promise(r => setTimeout(r, 800));
    }

    this.ignoreResults = false;
    this.state = 'idle';
    reportState('idle');
  }

  /**
   * Proactive speech — used by screen watcher to alert about time-sensitive events.
   * Same pattern as respondBrief: set state, speak, reset.
   */
  private async proactiveSpeak(text: string): Promise<void> {
    if (this.state !== 'idle' || this.ignoreResults) return;

    this.state = 'processing';
    this.interrupted = false;

    resetSpeechAbort();
    this.ignoreResults = true;
    this.ignoreStartTime = Date.now();

    console.log(fmt.dim(`  [watch] Speaking: ${text}`));
    await this.speakResponse(text);

    if (!this.interrupted) {
      await new Promise(r => setTimeout(r, 800));
    }

    this.ignoreResults = false;
    this.state = 'idle';
    reportState('idle');
  }

  private async speakResponse(text: string): Promise<void> {
    if (this.interrupted) return;
    const clean = this.sanitizeForSpeech(text);
    reportSpeaking(clean); // publish the caption for the fullscreen orb
    this.ignoreStartTime = Date.now();

    // Strip "jarvis" from speech to avoid wake word self-triggering
    await speak(clean);
  }
}
