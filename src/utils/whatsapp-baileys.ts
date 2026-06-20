// ---------------------------------------------------------------------------
// WhatsApp via Baileys — instant, browserless sending
// ---------------------------------------------------------------------------
// Holds ONE persistent multi-device WebSocket connection in-process (JARVIS is
// a long-lived Node process). A send is a single socket call (<1s) instead of
// driving web.whatsapp.com with Playwright (7-15s).
//
// Auth persists to ~/.jarvis/whatsapp-auth via useMultiFileAuthState, so the QR
// is scanned ONCE; subsequent boots reconnect silently. Inbound messages are
// buffered in memory so `read whatsapp` can return a recent window.
//
// Adapted from the alfred sidecar's Baileys wrapper, hardened against duplicate
// sockets: a single in-flight guard, stale-socket teardown, and a guarded
// reconnect timer prevent the geometric socket/listener leak that an unguarded
// reconnect + manual re-pair would otherwise cause.

import { mkdirSync, rmSync } from 'fs';
import makeWASocket, {
  type WAMessage,
  type WASocket,
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import P from 'pino';
import { createLogger } from './logger.js';

const log = createLogger('whatsapp-baileys');

export type ConnectionState =
  | { state: 'connecting' }
  | { state: 'open'; user?: string }
  | { state: 'qr' }
  | { state: 'closed'; reason?: string }
  | { state: 'idle' };

export interface InboundMessage {
  id: string;
  from: string;
  chatId: string;
  text: string;
  timestampMs: number;
  pushName?: string;
}

export interface StartOpts {
  authDir: string;
  onQR: (qr: string) => void;
}

const MAX_BUFFERED = 500;

// ── Module singleton state ──
let sock: WASocket | null = null;
let connectionState: ConnectionState = { state: 'idle' };
let started = false;
let connecting = false; // in-flight guard — only one connect() at a time
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentAuthDir = '';
let onQRCb: ((qr: string) => void) | null = null;
let qrPrintCount = 0; // bound how many times we print the QR before giving up
const MAX_QR_PRINTS = 5;
const buffer: InboundMessage[] = [];
const seenIds = new Set<string>(); // dedup inbound across any socket churn

// Baileys' encryption layer (libsignal) writes session-rotation chatter straight
// to console.log/console.error — harmless housekeeping, but it floods the REPL.
// Filter just those lines; everything else passes through untouched.
let signalNoiseFiltered = false;
function suppressSignalNoise(): void {
  if (signalNoiseFiltered) return;
  signalNoiseFiltered = true;
  const NOISE = [
    'Closing open session',
    'Closing session',
    'Closing stale',
    'SessionEntry',
    'Removing old closed session',
    'Failed to decrypt',
    'incoming prekey bundle',
    'No matching sessions',
    'No session found',
  ];
  const isNoise = (args: unknown[]): boolean => {
    const first = args[0];
    if (typeof first === 'string' && NOISE.some((n) => first.includes(n))) return true;
    // libsignal also dumps a raw SessionEntry object — detect it by shape.
    if (first && typeof first === 'object') {
      const o = first as Record<string, unknown>;
      if ('_chains' in o && 'currentRatchet' in o) return true;
      const ctor = (first as { constructor?: { name?: string } }).constructor?.name;
      if (ctor === 'SessionEntry' || ctor === 'SessionRecord') return true;
    }
    return false;
  };
  const wrap = (orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
    if (isNoise(args)) return;
    orig(...args);
  };
  console.log = wrap(console.log.bind(console)) as typeof console.log;
  console.error = wrap(console.error.bind(console)) as typeof console.error;
  console.info = wrap(console.info.bind(console)) as typeof console.info;
}

/**
 * Open the persistent WhatsApp connection. Safe to call once at boot.
 * Prints a QR (via onQR) on first run; reconnects automatically thereafter.
 */
export async function startWhatsApp(opts: StartOpts): Promise<void> {
  if (started) return;
  started = true;
  suppressSignalNoise();
  currentAuthDir = opts.authDir;
  onQRCb = opts.onQR;
  mkdirSync(opts.authDir, { recursive: true });
  await connect();
}

/** Tear down the current socket: remove listeners and end it so no stale
 *  closures keep firing events or scheduling reconnects. */
function teardownSocket(): void {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners('connection.update');
    sock.ev.removeAllListeners('creds.update');
    sock.ev.removeAllListeners('messages.upsert');
  } catch {
    /* best-effort */
  }
  try {
    sock.end(undefined);
  } catch {
    /* best-effort */
  }
  sock = null;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return; // already scheduled
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((e) => log.error('WhatsApp reconnect failed', e));
  }, 3000);
}

