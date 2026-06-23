import { Command } from 'commander';
import chalk from 'chalk';
import { requireAuth, getClient } from '../lib/api.js';
import { resolveSite } from '../lib/site-resolver.js';
import { success, error, table, spinner, info, isJsonMode } from '../lib/output.js';

/**
 * Site versions: restorable point-in-time copies of a site's files + database.
 * Unlike backups, a version can be rolled back to in-place. The intended
 * workflow (and the reason this exists for the AI era): create a version
 * BEFORE letting an agent run a batch of changes, then roll back the one
 * change that broke it — in one command.
 *
 * Named `versions` (not "snapshot") to avoid confusion with InstaWP's separate
 * "Snapshots" product.
 */

const POLL_INTERVAL = 3000; // 3s
const MAX_WAIT = 10 * 60 * 1000; // 10 min — create/restore scale with site size

/** Poll a CloudTask until it completes, errors, or times out. */
async function pollTask(
  client: any,
  taskId: string | number,
  label: string,
): Promise<'completed' | 'error' | 'timeout'> {
  const spin = spinner(`${label}...`);
  spin.start();
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT) {
    try {
      const res = await client.get(`/tasks/${taskId}/status`);
      const task = res.data?.data;
      const pct = parseFloat(task?.percentage_complete) || 0;
      const status = task?.status;

      if (status === 'completed') {
        spin.stop();
        return 'completed';
      }
      if (status === 'error' || status === 'failed') {
        spin.fail(`${label} failed`);
        if (task?.comment) error(task.comment);
        return 'error';
      }
      (spin as any).text = pct > 0 ? `${label}... ${chalk.dim(`(${Math.round(pct)}%)`)}` : `${label}...`;
    } catch {
      // Task status endpoint may not be ready yet — keep polling.
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }

  spin.fail(`${label} timed out`);
  return 'timeout';
}

