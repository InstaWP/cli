import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { requireAuth } from '../lib/api.js';
import { resolveSite } from '../lib/site-resolver.js';
import { ensureSshAccess } from '../lib/ssh-keys.js';
import { syncFiles } from '../lib/ssh-connection.js';
import { buildRemotePath, buildSyncFilterArgs } from '../lib/paths.js';
import { success, error, spinner, info } from '../lib/output.js';

function checkRsync(): boolean {
  // Windows transfers go over pure-JS SFTP, so rsync isn't required there.
  if (process.platform === 'win32') return true;
  const result = spawnSync('which', ['rsync'], { stdio: 'ignore' });
  return result.status === 0;
}

function getRsyncInstallInstructions(): string {
  const platform = process.platform;
  if (platform === 'darwin') return 'Install rsync: brew install rsync';
  if (platform === 'linux') return 'Install rsync: sudo apt install rsync  (or equivalent for your distro)';
  return 'Install rsync for your platform.';
}

async function promptYesNo(question: string): Promise<boolean> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  const a = answer.trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

export function registerSyncCommand(program: Command): void {
  const sync = program
    .command('sync')
    .description('Sync files with a remote site via rsync (wp-content/ by default; --webroot or --remote-path for other paths)');

  sync
    .command('push <site>')
    .description('Push local files to a remote site (default: wp-content/)')
    .option('--path <path>', 'Local source path', './wp-content/')
    .option('--remote-path <path>', 'Remote target path (absolute, or relative to public_html/). Default: wp-content/')
    .option('--webroot', 'Target the site webroot (public_html/) instead of wp-content/')
    .option('--exclude <pattern...>', 'Additional exclude patterns')
    .option('--include <pattern...>', 'Include patterns')
    .option('--delete', 'Delete remote files that are absent locally (make remote MIRROR local)')
    .option('--yes', 'Skip the --delete confirmation prompt')
    .option('--ssh-host <host>', 'Override the SSH host (CDN-fronted sites; also via INSTAWP_SSH_HOST)')
    .option('--refresh', 'Re-resolve SSH access, ignoring the cached host')
    .option('--dry-run', 'Show what would be transferred')
    .action(async (siteIdentifier: string, opts) => {
      requireAuth();

      if (!checkRsync()) {
        error('rsync is required for sync.');
        info(getRsyncInstallInstructions());
        process.exit(1);
      }

      if (opts.delete && process.platform === 'win32') {
        error('--delete is not supported on Windows (SFTP transport). Use a macOS/Linux host.');
        process.exit(1);
      }

      const spin = spinner('Resolving site...');
      spin.start();

      let site;
      try {
        site = await resolveSite(siteIdentifier);
        spin.succeed(`Site: ${site.name || site.sub_domain} (ID: ${site.id})`);
      } catch {
        spin.fail('Site resolution failed');
        process.exit(1);
      }

      const conn = await ensureSshAccess(site.id, { sshHost: opts.sshHost, refresh: opts.refresh });

      const localPath = opts.path.endsWith('/') ? opts.path : opts.path + '/';
      const remotePath = buildRemotePath(conn, opts);
      const remoteTarget = `${conn.username}@${conn.host}:${remotePath}`;

      const extraArgs = buildSyncFilterArgs(opts);

      // --delete is destructive; confirm unless --dry-run or --yes.
      if (opts.delete && !opts.dryRun && !opts.yes) {
        console.log(chalk.yellow(`\n⚠ --delete will REMOVE files under ${conn.host}:${remotePath} that don't exist in ${localPath}`));
        const ok = await promptYesNo('Continue? (y/N) ');
        if (!ok) { info('Cancelled.'); return; }
      }

      info(`Pushing ${localPath} -> ${conn.host}:${remotePath}`);
      if (opts.dryRun) info('(dry run)');
      if (opts.delete) info('(--delete: remote will mirror local)');

      const exitCode = await syncFiles(conn, localPath, remoteTarget, extraArgs, !!opts.dryRun, true);

      if (exitCode === 0) {
        success('Push complete');
      } else {
        error(`rsync exited with code ${exitCode}`);
        process.exit(exitCode);
      }
    });

  sync
    .command('pull <site>')
    .description('Pull remote files to local (default: wp-content/)')
    .option('--path <path>', 'Local destination path', './wp-content/')
    .option('--remote-path <path>', 'Remote source path (absolute, or relative to public_html/). Default: wp-content/')
    .option('--webroot', 'Pull the site webroot (public_html/) instead of wp-content/')
    .option('--exclude <pattern...>', 'Additional exclude patterns')
    .option('--include <pattern...>', 'Include patterns')
    .option('--delete', 'Delete local files that are absent on the remote (make local MIRROR remote)')
    .option('--yes', 'Skip the --delete confirmation prompt')
    .option('--ssh-host <host>', 'Override the SSH host (CDN-fronted sites; also via INSTAWP_SSH_HOST)')
    .option('--refresh', 'Re-resolve SSH access, ignoring the cached host')
    .option('--dry-run', 'Show what would be transferred')
    .action(async (siteIdentifier: string, opts) => {
      requireAuth();

      if (!checkRsync()) {
        error('rsync is required for sync.');
        info(getRsyncInstallInstructions());
        process.exit(1);
      }

      if (opts.delete && process.platform === 'win32') {
        error('--delete is not supported on Windows (SFTP transport). Use a macOS/Linux host.');
        process.exit(1);
      }

      const spin = spinner('Resolving site...');
      spin.start();

      let site;
      try {
        site = await resolveSite(siteIdentifier);
        spin.succeed(`Site: ${site.name || site.sub_domain} (ID: ${site.id})`);
      } catch {
        spin.fail('Site resolution failed');
        process.exit(1);
      }

      const conn = await ensureSshAccess(site.id, { sshHost: opts.sshHost, refresh: opts.refresh });

      const localPath = opts.path.endsWith('/') ? opts.path : opts.path + '/';
      const remotePath = buildRemotePath(conn, opts);
      const remoteSource = `${conn.username}@${conn.host}:${remotePath}`;

      const extraArgs = buildSyncFilterArgs(opts);

      // --delete is destructive; confirm unless --dry-run or --yes.
      if (opts.delete && !opts.dryRun && !opts.yes) {
        console.log(chalk.yellow(`\n⚠ --delete will REMOVE files under ${localPath} that don't exist on ${conn.host}:${remotePath}`));
        const ok = await promptYesNo('Continue? (y/N) ');
        if (!ok) { info('Cancelled.'); return; }
      }

      info(`Pulling ${conn.host}:${remotePath} -> ${localPath}`);
      if (opts.dryRun) info('(dry run)');
      if (opts.delete) info('(--delete: local will mirror remote)');

      const exitCode = await syncFiles(conn, remoteSource, localPath, extraArgs, !!opts.dryRun, true);

      if (exitCode === 0) {
        success('Pull complete');
      } else {
        error(`rsync exited with code ${exitCode}`);
        process.exit(exitCode);
      }
    });
}
