import { Command } from 'commander';
import { basename, join } from 'node:path';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import chalk from 'chalk';
import { requireAuth, getClient } from '../lib/api.js';
import { getApiUrl } from '../lib/config.js';
import { ensureSshAccess } from '../lib/ssh-keys.js';
import { scpUpload, execViaSsh } from '../lib/ssh-connection.js';
import { waitForHttp } from '../lib/http-ready.js';
import { success, error, info, spinner, isJsonMode } from '../lib/output.js';
import {
  findWpRoot,
  findWpConfig,
  parseWpConfig,
  detectWpVersion,
  normalizeSourceDomain,
  FILE_EXCLUDES,
} from '../lib/wp-local.js';
import { createFilesZip, exportDatabase, detectSourceUrl, wpCliWorksOn } from '../lib/wp-archive.js';
import type { AxiosInstance } from 'axios';

/**
 * `instawp migrate push [path]` — mirror an on-disk WordPress install up to a
 * brand-new hosted InstaWP site. This reproduces the end result of the plugin's
 * `wp instawp local push` (files + DB migrated to a fresh site), but driven
 * entirely by the CLI's personal API token over site-scoped routes — no Connect
 * record and no migration-dashboard entry.
 *
 * Flow: archive files (zip) → export DB (.sql) → create reserved site → scp both
 * archives into the new site's public_html → PUT /sites/{id}/restore-raw (the
 * server-side restore engine unzips, imports, and search-replaces the old domain
 * → new domain) → poll to completion.
 */
export function registerMigrateCommand(program: Command): void {
  const migrate = program
    .command('migrate')
    .description('Migrate a local WordPress site up to a new hosted InstaWP site');

  migrate
    .command('push [path]')
    .description('Mirror a local WordPress install to a brand-new hosted InstaWP site (files + database)')
    .option('--path <dir>', 'Path to the local WordPress install (overrides the positional argument)')
    .option('--name <name>', 'Name for the new hosted site (default: the WP directory name)')
    .option('--source-url <url>', 'Local site URL (auto-detected from wp-cli / wp-config if omitted)')
    .option('--wp <version>', 'WordPress version for the new site (default: detected from the local install)')
    .option('--php <version>', 'PHP version for the new site')
    .option('--keep-archives', 'Keep the temporary zip/sql archives instead of deleting them')
    .option('--dry-run', 'Print the migration plan without creating a site or uploading anything')
    .action(migratePushAction);
}

