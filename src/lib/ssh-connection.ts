import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import type { SshConnection } from '../types.js';
import { toRsyncPath } from './paths.js';
import { sliceAfterMarker } from './remote-command.js';
import { syncViaSftp } from './sftp-sync.js';

const KNOWN_HOSTS = path.join(homedir(), '.instawp', 'known_hosts');

// Paths embedded into the rsync `-e ssh ...` command are parsed by rsync's
// internal shell (msys/cygwin sh on Windows), where backslashes are escapes.
// Use forward slashes throughout. The actual ssh.exe on Windows accepts both.
function toSshPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function ensureKnownHosts(): void {
  const dir = path.dirname(KNOWN_HOSTS);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function sshArgs(conn: SshConnection): string[] {
  ensureKnownHosts();
  return [
    '-i', conn.privateKeyPath,
    '-p', String(conn.port),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
  ];
}

function sshTarget(conn: SshConnection): string {
  return `${conn.username}@${conn.host}`;
}

/** scp args mirroring sshArgs (key, port via uppercase -P, known-hosts). */
function scpArgs(conn: SshConnection): string[] {
  ensureKnownHosts();
  return [
    '-C', // compress in transit — SQL dumps compress ~5–10×; near-free on already-compressed inputs
    '-i', conn.privateKeyPath,
    '-P', String(conn.port),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
  ];
}

/** Upload a single local file to the remote via scp. Returns the exit code. */
export function scpUpload(conn: SshConnection, localPath: string, remotePath: string): number {
  const target = `${conn.username}@${conn.host}:${remotePath}`;
  const result = spawnSync('scp', [...scpArgs(conn), localPath, target], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  if ((result.status ?? 1) !== 0 && result.stderr) {
    console.error(result.stderr);
  }
  return result.status ?? 1;
}

export function spawnInteractiveSsh(conn: SshConnection): number {
  const result = spawnSync('ssh', [...sshArgs(conn), sshTarget(conn)], {
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

/**
 * Resolve the site's real docroot — the absolute `.../public_html` path — from the
 * server. String-building `/home/<user>/web/<domain>/public_html` is unreliable for
 * two independent reasons:
 *   1. **Domain cutover** — the API's domain becomes the new primary domain while the
 *      HestiaCP web dir keeps the ORIGINAL sub_domain (`~/web/<orig>/public_html`).
 *   2. **Chroot/jailed SSH** — on some nodes the SSH account is confined to a chroot
 *      whose docroot is `/web/<site>/public_html`; the `/home/<user>` prefix is valid
 *      out-of-jail but does NOT exist inside the session the CLI actually uses.
 * So we ask the server for the `public_html` that actually holds wp-config.php,
 * checking both `~/web/*` and `/web/*` (jail), with a bounded `find` fallback. Returns
 * the absolute docroot (e.g. `/home/u/web/foo/public_html` or `/web/foo/public_html`),
 * or null on failure so the caller keeps its computed path.
 */
export function resolveRemoteDocRoot(conn: SshConnection): string | null {
  const marker = `__IWP_DOCROOT_${randomBytes(4).toString('hex')}__`;
  // Marker-print (MOTD precedes it), then print the docroot. Check ~/web/* and /web/*
  // (chroot), then fall back to a bounded find so odd layouts still resolve.
  const script =
    `printf '%s\\n' '${marker}'; ` +
    'd=""; for c in "$HOME"/web/*/public_html /web/*/public_html; do ' +
    '[ -f "$c/wp-config.php" ] && d="$c" && break; done; ' +
    '[ -z "$d" ] && d="$(find "$HOME" /web -maxdepth 4 -name wp-config.php 2>/dev/null | head -n1 | xargs -r dirname)"; ' +
    "printf '%s\\n' \"$d\"";
  const res = execViaSsh(conn, script);
  if (res.exitCode !== 0) return null;
  const out = sliceAfterMarker(res.stdout, marker);
  // The docroot is the emitted line starting with `/` (ignore any stray shell noise).
  const p = out.split('\n').map((s) => s.trim()).filter(Boolean).find((s) => s.startsWith('/'));
  return p || null;
}

export function execViaSsh(conn: SshConnection, command: string): { stdout: string; stderr: string; exitCode: number } {
  // Pipe command via stdin with -T (no PTY) — InstaWP servers require this
  // instead of passing command as SSH args
  const result = spawnSync('ssh', ['-T', ...sshArgs(conn), sshTarget(conn)], {
    input: command + '\n',
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? 1,
  };
}

/**
 * Execute a command via SSH while streaming the local process's stdin to the
 * remote command (the way `ssh host cmd` does). Unlike execViaSsh — which
 * delivers the command over stdin and therefore can't also forward piped data —
 * this passes the command as an ssh argument, leaving stdin free to stream.
 *
 * Side effect: the remote runs a non-login shell (`$SHELL -c <cmd>`), so it does
 * NOT print the login banner/MOTD. `capture` controls output handling: when
 * false (text mode) stdout/stderr are inherited for real-time, binary-safe
 * passthrough; when true (JSON mode) they're captured and returned.
 */
export function execViaSshStreamStdin(
  conn: SshConnection,
  command: string,
  capture: boolean,
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('ssh', ['-T', ...sshArgs(conn), sshTarget(conn), command], {
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    encoding: capture ? 'utf-8' : undefined,
    maxBuffer: 500 * 1024 * 1024,
  });
  return {
    stdout: capture ? ((result.stdout as string) || '') : '',
    stderr: capture ? ((result.stderr as string) || '') : '',
    exitCode: result.status ?? 1,
  };
}

/**
 * Execute a command via SSH and stream stdout directly to a file.
 * Useful for large outputs like database dumps.
 */
export function execViaSshToFile(conn: SshConnection, command: string, outputPath: string): { exitCode: number; stderr: string } {
  ensureKnownHosts();
  const fd = openSync(outputPath, 'w');
  try {
    const result = spawnSync('ssh', ['-T', ...sshArgs(conn), sshTarget(conn)], {
      input: command + '\n',
      stdio: ['pipe', fd, 'pipe'],
      encoding: 'utf-8',
      maxBuffer: 500 * 1024 * 1024, // 500MB
    });
    return {
      exitCode: result.status ?? 1,
      stderr: (result.stderr as string) || '',
    };
  } finally {
    closeSync(fd);
  }
}

export function rsyncViaSsh(
  conn: SshConnection,
  source: string,
  dest: string,
  extraArgs: string[],
  dryRun: boolean,
  stream: boolean,
): number {
  ensureKnownHosts();
  const keyPath = toSshPath(conn.privateKeyPath);
  const knownHosts = toSshPath(KNOWN_HOSTS);
  const sshCmd = `ssh -i "${keyPath}" -p ${conn.port} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="${knownHosts}"`;

  const args = [
    '-arz',
    '--itemize-changes',
    '--exclude=.git',
    '--exclude=node_modules',
    '--exclude=.DS_Store',
    ...(dryRun ? ['--dry-run'] : []),
    ...extraArgs,
    '-e', sshCmd,
    toRsyncPath(source),
    toRsyncPath(dest),
  ];

  // rsyncViaSsh only runs on macOS/Linux now (Windows uses syncViaSftp).
  const result = spawnSync('rsync', args, {
    stdio: stream ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    encoding: stream ? undefined : 'utf-8',
  });

  if (!stream && result.stdout) {
    console.log(result.stdout);
  }
  if (!stream && result.stderr && result.status !== 0) {
    console.error(result.stderr);
  }

  return result.status ?? 1;
}

/** Strip a `user@host:` prefix, returning the remote path (or null if not remote). */
function parseRemoteSpec(spec: string, conn: SshConnection): string | null {
  const prefix = `${conn.username}@${conn.host}:`;
  if (spec.startsWith(prefix)) return spec.slice(prefix.length);
  const m = spec.match(/^[^@/\\]+@[^:]+:(.*)$/);
  return m ? m[1] : null;
}

/**
 * Transfer files between local and remote. On macOS/Linux this shells out to
 * rsync (delta sync). On Windows it uses a pure-JS SFTP client instead —
 * the bundled msys rsync.exe cannot drive native Windows OpenSSH (incompatible
 * pipe/signal semantics → "connection unexpectedly closed"), so rsync-over-ssh
 * is unusable there. Same call shape as rsyncViaSsh; one of source/dest is a
 * `user@host:path` spec.
 */
export async function syncFiles(
  conn: SshConnection,
  source: string,
  dest: string,
  extraArgs: string[],
  dryRun: boolean,
  stream: boolean,
): Promise<number> {
  if (process.platform !== 'win32') {
    return rsyncViaSsh(conn, source, dest, extraArgs, dryRun, stream);
  }

  const destRemote = parseRemoteSpec(dest, conn);
  const sourceRemote = parseRemoteSpec(source, conn);
  let direction: 'push' | 'pull';
  let localPath: string;
  let remotePath: string;
  if (destRemote !== null) {
    direction = 'push'; localPath = source; remotePath = destRemote;
  } else if (sourceRemote !== null) {
    direction = 'pull'; localPath = dest; remotePath = sourceRemote;
  } else {
    console.error('syncFiles: could not determine remote endpoint from source/dest');
    return 1;
  }

  // rsyncViaSsh hardcodes these defaults; mirror them for SFTP.
  const excludes = ['.git', 'node_modules', '.DS_Store'];
  const includes: string[] = [];
  for (const a of extraArgs) {
    if (a.startsWith('--exclude=')) excludes.push(a.slice('--exclude='.length));
    else if (a.startsWith('--include=')) includes.push(a.slice('--include='.length));
  }

  return syncViaSftp(conn, {
    direction,
    localPath,
    remotePath,
    excludes,
    includes,
    dryRun,
    onItem: (action, rel) => {
      if (action === 'error') console.error(rel);
      else if (rel) console.log(`  ${action === 'sent' ? '↑' : '↓'} ${rel}`);
    },
  });
}