function formatDate(value?: string): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function registerVersionsCommand(program: Command): void {
  const versionsCmd = program
    .command('versions')
    .aliases(['version'])
    .description('Manage site versions (restorable point-in-time copies) — create one before risky changes, roll back in one command');

  // versions create <site>
  versionsCmd
    .command('create <site>')
    .description('Create a version of a site (a restorable point-in-time copy)')
    .option('--name <name>', 'Label for the version (max 25 chars), e.g. "before plugin update"')
    .option('--no-wait', 'Return immediately instead of waiting for the version to finish')
    .action(async (siteIdentifier: string, opts) => {
      requireAuth();
      const client = getClient();

      const rspin = spinner('Resolving site...');
      rspin.start();
      let site;
      try {
        site = await resolveSite(siteIdentifier);
        rspin.stop();
      } catch {
        rspin.fail('Site resolution failed');
        process.exit(1);
      }
      const label = site.name || site.sub_domain || String(site.id);

      const spin = spinner(`Creating version of ${label}...`);
      spin.start();

      let versionId: number | undefined;
      let taskId: string | number | undefined;
      try {
        const res = await client.post('/site-versions', { site_id: site.id });
        versionId = res.data?.data?.id;
        taskId = res.data?.data?.task_id;
        spin.stop();

        if (!versionId) {
          error('Version creation failed', res.data?.message || res.data);
          process.exit(1);
        }
      } catch (err: any) {
        spin.fail('Failed to create version');
        error('Could not create version', err.response?.data?.message || err.message);
        process.exit(1);
      }

      // Optional name — the create endpoint doesn't accept one, so set it via
      // update. The server caps names at 25 chars (longer → 422), so truncate.
      const versionName = opts.name ? String(opts.name).slice(0, 25) : undefined;
      if (versionName) {
        try {
          await client.put(`/site-versions/${versionId}`, { name: versionName });
        } catch {
          info('Version created, but naming it failed (you can rename it later).');
        }
      }

      if (!opts.wait) {
        if (isJsonMode()) {
          console.log(JSON.stringify({ success: true, data: { id: versionId, status: 'progress', task_id: taskId ?? null } }));
        } else {
          success('Version started', { id: versionId, status: 'progress' });
          info('It will be restorable once complete. Check with: instawp versions list ' + siteIdentifier);
        }
        return;
      }

      if (taskId) {
        const result = await pollTask(client, taskId, 'Creating version');
        if (result !== 'completed') {
          info(`Version (ID ${versionId}) is still processing. Check with: instawp versions list ${siteIdentifier}`);
          process.exit(result === 'error' ? 1 : 0);
        }
      }

      if (isJsonMode()) {
        console.log(JSON.stringify({ success: true, data: { id: versionId, status: 'completed', name: versionName || null } }));
      } else {
        success('Version ready', { id: versionId, ...(versionName ? { name: versionName } : {}) });
        info(`Roll back any time with: instawp versions restore ${siteIdentifier} ${versionId}`);
      }
    });

  // versions list <site>
  versionsCmd
    .command('list <site>')
    .description('List a site\'s versions (most recent first)')
    .action(async (siteIdentifier: string) => {
      requireAuth();
      const client = getClient();

      const rspin = spinner('Resolving site...');
      rspin.start();
      let site;
      try {
        site = await resolveSite(siteIdentifier);
        rspin.stop();
      } catch {
        rspin.fail('Site resolution failed');
        process.exit(1);
      }

      const spin = spinner('Fetching versions...');
      spin.start();
      try {
        const res = await client.get('/site-versions', { params: { site_id: site.id, per_page: 100 } });
        const versions: any[] = res.data?.data || [];
        spin.stop();

        if (versions.length === 0) {
          if (isJsonMode()) {
            console.log(JSON.stringify([]));
          } else {
            info('No versions yet. Create one with: instawp versions create ' + (site.name || site.id));
          }
          return;
        }

        const rows = versions.map((v: any) => ({
          id: v.id,
          name: v.name || chalk.dim('(unnamed)'),
          size: v.size_mb != null ? `${v.size_mb} MB` : '',
          status: v.status === 'completed' ? chalk.green('completed') : v.status === 'progress' ? chalk.yellow('in progress') : (v.status || ''),
          created: formatDate(v.created_at),
        }));

        table(['ID', 'Name', 'Size', 'Status', 'Created'], rows);
      } catch (err: any) {
        spin.fail('Failed to fetch versions');
        error('Could not list versions', err.response?.data?.message || err.message);
        process.exit(1);
      }
    });

  // versions restore <site> <version-id>
  versionsCmd
    .command('restore <site> <version-id>')
    .description('Roll a site back to a version — OVERWRITES current files and database')
    .option('--force', 'Skip confirmation')
    .option('--no-wait', 'Return immediately instead of waiting for the restore to finish')
    .action(async (siteIdentifier: string, versionId: string, opts) => {
      requireAuth();
      const client = getClient();

      const rspin = spinner('Resolving site...');
      rspin.start();
      let site;
      try {
        site = await resolveSite(siteIdentifier);
        rspin.stop();
      } catch {
        rspin.fail('Site resolution failed');
        process.exit(1);
      }
      const label = site.name || site.sub_domain || String(site.id);

      if (!opts.force) {
        if (isJsonMode()) {
          error('Use --force to restore in JSON mode (this overwrites the live site)');
          process.exit(1);
        }
        const readline = await import('node:readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            `Restore "${label}" to version ${versionId}? This OVERWRITES the current files and database and cannot be undone. (y/N) `,
            resolve,
          );
        });
        rl.close();
        if (answer.toLowerCase() !== 'y') {
          info('Cancelled.');
          return;
        }
      }

      const spin = spinner(`Starting restore of ${label}...`);
      spin.start();

      let taskId: string | number | undefined;
      try {
        const res = await client.put(`/sites/${site.id}/restore-versions/${versionId}`);
        taskId = res.data?.data?.task_id;
        spin.stop();
      } catch (err: any) {
        spin.fail('Failed to start restore');
        error('Could not restore version', err.response?.data?.message || err.message);
        process.exit(1);
      }

      if (!opts.wait) {
        if (isJsonMode()) {
          console.log(JSON.stringify({ success: true, data: { site_id: site.id, version_id: Number(versionId), status: 'restoring', task_id: taskId ?? null } }));
        } else {
          success('Restore started', { site: label, version: versionId });
          info('The site will be back shortly. Check with: instawp sites list');
        }
        return;
      }

      if (taskId) {
        const result = await pollTask(client, taskId, 'Restoring version');
        if (result !== 'completed') {
          info('Restore is still processing. The site will update once it finishes.');
          process.exit(result === 'error' ? 1 : 0);
        }
      }

      if (isJsonMode()) {
        console.log(JSON.stringify({ success: true, data: { site_id: site.id, version_id: Number(versionId), status: 'completed' } }));
      } else {
        success(`"${label}" restored to version ${versionId}`);
      }
    });

  // versions delete <site> <version-id...>
  versionsCmd
    .command('delete <site> <version-ids...>')
    .description('Delete one or more versions')
    .option('--force', 'Skip confirmation')
    .action(async (siteIdentifier: string, versionIds: string[], opts) => {
      requireAuth();
      const client = getClient();

      const rspin = spinner('Resolving site...');
      rspin.start();
      let site;
      try {
        site = await resolveSite(siteIdentifier);
        rspin.stop();
      } catch {
        rspin.fail('Site resolution failed');
        process.exit(1);
      }
      const label = site.name || site.sub_domain || String(site.id);

      const ids = versionIds.map((v) => parseInt(v, 10)).filter((n) => !Number.isNaN(n));
      if (ids.length === 0) {
        error('No valid version IDs provided');
        process.exit(1);
      }

      if (!opts.force) {
        if (isJsonMode()) {
          error('Use --force to delete in JSON mode');
          process.exit(1);
        }
        const readline = await import('node:readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`Delete ${ids.length} version(s) [${ids.join(', ')}] of "${label}"? (y/N) `, resolve);
        });
        rl.close();
        if (answer.toLowerCase() !== 'y') {
          info('Cancelled.');
          return;
        }
      }

      const spin = spinner('Deleting version(s)...');
      spin.start();
      try {
        const res = await client.delete('/site-versions', { data: { ids } });
        const data = res.data?.data || {};
        const successIds: number[] = data.success_ids || [];
        const failedIds: number[] = data.failed_ids || [];
        spin.stop();

        if (isJsonMode()) {
          console.log(JSON.stringify({ success: true, data: { success_ids: successIds, failed_ids: failedIds } }));
          return;
        }

        if (successIds.length) success(`Deleted version(s): ${successIds.join(', ')}`);
        if (failedIds.length) error(`Failed to delete: ${failedIds.join(', ')}`);
      } catch (err: any) {
        spin.fail('Failed to delete version(s)');
        error('Could not delete versions', err.response?.data?.message || err.message);
        process.exit(1);
      }
    });
}
