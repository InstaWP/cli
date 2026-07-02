import { Command } from 'commander';
import { randomBytes } from 'node:crypto';
import { requireAuth, getClient } from '../lib/api.js';
import { resolveSite } from '../lib/site-resolver.js';
import { ensureSshAccess } from '../lib/ssh-keys.js';
import { execViaSsh, execViaSshStreamStdin } from '../lib/ssh-connection.js';
import { SshUnreachableError } from '../lib/ssh-preflight.js';
import { buildRemoteCommandString, sliceAfterMarker } from '../lib/remote-command.js';
import { error, info, spinner, isJsonMode } from '../lib/output.js';

interface ExecOpts {
  api?: boolean;
  timeout?: string;
  shell?: boolean;
  stdin?: boolean;
  sshHost?: string;
  refresh?: boolean;
  fallback?: boolean; // commander --no-fallback sets this false; default true
}

async function execAction(siteIdentifier: string, args: string[], opts: ExecOpts): Promise<void> {
  requireAuth();

  if (opts.stdin && opts.api) {
    error('--stdin is only supported with the SSH transport (not --api)');
    process.exit(1);
  }

  // Drop POSIX `--` end-of-options marker so users can write
  //   instawp wp <site> -- post list --post_type=page
  // and have everything after `--` reach WP-CLI verbatim.
  args = args.filter(a => a !== '--');

  if (args.length === 0) {
    error('No command specified. Usage: instawp exec <site> <command...>');
    process.exit(1);
  }

  const spin = spinner('Resolving site...');
  spin.start();

  let site;
  try {
    site = await resolveSite(siteIdentifier);
    spin.stop();
  } catch (err: any) {
    spin.fail('Site resolution failed');
    process.exit(1);
  }

  const command = buildRemoteCommandString(args, !!opts.shell);

  if (opts.api) {
    await execViaApi(site, command, opts);
  } else {
    await execViaSshTransport(site, command, {
      streamStdin: !!opts.stdin,
      sshHost: opts.sshHost,
      refresh: opts.refresh,
      // wp/exec can transparently fall back to the API transport when SSH can't be
      // reached (CDN-fronted site). --stdin has no API equivalent, so no fallback there.
      canFallback: opts.fallback !== false && !opts.stdin,
      onFallback: () => execViaApi(site, command, opts),
    });
  }
}