async function connect(): Promise<void> {
  if (connecting) return; // in-flight guard — never run two connects at once
  connecting = true;

  // Cancel any pending reconnect and tear down a previous socket before we
  // create a new one, so old listeners/closures can't fire.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  teardownSocket();

  try {
    const { state: auth, saveCreds } = await useMultiFileAuthState(currentAuthDir);
    const { version } = await fetchLatestBaileysVersion().catch(
      () => ({ version: undefined as unknown as [number, number, number] }),
    );

    connectionState = { state: 'connecting' };

    const socket = makeWASocket({
      version,
      auth,
      browser: Browsers.macOS('Jarvis'),
      // Baileys is extremely chatty (app-state sync warnings, stream errors that
      // it recovers from on its own). Silence its internal logger — we surface
      // the states that matter through our own `log`.
      logger: P({ level: 'silent' }),
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    sock = socket;

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', (update) => {
      // Ignore events from a socket that is no longer the active one.
      if (sock !== socket) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionState = { state: 'qr' };
        // The QR refreshes (~every 20s) until scanned. Print it a bounded number
        // of times so it can't flood the console, then stop and tell the user.
        if (qrPrintCount < MAX_QR_PRINTS) {
          qrPrintCount++;
          onQRCb?.(qr);
          if (qrPrintCount === MAX_QR_PRINTS) {
            log.warn('WhatsApp QR shown several times without linking — run "whatsapp login" to show a fresh one.');
          }
        }
      }

      if (connection === 'open') {
        connecting = false;
        qrPrintCount = 0; // linked — reset so a future re-pair prints again
        const me = socket.user?.id;
        connectionState = { state: 'open', user: me };
        log.info(`WhatsApp connected as ${me ?? '(unknown)'}`);
      } else if (connection === 'close') {
        connecting = false;
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
          ?.statusCode;
        const reason = lastDisconnect?.error ? (lastDisconnect.error as Error).message : 'unknown';
        connectionState = { state: 'closed', reason };

        if (code !== DisconnectReason.loggedOut) {
          log.warn(`WhatsApp closed (code=${code ?? '?'}) — reconnecting in 3s`);
          scheduleReconnect();
        } else {
          log.warn('WhatsApp logged out — wiping auth; re-pair with "whatsapp login"');
          teardownSocket();
          try {
            rmSync(currentAuthDir, { recursive: true, force: true });
            mkdirSync(currentAuthDir, { recursive: true });
          } catch {
            /* best-effort */
          }
          // Do NOT auto-reconnect after logout — the user must re-pair.
        }
      }
    });

    socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (sock !== socket) return;
      if (type !== 'notify') return;
      const meJid = socket.user?.id ? normaliseJid(socket.user.id) : '';
      for (const m of messages) {
        const inbound = toInbound(m, meJid);
        if (!inbound) continue;
        if (inbound.id && seenIds.has(inbound.id)) continue; // dedup
        if (inbound.id) seenIds.add(inbound.id);
        buffer.push(inbound);
        while (buffer.length > MAX_BUFFERED) {
          const removed = buffer.shift();
          if (removed?.id) seenIds.delete(removed.id);
        }
      }
    });
  } catch (err) {
    connecting = false;
    throw err;
  }
}

/**
 * Send a WhatsApp message. `to` is an E.164 phone number (digits) or a full JID.
 * Returns the message id. The ENTIRE send is one socket call (<1s).
 */
export async function sendWhatsApp(to: string, text: string): Promise<string> {
  if (!sock || connectionState.state !== 'open') {
    throw new Error(`WhatsApp not connected (state=${connectionState.state})`);
  }
  const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
  const result = await sock.sendMessage(jid, { text });
  return result?.key?.id ?? '';
}

/** Recent inbound messages within the lookback window (most recent first). */
export function recentInbound(lookbackHours: number, limit: number): InboundMessage[] {
  const since = Date.now() - lookbackHours * 3600 * 1000;
  return buffer
    .filter((m) => m.timestampMs >= since)
    .slice(-limit)
    .reverse();
}

/** Current connection state. */
export function waStatus(): ConnectionState {
  return connectionState;
}

export function isWhatsAppConnected(): boolean {
  return connectionState.state === 'open';
}

/**
 * Force a fresh pairing cycle: wipe auth and reconnect so a new QR is emitted.
 * Cancels any pending reconnect and tears down the current socket first so we
 * never end up with two live sockets racing.
 */
export async function repairWhatsApp(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  teardownSocket();
  try {
    rmSync(currentAuthDir, { recursive: true, force: true });
    mkdirSync(currentAuthDir, { recursive: true });
  } catch {
    /* best-effort */
  }
  qrPrintCount = 0; // fresh pairing — allow QR prints again
  connecting = false; // allow the intentional reconnect through the guard
  await new Promise((r) => setTimeout(r, 500));
  await connect();
}

// ── Helpers ──

function normaliseJid(jid: string): string {
  // Strip device suffix (`:NN`): 971523135270:16@s.whatsapp.net -> 971523135270@s.whatsapp.net
  const at = jid.indexOf('@');
  if (at === -1) return jid;
  const colon = jid.slice(0, at).indexOf(':');
  if (colon === -1) return jid;
  return jid.slice(0, colon) + jid.slice(at);
}

function toInbound(m: WAMessage, meJid: string): InboundMessage | null {
  // Allow fromMe only for self-chat (WhatsApp "Message yourself"); suppress
  // our own outbound replies from looping back as inbound.
  const remote = normaliseJid(m.key.remoteJid ?? '');
  const isSelfChat = !!meJid && remote === meJid;
  if (m.key.fromMe && !isSelfChat) return null;

  const text =
    m.message?.conversation ??
    m.message?.extendedTextMessage?.text ??
    m.message?.imageMessage?.caption ??
    m.message?.videoMessage?.caption ??
    '';
  if (!text) return null;

  return {
    id: m.key.id ?? '',
    from: m.key.participant ?? m.key.remoteJid ?? '',
    chatId: m.key.remoteJid ?? '',
    text,
    timestampMs: Number(m.messageTimestamp ?? 0) * 1000 || Date.now(),
    pushName: m.pushName ?? undefined,
  };
}
