/**
 * Energy Efficiency Tracker
 * Tracks energy consumption, latency, and cost per JARVIS operation.
 * Inspired by Stanford's Intelligence Per Watt research.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { configPath } from '../utils/config.js';

const log = createLogger('energy-tracker');

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface EnergyMetric {
  timestamp: number;
  operation: string;        // "llm_call", "web_search", "file_read", etc.
  module: string;           // which JARVIS module triggered it
  latencyMs: number;
  energyJoules?: number;    // estimated energy in Joules (Apple Silicon)
  tokensUsed?: number;      // for LLM calls
  costUsd?: number;         // estimated API cost
  provider?: string;        // "claude", "ollama", "elevenlabs", etc.
}

export interface EnergyReport {
  totalOperations: number;
  totalLatencyMs: number;
  totalEnergyJoules: number;
  totalCostUsd: number;
  averageLatencyMs: number;
  operationBreakdown: Array<{
    operation: string;
    count: number;
    avgLatency: number;
    totalEnergy: number;
    totalCost: number;
  }>;
  moduleBreakdown: Array<{
    module: string;
    count: number;
    avgLatency: number;
    totalCost: number;
  }>;
  efficiencyScore: number;  // 0-100, higher is better
  period: { from: number; to: number };
}

// ── Constants ───────────────────────────────────────────────────────────────

const METRICS_PATH = configPath('energy-metrics.json');
const MAX_ENTRIES = 10000;

// LLM pricing per 1M tokens (input / output) in USD
const LLM_PRICING: Record<string, Record<string, { input: number; output: number }>> = {
  claude: {
    'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
    'claude-haiku-4-5': { input: 1.0, output: 5.0 },
    'claude-opus-4-8': { input: 5.0, output: 25.0 },
    'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
    'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
    'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
    'claude-3-haiku': { input: 0.25, output: 1.25 },
    'claude-3-5-haiku': { input: 0.80, output: 4.0 },
    'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
    'claude-3-opus': { input: 15.0, output: 75.0 },
    default: { input: 3.0, output: 15.0 },
  },
  openai: {
    'gpt-4o': { input: 2.5, output: 10.0 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'gpt-4-turbo': { input: 10.0, output: 30.0 },
    default: { input: 2.5, output: 10.0 },
  },
  ollama: {
    default: { input: 0, output: 0 }, // local, no API cost
  },
  elevenlabs: {
    default: { input: 0.30, output: 0 }, // per 1K chars, approximated
  },
};

// Estimated watts for various operation types on Apple Silicon
const OPERATION_WATT_ESTIMATES: Record<string, number> = {
  llm_call: 2.0,       // network + minimal local CPU
  web_search: 1.5,
  file_read: 0.5,
  file_write: 0.6,
  shell_exec: 1.0,
  screen_capture: 1.2,
  voice_synthesis: 1.8,
  voice_recognition: 2.0,
  image_analysis: 2.5,
  default: 1.0,
};

// ── In-memory store ─────────────────────────────────────────────────────────

let metrics: EnergyMetric[] = [];
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(METRICS_PATH)) {
      const raw = fs.readFileSync(METRICS_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        metrics = parsed;
      }
    }
  } catch (err) {
    log.debug('Failed to load energy metrics', err);
    metrics = [];
  }
}

// ── Exported functions ──────────────────────────────────────────────────────

/**
 * Record an operation metric.
 */
export function trackOperation(metric: Omit<EnergyMetric, 'timestamp'>): void {
  ensureLoaded();

  const entry: EnergyMetric = {
    timestamp: Date.now(),
    ...metric,
  };

  // If no energy estimate provided, estimate from latency and operation type
  if (entry.energyJoules == null) {
    const watts = OPERATION_WATT_ESTIMATES[entry.operation] ?? OPERATION_WATT_ESTIMATES.default;
    entry.energyJoules = watts * (entry.latencyMs / 1000);
  }

  // If no cost and it's an LLM call with token info, estimate cost
  if (entry.costUsd == null && entry.tokensUsed != null && entry.provider) {
    entry.costUsd = estimateLLMCost(
      Math.floor(entry.tokensUsed * 0.4),  // rough input/output split
      Math.floor(entry.tokensUsed * 0.6),
      entry.provider,
      'default'
    );
  }

  metrics.push(entry);

  // Prune if over limit
  if (metrics.length > MAX_ENTRIES) {
    metrics = metrics.slice(metrics.length - MAX_ENTRIES);
  }
}

/**
 * Estimate current system energy usage on Apple Silicon (macOS).
 * Returns watts or null if unavailable.
 */
