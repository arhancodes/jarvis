/**
 * Runs every entry in tools/routing-corpus.json through the real parse() and
 * reports PASS/FAIL. An entry passes when parse() routes to expectModule (or
 * any module in expectAny). expectAction / expectArgIncludes add stricter
 * behavioral checks. expectModule:null means "should fall through to Claude".
 *
 *   npx tsx tools/check-corpus.ts          # summary + failures
 *   npx tsx tools/check-corpus.ts --all    # show every row
 */
import './_register-modules.js';
import { parse } from '../src/core/parser.js';
import { readFileSync } from 'fs';

interface Entry {
  input: string;
  expectModule: string | null;
  expectAny?: string[];
  expectAction?: string;
  expectArgIncludes?: string;
  note?: string;
}

async function main() {
  const corpus: Entry[] = JSON.parse(readFileSync(new URL('./routing-corpus.json', import.meta.url), 'utf8'));
  const showAll = process.argv.includes('--all');
  let pass = 0;
  const fails: string[] = [];
  for (const e of corpus) {
    const r = await parse(e.input);
    const got = r ? r.module : null;
    const accept = e.expectAny ?? (e.expectModule ? [e.expectModule] : []);
    let ok = e.expectModule === null ? got === null : !!got && accept.includes(got);
    if (ok && e.expectAction && r?.action !== e.expectAction) ok = false;
    if (ok && e.expectArgIncludes) {
      const argStr = JSON.stringify(r?.args ?? {}).toLowerCase();
      if (!argStr.includes(e.expectArgIncludes.toLowerCase())) ok = false;
    }
    if (ok) pass++;
    else fails.push(`  FAIL "${e.input}"\n        got=${got}/${r?.action ?? ''} ${JSON.stringify(r?.args ?? {})}\n        want=${e.expectModule ?? 'null'}${e.expectAction ? '/' + e.expectAction : ''}  (${e.note ?? ''})`);
    if (showAll) console.log(`${ok ? 'ok  ' : 'FAIL'} ${e.input.slice(0, 50).padEnd(50)} got=${String(got)}/${r?.action ?? ''}`);
  }
  console.log(`\n${pass}/${corpus.length} routed as expected  (${corpus.length - pass} need fixing)`);
  if (fails.length && !showAll) console.log('\n' + fails.join('\n'));
  process.exit(0);
}
main();
