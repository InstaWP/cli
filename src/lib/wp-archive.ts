import archiver from 'archiver';
import { createWriteStream, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { FILE_EXCLUDES, parseDbHost } from './wp-local.js';
import type { WpConfig } from './wp-local.js';

/**
 * Side-effecting archive helpers for `migrate push`: zip the WP root and dump the
 * DB. These shell out to `wp`/`mysqldump` and stream large outputs to disk (never
 * into memory), the same way the rest of the CLI handles big dumps.
 */

export interface ZipResult {
  path: string;
  bytes: number;
  entries: number;
}

/**
 * The glob ignore patterns handed to archiver: each excluded directory both as a
 * bare entry and everything beneath it. Exposed (and unit-tested) separately so
 * the exclusion wiring can't silently drift from FILE_EXCLUDES.
 */
export function excludeGlobs(): string[] {
  return FILE_EXCLUDES.flatMap((ex) => [ex, `${ex}/**`]);
}

/**
 * Stream a zip of the WordPress root to `outPath`, applying the plugin's exact
 * exclusions. Files are added at the archive root (relative to wpRoot), so the
 * resulting zip matches what the plugin's ZipArchive produces and the server-side
 * restore engine expects. `onEntry` fires per-file for progress.
 */
export function createFilesZip(opts: {
  wpRoot: string;
  outPath: string;
  onEntry?: (count: number) => void;
}): Promise<ZipResult> {
  const { wpRoot, outPath, onEntry } = opts;
  return new Promise<ZipResult>((resolve, reject) => {
    const output = createWriteStream(outPath);
    // Level 6: solid ratio without the CPU cost of 9 on multi-GB sites.
    const archive = archiver('zip', { zlib: { level: 6 } });
    let entries = 0;

    output.on('close', () => resolve({ path: outPath, bytes: archive.pointer(), entries }));
    output.on('error', reject);
    archive.on('error', reject);
    // ENOENT warnings happen for files deleted mid-walk — non-fatal, skip them.
    archive.on('warning', (err: any) => {
      if (err?.code !== 'ENOENT') reject(err);
    });
    archive.on('entry', () => {
      entries++;
      onEntry?.(entries);
    });

    archive.pipe(output);
    archive.glob('**/*', { cwd: wpRoot, dot: true, ignore: excludeGlobs() });
    archive.finalize().catch(reject);
  });
}

/** True if a `wp` binary is on PATH at all. */
export function hasWpCli(): boolean {
  const r = spawnSync('wp', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

/**
 * True if wp-cli can operate on THIS install (binary present AND it can reach the
 * DB / sees an installed site). This is the gate for using `wp db export` and
 * `wp option get` instead of the raw-creds fallback.
 */
export function wpCliWorksOn(wpRoot: string): boolean {
  if (!hasWpCli()) return false;
  const r = spawnSync('wp', [`--path=${wpRoot}`, 'core', 'is-installed', '--quiet'], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

export interface DbExportResult {
  path: string;
  method: 'wp' | 'mysqldump';
}

/**
 * Export the site DB to `outPath` as a raw .sql dump. Prefers `wp db export`
 * (matches the plugin exactly); falls back to `mysqldump` driven by the creds
 * parsed from wp-config.php. The password is passed via `MYSQL_PWD` so it never
 * lands in argv / `ps` output. Throws with actionable guidance on failure.
 */
export function exportDatabase(opts: {
  wpRoot: string;
  wpConfig: WpConfig;
  outPath: string;
  useWpCli: boolean;
}): DbExportResult {
  const { wpRoot, wpConfig, outPath, useWpCli } = opts;

  if (useWpCli) {
    const r = spawnSync(
      'wp',
      [`--path=${wpRoot}`, 'db', 'export', outPath, '--single-transaction', '--default-character-set=utf8mb4'],
      { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (r.status === 0) return { path: outPath, method: 'wp' };
    // Fall through to mysqldump on wp failure (e.g. PHP memory limits on huge DBs).
  }

  const { host, port, socket } = parseDbHost(wpConfig.dbHost);
  const args = [
    '--single-transaction',
    '--no-tablespaces',
    '--default-character-set=utf8mb4',
    '-h', host,
    '-u', wpConfig.dbUser,
  ];
  if (port) args.push('-P', String(port));
  if (socket) args.push('-S', socket);
  args.push(wpConfig.dbName);

  const fd = openSync(outPath, 'w');
  try {
    const r = spawnSync('mysqldump', args, {
      stdio: ['ignore', fd, 'pipe'],
      encoding: 'utf-8',
      env: { ...process.env, MYSQL_PWD: wpConfig.dbPassword },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error && (r.error as any).code === 'ENOENT') {
      throw new Error(
        'Neither a working `wp` CLI nor `mysqldump` was found. Install one, or run inside a shell where `wp` works on this site.',
      );
    }
    if (r.status !== 0) {
      throw new Error('mysqldump failed: ' + (r.stderr?.trim() || `exit ${r.status}`));
    }
  } finally {
    closeSync(fd);
  }
  return { path: outPath, method: 'mysqldump' };
}

/**
 * Best-effort discovery of the local site's home URL (used as restore-raw's
 * `source_domain`). Order: wp-cli `option get home`/`siteurl`, then the WP_HOME/
 * WP_SITEURL constants from wp-config.php, then a direct DB query via the `mysql`
 * client. Returns null if none work — the caller then requires `--source-url`.
 */
export function detectSourceUrl(opts: {
  wpRoot: string;
  wpConfig: WpConfig;
  useWpCli: boolean;
}): string | null {
  const { wpRoot, wpConfig, useWpCli } = opts;

  if (useWpCli) {
    for (const key of ['home', 'siteurl']) {
      const r = spawnSync('wp', [`--path=${wpRoot}`, 'option', 'get', key], { encoding: 'utf-8' });
      const val = (r.stdout || '').trim();
      if (r.status === 0 && val) return val;
    }
  }

  if (wpConfig.wpHome) return wpConfig.wpHome;
  if (wpConfig.wpSiteUrl) return wpConfig.wpSiteUrl;

  // Last resort: ask MySQL directly for the `home` option.
  const dbUrl = queryHomeFromDb(wpConfig);
  if (dbUrl) return dbUrl;

  return null;
}

/** Query `{prefix}options.home` via the `mysql` client. Returns null on any failure. */
function queryHomeFromDb(wpConfig: WpConfig): string | null {
  const { host, port, socket } = parseDbHost(wpConfig.dbHost);
  const sql = `SELECT option_value FROM \`${wpConfig.tablePrefix}options\` WHERE option_name='home' LIMIT 1`;
  const args = ['-h', host, '-u', wpConfig.dbUser, '-N', '-B', '-e', sql];
  if (port) args.push('-P', String(port));
  if (socket) args.push('-S', socket);
  args.push(wpConfig.dbName);

  const r = spawnSync('mysql', args, {
    encoding: 'utf-8',
    env: { ...process.env, MYSQL_PWD: wpConfig.dbPassword },
  });
  if (r.status !== 0) return null;
  const val = (r.stdout || '').trim().split('\n')[0]?.trim();
  return val || null;
}
