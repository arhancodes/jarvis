import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { resolveContactNumber } from '../src/utils/contacts.js';
import { configPath } from '../src/utils/config.js';
import { writeJsonConfig } from '../src/utils/config.js';

// These branches are deterministic and never touch macOS Contacts:
//   - an input that is already a phone number returns immediately
//   - a name present in config/whatsapp-contacts.json resolves from the map
// (the osascript fallback is only reached for names NOT in the map.)

const cfgFile = 'whatsapp-contacts.json';
const cfgExisted = existsSync(configPath(cfgFile));

describe('resolveContactNumber', () => {
  afterAll(() => {
    if (!cfgExisted && existsSync(configPath(cfgFile))) rmSync(configPath(cfgFile));
  });

  it('returns digits for an input that is already a phone number', async () => {
    expect(await resolveContactNumber('+1 (234) 567-8900')).toBe('12345678900');
  });

  it('strips formatting from a plain number', async () => {
    expect(await resolveContactNumber('971 50 123 4567')).toBe('971501234567');
  });

  it('returns null for empty input', async () => {
    expect(await resolveContactNumber('   ')).toBeNull();
  });

  it('resolves a name from the config map (case-insensitive)', async () => {
    writeJsonConfig(cfgFile, { 'Zzdummy Person': '+1 555 0100' });
    expect(await resolveContactNumber('zzdummy person')).toBe('15550100');
  });
});
