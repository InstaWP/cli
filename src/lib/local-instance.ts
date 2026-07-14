import type { LocalInstance } from '../types.js';

/** Lowercase a name and replace any non `[a-zA-Z0-9_-]` char with `-`. */
export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}

/**
 * Default local-instance name for a cloned cloud site.
 *
 * Prefers the site's name; otherwise the FIRST DNS label of its
 * subdomain/domain — so "client-store-1234.instawp.site" becomes
 * "client-store-1234", NOT "client-store-1234-instawp-site" (the old behavior,
 * which sanitized the whole domain and turned the dots into hyphens). Falls
 * back to "site-<id>".
 */
export function defaultInstanceName(site: { id: number; name?: string; sub_domain?: string }): string {
  const fromName = (site.name || '').trim();
  const fromLabel = (site.sub_domain || '').split('.')[0];
  return sanitizeName(fromName || fromLabel || `site-${site.id}`);
}

/**
 * Extract a table prefix from `wp config get table_prefix` stdout, ignoring an
 * SSH login banner/MOTD that InstaWP servers prepend to non-interactive command
 * output. Returns the LAST identifier-only line (the command's real output comes
 * after any banner), or `fallback` if none looks valid.
 */
export function parseTablePrefix(stdout: string, fallback = 'wp_'): string {
  const lines = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^[A-Za-z0-9_]+$/.test(lines[i])) return lines[i];
  }
  return fallback;
}

/**
 * Parse `SHOW TABLES` stdout into a set of table names, dropping MOTD/banner and
 * any non-identifier lines (MySQL table names are `[A-Za-z0-9_$]+`). Junk lines
 * with spaces/punctuation are excluded; a stray one-word banner line would at
 * worst add an unused entry (never causes a real table to be skipped, since the
 * intersection is keyed on local → cloud names).
 */
export function parseSqlTableNames(stdout: string): Set<string> {
  return new Set(
    stdout.split('\n').map((s) => s.trim()).filter((t) => /^[A-Za-z0-9_$]+$/.test(t)),
  );
}

/**
 * Which cloud site a `local push` should target, in priority order:
 *   1. an explicit cloud-site argument
 *   2. the cloud site this instance was cloned from (`cloudSiteId`)
 *   3. none — the caller provisions a new site
 *
 * This is why a `local clone` records `cloudSiteId`: so a later `local push`
 * with no argument pushes back to the ORIGIN site instead of creating a new
 * one named after the local instance.
 */
export function pushTargetRef(
  cloudSiteArg: string | undefined,
  instance: Pick<LocalInstance, 'cloudSiteId'>,
): string | undefined {
  if (cloudSiteArg && cloudSiteArg.trim()) return cloudSiteArg.trim();
  if (instance.cloudSiteId) return String(instance.cloudSiteId);
  return undefined;
}

/**
 * Does this push carry the database as well as the files?
 *
 * Pushing into an EXISTING site stays opt-in (`--with-db`) — it overwrites live
 * data. But when the push is what CREATES the site, the database is the whole
 * point: files-only would leave the user on a brand-new site with none of their
 * pages, posts or settings. So a site-creating push takes the DB by default.
 * `--no-db` always wins, so the files-only behaviour stays reachable.
 */
export function shouldPushDb(
  opts: { withDb?: boolean; db?: boolean },
  isNewSite: boolean,
): boolean {
  if (opts.db === false) return false;
  return !!opts.withDb || isNewSite;
}
