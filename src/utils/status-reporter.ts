import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { IS_MAC } from './platform.js';
import { createLogger } from './logger.js';

const log = createLogger('status-reporter');

// ── Status Reporter ──
// Writes JARVIS state to /tmp/jarvis-status.json for the menubar app to read.
// Also broadcasts via AIM so all connected devices see state changes.

const STATUS_PATH = '/tmp/jarvis-status.json';

interface JarvisStatusData {
  running: boolean;
  voiceActive: boolean;
  state: string;          // idle, activated, processing, speaking
  lastCommand: string;
  lastCommandTime: number;
  modulesLoaded: number;
  pid: number;
  // ── Richer status (for the menubar) ──
  recentCommands: string[]; // last few commands, most recent first
  sidecarReady: boolean;    // Rust sidecar up
  whatsappConnected: boolean;
  model: string;            // active LLM model
  bootTime: number;         // epoch ms, for uptime
}

const currentStatus: JarvisStatusData = {
  running: false,
  voiceActive: false,
  state: 'idle',
  lastCommand: '',
  lastCommandTime: 0,
  modulesLoaded: 0,
  pid: process.pid,
  recentCommands: [],
  sidecarReady: false,
  whatsappConnected: false,
  model: '',
  bootTime: 0,
};

let statusCallback: ((status: JarvisStatusData) => void) | null = null;
let aimBroadcast: ((state: string, extra?: Record<string, any>) => void) | null = null;

/**
 * Register a callback for real-time status updates (used by watch server).
 */
export function onStatusUpdate(cb: (status: JarvisStatusData) => void): void {
  statusCallback = cb;
}

/**
 * Register the AIM broadcast function for pushing status to all devices.
 */
export function setAIMStatusBroadcast(fn: (state: string, extra?: Record<string, any>) => void): void {
  aimBroadcast = fn;
}

function flush(): void {
  // Write local status file (for menubar app on Mac)
  if (IS_MAC) {
    try {
      writeFileSync(STATUS_PATH, JSON.stringify(currentStatus));
    } catch (err) { log.debug('Failed to write status file', err); }
  }
  // Push to watch server if connected
  statusCallback?.(currentStatus);
  // Broadcast via AIM to all connected devices
  aimBroadcast?.(currentStatus.state, {
    lastCommand: currentStatus.lastCommand,
    voiceActive: currentStatus.voiceActive,
  });
}

export function reportBoot(moduleCount: number): void {
  currentStatus.running = true;
  currentStatus.modulesLoaded = moduleCount;
  currentStatus.pid = process.pid;
  currentStatus.bootTime = Date.now();
  flush();
}

export function reportVoice(active: boolean): void {
  currentStatus.voiceActive = active;
  if (!active) currentStatus.state = 'idle';
  flush();
}

export function reportState(state: string): void {
  currentStatus.state = state;
  flush();
}

export function reportCommand(command: string): void {
  currentStatus.lastCommand = command;
  currentStatus.lastCommandTime = Date.now();
  // Keep a short rolling history (most recent first, de-duped against the last one).
  const trimmed = command.trim();
  if (trimmed && currentStatus.recentCommands[0] !== trimmed) {
    currentStatus.recentCommands.unshift(trimmed);
    currentStatus.recentCommands = currentStatus.recentCommands.slice(0, 5);
  }
  flush();
}

/** Rust sidecar up/down. */
export function reportSidecar(ready: boolean): void {
  currentStatus.sidecarReady = ready;
  flush();
}

/** WhatsApp connection state. */
export function reportWhatsApp(connected: boolean): void {
  currentStatus.whatsappConnected = connected;
  flush();
}

/** Active LLM model label. */
export function reportModel(model: string): void {
  currentStatus.model = model;
  flush();
}

export function reportShutdown(): void {
  currentStatus.running = false;
  currentStatus.state = 'idle';
  flush();
  // Clean up the status file
  try {
    if (existsSync(STATUS_PATH)) unlinkSync(STATUS_PATH);
  } catch (err) { log.debug('Failed to clean up status file', err); }
}
