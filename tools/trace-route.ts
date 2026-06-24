/**
 * Routing trace harness — registers every module in the SAME order as
 * src/index.ts, then runs parse() on a list of inputs and prints the routing
 * decision as JSON. NO side effects are executed (we never call execute()).
 *
 * Usage:
 *   tsx tools/trace-route.ts "what's the weather" "ps" "10 miles to km"
 *   echo '["cmd one","cmd two"]' | tsx tools/trace-route.ts --stdin
 */
import './_register-modules.js';
import { parse } from '../src/core/parser.js';

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
