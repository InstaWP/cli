import { Command } from 'commander';
import { join, dirname, basename } from 'node:path';
import { existsSync, mkdirSync, statSync, createReadStream, createWriteStream, unlinkSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import chalk from 'chalk';
import { requireAuth } from '../lib/api.js';
import { resolveSite } from '../lib/site-resolver.js';
import { ensureSshAccess } from '../lib/ssh-keys.js';
import { execViaSsh, execViaSshToFile, scpUpload } from '../lib/ssh-connection.js';
import { parseTablePrefix } from '../lib/local-instance.js';
import { detectDumpPrefix, readSqlHead, rewriteDumpPrefix } from '../lib/sql-dump.js';
import { success, error, spinner, info, isJsonMode } from '../lib/output.js';

/** Timestamp like `2026-05-23T12-34-56` (filename-safe — `:` is illegal on Windows). */
function isoTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, '');
}

function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function gunzipFile(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(dest));
}

async function promptYesNo(question: string, defaultYes = false): Promise<boolean> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(question, resolve);
  });
  rl.close();
  const a = answer.trim().toLowerCase();
  if (a === '') return defaultYes;
  return a === 'y' || a === 'yes';
}

/** True if a URL is a plain http(s) URL safe to embed in a single-quoted shell arg. */
function isShellSafeUrl(u: string): boolean {
  return /^https?:\/\/[^\s'"\\$`]+$/.test(u);
}

export function registerDbCommand(program: Command): void {
  const db = program
    .command('db')
    .description('Push/pull MySQL database dumps to/from a remote site');

  // db pull <site>
  db
    .command('pull <site>')
    .description('Pull remote MySQL database to a local SQL dump')
    .option('--output <path>', 'Output file path (default: ./db-<site>-<timestamp>.sql.gz)')
    .option('--no-compress', 'Write uncompressed .sql instead of .sql.gz')
    .action(async (siteIdentifier: string, opts: any) => {
      requireAuth();

      const resolveSpin = spinner('Resolving site...');
      resolveSpin.start();
      let site;
      try {
        site = await resolveSite(siteIdentifier);
        resolveSpin.succeed(`Site: ${site.name || site.sub_domain} (ID: ${site.id})`);
      } catch {
        resolveSpin.fail('Site resolution failed');
        process.exit(1);
      }

      const conn = await ensureSshAccess(site.id);
      const wpPath = `/home/${conn.username}/web/${conn.domain}/public_html`;

      const compress = opts.compress !== false;
      const siteLabel = sanitizeForFilename(site.name || site.sub_domain || `site-${site.id}`);
      const ext = compress ? 'sql.gz' : 'sql';
      const outputPath = opts.output || `./db-${siteLabel}-${isoTimestamp()}.${ext}`;

      // Make sure the output directory exists
      const outDir = dirname(outputPath);
      if (outDir && outDir !== '.' && !existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
      }

      const dumpSpin = spinner(`Exporting database from ${conn.domain}...`);
      dumpSpin.start();

      // Stream `wp db export -` from remote. If --compress, pipe through gzip on
      // the remote side so we never materialize the uncompressed dump locally.
      const remoteCmd = compress
        ? `cd ${wpPath} && wp db export --single-transaction - | gzip`
        : `cd ${wpPath} && wp db export --single-transaction -`;

      try {
        const { exitCode, stderr } = execViaSshToFile(conn, remoteCmd, outputPath);
        if (exitCode !== 0) {
          dumpSpin.fail('Database export failed');
          if (stderr) error(stderr.trim());
          // Clean up empty/partial file
          try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch { /* ignore */ }
          process.exit(1);
        }
        const sizeBytes = statSync(outputPath).size;
        if (sizeBytes === 0) {
          dumpSpin.fail('Database export produced an empty file');
          try { unlinkSync(outputPath); } catch { /* ignore */ }
          process.exit(1);
        }
        dumpSpin.succeed(`Database exported (${formatBytes(sizeBytes)})`);

        success('Pull complete', {
          file: outputPath,
          size_bytes: sizeBytes,
          site_id: site.id,
        });
      } catch (err: any) {
        dumpSpin.fail('Database export failed');
        error(err.message || String(err));
        try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch { /* ignore */ }
        process.exit(1);
      }
    });

  // db push <site> <file>
  db
    .command('push <site> <file>')
    .description('Push local SQL dump to remote site database (creates a backup first)')
    .option('--force', 'Skip confirmation prompt')
    .option('--no-backup', 'Skip taking a remote backup before overwrite (DANGEROUS)')
    .option('--rewrite-prefix', "Rewrite the dump's table prefix to match the remote site's prefix (e.g. wp_ → iwpa4c7_)")
    .option('--search-replace <from-to...>', 'After import, run wp search-replace <from> <to> across all tables (serialization-safe, skips guid). Pass exactly two URLs.')
    .addHelpText('after', `
Notes:
  - Always takes a remote backup first unless --no-backup is passed.
  - Table prefix: if the dump's prefix differs from the remote site's prefix,
    the import would create orphan tables the site never reads. The push detects
    this and offers to rewrite; pass --rewrite-prefix to do it non-interactively
    (also remaps the role/capability keys so admin login survives).
  - URLs: after a cross-domain push, remap URLs with:
      --search-replace <old-url> <new-url>
    (or run 'instawp wp <site> search-replace <old-url> <new-url>' yourself).

Examples:
  $ instawp db push my-site dump.sql --rewrite-prefix
  $ instawp db push my-site dump.sql --search-replace http://localhost:10115 https://my-site.instawp.site
`)
    .action(async (siteIdentifier: string, file: string, opts: any) => {
      requireAuth();

      // Validate input file
      if (!existsSync(file)) {
        error(`File not found: ${file}`);
        process.exit(1);
      }
      const localSize = statSync(file).size;
      if (localSize === 0) {
        error(`File is empty: ${file}`);
        process.exit(1);
      }

      // Parse --search-replace (expects exactly two URLs: from, to)
      let srFrom: string | undefined;
      let srTo: string | undefined;
      if (opts.searchReplace !== undefined) {
        const vals = Array.isArray(opts.searchReplace) ? opts.searchReplace : [opts.searchReplace];
        if (vals.length !== 2) {
          error('--search-replace expects exactly two values: <from-url> <to-url>');
          process.exit(1);
        }
        [srFrom, srTo] = vals;
        if (!isShellSafeUrl(srFrom!) || !isShellSafeUrl(srTo!)) {
          error('--search-replace URLs must be plain http(s) URLs (no spaces, quotes, or shell metacharacters)');
          process.exit(1);
        }
      }

      // In JSON mode, can't prompt — require --force
      if (isJsonMode() && !opts.force) {
        error('--force is required when using --json (cannot prompt for confirmation)');
        process.exit(1);
      }

      const resolveSpin = spinner('Resolving site...');
      resolveSpin.start();
      let site;
      try {
        site = await resolveSite(siteIdentifier);
        resolveSpin.succeed(`Site: ${site.name || site.sub_domain} (ID: ${site.id})`);
      } catch {
        resolveSpin.fail('Site resolution failed');
        process.exit(1);
      }

      const conn = await ensureSshAccess(site.id);
      const wpPath = `/home/${conn.username}/web/${conn.domain}/public_html`;
      const remoteHome = `/home/${conn.username}`;

      const timestamp = isoTimestamp();
      const backupFilename = `db-backup-${timestamp}.sql.gz`;
      const backupRemotePath = `${remoteHome}/${backupFilename}`;
      const takeBackup = opts.backup !== false;

      // Confirmation
      if (!opts.force) {
        const backupLine = takeBackup
          ? `A backup will be saved to ~/${backupFilename} on the remote.`
          : chalk.red('NO BACKUP will be taken (--no-backup). This is irreversible.');
        console.log(`\nThis will ${chalk.bold.red('OVERWRITE')} the database on ${chalk.bold(conn.domain)}.`);
        console.log(backupLine);
        const ok = await promptYesNo('Continue? (y/N) ');
        if (!ok) {
          info('Cancelled.');
          return;
        }
      }

      // Start the clock once the actual work begins (excludes prompt think-time).
      const startedAt = Date.now();

      // Step 1: Backup
      if (takeBackup) {
        const backupSpin = spinner(`Backing up remote database to ~/${backupFilename}...`);
        backupSpin.start();
        const backupCmd = `cd ${wpPath} && wp db export --single-transaction - | gzip > ${backupRemotePath}`;
        const backupResult = execViaSsh(conn, backupCmd);
        if (backupResult.exitCode !== 0) {
          backupSpin.fail('Backup failed — aborting push');
          if (backupResult.stderr) error(backupResult.stderr.trim());
          process.exit(1);
        }
        backupSpin.succeed(`Backup saved: ~/${backupFilename}`);
      } else {
        info('Skipping backup (--no-backup)');
      }

      // ---- Local temp tracking (decompressed / prefix-rewritten dumps) ----
      const localTemps = new Set<string>();
      const cleanupLocalTemps = () => {
        for (const f of localTemps) { try { unlinkSync(f); } catch { /* ignore */ } }
        localTemps.clear();
      };
      const tmpDir = process.env.TMPDIR || '/tmp';

      // Step 2: Prepare local SQL (gunzip if needed)
      const isGzipped = file.endsWith('.gz') || file.endsWith('.gzip');
      let uploadSource = file;

      if (isGzipped) {
        const decompressSpin = spinner('Decompressing local dump...');
        decompressSpin.start();
        try {
          const decompressedPath = join(tmpDir, `instawp-db-push-${randomBytes(6).toString('hex')}.sql`);
          localTemps.add(decompressedPath);
          await gunzipFile(file, decompressedPath);
          uploadSource = decompressedPath;
          const decompressedSize = statSync(uploadSource).size;
          decompressSpin.succeed(`Decompressed (${formatBytes(decompressedSize)})`);
        } catch (err: any) {
          decompressSpin.fail('Decompression failed');
          error(err.message || String(err));
          cleanupLocalTemps();
          if (takeBackup) info(`Remote backup preserved: ~/${backupFilename}`);
          process.exit(1);
        }
      }

      // Step 2b: Table-prefix safety. A dump whose prefix differs from the remote
      // site's prefix imports "successfully" but creates orphan tables the site
      // never reads (exit 0, silent breakage). Detect it, and on request rewrite
      // the dump's identifiers + remap the prefix-bound role keys after import.
      let remapFromPrefix: string | null = null; // set when we rewrite — fixes role/cap keys post-import
      let remotePrefix = 'wp_';
      {
        const pfxRes = execViaSsh(conn, `cd ${wpPath} && wp config get table_prefix`);
        remotePrefix = parseTablePrefix(pfxRes.exitCode === 0 ? pfxRes.stdout : '', 'wp_');
        const dumpPrefix = detectDumpPrefix(readSqlHead(uploadSource));

        if (dumpPrefix !== null && dumpPrefix !== remotePrefix) {
          console.log('');
          console.log(chalk.yellow(`⚠ Table-prefix mismatch: dump uses '${dumpPrefix}' but ${conn.domain} uses '${remotePrefix}'.`));
          console.log(chalk.yellow('  Importing as-is would create orphan tables the site never reads.'));

          let doRewrite = opts.rewritePrefix === true;
          if (!doRewrite) {
            if (opts.force) {
              // Non-interactive (or --json): never silently break, but respect --force.
              info("Proceeding without rewrite (pass --rewrite-prefix to remap the dump's prefix).");
            } else {
              doRewrite = await promptYesNo(`Rewrite the dump's prefix '${dumpPrefix}' -> '${remotePrefix}' before importing? (Y/n) `, true);
              if (!doRewrite) {
                const proceed = await promptYesNo('Import anyway with the mismatched prefix? (y/N) ', false);
                if (!proceed) { info('Cancelled.'); cleanupLocalTemps(); return; }
              }
            }
          }

          if (doRewrite) {
            const rwSpin = spinner(`Rewriting dump prefix '${dumpPrefix}' -> '${remotePrefix}'...`);
            rwSpin.start();
            try {
              const rewrittenPath = join(tmpDir, `instawp-db-push-rw-${randomBytes(6).toString('hex')}.sql`);
              localTemps.add(rewrittenPath);
              await rewriteDumpPrefix(uploadSource, rewrittenPath, dumpPrefix, remotePrefix);
              uploadSource = rewrittenPath;
              remapFromPrefix = dumpPrefix;
              rwSpin.succeed('Dump prefix rewritten');
            } catch (err: any) {
              rwSpin.fail('Prefix rewrite failed');
              error(err.message || String(err));
              cleanupLocalTemps();
              if (takeBackup) info(`Remote backup preserved: ~/${backupFilename}`);
              process.exit(1);
            }
          }
        } else if (dumpPrefix === null && opts.rewritePrefix) {
          info("Could not detect the dump's table prefix — skipping --rewrite-prefix.");
        }
      }

      // Step 3: Upload via scp to /tmp on remote
      const remoteTempName = `db-import-${randomBytes(6).toString('hex')}.sql`;
      const remoteTempPath = `/tmp/${remoteTempName}`;

      const uploadSpin = spinner(`Uploading ${basename(uploadSource)} to remote...`);
      uploadSpin.start();
      const scpExit = scpUpload(conn, uploadSource, remoteTempPath);
      if (scpExit !== 0) {
        uploadSpin.fail(`Upload failed (scp exit ${scpExit})`);
        cleanupLocalTemps();
        if (takeBackup) info(`Remote backup preserved: ~/${backupFilename}`);
        process.exit(1);
      }
      uploadSpin.succeed('Upload complete');

      // Clean up local temp files (we have it on remote now)
      cleanupLocalTemps();

      // Step 4: Import on remote
      const importSpin = spinner(`Importing database on ${conn.domain}...`);
      importSpin.start();
      const importResult = execViaSsh(
        conn,
        `cd ${wpPath} && wp db import ${remoteTempPath}`,
      );

      if (importResult.exitCode !== 0) {
        importSpin.fail('Import failed');
        if (importResult.stderr) error(importResult.stderr.trim());
        else if (importResult.stdout) error(importResult.stdout.trim());

        // Clean up temp file on remote even on failure (best effort)
        execViaSsh(conn, `rm -f ${remoteTempPath}`);

        if (takeBackup) {
          console.log('');
          info(`Remote backup preserved at: ~/${backupFilename}`);
          info('To restore:');
          console.log(`  ssh ${conn.username}@${conn.host} 'cd ${wpPath} && gunzip -c ${backupRemotePath} | wp db import -'`);
          console.log(`  ${chalk.dim('# or pull the backup down and re-push:')}`);
          console.log(`  scp ${conn.username}@${conn.host}:${backupRemotePath} ./`);
          console.log(`  instawp db push ${siteIdentifier} ./${backupFilename}`);
        } else {
          error('No backup was taken — database state may be inconsistent.');
        }
        process.exit(1);
      }
      importSpin.succeed('Database imported');

      // Step 4b: If we rewrote the table prefix, the role/capability keys stored
      // in the data still carry the OLD prefix (they're values, not identifiers).
      // Remap them so the admin keeps its capabilities and wp-admin stays usable.
      if (remapFromPrefix && remapFromPrefix !== remotePrefix) {
        const capSpin = spinner('Remapping user roles/capabilities to the remote prefix...');
        capSpin.start();
        const um = `${remotePrefix}usermeta`;
        const opt = `${remotePrefix}options`;
        const stmts = [
          `UPDATE ${um} SET meta_key='${remotePrefix}capabilities' WHERE meta_key='${remapFromPrefix}capabilities'`,
          `UPDATE ${um} SET meta_key='${remotePrefix}user_level' WHERE meta_key='${remapFromPrefix}user_level'`,
          `UPDATE ${opt} SET option_name='${remotePrefix}user_roles' WHERE option_name='${remapFromPrefix}user_roles'`,
        ];
        let capOk = true;
        for (const s of stmts) {
          const r = execViaSsh(conn, `cd ${wpPath} && wp db query "${s}"`);
          if (r.exitCode !== 0) { capOk = false; if (r.stderr) error(r.stderr.trim()); }
        }
        if (capOk) capSpin.succeed('Roles/capabilities remapped');
        else capSpin.fail('Could not remap roles/capabilities — wp-admin access may need a manual fix');
      }

      // Step 4c: Optional URL search-replace (serialization-safe, server-side).
      // Skip `guid` — post GUIDs are permanent identifiers, not links, and WP
      // best practice is to never rewrite them on a domain change.
      if (srFrom && srTo) {
        const srSpin = spinner(`Rewriting URLs (${srFrom} -> ${srTo})...`);
        srSpin.start();
        const srRes = execViaSsh(conn, `cd ${wpPath} && wp search-replace '${srFrom}' '${srTo}' --all-tables --skip-columns=guid --report-changed-only`);
        if (srRes.exitCode === 0) {
          srSpin.succeed('URLs rewritten');
          if (!isJsonMode() && srRes.stdout.trim()) console.log(srRes.stdout.trim());
        } else {
          srSpin.fail('URL search-replace failed (DB imported; run it manually if links are wrong)');
          if (srRes.stderr) error(srRes.stderr.trim());
        }
      }

      // Step 5: Cleanup remote temp file
      const cleanupSpin = spinner('Cleaning up...');
      cleanupSpin.start();
      const cleanupResult = execViaSsh(conn, `rm -f ${remoteTempPath}`);
      if (cleanupResult.exitCode !== 0) {
        cleanupSpin.fail(`Could not remove ${remoteTempPath} (non-fatal)`);
      } else {
        cleanupSpin.succeed('Cleanup complete');
      }

      const elapsedSec = (Date.now() - startedAt) / 1000;
      const rate = elapsedSec > 0 ? `${formatBytes(localSize / elapsedSec)}/s` : 'n/a';
      const elapsedStr = `${elapsedSec < 10 ? elapsedSec.toFixed(1) : Math.round(elapsedSec)}s (${rate})`;

      success('Push complete', {
        site_id: site.id,
        backup_path: takeBackup ? backupRemotePath : null,
        restored_from: file,
        size_bytes: localSize,
        rewrote_prefix: remapFromPrefix ? `${remapFromPrefix} -> ${remotePrefix}` : null,
        search_replaced: srFrom && srTo ? `${srFrom} -> ${srTo}` : null,
        elapsed: elapsedStr,
      });

      if (!isJsonMode() && takeBackup) {
        console.log(`\n  ${chalk.dim('Backup:')} ~/${backupFilename} ${chalk.dim('(on remote)')}`);
      }
    });
}
