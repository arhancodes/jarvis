/**
 * Energy Monitor Module
 * Displays energy consumption, API costs, and efficiency reports for JARVIS.
 */

import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import {
  getEnergyReport,
  getDailyReport,
  getEfficiencyScore,
  estimateEnergy,
} from '../intelligence/energy-tracker.js';

export class EnergyMonitorModule implements JarvisModule {
  name = 'energy-monitor' as const;
  description = 'Track and report energy consumption, API costs, and efficiency metrics';

  patterns: PatternDefinition[] = [
    {
      intent: 'report',
      patterns: [
        /^(?:show |get |give me )?(?:an? )?energy\s*report$/i,
        /^(?:show |get )?power\s*(?:usage|report)$/i,
        /^how much energy/i,
        /^(?:daily )?(?:energy |power )?(?:consumption|usage)$/i,
        /^(?:show |get )?(?:full )?(?:energy |efficiency )?report$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'cost',
      patterns: [
        /^(?:show |get )?(?:api |llm )?cost(?:\s*report)?$/i,
        /^(?:how much (?:did|does|has) )?(?:it |jarvis )?cost/i,
        /^api\s*(?:cost|spend|spending|usage)$/i,
        /^(?:show |get )?cost\s*(?:summary|breakdown)$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'efficiency',
      patterns: [
        /^(?:show |get |what(?:'?s| is) (?:the |my )?)?efficiency\s*(?:score)?$/i,
        /^(?:how )?efficient/i,
        /^(?:show |get )?efficiency\s*(?:rating|grade|metrics)$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'report':
        return this.showReport();
      case 'cost':
        return this.showCostSummary();
      case 'efficiency':
        return this.showEfficiency();
      default:
        return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private async showReport(): Promise<CommandResult> {
    const daily = getDailyReport();
    const report = getEnergyReport(todayStart());
    const currentWatts = estimateEnergy();

    const lines: string[] = [
      '=== JARVIS Energy Report ===',
      '',
      daily,
      '',
    ];

    if (currentWatts != null) {
      lines.push(`Current system draw: ~${currentWatts.toFixed(1)}W`);
      lines.push('');
    }

    if (report.totalOperations > 0) {
      lines.push('--- Operation Breakdown ---');
      for (const op of report.operationBreakdown) {
        lines.push(
          `  ${op.operation}: ${op.count} ops, avg ${op.avgLatency}ms, ` +
          `~${(op.totalEnergy / 3600).toFixed(4)} kWh, $${op.totalCost.toFixed(4)}`
        );
      }

      lines.push('');
      lines.push('--- Module Breakdown ---');
      for (const mod of report.moduleBreakdown) {
        lines.push(
          `  ${mod.module}: ${mod.count} ops, avg ${mod.avgLatency}ms, $${mod.totalCost.toFixed(4)}`
        );
      }

      lines.push('');
      lines.push(`Efficiency Score: ${report.efficiencyScore}/100`);
    }

    return {
      success: true,
      message: lines.join('\n'),
      voiceMessage: daily,
    };
  }

  private async showCostSummary(): Promise<CommandResult> {
    const report = getEnergyReport(todayStart());

    if (report.totalOperations === 0) {
      return { success: true, message: 'No operations tracked today. API cost: $0.00' };
    }

    const lines: string[] = [
      '=== API Cost Summary ===',
      '',
      `Total cost today: $${report.totalCostUsd.toFixed(4)}`,
      `Total operations: ${report.totalOperations}`,
      `Avg cost/operation: $${(report.totalCostUsd / report.totalOperations).toFixed(6)}`,
      '',
      '--- By Module ---',
    ];

    for (const mod of report.moduleBreakdown.filter(m => m.totalCost > 0)) {
      lines.push(`  ${mod.module}: $${mod.totalCost.toFixed(4)} (${mod.count} ops)`);
    }

    const freeOps = report.moduleBreakdown.filter(m => m.totalCost === 0);
    if (freeOps.length > 0) {
      lines.push('');
      lines.push('--- Free (local) ---');
      for (const mod of freeOps) {
        lines.push(`  ${mod.module}: ${mod.count} ops`);
      }
    }

    const voiceMsg = `Today's API cost is $${report.totalCostUsd.toFixed(2)} across ${report.totalOperations} operations.`;
    return { success: true, message: lines.join('\n'), voiceMessage: voiceMsg };
  }

  private async showEfficiency(): Promise<CommandResult> {
    const score = getEfficiencyScore();
    const currentWatts = estimateEnergy();

    let grade: string;
    if (score >= 90) grade = 'Excellent';
    else if (score >= 70) grade = 'Good';
    else if (score >= 50) grade = 'Moderate';
    else if (score >= 30) grade = 'Poor';
    else grade = 'Critical';

    const lines = [
      `Efficiency Score: ${score}/100 (${grade})`,
    ];

    if (currentWatts != null) {
      lines.push(`Current system power draw: ~${currentWatts.toFixed(1)}W`);
    }

    const report = getEnergyReport(todayStart());
    if (report.totalOperations > 0) {
      const kWh = (report.totalEnergyJoules / 3600).toFixed(4);
      lines.push(`Energy used today: ~${kWh} kWh over ${report.totalOperations} operations`);
      lines.push(`Average latency: ${report.averageLatencyMs}ms`);
    }

    return {
      success: true,
      message: lines.join('\n'),
      voiceMessage: `Efficiency score is ${score} out of 100. Rating: ${grade}.`,
    };
  }

  getHelp(): string {
    return [
      'Energy Monitor - Track JARVIS energy and cost efficiency',
      '',
      'Commands:',
      '  energy report     — Full energy and cost report',
      '  api cost          — API cost summary',
      '  efficiency score  — Efficiency rating (0-100)',
      '  power usage       — Current power consumption',
    ].join('\n');
  }
}

function todayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
