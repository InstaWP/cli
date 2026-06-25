import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { baselineDir, loadBaseline, saveBaseline } from '../lib/db-baseline.js';

const dirs: string[] = [];
function tmpBase(): string {
  const d = mkdtempSync(join(tmpdir(), 'iwp-baseline-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('db-baseline store', () => {
  it('round-trips sql + fingerprint per site', () => {
    const base = tmpBase();
    expect(loadBaseline(42, base)).toBeNull();
    saveBaseline(42, 'CREATE TABLE `wp_options` ...', 'fp-abc', '2026-06-25T00:00:00Z', base);
    const got = loadBaseline(42, base);
    expect(got?.sql).toContain('wp_options');
    expect(got?.fingerprint).toBe('fp-abc');
    expect(got?.savedAt).toBe('2026-06-25T00:00:00Z');
  });

  it('scopes baselines per site id', () => {
    const base = tmpBase();
    saveBaseline(1, 'a', 'fp1', 't', base);
    saveBaseline(2, 'b', 'fp2', 't', base);
    expect(loadBaseline(1, base)?.fingerprint).toBe('fp1');
    expect(loadBaseline(2, base)?.fingerprint).toBe('fp2');
    expect(baselineDir(1, base)).not.toBe(baselineDir(2, base));
  });
});
