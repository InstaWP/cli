// Per-site baseline store for `db push --incremental`. The baseline is a compact
// per-row hash MANIFEST (not the full dump) so a large DB doesn't blow up memory.
// Stored under ~/.instawp/baselines/<siteId>/manifest.json.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { serializeManifest, deserializeManifest, type Manifest } from './db-delta.js';

/** Root dir for baselines; `base` is injectable for tests (defaults to ~/.instawp). */
export function baselineDir(siteId: number | string, base = join(homedir(), '.instawp')): string {
  return join(base, 'baselines', String(siteId));
}

/** Load the stored manifest for a site, or null if none / unreadable. */
export function loadBaseline(siteId: number | string, base?: string): Manifest | null {
  const p = join(baselineDir(siteId, base), 'manifest.json');
  if (!existsSync(p)) return null;
  try {
    return deserializeManifest(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/** Save (overwrite) the manifest for a site. */
export function saveBaseline(siteId: number | string, manifest: Manifest, base?: string): void {
  const dir = baselineDir(siteId, base);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), serializeManifest(manifest), 'utf-8');
}
