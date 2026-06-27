// ── WHOOP API client (v2) ──
// OAuth bearer with refresh-token rotation, talking to the official WHOOP v2
// developer API. Credentials + tokens live in config/whoop.json (gitignored).
// Modeled on the user's whoop-imessage bot (same endpoints/fields/refresh flow).
//
//   token : https://api.prod.whoop.com/oauth/oauth2/token   (grant_type=refresh_token)
//   base  : https://api.prod.whoop.com/developer/v2
//   GET /recovery        -> records[].score.recovery_score / hrv_rmssd_milli / resting_heart_rate
//   GET /activity/sleep  -> records[].score.sleep_performance_percentage / stage_summary / ...
//   GET /cycle           -> records[].score.strain

import { fetch as undiciFetch, Agent } from 'undici';
import { createServer } from 'http';
import { exec } from 'child_process';
import { randomBytes } from 'crypto';
import { readJsonConfig, writeJsonConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('whoop');

const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API_BASE = 'https://api.prod.whoop.com/developer/v2';
const SCOPES = 'read:sleep read:recovery read:cycles offline';
const DEFAULT_REDIRECT = 'http://localhost:8080/callback';
// api.prod.whoop.com sits behind Cloudflare, which 403s the default Node UA.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const agent = new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 120_000 });

interface WhoopConfig {
  client_id: string;
  client_secret: string;
  redirect_uri?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number; // epoch seconds
}

function load(): WhoopConfig | null {
  const c = readJsonConfig<WhoopConfig | null>('whoop.json', null);
  if (!c || !c.client_id || !c.client_secret || !c.refresh_token) return null;
  return c;
}

/** True once we have a usable refresh token (i.e. authorized at least once). */
export function isWhoopConfigured(): boolean {
  return load() !== null;
}

/** True if we have client credentials (enough to start the OAuth connect flow). */
export function hasWhoopCredentials(): boolean {
  const c = readJsonConfig<WhoopConfig | null>('whoop.json', null);
  return !!(c && c.client_id && c.client_secret);
}

async function refresh(cfg: WhoopConfig): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: cfg.refresh_token!,
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    scope: 'offline',
  });
  const res = await undiciFetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    body,
    dispatcher: agent,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`WHOOP token refresh failed (HTTP ${res.status}). ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  cfg.access_token = json.access_token;
  if (json.refresh_token) cfg.refresh_token = json.refresh_token; // rotation: keep newest
  cfg.expires_at = Math.floor(Date.now() / 1000) + (json.expires_in ?? 3600);
  writeJsonConfig('whoop.json', cfg);
  log.debug('WHOOP access token refreshed');
  return cfg.access_token;
}

async function getAccessToken(): Promise<string> {
  const cfg = load();
  if (!cfg) throw new Error('WHOOP is not configured (config/whoop.json missing client_id/secret/refresh_token).');
  if (!cfg.access_token || Date.now() / 1000 >= (cfg.expires_at ?? 0) - 60) {
    return refresh(cfg);
  }
  return cfg.access_token;
}

async function apiGet<T = any>(path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ''}`;

  const doFetch = (tok: string) =>
    undiciFetch(url, {
      headers: { Authorization: `Bearer ${tok}`, 'User-Agent': USER_AGENT, Accept: 'application/json' },
      dispatcher: agent,
    });

  let token = await getAccessToken();
  let res = await doFetch(token);
  if (res.status === 401) {
    // Token rejected — refresh once and retry.
    const cfg = load();
    if (cfg) { token = await refresh(cfg); res = await doFetch(token); }
  }
  if (res.status === 429) throw new Error('WHOOP rate limit hit — try again in a minute.');
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`WHOOP API error (HTTP ${res.status}). ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

interface Record_ { score_state?: string; score?: any; start?: string; end?: string; created_at?: string }

/** Most recent record whose score_state is SCORED (WHOOP returns unscored drafts too). */
function latestScored(records: Record_[]): Record_ | null {
  for (const r of records) {
    if (r.score_state === 'SCORED' && r.score) return r;
  }
  return null;
}

export interface Recovery { recovery: number; hrv: number | null; rhr: number | null }
export interface Sleep { performance: number | null; hours: number | null; efficiency: number | null; respiratoryRate: number | null }
export interface Strain { strain: number | null }

export async function getRecovery(): Promise<Recovery | null> {
  const data = await apiGet<{ records: Record_[] }>('/recovery', { limit: '10' });
  const rec = latestScored(data.records || []);
  if (!rec) return null;
  const s = rec.score;
  return {
    recovery: Math.round(s.recovery_score),
    hrv: s.hrv_rmssd_milli != null ? Math.round(s.hrv_rmssd_milli) : null,
    rhr: s.resting_heart_rate != null ? Math.round(s.resting_heart_rate) : null,
  };
}

export async function getSleep(): Promise<Sleep | null> {
  const data = await apiGet<{ records: Record_[] }>('/activity/sleep', { limit: '10' });
  const rec = latestScored(data.records || []);
  if (!rec) return null;
  const s = rec.score;
  const inBedMs = s.stage_summary?.total_in_bed_time_milli;
  return {
    performance: s.sleep_performance_percentage != null ? Math.round(s.sleep_performance_percentage) : null,
    hours: inBedMs != null ? Math.round((inBedMs / 3_600_000) * 10) / 10 : null,
    efficiency: s.sleep_efficiency_percentage != null ? Math.round(s.sleep_efficiency_percentage) : null,
    respiratoryRate: s.respiratory_rate != null ? Math.round(s.respiratory_rate * 10) / 10 : null,
  };
}

export async function getStrain(): Promise<Strain | null> {
  const data = await apiGet<{ records: Record_[] }>('/cycle', { limit: '10' });
  const rec = latestScored(data.records || []);
  if (!rec) return null;
  return { strain: rec.score.strain != null ? Math.round(rec.score.strain * 10) / 10 : null };
}

// ── One-time OAuth connect (browser consent + local callback) ──

async function exchangeCode(cfg: WhoopConfig, code: string, redirectUri: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    redirect_uri: redirectUri,
  });
  const res = await undiciFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, Accept: 'application/json' },
    body,
    dispatcher: agent,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`WHOOP code exchange failed (HTTP ${res.status}). ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  cfg.access_token = json.access_token;
  if (json.refresh_token) cfg.refresh_token = json.refresh_token;
  cfg.expires_at = Math.floor(Date.now() / 1000) + (json.expires_in ?? 3600);
  writeJsonConfig('whoop.json', cfg);
}

