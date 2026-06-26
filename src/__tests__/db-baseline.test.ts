import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { baselineDir, loadBaseline, saveBaseline } from '../lib/db-baseline.js';
import { buildManifest } from '../lib/db-delta.js';

const dirs: string[] = [];
function tmpBase(): string {
  const d = mkdtempSync(join(tmpdir(), 'iwp-baseline-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const DDL = `CREATE TABLE \`wp_options\` (
  \`option_id\` bigint(20) NOT NULL AUTO_INCREMENT,
  \`option_name\` varchar(191) NOT NULL,
  PRIMARY KEY (\`option_id\`)
) ENGINE=InnoDB;`;

describe('db-baseline manifest store', () => {
  it('round-trips a manifest per site', async () => {
    const base = tmpBase();
    expect(loadBaseline(42, base)).toBeNull();
    const m = await buildManifest([DDL, "INSERT INTO `wp_options` VALUES (1,'siteurl','http://x');"].join('\n').split('\n'));
    saveBaseline(42, m, base);
    const got = loadBaseline(42, base);
    expect(got?.fingerprint).toBe(m.fingerprint);
    expect(got?.single.get('wp_options')?.rows.get('1')).toBe(m.single.get('wp_options')?.rows.get('1'));
  });

  it('scopes baselines per site id', async () => {
    const base = tmpBase();
    const m = await buildManifest([DDL, "INSERT INTO `wp_options` VALUES (1,'a','b');"].join('\n').split('\n'));
    saveBaseline(1, m, base);
    expect(loadBaseline(1, base)?.fingerprint).toBe(m.fingerprint);
    expect(loadBaseline(2, base)).toBeNull();
    expect(baselineDir(1, base)).not.toBe(baselineDir(2, base));
  });
});
