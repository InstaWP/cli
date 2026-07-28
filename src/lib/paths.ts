import { fileURLToPath } from 'node:url';
import { dirname, resolve, posix as posixPath } from 'node:path';

interface RemoteConn { username: string; domain: string; docRoot?: string }

/**
 * The remote docroot (`.../public_html`). Prefers the server-resolved absolute path
 * (`conn.docRoot`, which handles domain cutover AND chroot/jailed accounts), falling
 * back to the legacy string-built `/home/<user>/web/<domain>/public_html` only if the
 * server lookup was unavailable.
 */
export function remoteDocRoot(conn: RemoteConn): string {
  return conn.docRoot || `/home/${conn.username}/web/${conn.domain}/public_html`;
}

/**
 * The remote account home, derived from the docroot (three levels up):
 * `/home/<user>` for a normal layout, `/` inside a chroot. Used for files the CLI
 * drops in the home dir (e.g. db-push backups).
 */
export function remoteHomeDir(conn: RemoteConn): string {
  const dr = remoteDocRoot(conn);
  return posixPath.dirname(posixPath.dirname(posixPath.dirname(dr)));
}

/**
 * Convert a local filesystem path to a form rsync understands.
 *
 * rsync uses `host:path` syntax to mean "remote path", so a Windows path like
 * `C:\Users\vikas\file` is interpreted as host `C` + path `\Users\vikas\file`,
 * which fails. The fix is msys-style: `/c/Users/vikas/file`. This matches what
 * rsync from Git for Windows expects and is accepted by cwRsync as well.
 *
 * Non-Windows: pass-through.
 * Remote paths (containing `user@host:`): pass-through.
 */
export function toRsyncPath(p: string): string {
  if (process.platform !== 'win32') return p;
  // Already a remote spec like user@host:path
  if (/^[^/\\:]+@[^:]+:/.test(p)) return p;
  // Drive letter form: C:\foo\bar or C:/foo/bar  →  /c/foo/bar
  const m = p.match(/^([A-Za-z]):[\\/](.*)$/);
  if (m) {
    return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  }
  // UNC or other — just normalize separators
  return p.replace(/\\/g, '/');
}

/**
 * Resolve the remote sync target for a site. Defaults to the site's
 * `wp-content/`, but `--webroot` targets `public_html/` and `--remote-path <p>`
 * targets an explicit path (absolute, or relative to `public_html/`). Always
 * returns a trailing slash so rsync/SFTP treat it as a directory.
 */
export function buildRemotePath(
  conn: RemoteConn,
  opts: { remotePath?: string; webroot?: boolean } = {},
): string {
  const webrootBase = remoteDocRoot(conn);
  let p: string;
  if (opts.remotePath) {
    p = opts.remotePath.startsWith('/')
      ? opts.remotePath
      : `${webrootBase}/${opts.remotePath.replace(/^\.?\//, '')}`;
  } else if (opts.webroot) {
    p = webrootBase;
  } else {
    p = `${webrootBase}/wp-content`;
  }
  return p.endsWith('/') ? p : p + '/';
}

/**
 * Build the rsync filter args (`--include`/`--exclude`) plus `--delete` for a
 * sync, in the ORDER rsync requires. rsync is **first-match-wins**, so user
 * `--include` patterns MUST precede user `--exclude` patterns — otherwise the
 * classic include-only idiom (include the dir glob + `*.html`, then a catch-all
 * `--exclude *`) lets the catch-all match (and stop recursing into) everything
 * before any include is considered, silently transferring nothing (#18).
 * `--delete` is an action flag, not a filter rule — keep it last.
 */
export function buildSyncFilterArgs(
  opts: { include?: string[]; exclude?: string[]; delete?: boolean } = {},
): string[] {
  const args: string[] = [];
  for (const pattern of opts.include ?? []) args.push(`--include=${pattern}`);
  for (const pattern of opts.exclude ?? []) args.push(`--exclude=${pattern}`);
  if (opts.delete) args.push('--delete');
  return args;
}

/**
 * Resolve a path inside the CLI's installed directory (e.g. bundled scripts).
 *
 * `new URL(import.meta.url).pathname` returns `/C:/...` on Windows which is
 * invalid. `fileURLToPath` returns a real OS path.
 *
 * @param importMetaUrl - pass `import.meta.url` from the calling module
 * @param relative - segments relative to the calling module's directory
 */
export function resolveFromModule(importMetaUrl: string, ...relative: string[]): string {
  const here = dirname(fileURLToPath(importMetaUrl));
  return resolve(here, ...relative);
}
