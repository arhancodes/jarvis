import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { registry } from '../src/core/registry.js';
import { parse } from '../src/core/parser.js';

// Register every module in production order so parse() sees real routing.
import '../tools/_register-modules.js';

interface Entry {
  input: string;
  expectModule: string | null;
  expectAny?: string[];
  expectAction?: string;
  expectArgIncludes?: string;
  note?: string;
}

const corpus: Entry[] = JSON.parse(
  readFileSync(resolve(__dirname, '../tools/routing-corpus.json'), 'utf8'),
);

describe('routing corpus (regression guard for the accuracy audit)', () => {
  for (const e of corpus) {
    it(`routes "${e.input}"`, async () => {
      const r = await parse(e.input);
      const got = r ? r.module : null;
      if (e.expectModule === null) {
        expect(got).toBeNull();
        return;
      }
      const accept = e.expectAny ?? [e.expectModule];
      expect(accept).toContain(got);
      if (e.expectAction) expect(r?.action).toBe(e.expectAction);
      if (e.expectArgIncludes) {
        expect(JSON.stringify(r?.args ?? {}).toLowerCase()).toContain(e.expectArgIncludes.toLowerCase());
      }
    });
  }
});
