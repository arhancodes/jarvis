import { exec, execSync, ChildProcess } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { IS_MAC } from './platform.js';
import { createLogger } from './logger.js';
import { readJsonConfig } from './config.js';

const log = createLogger('voice');

// ── JARVIS Voice Output ──
// Edge TTS (Microsoft neural voices) with macOS Daniel fallback.
// On Linux VPS: speak() is a no-op (no speakers). generateTTSAudio() still works
// for streaming audio to connected devices.

const FALLBACK_VOICE = 'Daniel';
const FALLBACK_RATE = 190;

interface VoiceConfig {
  provider: 'edge-tts' | 'elevenlabs' | 'macos';
  edgeTts?: {
    voice: string;
    rate?: string;   // e.g. "+10%", "-5%"
    pitch?: string;  // e.g. "+5Hz", "-5Hz"
  };
  elevenlabs?: {
    apiKey: string;
    voiceId: string;
    model?: string;
  };
  fallbackVoice?: string;
  fallbackRate?: number;
}

let enabled = true;
let currentProcess: ChildProcess | null = null;
let config: VoiceConfig = { provider: 'macos' };
let speechAborted = false;

// Load config on startup
function loadConfig(): void {
  const loaded = readJsonConfig<VoiceConfig>('voice.json', { provider: 'macos' });
  config = loaded;
}
loadConfig();

export function isVoiceEnabled(): boolean {
  return enabled;
}

export function enableVoice(): void {
  enabled = true;
}

export function disableVoice(): void {
  stopSpeaking();
  enabled = false;
}

export function toggleVoice(): boolean {
  if (enabled) disableVoice();
  else enableVoice();
  return enabled;
}

export function setVoice(_name: string): void {
  // Legacy — config file controls voice now
}

export function getVoice(): string {
  if (config.provider === 'edge-tts') return config.edgeTts?.voice || 'en-GB-RyanNeural';
  if (config.provider === 'elevenlabs') return 'ElevenLabs';
  return config.fallbackVoice || FALLBACK_VOICE;
}

export function setRate(_wpm: number): void {
  // Legacy — config file controls rate now
}

export function getRate(): number {
  return config.fallbackRate || FALLBACK_RATE;
}

export function isSpeaking(): boolean {
  return currentProcess !== null;
}

export function stopSpeaking(): void {
  if (currentProcess) {
    currentProcess.kill('SIGKILL');
    currentProcess = null;
  }
  // Kill any lingering TTS audio or say processes spawned by JARVIS (macOS only)
  if (IS_MAC) {
    try { execSync('pkill -f "afplay.*jarvis-tts" 2>/dev/null', { stdio: 'ignore' }); } catch (err) { log.debug('Failed to kill afplay processes', err); }
    try { execSync('pkill -f "say -v" 2>/dev/null', { stdio: 'ignore' }); } catch (err) { log.debug('Failed to kill say processes', err); }
  }
}

/**
 * Abort speech AND prevent any further speak() calls until reset.
 * Used by voice interrupt — ensures modules can't re-speak after being cut off.
 */
export function abortSpeech(): void {
  speechAborted = true;
  stopSpeaking();
}

/**
 * Clear the abort flag. Call at the start of each new command.
 */
export function resetSpeechAbort(): void {
  speechAborted = false;
}

// Kill speech on process exit — prevents orphaned audio after Ctrl+C / close
function registerExitCleanup(): void {
  const cleanup = () => { stopSpeaking(); };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGHUP', () => { cleanup(); process.exit(0); });
}
registerExitCleanup();

function cleanText(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')           // ANSI escape codes
    .replace(/[─═╗╔╚╝║╠╣╬│┌┐└┘├┤┬┴┼]/g, '')  // box drawing chars
    .replace(/[█▓▒░▀▄▌▐]/g, '')               // block chars
    .replace(/[✓✗✔✘●○■□▪▫►◄▲▼]/g, '')         // symbols
    .replace(/\s*\n\s*/g, '. ')                // newlines to pauses
    .replace(/\s{2,}/g, ' ')                   // collapse whitespace
    .replace(/\.{2,}/g, '.')                   // collapse dots
    .trim();
}

/**
 * Speak using Edge TTS (Microsoft neural voices). Free, no API key needed.
 */