export function estimateEnergy(): number | null {
  try {
    // Try pmset for battery drain rate
    const pmsetOutput = execSync('pmset -g batt 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
    // Look for wattage info or derive from percentage + time remaining
    const drawMatch = pmsetOutput.match(/(-?\d+\.\d+)\s*W/i);
    if (drawMatch) {
      return Math.abs(parseFloat(drawMatch[1]));
    }

    // Try parsing discharge rate from percentage and time remaining
    const pctMatch = pmsetOutput.match(/(\d+)%/);
    const timeMatch = pmsetOutput.match(/(\d+):(\d+)\s*remaining/);
    if (pctMatch && timeMatch) {
      const pct = parseInt(pctMatch[1]);
      const hoursLeft = parseInt(timeMatch[1]) + parseInt(timeMatch[2]) / 60;
      // Typical MacBook battery ~60Wh; estimate watts from drain rate
      const batteryWh = 60;
      const wattsEstimate = (pct / 100 * batteryWh) / hoursLeft;
      return Math.round(wattsEstimate * 100) / 100;
    }
  } catch (err) {
    log.debug('pmset energy estimation failed', err);
  }

  try {
    // Fallback: estimate from CPU usage
    const topOutput = execSync("top -l 1 -n 0 2>/dev/null | grep 'CPU usage'", {
      encoding: 'utf-8',
      timeout: 10000,
    });
    const userMatch = topOutput.match(/([\d.]+)%\s*user/);
    const sysMatch = topOutput.match(/([\d.]+)%\s*sys/);
    if (userMatch || sysMatch) {
      const userPct = userMatch ? parseFloat(userMatch[1]) : 0;
      const sysPct = sysMatch ? parseFloat(sysMatch[1]) : 0;
      const totalCpu = userPct + sysPct;
      // Apple Silicon M-series TDP ~20-30W; scale linearly as rough estimate
      const tdp = 25;
      const idleWatts = 3;
      return Math.round((idleWatts + (tdp - idleWatts) * (totalCpu / 100)) * 100) / 100;
    }
  } catch (err) {
    log.debug('CPU-based energy estimation failed', err);
  }

  return null;
}

/**
 * Estimate LLM API cost in USD.
 */
export function estimateLLMCost(
  tokensIn: number,
  tokensOut: number,
  provider: string,
  model: string
): number {
  const providerPricing = LLM_PRICING[provider.toLowerCase()] ?? LLM_PRICING.claude;
  const pricing = providerPricing[model] ?? providerPricing.default;
  if (!pricing) return 0;

  const inputCost = (tokensIn / 1_000_000) * pricing.input;
  const outputCost = (tokensOut / 1_000_000) * pricing.output;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal places
}

/**
 * Generate an aggregated energy report.
 */
export function getEnergyReport(since?: number): EnergyReport {
  ensureLoaded();

  const cutoff = since ?? 0;
  const filtered = metrics.filter(m => m.timestamp >= cutoff);

  if (filtered.length === 0) {
    return {
      totalOperations: 0,
      totalLatencyMs: 0,
      totalEnergyJoules: 0,
      totalCostUsd: 0,
      averageLatencyMs: 0,
      operationBreakdown: [],
      moduleBreakdown: [],
      efficiencyScore: 100,
      period: { from: cutoff, to: Date.now() },
    };
  }

  const totalLatencyMs = filtered.reduce((s, m) => s + m.latencyMs, 0);
  const totalEnergyJoules = filtered.reduce((s, m) => s + (m.energyJoules ?? 0), 0);
  const totalCostUsd = filtered.reduce((s, m) => s + (m.costUsd ?? 0), 0);

  // Operation breakdown
  const opMap = new Map<string, { count: number; totalLatency: number; totalEnergy: number; totalCost: number }>();
  for (const m of filtered) {
    const entry = opMap.get(m.operation) ?? { count: 0, totalLatency: 0, totalEnergy: 0, totalCost: 0 };
    entry.count++;
    entry.totalLatency += m.latencyMs;
    entry.totalEnergy += m.energyJoules ?? 0;
    entry.totalCost += m.costUsd ?? 0;
    opMap.set(m.operation, entry);
  }
  const operationBreakdown = Array.from(opMap.entries())
    .map(([operation, d]) => ({
      operation,
      count: d.count,
      avgLatency: Math.round(d.totalLatency / d.count),
      totalEnergy: Math.round(d.totalEnergy * 1000) / 1000,
      totalCost: Math.round(d.totalCost * 1_000_000) / 1_000_000,
    }))
    .sort((a, b) => b.totalCost - a.totalCost);

  // Module breakdown
  const modMap = new Map<string, { count: number; totalLatency: number; totalCost: number }>();
  for (const m of filtered) {
    const entry = modMap.get(m.module) ?? { count: 0, totalLatency: 0, totalCost: 0 };
    entry.count++;
    entry.totalLatency += m.latencyMs;
    entry.totalCost += m.costUsd ?? 0;
    modMap.set(m.module, entry);
  }
  const moduleBreakdown = Array.from(modMap.entries())
    .map(([module, d]) => ({
      module,
      count: d.count,
      avgLatency: Math.round(d.totalLatency / d.count),
      totalCost: Math.round(d.totalCost * 1_000_000) / 1_000_000,
    }))
    .sort((a, b) => b.totalCost - a.totalCost);

  return {
    totalOperations: filtered.length,
    totalLatencyMs: Math.round(totalLatencyMs),
    totalEnergyJoules: Math.round(totalEnergyJoules * 1000) / 1000,
    totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
    averageLatencyMs: Math.round(totalLatencyMs / filtered.length),
    operationBreakdown,
    moduleBreakdown,
    efficiencyScore: computeEfficiencyScore(filtered, totalEnergyJoules, totalCostUsd),
    period: {
      from: Math.min(...filtered.map(m => m.timestamp)),
      to: Math.max(...filtered.map(m => m.timestamp)),
    },
  };
}

/**
 * Get the overall efficiency score (0-100).
 */
export function getEfficiencyScore(): number {
  ensureLoaded();
  if (metrics.length === 0) return 100;

  const totalEnergy = metrics.reduce((s, m) => s + (m.energyJoules ?? 0), 0);
  const totalCost = metrics.reduce((s, m) => s + (m.costUsd ?? 0), 0);
  return computeEfficiencyScore(metrics, totalEnergy, totalCost);
}

/**
 * Generate a human-readable daily summary.
 */
export function getDailyReport(): string {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const report = getEnergyReport(todayStart.getTime());

  if (report.totalOperations === 0) {
    return 'No operations tracked today.';
  }

  const kWh = (report.totalEnergyJoules / 3600).toFixed(3);
  const cost = report.totalCostUsd.toFixed(2);

  // Find most expensive module
  const mostExpensive = report.moduleBreakdown[0];
  const mostExpensiveStr = mostExpensive
    ? `Most expensive: ${mostExpensive.module} ($${mostExpensive.totalCost.toFixed(2)})`
    : '';

  // Find most efficient operation (lowest energy per op)
  const mostEfficient = [...report.operationBreakdown]
    .filter(o => o.count > 0 && o.totalEnergy > 0)
    .sort((a, b) => (a.totalEnergy / a.count) - (b.totalEnergy / b.count))[0];
  const mostEfficientStr = mostEfficient
    ? `Most efficient: ${mostEfficient.operation} (${(mostEfficient.totalEnergy / mostEfficient.count / 3600).toFixed(4)} kWh/op)`
    : '';

  const parts = [
    `Today: ${report.totalOperations} operations, ~${kWh} kWh, $${cost} API cost.`,
    mostExpensiveStr,
    mostEfficientStr,
    `Efficiency score: ${report.efficiencyScore}/100.`,
  ].filter(Boolean);

  return parts.join(' ');
}

/**
 * Persist metrics to disk.
 */
export function flushEnergyData(): void {
  ensureLoaded();
  try {
    const dir = path.dirname(METRICS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(METRICS_PATH, JSON.stringify(metrics, null, 2));
  } catch (err) {
    log.error('Failed to flush data', err);
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

function computeEfficiencyScore(
  entries: EnergyMetric[],
  totalEnergyJoules: number,
  totalCostUsd: number
): number {
  if (entries.length === 0) return 100;

  // Factor 1: Operations per joule (higher is better)
  // Baseline: 1 op per joule = decent
  const opsPerJoule = totalEnergyJoules > 0 ? entries.length / totalEnergyJoules : entries.length;
  const energyScore = Math.min(100, opsPerJoule * 50); // 2 ops/J = 100

  // Factor 2: Cost per operation (lower is better)
  // Baseline: $0.01 per op = decent
  const costPerOp = entries.length > 0 ? totalCostUsd / entries.length : 0;
  const costScore = Math.max(0, 100 - (costPerOp * 5000)); // $0.02/op = 0

  // Factor 3: Average latency (lower is better)
  // Baseline: 1000ms = decent
  const avgLatency = entries.reduce((s, m) => s + m.latencyMs, 0) / entries.length;
  const latencyScore = Math.max(0, Math.min(100, 100 - (avgLatency / 50))); // 5000ms = 0

  // Factor 4: Local vs remote ratio (more local = better efficiency)
  const localOps = entries.filter(m =>
    m.provider === 'ollama' || !m.provider || m.operation === 'file_read' || m.operation === 'file_write' || m.operation === 'shell_exec'
  ).length;
  const localRatio = localOps / entries.length;
  const localScore = localRatio * 100;

  // Weighted average
  const score = (energyScore * 0.3) + (costScore * 0.3) + (latencyScore * 0.2) + (localScore * 0.2);
  return Math.round(Math.max(0, Math.min(100, score)));
}