async function migratePushAction(pathArg: string | undefined, opts: any): Promise<void> {
  requireAuth();
  const json = isJsonMode();

  // 1. Locate the WordPress install (positional > --path > cwd).
  const startDir = pathArg || opts.path || process.cwd();
  const wpRoot = findWpRoot(startDir);
  if (!wpRoot) {
    error(`No WordPress install found at or above ${chalk.dim(startDir)} (looked for wp-includes/version.php).`);
    info('Run this from inside a WordPress directory, or pass the path: instawp migrate push /path/to/wp');
    process.exit(1);
  }

  const wpConfigPath = findWpConfig(wpRoot);
  if (!wpConfigPath) {
    error(`Found WordPress at ${chalk.dim(wpRoot)} but no wp-config.php alongside it.`);
    process.exit(1);
  }

  let wpConfig;
  try {
    wpConfig = parseWpConfig(readFileSync(wpConfigPath, 'utf-8'));
  } catch (err: any) {
    error('Could not read database settings from wp-config.php', err.message);
    process.exit(1);
  }

  // 2. Detect wp-cli availability, the source URL, and the WP version.
  const useWpCli = wpCliWorksOn(wpRoot);

  const rawSourceUrl = opts.sourceUrl || detectSourceUrl({ wpRoot, wpConfig, useWpCli });
  if (!rawSourceUrl) {
    error('Could not determine the local site URL.');
    info('Pass it explicitly: instawp migrate push --source-url http://your-local-site.test');
    process.exit(1);
  }
  const sourceDomain = normalizeSourceDomain(rawSourceUrl);
  if (!sourceDomain) {
    error(`Invalid --source-url "${rawSourceUrl}" — could not derive a source domain from it.`);
    process.exit(1);
  }

  const wpVersion = opts.wp || detectWpVersion(wpRoot) || undefined;
  // Default the new site's name to the source domain's first label (e.g.
  // "my-shop" from "my-shop.local") — far more meaningful than the WP dir's
  // basename, which for Local/most stacks is a generic "public"/"public_html".
  const domainLabel = sourceDomain.split('/')[0].split(':')[0].split('.')[0];
  const siteName = opts.name || domainLabel || basename(wpRoot);

  // 3. Dry run — describe the plan, touch nothing.
  if (opts.dryRun) {
    if (json) {
      console.log(JSON.stringify({
        success: true,
        dry_run: true,
        data: {
          wp_root: wpRoot,
          wp_config: wpConfigPath,
          source_domain: sourceDomain,
          wp_version: wpVersion || null,
          table_prefix: wpConfig.tablePrefix,
          db_export_method: useWpCli ? 'wp db export' : 'mysqldump',
          new_site_name: siteName,
          excludes: FILE_EXCLUDES,
        },
      }));
      return;
    }
    info('(dry run) Plan — nothing will be created or uploaded:');
    console.log(`  ${chalk.dim('WP root:')}        ${wpRoot}`);
    console.log(`  ${chalk.dim('Source domain:')}  ${sourceDomain}`);
    console.log(`  ${chalk.dim('WP version:')}     ${wpVersion || 'unknown'}`);
    console.log(`  ${chalk.dim('DB export via:')}  ${useWpCli ? 'wp db export' : 'mysqldump (wp-config creds)'}`);
    console.log(`  ${chalk.dim('New site name:')}  ${siteName}`);
    console.log(`  ${chalk.dim('Excludes:')}       ${FILE_EXCLUDES.join(', ')}`);
    info('Would: create a reserved hosted site → upload files+DB → restore (mirror).');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, '');
  const rand = randomBytes(3).toString('hex');
  const zipPath = join(tmpdir(), `wordpress_backup_${stamp}_${rand}.zip`);
  const sqlPath = join(tmpdir(), `wordpress_db_backup_${stamp}_${rand}.sql`);
  const cleanupLocal = () => {
    if (opts.keepArchives) return;
    for (const f of [zipPath, sqlPath]) {
      try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
    }
  };

  try {
    // 4. Archive files.
    const zipSpin = spinner('Archiving WordPress files...');
    zipSpin.start();
    const zip = await createFilesZip({
      wpRoot,
      outPath: zipPath,
      onEntry: (n) => { zipSpin.text = `Archiving WordPress files... (${n} files)`; },
    });
    zipSpin.succeed(`Files archived (${zip.entries} files, ${fmtBytes(zip.bytes)})`);

    // 5. Export DB.
    const dbSpin = spinner('Exporting database...');
    dbSpin.start();
    let dbMethod: string;
    try {
      const res = exportDatabase({ wpRoot, wpConfig, outPath: sqlPath, useWpCli });
      dbMethod = res.method;
    } catch (err: any) {
      dbSpin.fail('Database export failed');
      error(err.message);
      cleanupLocal();
      process.exit(1);
    }
    dbSpin.succeed(`Database exported (${fmtBytes(statSync(sqlPath).size)}, via ${dbMethod})`);

    const client = getClient();

    // 6. Create the destination hosted site (reserved/permanent), wait for provisioning.
    const created = await createReservedSite(client, { siteName, wpVersion, php: opts.php });

    // 7. SSH access + upload both archives into the new site's public_html — the
    //    exact location restore-raw reconstructs server-side.
    const conn = await ensureSshAccess(created.id);
    const subDomain = created.subDomain || conn.domain;
    const remoteDir = `/home/${conn.username}/web/${subDomain}/public_html`;
    const zipBase = basename(zipPath);
    const sqlBase = basename(sqlPath);

    const upSpin = spinner('Uploading archives to the new site...');
    upSpin.start();
    if (scpUpload(conn, zipPath, `${remoteDir}/${zipBase}`) !== 0) {
      upSpin.fail('Failed to upload the files archive');
      cleanupLocal();
      process.exit(1);
    }
    if (scpUpload(conn, sqlPath, `${remoteDir}/${sqlBase}`) !== 0) {
      upSpin.fail('Failed to upload the database archive');
      cleanupLocal();
      process.exit(1);
    }
    upSpin.succeed('Archives uploaded');
    // Local copies are no longer needed once they're on the server.
    cleanupLocal();

    // 8. Trigger the server-side restore (unzip + import + search-replace
    //    sourceDomain → new domain), then wait for the task to finish.
    const restoreSpin = spinner('Restoring on the new site...');
    restoreSpin.start();
    let restoreTaskId: string | number | null = null;
    try {
      const res = await client.put(`/sites/${created.id}/restore-raw`, {
        file_bkp: zipBase,
        db_bkp: sqlBase,
        source_domain: sourceDomain,
      });
      restoreTaskId = res.data?.data?.task_id ?? null;
    } catch (err: any) {
      restoreSpin.fail('Restore request failed');
      error(err.response?.data?.message || err.message);
      info(`The site was created (ID ${created.id}) but the restore did not start. Archives are at ${remoteDir}.`);
      process.exit(1);
    }

    if (restoreTaskId) {
      const ok = await pollTask(client, restoreTaskId, {
        maxMs: 30 * 60 * 1000,
        onPct: (pct) => { restoreSpin.text = `Restoring on the new site... (${Math.round(pct)}%)`; },
      });
      if (ok === 'error') {
        restoreSpin.fail('Restore failed on the server');
        error('The migration restore reported an error. Check the site in the dashboard.');
        process.exit(1);
      }
      if (ok === 'timeout') {
        restoreSpin.stop();
        info(`Restore is taking a while (site ID ${created.id}). It may still finish — check the dashboard.`);
      } else {
        restoreSpin.succeed('Restore complete');
      }
    } else {
      // No task id returned — best effort; assume it ran synchronously.
      restoreSpin.succeed('Restore initiated');
    }

    // 9. Best-effort: remove the uploaded archives from the new site's webroot.
    execViaSsh(conn, `rm -f '${remoteDir}/${zipBase}' '${remoteDir}/${sqlBase}'`);

    // 10. Wait for the site to answer over HTTP, then report.
    if (created.url) {
      const httpSpin = spinner('Waiting for the site to respond...');
      httpSpin.start();
      const ready = await waitForHttp(created.url, 180000);
      if (ready) httpSpin.succeed('Site is responding'); else httpSpin.stop();
    }

    const adminUrl = created.url ? `${created.url}/wp-admin` : '';
    if (json) {
      console.log(JSON.stringify({
        success: true,
        data: {
          site_id: created.id,
          url: created.url,
          wp_admin_url: adminUrl,
          source_domain: sourceDomain,
          files: { archived: zip.entries, bytes: zip.bytes },
          db_export_method: dbMethod,
        },
      }));
      return;
    }

    success('Migration complete — your local site is now live on InstaWP.');
    if (created.url) console.log(`\n  ${chalk.dim('Site URL:')}  ${chalk.cyan.underline(created.url)}`);
    if (adminUrl) console.log(`  ${chalk.dim('WP Admin:')}  ${chalk.cyan.underline(adminUrl)}`);
    info('Log in with your local site’s existing WordPress admin account (your users were migrated).');
    info('Note: the instawp-connect plugin is not installed on the new site (this is a faithful copy of your local files). Manage it over SSH or `instawp wp`/`instawp open`.');
  } catch (err: any) {
    cleanupLocal();
    error('Migration failed', err?.message || String(err));
    process.exit(1);
  }
}