async function speakEdgeTts(text: string): Promise<boolean> {
  const voice = config.edgeTts?.voice || 'en-GB-RyanNeural';
  const rate = config.edgeTts?.rate || '+0%';
  const pitch = config.edgeTts?.pitch || '+0Hz';
  const tmpFile = join(tmpdir(), `jarvis-tts-${Date.now()}.mp3`);

  try {
    // Generate audio file using edge-tts CLI
    await new Promise<void>((resolve, reject) => {
      const escaped = text.replace(/"/g, '\\"');
      const cmd = `edge-tts --voice "${voice}" --rate="${rate}" --pitch="${pitch}" --text "${escaped}" --write-media "${tmpFile}"`;
      exec(cmd, { timeout: 15000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (speechAborted) {
      try { unlinkSync(tmpFile); } catch (err) { log.debug('Failed to clean up TTS temp file', err); }
      return true;
    }

    // Play the audio
    return new Promise((resolve) => {
      currentProcess = exec(`afplay "${tmpFile}"`, { timeout: 60000 }, () => {
        currentProcess = null;
        try { unlinkSync(tmpFile); } catch (err) { log.debug('Failed to clean up TTS temp file', err); }
        resolve(true);
      });
    });
  } catch (err) {
    log.debug('Edge TTS synthesis failed', err);
    try { unlinkSync(tmpFile); } catch (err2) { log.debug('Failed to clean up TTS temp file', err2); }
    return false;
  }
}

/**
 * Speak using ElevenLabs API. Returns false if quota exceeded or API error.
 */
async function speakElevenLabs(text: string): Promise<boolean> {
  const apiKey = config.elevenlabs?.apiKey;
  const voiceId = config.elevenlabs?.voiceId;
  if (!apiKey || !voiceId) return false;

  const model = config.elevenlabs?.model || 'eleven_multilingual_v2';
  const tmpFile = join(tmpdir(), `jarvis-tts-${Date.now()}.mp3`);

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.15 },
      }),
    });

    if (!response.ok) {
      // Quota/plan error or bad voice — make it visible (it was silent before)
      // then signal failure so we can fall back to Edge/macOS.
      log.warn(`ElevenLabs TTS failed (${response.status}) — falling back. A 402 means the voice needs a paid plan.`);
      return false;
    }

    const arrayBuf = await response.arrayBuffer();
    const { writeFileSync } = await import('fs');
    writeFileSync(tmpFile, Buffer.from(arrayBuf));

    if (speechAborted) {
      try { unlinkSync(tmpFile); } catch (err) { log.debug('Failed to clean up ElevenLabs temp file', err); }
      return true;
    }

    return new Promise((resolve) => {
      currentProcess = exec(`afplay "${tmpFile}"`, { timeout: 60000 }, () => {
        currentProcess = null;
        try { unlinkSync(tmpFile); } catch (err) { log.debug('Failed to clean up ElevenLabs temp file', err); }
        resolve(true);
      });
    });
  } catch (err) {
    log.debug('ElevenLabs synthesis failed', err);
    try { unlinkSync(tmpFile); } catch (err2) { log.debug('Failed to clean up ElevenLabs temp file', err2); }
    return false;
  }
}

/**
 * Speak using macOS `say` command (last resort fallback).
 */
