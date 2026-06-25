// Pure engine for `db push --incremental`: parse two per-row, PK-sorted MySQL
// dumps (baseline vs current) and emit a minimal REPLACE/DELETE delta. NO I/O,
// NO DROP/CREATE — this is the data-mutating surface, so it is kept pure and
// heavily unit-tested. Falls back to a full push (mode:'full') whenever a delta
// can't be expressed safely (schema/DDL change, or a table without a single
// primary key).
//
// Input requirement: dumps produced with `mysqldump --skip-extended-insert
// --order-by-primary` (one row per INSERT, one tuple per statement). Use
// hasExtendedInsert() to reject anything else before diffing.
import { createHash } from 'node:crypto';

export interface TableSchema {
  columns: string[];
  pkCol: string | null; // null when composite or absent → not delta-eligible
  pkIndex: number; // -1 when pkCol is null
}

export interface DeltaResult {
  mode: 'delta' | 'full';
  reason?: string;
  sql?: string;
  stats?: { tablesChanged: number; replaces: number; deletes: number };
}

/** Split a VALUES tuple body (without the outer parens) into top-level fields. */
export function splitSqlTuple(inner: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inStr) {
      if (c === '\\') { cur += c + (inner[i + 1] ?? ''); i++; continue; } // backslash escape
      cur += c;
      if (c === "'") inStr = false;
      continue;
    }
    if (c === "'") { inStr = true; cur += c; continue; }
    if (c === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** Parse one INSERT statement into its table + tuple bodies (>1 tuple = extended insert). */
export function parseInsertStatement(stmt: string): { table: string; tuples: string[] } | null {
  const m = stmt.match(/^INSERT INTO\s+`([^`]+)`\s+(?:\([^)]*\)\s+)?VALUES\s*/i);
  if (!m) return null;
  const rest = stmt.slice(m[0].length);
  const tuples: string[] = [];
  let i = 0;
  while (i < rest.length) {
    if (rest[i] !== '(') { i++; continue; }
    let depth = 0;
    let inStr = false;
    let tuple = '';
    let j = i;
    for (; j < rest.length; j++) {
      const c = rest[j];
      if (inStr) {
        if (c === '\\') { tuple += c + (rest[j + 1] ?? ''); j++; continue; }
        tuple += c;
        if (c === "'") inStr = false;
        continue;
      }
      if (c === "'") { inStr = true; tuple += c; continue; }
      if (c === '(') { depth++; if (depth === 1) continue; tuple += c; continue; }
      if (c === ')') { depth--; if (depth === 0) break; tuple += c; continue; }
      tuple += c;
    }
    tuples.push(tuple);
    i = j + 1;
  }
  return { table: m[1], tuples };
}

/** True if any INSERT carries more than one tuple (i.e. NOT --skip-extended-insert). */
export function hasExtendedInsert(sql: string): boolean {
  for (const raw of sql.split('\n')) {
    const line = raw.trim();
    if (!/^INSERT INTO/i.test(line)) continue;
    const parsed = parseInsertStatement(line);
    if (parsed && parsed.tuples.length > 1) return true;
  }
  return false;
}

/** Parse CREATE TABLE blocks → ordered columns + single-column PK (if any). */
export function parseCreateTables(sql: string): Map<string, TableSchema> {
  const map = new Map<string, TableSchema>();
  // Anchored to line-start (m flag): real mysqldump DDL starts at column 0, so a
  // "CREATE TABLE `x` (" occurring inside a single-line INSERT's row data can't match.
  const re = /^CREATE TABLE\s+`([^`]+)`\s*\(([\s\S]*?)\n\)/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const table = m[1];
    const body = m[2];
    const columns: string[] = [];
    for (const line of body.split('\n')) {
      const cm = line.trim().match(/^`([^`]+)`/);
      if (cm) columns.push(cm[1]);
    }
    let pkCol: string | null = null;
    const pk = body.match(/PRIMARY KEY\s*\(([^)]+)\)/i);
    if (pk) {
      const cols = pk[1].split(',').map((s) => s.trim().replace(/`/g, ''));
      if (cols.length === 1) pkCol = cols[0];
    }
    map.set(table, { columns, pkCol, pkIndex: pkCol ? columns.indexOf(pkCol) : -1 });
  }
  return map;
}

