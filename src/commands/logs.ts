import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { requireAuth } from '../lib/api.js';
import { resolveSite } from '../lib/site-resolver.js';
import { ensureSshAccess } from '../lib/ssh-keys.js';
import { remoteDocRoot } from '../lib/paths.js';
import { execViaSsh } from '../lib/ssh-connection.js';
import { error, spinner, isJsonMode } from '../lib/output.js';
import type { SshConnection } from '../types.js';

interface LogSpec {
  /** Short label (e.g. 'wp', 'php', 'nginx') */
  kind: 'wp' | 'php' | 'nginx';
  /** Candidate paths to probe, in priority order */
  candidates: string[];
}

interface ResolvedLog {
  kind: LogSpec['kind'];
  path: string;
}

const KNOWN_HOSTS = path.join(homedir(), '.instawp', 'known_hosts');

function ensureKnownHosts(): void {
  const dir = path.dirname(KNOWN_HOSTS);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Build the base ssh argv (mirrors the private helper inside ssh-connection.ts).
 * We replicate it here because the follow-mode path needs raw `spawnSync` with
 * a non-default stdio configuration (`stdio: ['pipe', 'inherit', 'inherit']`).
 */
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

/**
 * Shell-quote a path for safe inclusion in a remote command. The values come
 * from `conn` (API-supplied) so this is defensive — domains can contain hyphens
 * but shouldn't contain single quotes; quote anyway to be safe.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function buildLogSpecs(conn: SshConnection, kinds: Array<LogSpec['kind']>): LogSpec[] {
  const domain = conn.domain;
  // Derive the per-domain paths from the server-resolved docroot so they're correct
  // under a chroot too (`/web/<domain>/…`, not `/home/<user>/web/<domain>/…`).
  const docRoot = remoteDocRoot(conn);                  // .../web/<domain>/public_html
  const webBase = docRoot.replace(/\/public_html\/?$/, ''); // .../web/<domain>
  const specs: LogSpec[] = [];

  for (const kind of kinds) {
    if (kind === 'wp') {
      specs.push({
        kind: 'wp',
        candidates: [`${docRoot}/wp-content/debug.log`],
      });
    } else if (kind === 'nginx') {
      specs.push({
        kind: 'nginx',
        candidates: [
          `${webBase}/logs/${domain}.error.log`,
          `/var/log/nginx/domains/${domain}.error.log`,
        ],
      });
    } else if (kind === 'php') {
      // HestiaCP keeps PHP-FPM errors in the per-domain log; the system-wide
      // php*-fpm.log only exists on some setups.
      specs.push({
        kind: 'php',
        candidates: [
          `${webBase}/logs/${domain}.error.log`,
          '/var/log/php8.3-fpm.log',
          '/var/log/php8.2-fpm.log',
          '/var/log/php8.1-fpm.log',
          '/var/log/php8.0-fpm.log',
          '/var/log/php7.4-fpm.log',
        ],
      });
    }
  }

  return specs;
}

/**
 * Probe candidate paths on the remote host and return the first one that
 * exists for each log spec. We send a single SSH command that prints a marker
 * line per kind so we don't need one round-trip per probe.
 */
function probeLogPaths(conn: SshConnection, specs: LogSpec[]): ResolvedLog[] {
  if (specs.length === 0) return [];

  // Build a script that, for each spec, prints "<kind>\t<first-existing-path>"
  // or "<kind>\t" if none exist.
  const lines: string[] = [];
  for (const spec of specs) {
    const checks = spec.candidates
      .map((p) => `if [ -r ${shellQuote(p)} ]; then echo "${spec.kind}\\t${p}"; found=1; break; fi`)
      .join('; ');
    lines.push(`found=0; for _ in 1; do ${checks}; done; if [ "$found" != "1" ]; then echo "${spec.kind}\\t"; fi`);
  }
  const script = lines.join('\n');

  const result = execViaSsh(conn, script);
  if (result.exitCode !== 0 && !result.stdout) {
    return [];
  }

  const resolved: ResolvedLog[] = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [kind, ...rest] = trimmed.split('\t');
    const remotePath = rest.join('\t').trim();
    if (remotePath && (kind === 'wp' || kind === 'php' || kind === 'nginx')) {
      resolved.push({ kind, path: remotePath });
    }
  }
  return resolved;
}

