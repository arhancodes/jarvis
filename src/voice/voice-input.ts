import { exec, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { run } from '../utils/shell.js';
import { fmt } from '../utils/formatter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface VoiceInputProvider {
  isAvailable(): Promise<boolean>;
  listen(durationMs?: number): Promise<string>;
  startContinuous(onCommand: (text: string) => Promise<void> | void): Promise<void>;
  stop(): void;
}

// Words/phrases JARVIS uses that generic speech recognition tends to mangle.
// Fed to SFSpeechRecognizer as contextualStrings so it *prefers* these tokens
// — fixes the "he didn't catch that" class at the source, before the parser.
const STT_VOCAB = [
  'JARVIS', 'WHOOP', 'recovery', 'strain', 'HRV', 'resting heart rate',
  "how's my recovery", 'how did I sleep', "what's my strain", 'should I train today',
  'Spotify', 'WhatsApp', 'HomeKit', 'Gmail', 'Calendar', 'GitHub', 'Claude',
  'Apple Watch', 'iPhone', 'Safari', 'Chrome', 'Xcode', 'Finder',
  'battery', 'brightness', 'volume', 'dark mode', 'do not disturb', 'screenshot',
  'clipboard', 'timer', 'reminder', 'alarm', 'stopwatch',
  'weather', 'forecast', 'news', 'headlines',
  'research', 'deep research', 'summarize', 'translate',
  'screen', 'read my screen', "what's on my screen", 'kill port', 'process',
  'mute', 'unmute', 'lock screen', 'sleep', 'wake word',
  'morning digest', 'good morning', 'smart home', 'lights', 'thermostat',
  'play', 'pause', 'next track', 'previous track', 'shuffle', 'playlist',
];
export const STT_VOCAB_SWIFT = '[' + STT_VOCAB.map((w) => '"' + w.replace(/"/g, '\\"') + '"').join(', ') + ']';

// High-confidence fixes for the way generic STT mangles JARVIS's proper nouns.
// Applied to the recognized transcript before parsing. Word-boundary + case-
// insensitive so they don't fire mid-word.
const STT_CORRECTIONS: Array<[RegExp, string]> = [
  [/\bwhat'?s\s*app\b/gi, 'whatsapp'],
  [/\b(?:hoops?|woops?|who\s*op)\b/gi, 'whoop'],
  [/\bspot(?:ty|i)\s*fy\b/gi, 'spotify'],
  [/\bhome\s*kit\b/gi, 'homekit'],
  [/\bget\s*hub\b/gi, 'github'],
  [/\bx\s*code\b/gi, 'xcode'],
  [/\bh\s*r\s*v\b/gi, 'hrv'],
];

/** Normalize common speech-recognition mis-hearings of JARVIS's vocabulary. */
export function correctTranscript(text: string): string {
  let s = text;
  for (const [re, rep] of STT_CORRECTIONS) s = s.replace(re, rep);
  return s;
}

// Swift helper source for macOS Speech Recognition
const SWIFT_HELPER = `
import Foundation
import Speech

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: voice-helper <duration_seconds>\\n", stderr)
    exit(1)
}

let duration = Double(CommandLine.arguments[1]) ?? 5.0

SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
        fputs("Speech recognition not authorized. Enable in System Settings > Privacy > Speech Recognition.\\n", stderr)
        exit(1)
    }
}

let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
let audioEngine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = false
request.contextualStrings = ${STT_VOCAB_SWIFT}

let inputNode = audioEngine.inputNode
let recordingFormat = inputNode.outputFormat(forBus: 0)
inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
    request.append(buffer)
}

audioEngine.prepare()
try audioEngine.start()

fputs("🎤 Listening...\\n", stderr)

var finalText = ""
let semaphore = DispatchSemaphore(value: 0)

let task = recognizer.recognitionTask(with: request) { result, error in
    if let result = result, result.isFinal {
        finalText = result.bestTranscription.formattedString
        semaphore.signal()
    }
    if let error = error {
        fputs("Recognition error: \\(error.localizedDescription)\\n", stderr)
        semaphore.signal()
    }
}

DispatchQueue.global().asyncAfter(deadline: .now() + duration) {
    audioEngine.stop()
    inputNode.removeTap(onBus: 0)
    request.endAudio()
}

_ = semaphore.wait(timeout: .now() + duration + 2.0)
print(finalText)
exit(0)
`;

export class MacOSVoiceInput implements VoiceInputProvider {
  private helperPath: string;
  private continuousProcess: ChildProcess | null = null;
  private isListening = false;

  constructor() {
    const voiceDir = join(__dirname, '..', '..', '.voice');
    this.helperPath = join(voiceDir, 'voice-helper');
  }

  async isAvailable(): Promise<boolean> {
    // Check if we can compile or have the binary
    if (existsSync(this.helperPath)) return true;
    // Check if swiftc is available
    const result = await run('which swiftc');
    return result.exitCode === 0;
  }

  private async ensureHelper(): Promise<boolean> {
    const voiceDir = dirname(this.helperPath);
    const swiftPath = join(voiceDir, 'voice-helper.swift');

    // Recompile when the helper source changes (e.g. updated STT vocabulary),
    // not just when the binary is missing.
    const upToDate =
      existsSync(this.helperPath) &&
      existsSync(swiftPath) &&
      readFileSync(swiftPath, 'utf-8') === SWIFT_HELPER;
    if (upToDate) return true;

    if (!existsSync(voiceDir)) mkdirSync(voiceDir, { recursive: true });
    writeFileSync(swiftPath, SWIFT_HELPER);

    console.log(fmt.info('Compiling voice helper (one-time setup)...'));
    const result = await run(
      `swiftc -O "${swiftPath}" -o "${this.helperPath}" -framework Speech -framework AVFoundation`,
      { timeout: 60000 }
    );

    if (result.exitCode !== 0) {
      console.log(fmt.error(`Failed to compile voice helper: ${result.stderr}`));
      return false;
    }

    console.log(fmt.success('Voice helper compiled successfully!'));
    return true;
  }

  async listen(durationMs: number = 5000): Promise<string> {
    const ready = await this.ensureHelper();
    if (!ready) throw new Error('Voice helper not available');

    const durationSec = Math.ceil(durationMs / 1000);
    const result = await run(`"${this.helperPath}" ${durationSec}`, { timeout: durationMs + 5000 });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'Voice recognition failed');
    }

    return result.stdout.trim();
  }

  async startContinuous(onCommand: (text: string) => Promise<void> | void): Promise<void> {
    const ready = await this.ensureHelper();
    if (!ready) throw new Error('Voice helper not available');

    this.isListening = true;
    console.log(fmt.banner('\n  🎤 Voice mode activated — speak your commands!'));
    console.log(fmt.info('Say "stop listening" or press Ctrl+C to exit voice mode.\n'));

    while (this.isListening) {
      try {
        const text = await this.listen(5000);
        if (!text) continue;

        const lower = text.toLowerCase().trim();
        if (lower === 'stop listening' || lower === 'stop' || lower === 'exit voice') {
          this.isListening = false;
          console.log(fmt.info('Voice mode deactivated.'));
          return;
        }

        console.log(fmt.dim(`  🗣  Heard: "${text}"`));
        await onCommand(text);
      } catch {
        // Brief pause on error then retry
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  stop(): void {
    this.isListening = false;
    if (this.continuousProcess) {
      this.continuousProcess.kill();
      this.continuousProcess = null;
    }
  }
}

// ── Fallback: no-op ──
export class NoopVoiceInput implements VoiceInputProvider {
  async isAvailable(): Promise<boolean> { return false; }
  async listen(): Promise<string> {
    throw new Error('Voice input is not configured.');
  }
  async startContinuous(_onCommand: (text: string) => Promise<void> | void): Promise<void> {
    throw new Error('Voice input is not configured.');
  }
  stop(): void { /* noop */ }
}

// Create the appropriate provider
export function createVoiceInput(): VoiceInputProvider {
  if (process.platform === 'darwin') {
    return new MacOSVoiceInput();
  }
  return new NoopVoiceInput();
}

export const voiceInput = createVoiceInput();
