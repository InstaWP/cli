// Per-site baseline store for `db push --incremental`. The baseline is the last
// successfully-pushed canonical dump (per-row, PK-sorted) plus its schema
// fingerprint; the next incremental push diffs the new dump against it. Stored
// under ~/.instawp/baselines/<siteId>/ (the dump can be large — one per site).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export interface Baseline {
  sql: string;
  fingerprint: string;
  savedAt?: string;
}

/** Root dir for baselines; `base` is injectable for tests (defaults to ~/.instawp). */
export function baselineDir(siteId: number | string, base = join(homedir(), '.instawp')): string {
  return join(base, 'baselines', String(siteId));
}

/** Load the stored baseline for a site, or null if none / unreadable. */
export function loadBaseline(siteId: number | string, base?: string): Baseline | null {
  const dir = baselineDir(siteId, base);
  const sqlPath = join(dir, 'baseline.sql');
  const metaPath = join(dir, 'baseline.json');
  if (!existsSync(sqlPath) || !existsSync(metaPath)) return null;
  try {
    const sql = readFileSync(sqlPath, 'utf-8');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    if (typeof meta?.fingerprint !== 'string') return null;
    return { sql, fingerprint: meta.fingerprint, savedAt: meta.savedAt };
  } catch {
    return null;
  }
}

/** Save (overwrite) the baseline for a site. `savedAt` is passed in (no clock here). */
export function saveBaseline(siteId: number | string, sql: string, fingerprint: string, savedAt: string, base?: string): void {
  const dir = baselineDir(siteId, base);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'baseline.sql'), sql, 'utf-8');
  writeFileSync(join(dir, 'baseline.json'), JSON.stringify({ fingerprint, savedAt }, null, 2), 'utf-8');
}
