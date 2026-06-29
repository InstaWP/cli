import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Detection + parsing helpers for an on-disk WordPress install. The CLI runs
 * OUTSIDE WordPress, so `migrate push` has to locate the WP root, read DB creds,
 * and figure out the site URL the same way the plugin does — but from the
 * filesystem instead of a live WP runtime. Everything here is pure (no network,
 * no spawning) so it's straightforward to unit-test.
 */

export interface WpConfig {
  dbName: string;
  dbUser: string;
  dbPassword: string;
  /** Raw DB_HOST as written in wp-config.php (may be `host`, `host:port`, or `:/socket`). */
  dbHost: string;
  tablePrefix: string;
  /** WP_HOME constant, if defined in wp-config.php. */
  wpHome?: string;
  /** WP_SITEURL constant, if defined in wp-config.php. */
  wpSiteUrl?: string;
}

/** A parsed DB_HOST split into the parts mysql/mysqldump need. */
export interface DbHostParts {
  host: string;
  port?: number;
  socket?: string;
}

/**
 * Directories (relative to the WP root) excluded from the files archive. Mirrors
 * the plugin's `cli_archive_wordpress_files` skip list EXACTLY — drift here would
 * mean the CLI ships a different payload than `wp instawp local push`.
 */
export const FILE_EXCLUDES: readonly string[] = [
  'wp-content/instawpbackups',
  'wp-content/upgrade',
  'wp-content/plugins/instawp-connect',
  'wp-content/plugins/instawp-helper',
  'wp-content/plugins/iwp-migration',
];

/**
 * Walk up from `startDir` looking for a WordPress root — the directory that
 * contains `wp-includes/version.php` (the definitive ABSPATH marker; wp-config.php
 * alone is ambiguous because it can live one level above ABSPATH). Returns the
 * absolute WP root, or null if none found before the filesystem root.
 */
export function findWpRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  // Bound the walk by the number of path segments so we always terminate.
  for (let i = 0; i < 64; i++) {
    if (existsSync(path.join(dir, 'wp-includes', 'version.php'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Locate wp-config.php for a given WP root. WordPress reads it from ABSPATH or,
 * failing that, exactly one directory above (as long as that parent doesn't
 * itself look like another WP install). Returns null if not found.
 */
export function findWpConfig(wpRoot: string): string | null {
  const inRoot = path.join(wpRoot, 'wp-config.php');
  if (existsSync(inRoot)) return inRoot;
  const parent = path.dirname(wpRoot);
  const oneUp = path.join(parent, 'wp-config.php');
  if (parent !== wpRoot && existsSync(oneUp) && !existsSync(path.join(parent, 'wp-settings.php'))) {
    return oneUp;
  }
  return null;
}

/** Pull a `define('NAME', 'value')` string value out of wp-config.php source. */
function parseDefine(source: string, name: string): string | undefined {
  // Tolerant of spacing and single/double quotes: define ( 'DB_NAME' , "value" )
  const re = new RegExp(
    `define\\s*\\(\\s*(['"])${name}\\1\\s*,\\s*(['"])([\\s\\S]*?)\\2\\s*\\)`,
  );
  const m = source.match(re);
  return m ? m[3] : undefined;
}

/**
 * Parse the DB credentials, table prefix, and any hard-coded site URL constants
 * out of wp-config.php. Throws if the required DB defines are missing (a malformed
 * or non-WordPress config), since the mysqldump fallback can't proceed without them.
 */
export function parseWpConfig(source: string): WpConfig {
  const dbName = parseDefine(source, 'DB_NAME');
  const dbUser = parseDefine(source, 'DB_USER');
  const dbPassword = parseDefine(source, 'DB_PASSWORD');
  const dbHost = parseDefine(source, 'DB_HOST');

  if (dbName === undefined || dbUser === undefined || dbHost === undefined) {
    throw new Error('wp-config.php is missing DB_NAME / DB_USER / DB_HOST defines');
  }

  // $table_prefix = 'wp_';  (the var name is fixed by WordPress)
  const prefixMatch = source.match(/\$table_prefix\s*=\s*(['"])([\s\S]*?)\1/);
  const tablePrefix = prefixMatch ? prefixMatch[2] : 'wp_';

  return {
    dbName,
    dbUser,
    dbPassword: dbPassword ?? '',
    dbHost,
    tablePrefix,
    wpHome: parseDefine(source, 'WP_HOME'),
    wpSiteUrl: parseDefine(source, 'WP_SITEURL'),
  };
}

/**
 * Split a WordPress DB_HOST into host + optional port/socket. WordPress accepts
 * `localhost`, `127.0.0.1:3307`, and `localhost:/tmp/mysql.sock` forms.
 */
export function parseDbHost(dbHost: string): DbHostParts {
  const idx = dbHost.indexOf(':');
  if (idx === -1) return { host: dbHost };
  const host = dbHost.slice(0, idx);
  const rest = dbHost.slice(idx + 1);
  if (/^\d+$/.test(rest)) return { host, port: parseInt(rest, 10) };
  // Anything non-numeric after the colon is a unix socket path.
  return { host: host || 'localhost', socket: rest };
}

/** Read the WordPress version from wp-includes/version.php (`$wp_version = '6.x';`). */
export function detectWpVersion(wpRoot: string): string | null {
  const versionFile = path.join(wpRoot, 'wp-includes', 'version.php');
  try {
    const src = readFileSync(versionFile, 'utf-8');
    const m = src.match(/\$wp_version\s*=\s*(['"])([\s\S]*?)\1/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a site URL into the `source_domain` the restore-raw endpoint expects:
 * no scheme, no leading `www.`, no trailing slash. The server validates against
 * `^(?!http://)(?!https://)(?!www\.).+$`, so all three must be stripped or the
 * call 422s. Subdirectory installs keep their path (e.g. `example.com/blog`).
 */
export function normalizeSourceDomain(url: string): string {
  return url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // strip scheme://
    .replace(/^www\./i, '')                  // strip leading www.
    .replace(/\/+$/, '');                    // strip trailing slash(es)
}

/**
 * True if a WP-root-relative path is inside one of the excluded directories.
 * Comparison is done on forward-slashed, lowercased segments so it matches on
 * both the dir itself and anything beneath it (and is case-insensitive on macOS/
 * Windows filesystems).
 */
export function matchesExclude(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  return FILE_EXCLUDES.some(
    (ex) => norm === ex || norm.startsWith(ex + '/'),
  );
}