/** Stable hash of the schema (normalized CREATE TABLE DDL), AUTO_INCREMENT stripped. */
export function schemaFingerprint(sql: string): string {
  const blocks: string[] = [];
  // Anchored to line-start (m flag): without it, "CREATE TABLE … );" appearing
  // inside row data (e.g. a post documenting SQL) matched too, lazily sweeping
  // volatile content into the fingerprint → it changed on every data edit →
  // --incremental always fell back to a full push. (AUTO_INCREMENT already stripped.)
  const re = /^CREATE TABLE[\s\S]*?\n\)[^;]*;/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    blocks.push(m[0].replace(/AUTO_INCREMENT=\d+/gi, 'AUTO_INCREMENT=').replace(/\s+/g, ' ').trim());
  }
  blocks.sort();
  return createHash('sha256').update(blocks.join('\n')).digest('hex');
}

/** table → ordered list of single-row INSERT tuple bodies (ALL tables, keyable or not). */
function parseInserts(sql: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const raw of sql.split('\n')) {
    const line = raw.trim();
    if (!/^INSERT INTO/i.test(line)) continue;
    const stmt = parseInsertStatement(line);
    if (!stmt || stmt.tuples.length !== 1) continue;
    if (!map.has(stmt.table)) map.set(stmt.table, []);
    map.get(stmt.table)!.push(stmt.tuples[0]);
  }
  return map;
}

/** Index a table's rows by its single-column PK literal (tuple → keyed map). */
function indexByPk(rows: string[], pkIndex: number): Map<string, string> {
  const m = new Map<string, string>();
  for (const tuple of rows) m.set(splitSqlTuple(tuple)[pkIndex], tuple);
  return m;
}

/** Order-independent equality of two row-tuple lists (rows are unique per table). */
function sameRowSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

/**
 * Compute a REPLACE/DELETE delta to bring the remote (== baseline) to `current`.
 * Table identifiers are emitted in the REMOTE prefix (dumpPrefix → remotePrefix).
 * Returns mode:'full' (with a reason) when a delta can't be safely expressed.
 *
 * A table WITHOUT a single-column primary key (e.g. `wp_term_relationships`,
 * composite PK) can't be row-diffed. Such a table is IGNORED when its row set is
 * unchanged (the common case — present on every WP site), and only forces a full
 * fallback when it actually changed. (Earlier this gated unconditionally, so any
 * site with a populated composite-PK table fell back to full on every push.)
 */
export function computeDelta(opts: {
  baselineSql: string;
  currentSql: string;
  dumpPrefix: string;
  remotePrefix: string;
}): DeltaResult {
  const { baselineSql, currentSql, dumpPrefix, remotePrefix } = opts;

  if (schemaFingerprint(baselineSql) !== schemaFingerprint(currentSql)) {
    return { mode: 'full', reason: 'schema/DDL changed since the baseline' };
  }

  const schemas = parseCreateTables(currentSql);
  const cur = parseInserts(currentSql);
  const base = parseInserts(baselineSql);
  const allTables = new Set<string>([...cur.keys(), ...base.keys()]);

  const remap = (t: string) => (t.startsWith(dumpPrefix) ? remotePrefix + t.slice(dumpPrefix.length) : t);
  const stmts: string[] = [];
  const changed = new Set<string>();
  let replaces = 0;
  let deletes = 0;

  for (const table of allTables) {
    const sch = schemas.get(table);
    const curRows = cur.get(table) ?? [];
    const baseRows = base.get(table) ?? [];

    // No usable single-column PK → can't row-diff. Ignore if unchanged; else full.
    if (!sch || sch.pkCol == null || sch.pkIndex < 0) {
      if (!sameRowSet(baseRows, curRows)) {
        return { mode: 'full', reason: `table \`${table}\` changed but has no single-column primary key` };
      }
      continue;
    }

    const remTable = remap(table);
    const curMap = indexByPk(curRows, sch.pkIndex);
    const baseMap = indexByPk(baseRows, sch.pkIndex);
    for (const [pk, tuple] of curMap) {
      const prev = baseMap.get(pk);
      if (prev === undefined || prev !== tuple) {
        stmts.push(`REPLACE INTO \`${remTable}\` VALUES (${tuple});`);
        replaces++;
        changed.add(table);
      }
    }
    for (const [pk, tuple] of baseMap) {
      if (!curMap.has(pk)) {
        const pkLit = splitSqlTuple(tuple)[sch.pkIndex];
        stmts.push(`DELETE FROM \`${remTable}\` WHERE \`${sch.pkCol}\`=${pkLit};`);
        deletes++;
        changed.add(table);
      }
    }
  }

  const stats = { tablesChanged: changed.size, replaces, deletes };
  if (!stmts.length) return { mode: 'delta', sql: '', stats };
  const sql = `SET FOREIGN_KEY_CHECKS=0;\nSET sql_mode='NO_AUTO_VALUE_ON_ZERO';\n${stmts.join('\n')}\n`;
  return { mode: 'delta', sql, stats };
}