/**
 * Run the WHOOP OAuth flow: open the consent page in the browser, catch the
 * redirect on a local callback server, exchange the code, and save fresh tokens
 * to config/whoop.json. One-time (or whenever the refresh token expires).
 * Resolves with a human-readable status string.
 */
export function whoopConnect(timeoutMs = 120_000): Promise<string> {
  const cfg = readJsonConfig<WhoopConfig | null>('whoop.json', null);
  if (!cfg || !cfg.client_id || !cfg.client_secret) {
    return Promise.reject(new Error('Missing client_id/client_secret in config/whoop.json.'));
  }
  const redirectUri = cfg.redirect_uri || DEFAULT_REDIRECT;
  const url = new URL(redirectUri);
  const port = Number(url.port) || 8080;
  const cbPath = url.pathname || '/callback';
  const state = randomBytes(16).toString('hex');

  const authorize = `${AUTH_URL}?` + new URLSearchParams({
    response_type: 'code',
    client_id: cfg.client_id,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
  }).toString();

  return new Promise<string>((resolve, reject) => {
    let done = false;
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);
      if (reqUrl.pathname !== cbPath) { res.writeHead(404); res.end(); return; }
      const code = reqUrl.searchParams.get('code');
      const gotState = reqUrl.searchParams.get('state');
      const err = reqUrl.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>WHOOP authorization complete.</h2><p>You can close this tab and return to JARVIS.</p>');
      if (done) return;
      done = true;
      server.close();
      if (err) { reject(new Error(`Authorization failed: ${err}`)); return; }
      if (!code) { reject(new Error('No authorization code returned.')); return; }
      if (gotState !== state) { reject(new Error('State mismatch — aborting.')); return; }
      exchangeCode(cfg, code, redirectUri)
        .then(() => resolve('WHOOP connected — tokens saved.'))
        .catch(reject);
    });
    server.on('error', (e) => { if (!done) { done = true; reject(e); } });
    server.listen(port, () => {
      log.info(`Waiting for WHOOP authorization on ${redirectUri} …`);
      exec(`open "${authorize.replace(/"/g, '%22')}"`);
    });
    setTimeout(() => {
      if (!done) { done = true; server.close(); reject(new Error('Authorization timed out — run “connect whoop” again.')); }
    }, timeoutMs);
  });
}
