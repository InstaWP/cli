import type Database from 'better-sqlite3';
import { openSync, writeSync, closeSync } from 'node:fs';
import { loadSqlite } from './sqlite.js';

/**
 * Generate a MySQL dump from a WordPress Playground SQLite database so a local
 * site's content can be pushed back to its MySQL cloud origin.
 *
 * This is the reverse of `local clone` (which converts MySQL → SQLite via the
 * bundled mysql2sqlite). The hard constraint: we CANNOT reliably reconstruct a
 * valid MySQL schema from the converted SQLite (the original MySQL column types
 * were lost during clone). So this dump is DATA-ONLY — `TRUNCATE` + `INSERT`
 * against the cloud's existing tables — and the caller must restrict it to
 * tables that already exist on the cloud (so a TRUNCATE never hits a missing
 * table and aborts the import). URL/serialization rewriting is intentionally
 * NOT done here; the caller runs `wp search-replace` on the cloud afterwards
 * (serialization-safe).
 */

/** Escape a string for a single-quoted MySQL literal (≈ mysql_real_escape_string). */
export function escapeMysqlString(s: string): string {
  return s.replace(/[\0\b\t\n\r\x1a\\'"]/g, (c) => {
    switch (c) {
      case '\0': return '\\0';
      case '\b': return '\\b';
      case '\t': return '\\t';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\x1a': return '\\Z';
      case '\\': return '\\\\';
      case "'": return "\\'";
      case '"': return '\\"';
      default: return c;
    }
  });
}

/** Format a value read from better-sqlite3 as a MySQL literal. */
export function formatMysqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (Buffer.isBuffer(v)) return v.length ? `0x${v.toString('hex')}` : "''";
  return `'${escapeMysqlString(String(v))}'`;
}

/** Quote a MySQL identifier, escaping embedded backticks. */
export function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

export interface DumpParams {
  /** Path to the Playground SQLite file (…/wp-content/database/.ht.sqlite). */
  sqlitePath: string;
  /** The cloud site's real table prefix (e.g. `wp_`). Local tables are `wp_*`. */
  cloudPrefix: string;
  /** Full table names that exist on the cloud — only their intersection with local is dumped. */
  cloudTables: Set<string>;
  /** Output .sql path. */
  outPath: string;
}

export interface DumpResult {
  /** Local→cloud table names actually written. */
  tables: { local: string; cloud: string; rows: number }[];
  /** Local `wp_*` tables skipped because no matching cloud table exists. */
  skipped: string[];
  totalRows: number;
}

// Flush an accumulated INSERT once it grows past this (keeps under MySQL's
// default max_allowed_packet, typically 16–64 MB).
const MAX_INSERT_BYTES = 4 * 1024 * 1024;

/**
 * Read every `wp_*` table from the SQLite DB whose cloud-prefixed name exists in
 * `cloudTables`, and write a data-only MySQL dump (TRUNCATE + chunked INSERTs)
 * to `outPath`. Returns what was written/skipped.
 */
export function generateMysqlDump(params: DumpParams): DumpResult {
  const { sqlitePath, cloudPrefix, cloudTables, outPath } = params;
  // Open the file first, then the DB inside the try, so a DB-open failure can't
  // leak the fd and vice versa (both closed in finally).
  const fd = openSync(outPath, 'w');
  let db: Database.Database | null = null;
  const result: DumpResult = { tables: [], skipped: [], totalRows: 0 };

  try {
    db = new (loadSqlite())(sqlitePath, { readonly: true });

    writeSync(fd, '-- InstaWP CLI: local SQLite → MySQL data dump\n');
    // Pin a sane sql_mode so our backslash escaping is always honored (a server
    // default of NO_BACKSLASH_ESCAPES would otherwise corrupt/mis-parse data).
    // NO_AUTO_VALUE_ON_ZERO also preserves explicit 0 in auto-increment columns.
    writeSync(fd, 'SET @OLD_SQL_MODE=@@SQL_MODE;\n');
    writeSync(fd, "SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n");
    writeSync(fd, 'SET FOREIGN_KEY_CHECKS=0;\n');
    writeSync(fd, 'SET NAMES utf8mb4;\n\n');

    const localTables = (db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[])
      .map((r) => r.name)
      .filter((n) => n.startsWith('wp_') && !n.startsWith('sqlite_'))
      .sort();

    for (const local of localTables) {
      const suffix = local.slice('wp_'.length);
      const cloud = cloudPrefix + suffix;
      if (!cloudTables.has(cloud)) {
        result.skipped.push(local);
        continue;
      }

      const cloudQ = quoteIdent(cloud);
      writeSync(fd, `\n-- ${local} → ${cloud}\n`);
      writeSync(fd, `TRUNCATE TABLE ${cloudQ};\n`);

      // safeIntegers(true): INTEGER columns arrive as JS bigint, not number, so
      // values above 2^53 (e.g. plugin-stored 64-bit IDs) aren't silently
      // truncated. formatMysqlValue already emits bigint losslessly.
      const stmt = db.prepare(`SELECT * FROM ${quoteIdent(local)}`).raw(true).safeIntegers(true);
      const cols = stmt.columns().map((c) => quoteIdent(c.name)).join(',');
      const insertHead = `INSERT INTO ${cloudQ} (${cols}) VALUES `;

      let rows = 0;
      let batch: string[] = [];
      let batchBytes = 0;
      const flush = () => {
        if (batch.length === 0) return;
        writeSync(fd, insertHead + batch.join(',') + ';\n');
        batch = [];
        batchBytes = 0;
      };
      for (const row of stmt.iterate() as Iterable<unknown[]>) {
        const tuple = '(' + row.map(formatMysqlValue).join(',') + ')';
        // Measure UTF-8 bytes (not JS chars) against the packet budget.
        const tupleBytes = Buffer.byteLength(tuple, 'utf8');
        if (batch.length > 0 && batchBytes + tupleBytes > MAX_INSERT_BYTES) flush();
        batch.push(tuple);
        batchBytes += tupleBytes + 1;
        rows++;
      }
      flush();

      result.tables.push({ local, cloud, rows });
      result.totalRows += rows;
    }

    writeSync(fd, '\nSET FOREIGN_KEY_CHECKS=1;\n');
    writeSync(fd, 'SET SQL_MODE=@OLD_SQL_MODE;\n');
  } finally {
    if (db) db.close();
    closeSync(fd);
  }

  return result;
}
