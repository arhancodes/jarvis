/**
 * AIM Bridge for JARVIS
 *
 * Connects JARVIS to the AIM relay server.
 *
 * On Mac (local dev): registers as 'mac' device, connects to remote AIM.
 * On Linux VPS: registers as 'server' device, connects to localhost AIM.
 *   - Handles commands from all devices (phone, watch, Mac)
 *   - Forwards macOS commands to connected Mac client via mac-proxy
 *   - Generates TTS audio and streams to requesting devices
 */

import WebSocket from 'ws';
import { conversationEngine } from '../core/conversation-engine.js';
import { parse, splitChainedCommands } from '../core/parser.js';
import { execute } from '../core/executor.js';
import { tryNaturalLanguageMapping } from '../modules/smart-assist.js';
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { IS_MAC } from '../utils/platform.js';
import { setMacProxySender, handleMacProxyResult } from '../utils/mac-proxy.js';
import { generateTTSAudio } from '../utils/voice-output.js';
import { getBreachStatus, runManualCheck } from '../utils/breach-monitor.js';
import { getNetworkDevices, trustDevice, runManualScan } from '../utils/network-guardian.js';
import { configPath } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const execAsync = promisify(exec);
const log = createLogger('aim-bridge');

// ── Config ──

interface AIMBridgeConfig {
  url: string;       // ws://vps-ip:5225 or wss://vps-ip:5225
  token?: string;    // Auth token
  deviceName?: string;
}

function loadAIMConfig(): AIMBridgeConfig | null {
  const aimPath = configPath('aim.json');

  try {
    if (existsSync(aimPath)) {
      const config = JSON.parse(readFileSync(aimPath, 'utf-8'));
      if (config.url) return config;
    }
  } catch (err) { log.debug('Failed to load AIM config', err); }

  // Also check environment variables
  if (process.env.AIM_URL) {
    return {
      url: process.env.AIM_URL,
      token: process.env.AIM_TOKEN,
      deviceName: process.env.AIM_DEVICE_NAME || (IS_MAC ? 'JARVIS-Mac' : 'JARVIS-Server'),
    };
  }

  // On Linux VPS, default to localhost AIM
  if (!IS_MAC) {
    return {
      url: 'ws://localhost:5225',
      deviceName: 'JARVIS-Server',
    };
  }

  return null;
}

// ── TTS for Mac local playback (only used when running on Mac) ──

interface VoiceJson {
  provider: string;
  elevenlabs?: { apiKey: string; voiceId: string; model?: string };
  edgeTts?: { voice: string; rate?: string; pitch?: string };
}

function loadVoiceJson(): VoiceJson {
  const voicePath = configPath('voice.json');
  try {
    if (existsSync(voicePath)) return JSON.parse(readFileSync(voicePath, 'utf-8'));
  } catch (err) { log.debug('Failed to load voice config', err); }
  return { provider: 'edge-tts' };
}

/**
 * Play audio directly on Mac speakers.
 * Only used when JARVIS runs on Mac and playOnMac is requested.
 */
async function playAudioOnMac(text: string): Promise<void> {
  if (!IS_MAC) {
    // On VPS, forward playOnMac request to connected Mac client via AIM
    const audioBuf = await generateTTSAudio(text);
    if (audioBuf) {
      sendToAIM({ type: 'play_audio', data: audioBuf.toString('base64'), to: 'mac' });
    }
    return;
  }

  const vc = loadVoiceJson();
  try {
    if (vc.provider === 'elevenlabs' && vc.elevenlabs?.apiKey && vc.elevenlabs?.voiceId) {
      const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vc.elevenlabs.voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': vc.elevenlabs.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: vc.elevenlabs.model || 'eleven_multilingual_v2',
          voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.15 },
        }),
      });
      if (resp.ok) {
        const tmpFile = join(tmpdir(), `jarvis-aim-mac-${Date.now()}.mp3`);
        writeFileSync(tmpFile, Buffer.from(await resp.arrayBuffer()));
        await execAsync(`afplay "${tmpFile}"`).catch(() => {});
        try { unlinkSync(tmpFile); } catch (err) { log.debug('Failed to clean up TTS temp file', err); }
        return;
      }
    }

    const voice = vc.edgeTts?.voice || 'en-GB-RyanNeural';
    const rate = vc.edgeTts?.rate || '+0%';
    const pitch = vc.edgeTts?.pitch || '+0Hz';
    const escaped = text.replace(/'/g, "'\\''");
    const tmpFile = join(tmpdir(), `jarvis-aim-mac-${Date.now()}.mp3`);

    await execAsync(
      `edge-tts --voice "${voice}" --rate="${rate}" --pitch="${pitch}" --text '${escaped}' --write-media "${tmpFile}"`,
      { timeout: 15000 },
    );
    if (existsSync(tmpFile)) {
      await execAsync(`afplay "${tmpFile}"`).catch(() => {});
      try { unlinkSync(tmpFile); } catch (err) { log.debug('Failed to clean up edge-tts temp file', err); }
      return;
    }
  } catch (err) { log.debug('TTS generation failed, falling back to macOS say', err); }

  const escaped = text.replace(/'/g, "'\\''");
  await execAsync(`say -v Daniel '${escaped}'`).catch(() => {});
}