interface CreatedSite {
  id: number;
  url: string;
  subDomain: string;
}

/**
 * Create a reserved (permanent) hosted site and block until it's provisioned,
 * mirroring `sites create`'s polling. Returns the site id, URL, and sub_domain
 * needed to build the SFTP/restore path.
 */
async function createReservedSite(
  client: AxiosInstance,
  opts: { siteName: string; wpVersion?: string; php?: string },
): Promise<CreatedSite> {
  const spin = spinner('Creating the hosted site...');
  spin.start();

  const payload: Record<string, any> = { site_name: opts.siteName, is_reserved: true };
  if (opts.wpVersion) payload.wp_version = opts.wpVersion;
  if (opts.php) payload.php_version = opts.php;

  let site: any;
  try {
    const res = await client.post('/sites', payload);
    site = res.data?.data;
    if (!site?.id) throw new Error('Unexpected response from site creation');
  } catch (err: any) {
    spin.fail('Site creation failed');
    error(err.response?.data?.message || err.message);
    process.exit(1);
  }

  const taskId = site.task_id;
  if (taskId) {
    spin.text = 'Provisioning WordPress...';
    const result = await pollTask(client, taskId, {
      maxMs: 5 * 60 * 1000,
      onPct: (pct) => { spin.text = `Provisioning WordPress... (${Math.round(pct)}%)`; },
    });
    if (result === 'error') {
      spin.fail('Provisioning failed');
      error('The new site failed to provision.');
      process.exit(1);
    }
  }

  // Fetch details for the final URL + sub_domain.
  let url = site.wp_url || '';
  let subDomain = site.sub_domain || '';
  try {
    const detail = await client.get(`/sites/${site.id}/details`);
    const data = detail.data?.data;
    const info2 = data?.site || data;
    url = info2?.url || url;
    subDomain = info2?.sub_domain || info2?.main_domain || subDomain;
  } catch { /* non-fatal */ }

  spin.succeed(`Hosted site created (ID: ${site.id})`);
  return { id: site.id, url, subDomain };
}

/**
 * Poll GET /tasks/{id}/status until the task completes, errors, or the budget
 * runs out. Returns 'completed' | 'error' | 'timeout'. Poll/transient errors are
 * swallowed and retried.
 */
async function pollTask(
  client: AxiosInstance,
  taskId: string | number,
  opts: { maxMs: number; onPct?: (pct: number) => void },
): Promise<'completed' | 'error' | 'timeout'> {
  const start = Date.now();
  while (Date.now() - start < opts.maxMs) {
    try {
      const res = await client.get(`/tasks/${taskId}/status`);
      const task = res.data?.data;
      const pct = parseFloat(task?.percentage_complete) || 0;
      opts.onPct?.(pct);
      if (task?.status === 'completed' || pct >= 100) return 'completed';
      if (task?.status === 'error') return 'error';
    } catch { /* transient — retry */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return 'timeout';
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
