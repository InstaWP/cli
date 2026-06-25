import { Command } from 'commander';
import { join, dirname, basename } from 'node:path';
import { existsSync, mkdirSync, statSync, createReadStream, createWriteStream, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
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
import { waitForHttp } from '../lib/http-ready.js';
import { parseBackupList, selectBackupsToPrune, type RemoteBackup } from '../lib/db-backups.js';
import { computeDelta, hasExtendedInsert, schemaFingerprint, type DeltaResult } from '../lib/db-delta.js';
import { loadBaseline, saveBaseline } from '../lib/db-baseline.js';
import { success, error, spinner, info, table, isJsonMode } from '../lib/output.js';
import type { SshConnection } from '../types.js';

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

/** Resolve a site and open an SSH connection (shared by the backups subcommands). */
async function resolveAndConnect(siteIdentifier: string): Promise<{ site: any; conn: SshConnection }> {
  const rspin = spinner('Resolving site...');
  rspin.start();
  let site: any;
  try {
    site = await resolveSite(siteIdentifier);
    rspin.succeed(`Site: ${site.name || site.sub_domain} (ID: ${site.id})`);
  } catch {
    rspin.fail('Site resolution failed');
    process.exit(1);
  }
  const conn = await ensureSshAccess(site.id);
  return { site, conn };
}

/** List `~/db-backup-*.sql.gz` on the remote (the files `db push` writes), newest first. */
function listRemoteBackups(conn: SshConnection): RemoteBackup[] {
  // GNU stat interprets the \t escapes; the for-loop guard avoids a literal glob
  // when nothing matches. parseBackupList tolerates any MOTD/banner lines.
  const cmd = `for f in ~/db-backup-*.sql.gz; do [ -e "$f" ] && stat -c '%n\\t%s\\t%Y' "$f"; done`;
  const res = execViaSsh(conn, cmd);
  return parseBackupList(res.stdout || '');
}

function isGzipped(file: string): boolean {
  return file.endsWith('.gz') || file.endsWith('.gzip');
}

/** Read the passed dump as plain SQL text (decompressing a .gz to a tracked temp). */
async function loadCanonicalDump(file: string, localTemps: Set<string>): Promise<string> {
  if (!isGzipped(file)) return readFileSync(file, 'utf-8');
  const tmp = join(process.env.TMPDIR || '/tmp', `instawp-incr-${randomBytes(6).toString('hex')}.sql`);
  localTemps.add(tmp);
  await gunzipFile(file, tmp);
  return readFileSync(tmp, 'utf-8');
}

/**
 * #17 — incremental push decision. Returns done=true if it fully handled the
 * push (delta applied, no-op, or cancelled); done=false to fall through to the
 * full push, carrying the baseline to persist after it succeeds. Additive: never
 * mutates the full-push path.
 */
async function prepareIncremental(p: {
  file: string; site: any; conn: SshConnection; wpPath: string; remoteHome: string; opts: any;
  srFrom?: string; srTo?: string; srTables: string[];
}): Promise<{ done: boolean; baseline?: { sql: string; fingerprint: string } }> {
  const { file, site, conn, wpPath, remoteHome, opts, srFrom, srTo, srTables } = p;
  const localTemps = new Set<string>();
  const cleanup = () => { for (const f of localTemps) { try { unlinkSync(f); } catch { /* ignore */ } } };
  try {
    const sql = await loadCanonicalDump(file, localTemps);
    if (hasExtendedInsert(sql)) {
      error('--incremental needs a per-row dump. Re-export with: mysqldump --skip-extended-insert --order-by-primary (or `wp db export` with those flags).');
      process.exit(1);
    }
    const fingerprint = schemaFingerprint(sql);
    const baseline = loadBaseline(site.id);

    // Full (re)base required → fall through to the full push, refresh baseline after.
    if (opts.full || !baseline || baseline.fingerprint !== fingerprint) {
      const why = opts.full ? '--full requested' : !baseline ? 'no baseline yet (first incremental push)' : 'schema changed since the baseline';
      info(`Full push (${why}); the incremental baseline will be refreshed afterwards.`);
      return { done: false, baseline: { sql, fingerprint } };
    }

    // Compute the row delta vs the stored baseline.
    const pfxRes = execViaSsh(conn, `cd ${wpPath} && wp config get table_prefix`);
    const remotePrefix = parseTablePrefix(pfxRes.exitCode === 0 ? pfxRes.stdout : '', 'wp_');
    const dumpPrefix = detectDumpPrefix(sql) ?? 'wp_';
    const delta = computeDelta({ baselineSql: baseline.sql, currentSql: sql, dumpPrefix, remotePrefix });

    if (delta.mode === 'full') {
      info(`Full push (${delta.reason}); the incremental baseline will be refreshed afterwards.`);
      return { done: false, baseline: { sql, fingerprint } };
    }

    if (!delta.sql) {
      info('No changes since the last push.');
      saveBaseline(site.id, sql, fingerprint, new Date().toISOString());
      success('Incremental push complete', { site_id: site.id, changed: false, replaces: 0, deletes: 0, tables_changed: 0 });
      return { done: true };
    }

    if (!opts.force && !isJsonMode()) {
      console.log(`\nIncremental push to ${chalk.bold(conn.domain)}: ${chalk.bold(String(delta.stats!.replaces))} change(s), ${chalk.bold(String(delta.stats!.deletes))} deletion(s) across ${delta.stats!.tablesChanged} table(s). A backup is taken first.`);
      const ok = await promptYesNo('Apply this delta? (y/N) ');
      if (!ok) { info('Cancelled.'); return { done: true }; }
    }

    await applyDelta({ conn, wpPath, remoteHome, site, delta, takeBackup: opts.backup !== false, remapFrom: dumpPrefix, remotePrefix, srFrom, srTo, srTables, verify: !!opts.verify });
    saveBaseline(site.id, sql, fingerprint, new Date().toISOString());
    return { done: true };
  } finally {
    cleanup();
  }
}

/** Apply a computed delta to the remote (backup → upload → import → remap → search-replace → verify). */
async function applyDelta(p: {
  conn: SshConnection; wpPath: string; remoteHome: string; site: any; delta: DeltaResult;
  takeBackup: boolean; remapFrom: string; remotePrefix: string; srFrom?: string; srTo?: string; srTables: string[]; verify: boolean;
}): Promise<void> {
  const { conn, wpPath, remoteHome, site, delta, takeBackup, remapFrom, remotePrefix, srFrom, srTo, srTables, verify } = p;
  const startedAt = Date.now();
  const backupFilename = `db-backup-${isoTimestamp()}.sql.gz`;
  const backupRemotePath = `${remoteHome}/${backupFilename}`;

  if (takeBackup) {
    const s = spinner(`Backing up remote database to ~/${backupFilename}...`);
    s.start();
    const r = execViaSsh(conn, `cd ${wpPath} && wp db export --single-transaction - | gzip > ${backupRemotePath}`);
    if (r.exitCode !== 0) { s.fail('Backup failed — aborting delta'); if (r.stderr) error(r.stderr.trim()); process.exit(1); }
    s.succeed(`Backup saved: ~/${backupFilename}`);
  } else {
    info('Skipping backup (--no-backup)');
  }

  const remoteTemp = `/tmp/db-delta-${randomBytes(6).toString('hex')}.sql`;
  const localTemp = join(process.env.TMPDIR || '/tmp', `instawp-db-delta-${randomBytes(6).toString('hex')}.sql`);
  writeFileSync(localTemp, delta.sql!, 'utf-8');
  const up = spinner('Uploading delta...');
  up.start();
  const scpExit = scpUpload(conn, localTemp, remoteTemp);
  try { unlinkSync(localTemp); } catch { /* ignore */ }
  if (scpExit !== 0) { up.fail(`Upload failed (scp exit ${scpExit})`); if (takeBackup) info(`Remote backup preserved: ~/${backupFilename}`); process.exit(1); }
  up.succeed('Delta uploaded');

  const imp = spinner(`Applying delta (${delta.stats!.replaces} change, ${delta.stats!.deletes} delete) on ${conn.domain}...`);
  imp.start();
  const ir = execViaSsh(conn, `cd ${wpPath} && wp db import ${remoteTemp}`);
  execViaSsh(conn, `rm -f ${remoteTemp}`);
  if (ir.exitCode !== 0) {
    imp.fail('Delta apply failed');
    if (ir.stderr) error(ir.stderr.trim()); else if (ir.stdout) error(ir.stdout.trim());
    if (takeBackup) {
      console.log('');
      info(`Remote backup preserved at: ~/${backupFilename}`);
      console.log(`  ssh ${conn.username}@${conn.host} 'cd ${wpPath} && gunzip -c ${backupRemotePath} | wp db import -'`);
    }
    process.exit(1);
  }
  imp.succeed('Delta applied');

  // REPLACE'd role/cap rows carry the dump prefix in their key VALUES — remap (idempotent).
  if (remapFrom && remapFrom !== remotePrefix) {
    const cs = spinner('Remapping user roles/capabilities to the remote prefix...');
    cs.start();
    const um = `${remotePrefix}usermeta`;
    const opt = `${remotePrefix}options`;
    const stmts = [
      `UPDATE ${um} SET meta_key='${remotePrefix}capabilities' WHERE meta_key='${remapFrom}capabilities'`,
      `UPDATE ${um} SET meta_key='${remotePrefix}user_level' WHERE meta_key='${remapFrom}user_level'`,
      `UPDATE ${opt} SET option_name='${remotePrefix}user_roles' WHERE option_name='${remapFrom}user_roles'`,
    ];
    let ok = true;
    for (const st of stmts) { const r = execViaSsh(conn, `cd ${wpPath} && wp db query "${st}"`); if (r.exitCode !== 0) { ok = false; if (r.stderr) error(r.stderr.trim()); } }
    if (ok) cs.succeed('Roles/capabilities remapped'); else cs.fail('Could not remap roles/capabilities — wp-admin access may need a manual fix');
  }

  if (srFrom && srTo) {
    const scope = srTables.length ? srTables.join(' ') : '--all-tables';
    const s = spinner(`Rewriting URLs (${srFrom} -> ${srTo})...`);
    s.start();
    const r = execViaSsh(conn, `cd ${wpPath} && wp search-replace '${srFrom}' '${srTo}' ${scope} --skip-columns=guid --report-changed-only`);
    if (r.exitCode === 0) { s.succeed('URLs rewritten'); if (!isJsonMode() && r.stdout.trim()) console.log(r.stdout.trim()); }
    else { s.fail('URL search-replace failed (delta applied; run it manually if links are wrong)'); if (r.stderr) error(r.stderr.trim()); }
  }

  let verified: string | null = null;
  if (verify) {
    const url = String(site.url || `https://${conn.domain}`).replace(/\/+$/, '');
    const s = spinner(`Verifying ${url} responds...`);
    s.start();
    const okv = await waitForHttp(url, 90000);
    if (okv) { s.succeed('Site is responding'); verified = 'ok'; }
    else { s.fail('Site did not respond within 90s (large changes can need a moment)'); verified = 'timeout'; }
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  success('Incremental push complete', {
    site_id: site.id,
    backup_path: takeBackup ? backupRemotePath : null,
    changed: true,
    replaces: delta.stats!.replaces,
    deletes: delta.stats!.deletes,
    tables_changed: delta.stats!.tablesChanged,
    elapsed: `${elapsedSec < 10 ? elapsedSec.toFixed(1) : Math.round(elapsedSec)}s`,
    ...(verified ? { verified } : {}),
  });
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
    .option('--sr-tables <table...>', 'Scope --search-replace to these (prefixed) tables instead of all tables — faster on big DBs whose bulk has no URLs')
    .option('--verify', 'After import, poll the site URL until it responds (large imports can briefly return 000)')
    .option('--incremental', 'Push only the row-level delta since the last push (auto-fulls on first run or schema change). Needs a per-row dump: mysqldump --skip-extended-insert --order-by-primary')
    .option('--full', 'Force a full push and refresh the incremental baseline')
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
    --search-replace scans all tables by default; pass --sr-tables to limit it.
  - --verify confirms the site answers HTTP after the import (reported in the summary).
  - --incremental ships only the row-delta since the last push (baseline stored
    per site under ~/.instawp/baselines/). First run, a schema change, or --full
    do a normal full push and refresh the baseline. Requires a per-row dump
    (mysqldump --skip-extended-insert --order-by-primary). The full push is
    untouched — incremental is purely additive.

Examples:
  $ instawp db push my-site dump.sql --rewrite-prefix --verify
  $ instawp db push my-site dump.sql --search-replace http://localhost:10115 https://my-site.instawp.site
  $ instawp db push my-site dump.sql --search-replace http://old https://new --sr-tables iwpa4c7_options iwpa4c7_posts iwpa4c7_postmeta
  $ instawp db push my-site dump.sql --incremental    # delta vs baseline (full push + baseline on first run)
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

      // Parse/validate --sr-tables (table names go into a shell command — keep identifier-safe)
      const srTables: string[] = Array.isArray(opts.srTables) ? opts.srTables : [];
      if (srTables.length) {
        const bad = srTables.filter((t) => !/^[A-Za-z0-9_]+$/.test(t));
        if (bad.length) {
          error(`--sr-tables: invalid table name(s): ${bad.join(', ')} (use plain prefixed table names)`);
          process.exit(1);
        }
        if (!srFrom) {
          error('--sr-tables only applies with --search-replace');
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

      // #17 — incremental delta push (additive). May fully handle the push and
      // return; otherwise falls through to the full push below (unchanged) and
      // refreshes the baseline once it succeeds.
      let baselineToSave: { sql: string; fingerprint: string } | null = null;
      if (opts.incremental || opts.full) {
        const decision = await prepareIncremental({ file, site, conn, wpPath, remoteHome, opts, srFrom, srTo, srTables });
        if (decision.done) return;
        baselineToSave = decision.baseline ?? null;
      }

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
        // Scope: explicit (prefixed) tables if --sr-tables given, else all tables.
        const scope = srTables.length ? srTables.join(' ') : '--all-tables';
        const srSpin = spinner(`Rewriting URLs (${srFrom} -> ${srTo})...`);
        srSpin.start();
        const srRes = execViaSsh(conn, `cd ${wpPath} && wp search-replace '${srFrom}' '${srTo}' ${scope} --skip-columns=guid --report-changed-only`);
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

      // Step 6: Optional readiness check. A large import can briefly leave the
      // site returning 000 right after import/flush; poll until it answers.
      let verified: string | null = null;
      if (opts.verify) {
        const siteUrl = String(site.url || `https://${conn.domain}`).replace(/\/+$/, '');
        const vSpin = spinner(`Verifying ${siteUrl} responds...`);
        vSpin.start();
        const ok = await waitForHttp(siteUrl, 90000);
        if (ok) { vSpin.succeed('Site is responding'); verified = 'ok'; }
        else { vSpin.fail('Site did not respond within 90s (large imports can need a moment to warm up)'); verified = 'timeout'; }
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
        ...(verified ? { verified } : {}),
      });

      if (!isJsonMode() && takeBackup) {
        console.log(`\n  ${chalk.dim('Backup:')} ~/${backupFilename} ${chalk.dim('(on remote)')}`);
      }

      // #17 — record the baseline after a successful full (re)base, so the next
      // --incremental push can diff against it.
      if (baselineToSave) {
        saveBaseline(site.id, baselineToSave.sql, baselineToSave.fingerprint, new Date().toISOString());
      }
    });

  // db backups list/prune <site> — manage the ~/db-backup-*.sql.gz files db push leaves behind
  const backups = db
    .command('backups')
    .description('List or prune db push backups (~/db-backup-*.sql.gz) on a site');

  backups
    .command('list <site>')
    .description('List the db-backup-*.sql.gz files on the remote site (newest first)')
    .action(async (siteIdentifier: string) => {
      requireAuth();
      const { conn } = await resolveAndConnect(siteIdentifier);
      const list = listRemoteBackups(conn);

      if (isJsonMode()) {
        console.log(JSON.stringify({
          success: true,
          data: { backups: list.map((b) => ({ file: b.file, size_bytes: b.sizeBytes, modified: new Date(b.mtime * 1000).toISOString() })) },
        }));
        return;
      }
      if (!list.length) { info('No backups found (~/db-backup-*.sql.gz).'); return; }
      table(['File', 'Size', 'Modified'], list.map((b) => ({
        file: b.file.replace(/^.*\//, ''),
        size: formatBytes(b.sizeBytes),
        modified: new Date(b.mtime * 1000).toISOString().replace('T', ' ').slice(0, 16),
      })));
      const total = list.reduce((n, b) => n + b.sizeBytes, 0);
      info(`${list.length} backup(s), ${formatBytes(total)} total`);
    });

  backups
    .command('prune <site>')
    .description('Delete old db-backup-*.sql.gz files (keep newest N and/or drop older than D days)')
    .option('--keep <n>', 'Keep the newest N backups, delete the rest', (v) => parseInt(v, 10))
    .option('--older-than <days>', 'Delete backups older than this many days', (v) => parseInt(v, 10))
    .option('--force', 'Skip confirmation prompt')
    .action(async (siteIdentifier: string, opts: any) => {
      requireAuth();
      if (opts.keep === undefined && opts.olderThan === undefined) {
        error('Specify --keep <n> and/or --older-than <days> (refusing to prune without a selector)');
        process.exit(1);
      }
      if ((opts.keep !== undefined && (!Number.isInteger(opts.keep) || opts.keep < 0)) ||
          (opts.olderThan !== undefined && (!Number.isInteger(opts.olderThan) || opts.olderThan < 0))) {
        error('--keep / --older-than must be non-negative integers');
        process.exit(1);
      }
      if (isJsonMode() && !opts.force) {
        error('--force is required when using --json (cannot prompt for confirmation)');
        process.exit(1);
      }

      const { conn } = await resolveAndConnect(siteIdentifier);
      const list = listRemoteBackups(conn);
      const { toDelete, toKeep } = selectBackupsToPrune(
        list,
        { keep: opts.keep, olderThanDays: opts.olderThan },
        Math.floor(Date.now() / 1000),
      );

      if (!toDelete.length) {
        if (isJsonMode()) { console.log(JSON.stringify({ success: true, data: { deleted: [], kept: toKeep.length } })); }
        else { info(`Nothing to prune (${toKeep.length} backup(s) kept).`); }
        return;
      }

      if (!isJsonMode()) {
        const freed = formatBytes(toDelete.reduce((n, b) => n + b.sizeBytes, 0));
        console.log(`Will delete ${chalk.bold.red(String(toDelete.length))} backup(s) (${freed}), keeping ${toKeep.length}:`);
        for (const b of toDelete) console.log(`  ${chalk.dim('-')} ${b.file.replace(/^.*\//, '')}`);
        if (!opts.force) {
          const ok = await promptYesNo('Delete these backups? (y/N) ');
          if (!ok) { info('Cancelled.'); return; }
        }
      }

      const quoted = toDelete.map((b) => `'${b.file.replace(/'/g, "'\\''")}'`).join(' ');
      const rm = execViaSsh(conn, `rm -f ${quoted}`);
      if (rm.exitCode !== 0) {
        error('Failed to delete some backups');
        if (rm.stderr) error(rm.stderr.trim());
        process.exit(1);
      }
      success('Backups pruned', { deleted: toDelete.length, kept: toKeep.length });
    });
}