// ── AIM Bridge ──

let aimWs: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let aimConnected = false;
let reconnectDelay = 5000;       // starts at 5s
const MAX_RECONNECT_DELAY = 300_000; // caps at 5 minutes
let consecutiveFailures = 0;
let lastErrorMsg = '';

// ── Command abort tracking ──
// When a new command arrives while one is still being processed,
// we abort the old one so TTS stops immediately.
let currentCommandAbort: AbortController | null = null;

function sendToAIM(msg: Record<string, unknown>): void {
  if (aimWs && aimWs.readyState === WebSocket.OPEN) {
    aimWs.send(JSON.stringify(msg));
  }
}

async function handleAIMCommand(msg: any): Promise<void> {
  const text = msg.text;
  const requestId = msg.requestId || '';
  const respondTo = msg.respondTo || msg.from;
  const noAudio = msg.noAudio === true;
  const playOnMac = msg.playOnMac === true;

  console.log(`  [aim] Remote command: "${text}" → respond to ${respondTo} (noAudio=${noAudio}, playOnMac=${playOnMac})`);

  // Abort any previous command that's still generating TTS
  if (currentCommandAbort) {
    console.log(`  [aim] Aborting previous command for new one`);
    currentCommandAbort.abort();
  }
  const abortController = new AbortController();
  currentCommandAbort = abortController;

  // Broadcast processing status
  sendToAIM({ type: 'status', state: 'processing', lastCommand: text });

  // ── Step 1: Try the normal command pipeline (parse → execute) ──
  const commands = splitChainedCommands(text);
  if (commands.length > 1) {
    // Handle chained commands
    const results: string[] = [];
    for (const cmd of commands) {
      const r = await tryExecuteCommand(cmd);
      if (r) results.push(r);
    }
    if (results.length > 0) {
      const combined = results.join('. ');
      sendToAIM({ type: 'token', text: combined, to: respondTo, requestId });
      await sendVoiceResponse(combined, respondTo, requestId, noAudio, playOnMac);
      sendToAIM({ type: 'status', state: 'idle' });
      return;
    }
  }

  // Single command
  const commandResult = await tryExecuteCommand(text);
  if (commandResult) {
    sendToAIM({ type: 'token', text: commandResult, to: respondTo, requestId });
    await sendVoiceResponse(commandResult, respondTo, requestId, noAudio, playOnMac);
    sendToAIM({ type: 'status', state: 'idle' });
    return;
  }

  // ── Step 2: No module matched — fall back to conversation engine ──
  const sentenceQueue: string[] = [];
  let buffer = '';
  let streamDone = false;

  const streamPromise = conversationEngine.processUnmatched(text, {
    voiceMode: true,
    onToken: (token: string) => {
      sendToAIM({ type: 'token', text: token, to: respondTo, requestId });

      buffer += token;
      const trimmed = buffer.trim();
      const wordCount = trimmed.split(/\s+/).length;

      if (/[.!?]["'）)]*\s*$/.test(trimmed) && wordCount >= 3) {
        sentenceQueue.push(trimmed);
        buffer = '';
      } else if (/\n\s*\n\s*$/.test(buffer) && wordCount >= 3) {
        sentenceQueue.push(trimmed);
        buffer = '';
      } else if (/[,;:]\s*$/.test(trimmed) && wordCount >= 7) {
        sentenceQueue.push(trimmed);
        buffer = '';
      } else if (wordCount >= 25) {
        sentenceQueue.push(trimmed);
        buffer = '';
      }
    },
    onCommandStart: (cmd: string) => {
      console.log(`  [aim] AI executing: ${cmd}`);
    },
    onCommandResult: (_cmd: string, result: any) => {
      if (result.success) {
        console.log(`  [aim] Action result: ${result.message}`);
      }
    },
  }).then(() => {
    if (buffer.trim()) sentenceQueue.push(buffer.trim());
    streamDone = true;
  }).catch((err) => {
    console.log(`  [aim] Conversation error: ${(err as Error).message}`);
    streamDone = true;
  });

  if (noAudio && !playOnMac) {
    await streamPromise.catch(() => {});
    sendToAIM({ type: 'status', state: 'idle' });
    return;
  }

  sendToAIM({ type: 'status', state: 'speaking' });

  while (!streamDone || sentenceQueue.length > 0) {
    // Check if this command was aborted (user started a new one)
    if (abortController.signal.aborted) {
      console.log(`  [aim] Command aborted, stopping TTS`);
      sentenceQueue.length = 0;
      break;
    }

    if (sentenceQueue.length > 0) {
      const sentence = sentenceQueue.shift()!
        .replace(/\[.*?\]/g, '')
        .replace(/\bjarvis\b[,.]?\s*/gi, '')
        .trim();

      if (sentence && !abortController.signal.aborted) {
        if (playOnMac) {
          await playAudioOnMac(sentence);
        } else {
          const audioBuf = await generateTTSAudio(sentence);
          if (audioBuf && !abortController.signal.aborted) {
            sendToAIM({ type: 'audio', data: audioBuf.toString('base64'), to: respondTo, requestId });
          }
        }
      }
    } else {
      await new Promise(r => setTimeout(r, 30));
    }
  }

  if (!playOnMac && !abortController.signal.aborted) {
    sendToAIM({ type: 'audioEnd', to: respondTo, requestId });
  }

  // Only set idle if we're still the active command
  if (currentCommandAbort === abortController) {
    sendToAIM({ type: 'status', state: 'idle' });
    currentCommandAbort = null;
  }
  await streamPromise.catch(() => {});
}

/**
 * Try to parse and execute a command through the module system.
 * Returns the result message if a module handled it, or null if nothing matched.
 */
async function tryExecuteCommand(text: string): Promise<string | null> {
  // Built-in commands (not module-based)
  if (/^breach\s+status$/i.test(text)) return getBreachStatus();
  if (/^breach\s+(check|scan)$/i.test(text)) return await runManualCheck();
  if (/^network\s+(devices|status)$/i.test(text)) return getNetworkDevices();
  if (/^network\s+scan$/i.test(text) || /unknown\s+devices?/i.test(text) || /new\s+devices?/i.test(text)
      || /who'?s?\s+on\s+(my\s+)?(net|wifi)/i.test(text) || /any\s+devices?/i.test(text)
      || /scan\s+(my\s+)?network/i.test(text) || /network\s+intruders?/i.test(text)) return await runManualScan();
  const trustMatch = text.match(/^trust\s+device\s+([0-9a-f:]+)(?:\s+(.+))?$/i);
  if (trustMatch) return trustDevice(trustMatch[1], trustMatch[2]);

  let parsed = await parse(text);

  // NLU fallback
  if (!parsed) {
    parsed = tryNaturalLanguageMapping(text);
  }

  if (!parsed) return null;

  try {
    const result = await execute(parsed);
    console.log(`  [aim] Command executed: "${text}" → ${result.success ? '✓' : '✗'} ${result.message}`);
    return result.voiceMessage || result.message;
  } catch (err) {
    console.log(`  [aim] Command error: ${(err as Error).message}`);
    return `Error: ${(err as Error).message}`;
  }
}

/**
 * Send a voice response via TTS to the requesting device.
 */
async function sendVoiceResponse(
  text: string, respondTo: string, requestId: string,
  noAudio: boolean, playOnMac: boolean
): Promise<void> {
  if (noAudio && !playOnMac) return;

  sendToAIM({ type: 'status', state: 'speaking' });

  const clean = text.replace(/\[.*?\]/g, '').replace(/\bjarvis\b[,.]?\s*/gi, '').trim();
  if (!clean) return;

  if (playOnMac) {
    await playAudioOnMac(clean);
  } else {
    const audioBuf = await generateTTSAudio(clean);
    if (audioBuf) {
      sendToAIM({ type: 'audio', data: audioBuf.toString('base64'), to: respondTo, requestId });
    }
    sendToAIM({ type: 'audioEnd', to: respondTo, requestId });
  }
}

function connectToAIM(config: AIMBridgeConfig): void {
  if (aimWs && aimWs.readyState === WebSocket.OPEN) return;

  // On VPS: register as 'server'. On Mac: register as 'mac'.
  const deviceType = IS_MAC ? 'mac' : 'server';
  const deviceId = IS_MAC ? 'jarvis-mac' : 'jarvis-server';
  const deviceName = config.deviceName || (IS_MAC ? 'JARVIS-Mac' : 'JARVIS-Server');

  const params = new URLSearchParams({
    device: deviceType,
    name: deviceName,
    id: deviceId,
  });
  if (config.token) params.set('token', config.token);

  const url = `${config.url}?${params}`;

  try {
    aimWs = new WebSocket(url);
  } catch (err) {
    console.log(`  [aim] Connection failed: ${(err as Error).message}`);
    scheduleReconnect(config);
    return;
  }

  aimWs.on('open', () => {
    aimConnected = true;
    reconnectDelay = 5000; // reset backoff on successful connect
    consecutiveFailures = 0;
    lastErrorMsg = '';
    console.log(`  [aim] Connected to AIM relay as '${deviceType}': ${config.url}`);

    // Register with capabilities
    const capabilities = IS_MAC
      ? ['audio', 'tts', 'systemControl', 'display', 'microphone']
      : ['tts', 'conversation', 'memory', 'modules'];

    sendToAIM({
      type: 'register',
      deviceType,
      deviceName,
      capabilities,
      from: deviceId,
    });

    // Wire up mac-proxy so macOS commands get forwarded through AIM
    if (!IS_MAC) {
      setMacProxySender((msg) => sendToAIM(msg));
    }

    // Start pinging
    pingTimer = setInterval(() => {
      sendToAIM({ type: 'ping' });
    }, 15000);
  });

  aimWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Handle cancel — abort current command's TTS generation
      if (msg.type === 'cancel') {
        if (currentCommandAbort) {
          console.log(`  [aim] Cancel received for ${msg.requestId}`);
          currentCommandAbort.abort();
        }
      }

      // Handle commands from devices
      if (msg.type === 'command' && msg.text) {
        handleAIMCommand(msg).catch((err) => {
          sendToAIM({ type: 'error', message: (err as Error).message, to: msg.from });
          sendToAIM({ type: 'status', state: 'idle' });
        });
      }

      // Handle system_command_result from Mac client (VPS mode)
      if (msg.type === 'system_command_result' && msg.requestId) {
        handleMacProxyResult(msg.requestId, msg.result || '', msg.error);
      }

      // Other message types (pong, ack, devices, etc.)
      if (msg.type === 'ack') {
        console.log(`  [aim] ${msg.message}`);
      }
    } catch (err) { log.debug('Failed to parse AIM message', err); }
  });

  aimWs.on('close', () => {
    aimConnected = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }

    // Clear mac-proxy sender on disconnect
    if (!IS_MAC) {
      setMacProxySender(null as any);
    }

    consecutiveFailures++;
    if (consecutiveFailures <= 1) {
      console.log(`  [aim] Disconnected from AIM relay`);
    } else if (consecutiveFailures === 2) {
      console.log(`  [aim] Disconnected — retrying with backoff (suppressing repeat logs)`);
    }
    // After 2 failures, suppress disconnect logs

    scheduleReconnect(config);
  });

  aimWs.on('error', (err) => {
    const msg = err.message;
    // Only log if it's a new error message (suppress repeated identical errors)
    if (msg !== lastErrorMsg || consecutiveFailures <= 1) {
      console.log(`  [aim] Error: ${msg}`);
      lastErrorMsg = msg;
    }
  });
}

function scheduleReconnect(config: AIMBridgeConfig): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToAIM(config);
  }, reconnectDelay);
  // Exponential backoff: 5s → 10s → 20s → 40s → ... → 5min max
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

// ── Public API ──

export function startAIMBridge(): boolean {
  const config = loadAIMConfig();
  if (!config) {
    console.log(`  [aim] No AIM config found (config/aim.json or AIM_URL env). Skipping remote bridge.`);
    return false;
  }

  console.log(`  [aim] Starting AIM bridge to ${config.url}`);
  connectToAIM(config);
  return true;
}

export function stopAIMBridge(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (aimWs) { aimWs.close(); aimWs = null; }
  aimConnected = false;
}

export function isAIMConnected(): boolean {
  return aimConnected;
}

/**
 * Broadcast a status update through AIM to all connected devices.
 * Used by status-reporter.ts to keep devices in sync.
 */
export function broadcastStatusViaAIM(state: string, extra?: Record<string, any>): void {
  sendToAIM({ type: 'status', state, ...extra });
}