function speakMacOS(text: string): Promise<void> {
  const voice = config.fallbackVoice || FALLBACK_VOICE;
  const rate = config.fallbackRate || FALLBACK_RATE;
  const escaped = text.replace(/'/g, "'\\''");

  return new Promise((resolve) => {
    currentProcess = exec(
      `say -v '${voice}' -r ${rate} '${escaped}'`,
      { timeout: 60000 },
      () => {
        currentProcess = null;
        resolve();
      },
    );
  });
}

/**
 * Speak text aloud.
 * Priority: ElevenLabs → Edge TTS → macOS say
 * Auto-falls through the chain on failure (e.g. quota exceeded).
 */
export async function speak(text: string): Promise<void> {
  if (!enabled || !text.trim() || speechAborted) return;

  // On Linux VPS there are no local speakers — audio is streamed to devices
  // via generateTTSAudio() instead. speak() is a no-op.
  if (!IS_MAC) return;

  const cleaned = cleanText(text);
  if (!cleaned) return;

  stopSpeaking();

  // Try ElevenLabs first
  if (config.provider === 'elevenlabs') {
    const ok = await speakElevenLabs(cleaned);
    if (ok || speechAborted) return;
  }

  // Try Edge TTS
  if (config.provider === 'elevenlabs' || config.provider === 'edge-tts') {
    const ok = await speakEdgeTts(cleaned);
    if (ok || speechAborted) return;
  }

  await speakMacOS(cleaned);
}

/**
 * Generate TTS audio as a Buffer (for streaming to Apple Watch).
 * Same provider chain as speak(), but returns audio instead of playing.
 */
export async function generateTTSAudio(text: string): Promise<Buffer | null> {
  const cleaned = cleanText(text);
  if (!cleaned) return null;

  // Try ElevenLabs
  if (config.provider === 'elevenlabs') {
    const buf = await generateElevenLabsAudio(cleaned);
    if (buf) return buf;
  }

  // Try Edge TTS
  if (config.provider === 'elevenlabs' || config.provider === 'edge-tts') {
    const buf = await generateEdgeTtsAudio(cleaned);
    if (buf) return buf;
  }

  // Fall back to macOS say → AIFF (only available on macOS)
  if (IS_MAC) {
    const buf = await generateMacOSAudio(cleaned);
    return buf;
  }

  return null;
}

async function generateElevenLabsAudio(text: string): Promise<Buffer | null> {
  const apiKey = config.elevenlabs?.apiKey;
  const voiceId = config.elevenlabs?.voiceId;
  if (!apiKey || !voiceId) return null;

  const model = config.elevenlabs?.model || 'eleven_multilingual_v2';

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.15 },
      }),
    });

    if (!response.ok) return null;
    const arrayBuf = await response.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (err) {
    log.debug('ElevenLabs audio generation failed', err);
    return null;
  }
}

async function generateEdgeTtsAudio(text: string): Promise<Buffer | null> {
  const voice = config.edgeTts?.voice || 'en-GB-RyanNeural';
  const rate = config.edgeTts?.rate || '+0%';
  const pitch = config.edgeTts?.pitch || '+0Hz';
  const tmpFile = join(tmpdir(), `jarvis-tts-gen-${Date.now()}.mp3`);

  try {
    await new Promise<void>((resolve, reject) => {
      const escaped = text.replace(/"/g, '\\"');
      const cmd = `edge-tts --voice "${voice}" --rate="${rate}" --pitch="${pitch}" --text "${escaped}" --write-media "${tmpFile}"`;
      exec(cmd, { timeout: 15000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const data = readFileSync(tmpFile);
    try { unlinkSync(tmpFile); } catch (err) { log.debug('Failed to clean up Edge TTS temp file', err); }
    return data;
  } catch (err) {
    log.debug('Edge TTS audio generation failed', err);
    try { unlinkSync(tmpFile); } catch (err2) { log.debug('Failed to clean up Edge TTS temp file', err2); }
    return null;
  }
}

async function generateMacOSAudio(text: string): Promise<Buffer | null> {
  const voice = config.fallbackVoice || FALLBACK_VOICE;
  const rate = config.fallbackRate || FALLBACK_RATE;
  const tmpFile = join(tmpdir(), `jarvis-tts-gen-${Date.now()}.aiff`);
  const escaped = text.replace(/'/g, "'\\''");

  try {
    await new Promise<void>((resolve, reject) => {
      exec(`say -v '${voice}' -r ${rate} -o '${tmpFile}' '${escaped}'`, { timeout: 15000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const data = readFileSync(tmpFile);
    try { unlinkSync(tmpFile); } catch (err) { log.debug('Failed to clean up macOS TTS temp file', err); }
    return data;
  } catch (err) {
    log.debug('macOS audio generation failed', err);
    try { unlinkSync(tmpFile); } catch (err2) { log.debug('Failed to clean up macOS TTS temp file', err2); }
    return null;
  }
}

/**
 * Get voice status info for display.
 */
export function getVoiceStatus(): string {
  const providerLabel = config.provider === 'edge-tts' ? 'Edge TTS' :
    config.provider === 'elevenlabs' ? 'ElevenLabs' : 'macOS';
  return [
    `Voice: ${enabled ? 'enabled' : 'disabled'}`,
    `    Provider: ${providerLabel}`,
    `    Voice: ${getVoice()}`,
  ].join('\n');
}
