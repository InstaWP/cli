// Helpers for building/cleaning the command sent to a remote shell over SSH.

/**
 * POSIX shell single-quote escape: shell-safe chars pass through, anything else
 * is wrapped in '...' with embedded ' → '\''. Required because the remote shell
 * receives joined args via stdin and would otherwise interpret parens, quotes,
 * semicolons, etc. (this is what fixed `wp eval '...'`).
 */
export function shellQuote(arg: string): string {
  if (arg === '') return "''";
  if (/^[a-zA-Z0-9_\-./=:@%+,]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function joinForRemote(args: string[]): string {
  return args.map(shellQuote).join(' ');
}

/**
 * Build the remote command string from raw argv.
 * - default: each arg is shell-quoted then joined, so a single arg containing
 *   metacharacters (`;`, `|`, …) is sent as one literal token (safe for
 *   `wp eval '...'`, but means `-- "echo a; echo b"` runs nothing useful).
 * - `shell`: join the args and wrap in `bash -lc '<cmdline>'` so the remote
 *   runs them through a real shell — enabling pipes, `;`, `>`, globs.
 */
export function buildRemoteCommandString(args: string[], shell = false): string {
  if (shell) return 'bash -lc ' + shellQuote(args.join(' '));
  return joinForRemote(args);
}

/**
 * Return the portion of `stdout` after the first line equal to `marker`
 * (dropping the marker line itself). InstaWP servers prepend a login banner/MOTD
 * to non-interactive SSH output; emitting a unique marker before the real
 * command lets us strip everything up to and including it. If the marker isn't
 * present (no banner) the original string is returned unchanged.
 */
export function sliceAfterMarker(stdout: string, marker: string): string {
  const idx = stdout.indexOf(marker);
  if (idx === -1) return stdout;
  let after = stdout.slice(idx + marker.length);
  if (after.startsWith('\r')) after = after.slice(1);
  if (after.startsWith('\n')) after = after.slice(1);
  return after;
}