async function execViaApi(site: any, command: string, opts: { timeout?: string }): Promise<void> {
  const spin2 = spinner(`Running: ${command}`);
  spin2.start();

  try {
    const client = getClient();
    const res = await client.post(`/sites/${site.id}/run-cmd`, {
      commands: [command],
      timeout_seconds: parseInt(opts.timeout || '30'),
    });

    spin2.stop();

    const data = res.data?.data;
    if (isJsonMode()) {
      console.log(JSON.stringify({ success: true, data }));
    } else {
      const stripEcho = (s: string) => {
        const lines = s.split('\n');
        if (lines[0] && /^\d{4}-\d{2}-\d{2}\s/.test(lines[0])) {
          return lines.slice(1).join('\n').trim();
        }
        return s.trim();
      };
      if (Array.isArray(data)) {
        for (const result of data) {
          const output = result.output || result;
          console.log(typeof output === 'string' ? stripEcho(output) : JSON.stringify(output));
        }
      } else if (typeof data === 'string') {
        console.log(stripEcho(data));
      } else if (data?.output) {
        console.log(typeof data.output === 'string' ? stripEcho(data.output) : JSON.stringify(data.output));
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
    }
  } catch (err: any) {
    spin2.fail('Command failed');
    error('Failed to run command', err.response?.data?.message || err.message);
    process.exit(1);
  }
}

async function execViaSshTransport(
  site: any,
  command: string,
  opts: { streamStdin?: boolean; sshHost?: string; refresh?: boolean; canFallback?: boolean; onFallback?: () => Promise<void> } = {},
): Promise<void> {
  let conn;
  try {
    conn = await ensureSshAccess(site.id, {
      sshHost: opts.sshHost,
      refresh: opts.refresh,
      onUnreachable: opts.canFallback ? 'throw' : 'exit',
    });
  } catch (err: any) {
    if (err instanceof SshUnreachableError && opts.canFallback && opts.onFallback) {
      info('SSH unreachable — falling back to the API transport. Use --no-fallback to disable.');
      await opts.onFallback();
      return;
    }
    throw err;
  }

  // Auto-cd into WordPress root so wp-cli and other tools work out of the box
  const wpRoot = conn.domain
    ? `/home/${conn.username}/web/${conn.domain}/public_html`
    : '';
  const base = wpRoot ? `cd ${wpRoot} && ${command}` : command;

  // --stdin: stream local stdin to the remote command (uploads, restore pipes,
  // `tar … | … 'tar xzf -'`). Passes the command as an ssh arg so stdin is free;
  // the non-login remote shell also means no MOTD, so no marker stripping needed.
  if (opts.streamStdin) {
    const capture = isJsonMode();
    const result = execViaSshStreamStdin(conn, base, capture);
    if (isJsonMode()) {
      console.log(JSON.stringify({
        success: result.exitCode === 0,
        data: { stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode },
      }));
    }
    // In text mode stdout/stderr were inherited (already streamed live).
    process.exit(result.exitCode);
  }

  // The remote login shell prepends a banner/MOTD to stdout on a cold (cold/idle)
  // connection, which pollutes value capture (`--field`, `--format=count`) and
  // the `--json` payload. Emit a unique marker before the real command, then
  // slice stdout after it so only the command's own output is returned. Exit
  // code is unaffected (the marker printf is a separate statement before `base`).
  const marker = `__IWP_OUT_${randomBytes(6).toString('hex')}__`;
  const result = execViaSsh(conn, `printf '%s\\n' '${marker}'; ${base}`);
  const stdout = sliceAfterMarker(result.stdout, marker);

  if (isJsonMode()) {
    console.log(JSON.stringify({
      success: result.exitCode === 0,
      data: {
        stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
      },
    }));
  } else {
    if (stdout) process.stdout.write(stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  process.exit(result.exitCode);
}

export function registerExecCommand(program: Command): void {
  program
    .command('exec <site> [args...]')
    .description('Escape hatch: run arbitrary shell on a remote site (SSH default, or --api). For WP-CLI use `wp` instead.')
    .passThroughOptions()
    .allowUnknownOption()
    .option('--api', 'Use API transport instead of SSH')
    .option('--shell', 'Run the args as one shell command line on the remote (enables pipes, ;, >, globs)')
    .option('--stdin', 'Stream local stdin to the remote command (for uploads / restore pipes; SSH only)')
    .option('--timeout <seconds>', 'Command timeout in seconds (API mode only)', '30')
    .option('--ssh-host <host>', 'Override the SSH host (CDN-fronted sites; also via INSTAWP_SSH_HOST)')
    .option('--refresh', 'Re-resolve SSH access, ignoring the cached host')
    .option('--no-fallback', 'Do not auto-fall-back to --api when SSH is unreachable')
    .addHelpText('after', `
Examples:
  $ instawp exec my-site ls -la
  $ instawp exec my-site -- tail -n 50 wp-content/debug.log
  $ instawp exec my-site --shell 'ps aux | grep php'   # --shell runs the whole line on the remote
  $ printf 'data' | instawp exec my-site --stdin --shell 'cat > /tmp/f'   # --stdin pipes stdin to the remote
  $ instawp exec my-site php -v --api

Note: shell metacharacters (| ; > globs) are NOT interpreted by default — each
arg is sent as one literal token. Use --shell (or '-- bash -lc "..."') to run a
pipeline or compound command on the remote.
`)
    .action(async (siteIdentifier: string, args: string[], opts) => {
      // passThroughOptions may swallow our flags into args — re-extract them.
      const extractedApi = args.includes('--api');
      const extractedShell = args.includes('--shell');
      const extractedStdin = args.includes('--stdin');
      const extractedRefresh = args.includes('--refresh');
      const extractedNoFallback = args.includes('--no-fallback');
      const extractValue = (flag: string): string | undefined => {
        const i = args.indexOf(flag);
        if (i !== -1 && args[i + 1]) {
          const v = args[i + 1];
          args = args.filter((_, idx) => idx !== i && idx !== i + 1);
          return v;
        }
        return undefined;
      };
      const extractedTimeout = extractValue('--timeout');
      const extractedSshHost = extractValue('--ssh-host');
      args = args.filter(a => !['--api', '--shell', '--stdin', '--refresh', '--no-fallback'].includes(a));
      if (extractedApi) opts.api = true;
      if (extractedShell) opts.shell = true;
      if (extractedStdin) opts.stdin = true;
      if (extractedTimeout) opts.timeout = extractedTimeout;
      if (extractedSshHost) opts.sshHost = extractedSshHost;
      if (extractedRefresh) opts.refresh = true;
      if (extractedNoFallback) opts.fallback = false;
      await execAction(siteIdentifier, args, opts);
    });
}

export function registerSqlCommand(program: Command): void {
  program
    .command('sql <site> <query>')
    .description('Run a SQL query on a site\'s database (via WP-CLI; hits MySQL directly, bypasses object cache)')
    .addHelpText('after', `
Examples:
  $ instawp sql my-site "SELECT option_value FROM wp_options WHERE option_name='siteurl'"
  $ instawp sql my-site "SELECT COUNT(*) FROM wp_posts WHERE post_status='publish'"
`)
    .action(async (siteIdentifier: string, query: string) => {
      // Route through the same shell-quoted SSH path as `wp db query`.
      await execAction(siteIdentifier, ['wp', 'db', 'query', query], {});
    });
}

export function registerWpCommand(program: Command): void {
  program
    .command('wp <site> [args...]')
    .description('Run WP-CLI on a remote site (the primary remote-access command)')
    .passThroughOptions()
    .allowUnknownOption()
    .option('--api', 'Use API transport instead of SSH')
    .option('--timeout <seconds>', 'Command timeout in seconds (API mode only)', '30')
    .option('--ssh-host <host>', 'Override the SSH host (CDN-fronted sites; also via INSTAWP_SSH_HOST)')
    .option('--refresh', 'Re-resolve SSH access, ignoring the cached host')
    .option('--no-fallback', 'Do not auto-fall-back to --api when SSH is unreachable')
    .addHelpText('after', `
Examples:
  $ instawp wp my-site plugin list
  $ instawp wp my-site theme activate twentytwentyfour
  $ instawp wp my-site -- post list --post_type=page    # use -- to pass raw WP-CLI args
  $ instawp wp my-site eval '\\\\MyClass::init(["force" => true]);'

Tip: wrap PHP/eval payloads in single quotes — args are shell-escaped automatically before being sent to the remote shell.
`)
    .action(async (siteIdentifier: string, args: string[], opts) => {
      // passThroughOptions may swallow our flags into args — re-extract them.
      const extractedApi = args.includes('--api');
      const extractedRefresh = args.includes('--refresh');
      const extractedNoFallback = args.includes('--no-fallback');
      const extractValue = (flag: string): string | undefined => {
        const i = args.indexOf(flag);
        if (i !== -1 && args[i + 1]) {
          const v = args[i + 1];
          args = args.filter((_, idx) => idx !== i && idx !== i + 1);
          return v;
        }
        return undefined;
      };
      const extractedTimeout = extractValue('--timeout');
      const extractedSshHost = extractValue('--ssh-host');
      args = args.filter(a => !['--api', '--refresh', '--no-fallback'].includes(a));
      if (extractedApi) opts.api = true;
      if (extractedTimeout) opts.timeout = extractedTimeout;
      if (extractedSshHost) opts.sshHost = extractedSshHost;
      if (extractedRefresh) opts.refresh = true;
      if (extractedNoFallback) opts.fallback = false;

      await execAction(siteIdentifier, ['wp', ...args], opts);
    });
}
