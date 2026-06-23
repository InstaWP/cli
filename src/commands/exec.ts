import { Command } from 'commander';
import { randomBytes } from 'node:crypto';
import { requireAuth, getClient } from '../lib/api.js';
import { resolveSite } from '../lib/site-resolver.js';
import { ensureSshAccess } from '../lib/ssh-keys.js';
import { execViaSsh } from '../lib/ssh-connection.js';
import { buildRemoteCommandString, sliceAfterMarker } from '../lib/remote-command.js';
import { error, spinner, isJsonMode } from '../lib/output.js';

async function execAction(siteIdentifier: string, args: string[], opts: { api?: boolean; timeout?: string; shell?: boolean }): Promise<void> {
  requireAuth();

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
    await execViaSshTransport(site, command);
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

async function execViaSshTransport(site: any, command: string): Promise<void> {
  const conn = await ensureSshAccess(site.id);

  // Auto-cd into WordPress root so wp-cli and other tools work out of the box
  const wpRoot = conn.domain
    ? `/home/${conn.username}/web/${conn.domain}/public_html`
    : '';
  const base = wpRoot ? `cd ${wpRoot} && ${command}` : command;

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
    .option('--timeout <seconds>', 'Command timeout in seconds (API mode only)', '30')
    .addHelpText('after', `
Examples:
  $ instawp exec my-site ls -la
  $ instawp exec my-site -- tail -n 50 wp-content/debug.log
  $ instawp exec my-site --shell 'ps aux | grep php'   # --shell runs the whole line on the remote
  $ instawp exec my-site php -v --api

Note: shell metacharacters (| ; > globs) are NOT interpreted by default — each
arg is sent as one literal token. Use --shell (or '-- bash -lc "..."') to run a
pipeline or compound command on the remote.
`)
    .action(async (siteIdentifier: string, args: string[], opts) => {
      // passThroughOptions may swallow --api/--shell/--timeout into args — extract them
      const extractedApi = args.includes('--api');
      const extractedShell = args.includes('--shell');
      const timeoutIdx = args.indexOf('--timeout');
      let extractedTimeout: string | undefined;
      if (timeoutIdx !== -1 && args[timeoutIdx + 1]) {
        extractedTimeout = args[timeoutIdx + 1];
        args = args.filter((_, i) => i !== timeoutIdx && i !== timeoutIdx + 1);
      }
      args = args.filter(a => a !== '--api' && a !== '--shell');
      if (extractedApi) opts.api = true;
      if (extractedShell) opts.shell = true;
      if (extractedTimeout) opts.timeout = extractedTimeout;
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
    .addHelpText('after', `
Examples:
  $ instawp wp my-site plugin list
  $ instawp wp my-site theme activate twentytwentyfour
  $ instawp wp my-site -- post list --post_type=page    # use -- to pass raw WP-CLI args
  $ instawp wp my-site eval '\\\\MyClass::init(["force" => true]);'

Tip: wrap PHP/eval payloads in single quotes — args are shell-escaped automatically before being sent to the remote shell.
`)
    .action(async (siteIdentifier: string, args: string[], opts) => {
      // passThroughOptions may swallow --api/--timeout into args — extract them
      const extractedApi = args.includes('--api');
      const timeoutIdx = args.indexOf('--timeout');
      let extractedTimeout: string | undefined;
      if (timeoutIdx !== -1 && args[timeoutIdx + 1]) {
        extractedTimeout = args[timeoutIdx + 1];
        args = args.filter((_, i) => i !== timeoutIdx && i !== timeoutIdx + 1);
      }
      args = args.filter(a => a !== '--api');
      if (extractedApi) opts.api = true;
      if (extractedTimeout) opts.timeout = extractedTimeout;

      await execAction(siteIdentifier, ['wp', ...args], opts);
    });
}