interface LogsOptions {
  wp?: boolean;
  php?: boolean;
  nginx?: boolean;
  follow?: boolean;
  lines?: string;
}

function parseLines(raw: string | undefined): number {
  const n = parseInt(raw ?? '100', 10);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return n;
}

function selectKinds(opts: LogsOptions): Array<LogSpec['kind']> {
  const kinds: Array<LogSpec['kind']> = [];
  if (opts.wp) kinds.push('wp');
  if (opts.php) kinds.push('php');
  if (opts.nginx) kinds.push('nginx');
  // Default: --wp
  if (kinds.length === 0) kinds.push('wp');
  return kinds;
}

function followLogs(conn: SshConnection, paths: string[], lines: number): number {
  const quoted = paths.map(shellQuote).join(' ');
  // tail -f handles multi-file natively and prints `==> path <==` headers.
  const command = `tail -n ${lines} -f ${quoted}\n`;

  const result = spawnSync('ssh', ['-T', ...sshArgs(conn), sshTarget(conn)], {
    input: command,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  return result.status ?? 1;
}

function tailLogs(conn: SshConnection, paths: string[], lines: number): { logs: { path: string; content: string }[]; exitCode: number } {
  // Per-file tail so we can attribute output back to each path for JSON mode
  // and for clean headers. (tail's own multi-file mode interleaves headers
  // and content, which is harder to split.)
  const logs: { path: string; content: string }[] = [];
  let worstExit = 0;

  for (const remotePath of paths) {
    const cmd = `tail -n ${lines} ${shellQuote(remotePath)}`;
    const res = execViaSsh(conn, cmd);
    if (res.exitCode !== 0 && worstExit === 0) {
      worstExit = res.exitCode;
    }
    logs.push({ path: remotePath, content: res.stdout });
  }

  return { logs, exitCode: worstExit };
}

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <site>')
    .description('Tail logs (WordPress debug, PHP-FPM, nginx) on a remote site')
    .option('--wp', 'Tail WordPress debug.log (default)')
    .option('--php', 'Tail PHP-FPM error log')
    .option('--nginx', 'Tail nginx error log')
    .option('-f, --follow', 'Follow log output (tail -f)')
    .option('-n, --lines <n>', 'Number of lines to show', '100')
    .action(async (siteIdentifier: string, opts: LogsOptions) => {
      requireAuth();

      const spin = spinner('Resolving site...');
      spin.start();

      let site;
      try {
        site = await resolveSite(siteIdentifier);
        spin.stop();
      } catch {
        spin.fail('Site resolution failed');
        process.exit(1);
      }

      const conn = await ensureSshAccess(site.id);

      if (!conn.domain) {
        error('Could not determine site domain — log paths cannot be resolved');
        process.exit(1);
      }

      const kinds = selectKinds(opts);
      const lines = parseLines(opts.lines);

      const probeSpin = spinner('Locating log files...');
      probeSpin.start();
      const specs = buildLogSpecs(conn, kinds);
      const resolved = probeLogPaths(conn, specs);
      probeSpin.stop();

      // Report any kinds we couldn't find a file for, then drop them.
      const found = new Set(resolved.map((r) => r.kind));
      for (const kind of kinds) {
        if (!found.has(kind)) {
          error(`No readable ${kind} log found on remote host`);
        }
      }

      if (resolved.length === 0) {
        process.exit(1);
      }

      const paths = resolved.map((r) => r.path);

      if (opts.follow) {
        // Follow mode never makes sense in JSON mode (streams forever).
        if (isJsonMode()) {
          error('--follow cannot be combined with --json');
          process.exit(1);
        }
        const code = followLogs(conn, paths, lines);
        process.exit(code);
      }

      const { logs, exitCode } = tailLogs(conn, paths, lines);

      if (isJsonMode()) {
        console.log(JSON.stringify({
          success: exitCode === 0,
          data: { logs },
        }));
        process.exit(exitCode);
      }

      // Print each log block with a header (matches GNU `tail` multi-file style)
      const multi = logs.length > 1;
      for (let i = 0; i < logs.length; i++) {
        const log = logs[i];
        if (multi) {
          if (i > 0) process.stdout.write('\n');
          process.stdout.write(`==> ${log.path} <==\n`);
        }
        process.stdout.write(log.content);
        if (log.content && !log.content.endsWith('\n')) {
          process.stdout.write('\n');
        }
      }

      process.exit(exitCode);
    });
}
