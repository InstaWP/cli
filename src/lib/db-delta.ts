// Memory-bounded engine for `db push --incremental` (#17).
//
// The naive approach (load both 181 MB dumps as strings → split → per-row Maps
// for both) blew past Node's ~4 GB heap (B3). Instead:
//   - the BASELINE is stored as a compact per-row hash MANIFEST (PK → content
//     hash) — not the full SQL;
//   - the CURRENT dump is STREAMED line-by-line (gz decompressed on the fly),
//     each row hashed and compared to the manifest; only CHANGED rows are
//     materialized into the delta.
// Peak memory ≈ manifest size (tens of MB), independent of dump size.
//
// A line-oriented state machine also makes the B1 class of bug structural: only
// a line *starting* with `CREATE TABLE` is schema; "CREATE TABLE …" inside a
// single-line INSERT's row data is always a row, never DDL.
//
// Input requirement: a per-row dump (`mysqldump --skip-extended-insert
// --order-by-primary`). An extended-insert dump throws ExtendedInsertError.
import { createHash } from 'node:crypto';

export class ExtendedInsertError extends Error {}

export interface TableSchema {
  columns: string[];
  pkCol: string | null;
  pkIndex: number;
}

export interface Manifest {
  version: number;
  fingerprint: string;
  // single-column-PK tables: PK literal → row content hash
  single: Map<string, { pkCol: string; pkIndex: number; rows: Map<string, number> }>;
  // composite / no-PK tables: order-independent aggregate (can only detect change)
  composite: Map<string, { count: number; sum: string }>;
}

export interface DiffResult {
  mode: 'delta' | 'full';
  reason?: string;
  sql?: string;
  stats?: { tablesChanged: number; replaces: number; deletes: number };
  newManifest: Manifest;
}

const CORE_SUFFIXES = ['options', 'users', 'posts', 'postmeta', 'usermeta', 'comments', 'commentmeta', 'term_taxonomy', 'term_relationships', 'termmeta', 'terms', 'links'];

/** Derive the table prefix (e.g. `wp_`) from a set of table names, or null. */
export function prefixFromTableNames(names: Iterable<string>): string | null {
  const arr = [...names];
  for (const suf of CORE_SUFFIXES) {
    for (const n of arr) if (n.endsWith(suf)) return n.slice(0, n.length - suf.length);
  }
  return null;
}

/** Fast 53-bit string hash (cyrb53) — for row content change-detection, not crypto. */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Split a VALUES tuple body (without outer parens) into top-level fields. */
export function splitSqlTuple(inner: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inStr) {
      if (c === '\\') { cur += c + (inner[i + 1] ?? ''); i++; continue; }
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

/** Parse one INSERT statement into its table + tuple bodies (>1 tuple = extended). */
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

/** Parse a single CREATE TABLE block → ordered columns + single-column PK. */
function parseCreateBlock(block: string): { table: string; schema: TableSchema } | null {
  const m = block.match(/^CREATE TABLE\s+`([^`]+)`\s*\(([\s\S]*)\n\)/i);
  if (!m) return null;
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
  return { table: m[1], schema: { columns, pkCol, pkIndex: pkCol ? columns.indexOf(pkCol) : -1 } };
}

function normalizeDdl(ddl: string): string {
  return ddl.replace(/AUTO_INCREMENT=\d+/gi, 'AUTO_INCREMENT=').replace(/\s+/g, ' ').trim();
}

function fingerprintFromBlocks(blocks: string[]): string {
  return createHash('sha256').update([...blocks].sort().join('\n')).digest('hex');
}

type DumpEvent =
  | { kind: 'schema'; table: string; ddl: string; schema: TableSchema }
  | { kind: 'row'; table: string; tuple: string }
  | { kind: 'extended' };

/** Stream a dump's lines into schema/row events (line-oriented state machine). */
async function* parseDumpStream(lines: AsyncIterable<string> | Iterable<string>): AsyncGenerator<DumpEvent> {
  let block: string[] | null = null;
  for await (const raw of lines) {
    if (block !== null) {
      block.push(raw);
      if (/^\)/.test(raw)) {
        const ddl = block.join('\n');
        block = null;
        const parsed = parseCreateBlock(ddl);
        if (parsed) yield { kind: 'schema', table: parsed.table, ddl, schema: parsed.schema };
      }
      continue;
    }
    if (/^CREATE TABLE/i.test(raw)) { block = [raw]; continue; }
    if (/^\s*INSERT INTO/i.test(raw)) {
      const stmt = parseInsertStatement(raw.trim());
      if (!stmt) continue;
      if (stmt.tuples.length !== 1) { yield { kind: 'extended' }; continue; }
      yield { kind: 'row', table: stmt.table, tuple: stmt.tuples[0] };
    }
  }
}

function emptyManifest(): Manifest {
  return { version: 1, fingerprint: '', single: new Map(), composite: new Map() };
}

/** Build a hash manifest from a (streamed) per-row dump. Throws on extended insert. */
export async function buildManifest(lines: AsyncIterable<string> | Iterable<string>): Promise<Manifest> {
  const schemas = new Map<string, TableSchema>();
  const ddlBlocks: string[] = [];
  const single = new Map<string, { pkCol: string; pkIndex: number; rows: Map<string, number> }>();
  const composite = new Map<string, { count: number; sum: bigint }>();

  for await (const ev of parseDumpStream(lines)) {
    if (ev.kind === 'extended') throw new ExtendedInsertError();
    if (ev.kind === 'schema') { schemas.set(ev.table, ev.schema); ddlBlocks.push(normalizeDdl(ev.ddl)); continue; }
    const sch = schemas.get(ev.table);
    const h = cyrb53(ev.tuple);
    if (sch && sch.pkCol != null && sch.pkIndex >= 0) {
      const pk = splitSqlTuple(ev.tuple)[sch.pkIndex];
      let t = single.get(ev.table);
      if (!t) { t = { pkCol: sch.pkCol, pkIndex: sch.pkIndex, rows: new Map() }; single.set(ev.table, t); }
      t.rows.set(pk, h);
    } else {
      let agg = composite.get(ev.table);
      if (!agg) { agg = { count: 0, sum: 0n }; composite.set(ev.table, agg); }
      agg.count++;
      agg.sum += BigInt(h);
    }
  }

  const m = emptyManifest();
  m.fingerprint = fingerprintFromBlocks(ddlBlocks);
  m.single = single;
  m.composite = new Map([...composite].map(([t, a]) => [t, { count: a.count, sum: a.sum.toString() }]));
  return m;
}

/**
 * Stream the current dump and diff it against the baseline manifest. Builds the
 * NEW manifest as it goes (so the caller can re-base without another pass).
 * Returns mode:'full' (with the new manifest) when a delta can't be expressed
 * (schema/DDL change, or a composite-PK table actually changed).
 */
export async function diffAgainstManifest(
  lines: AsyncIterable<string> | Iterable<string>,
  baseline: Manifest,
  opts: { dumpPrefix: string; remotePrefix: string },
): Promise<DiffResult> {
  const { dumpPrefix, remotePrefix } = opts;
  const remap = (t: string) => (t.startsWith(dumpPrefix) ? remotePrefix + t.slice(dumpPrefix.length) : t);

  const schemas = new Map<string, TableSchema>();
  const ddlBlocks: string[] = [];
  // working copy of baseline single-PK rows → remaining ones = DELETEs
  const remaining = new Map<string, Map<string, number>>();
  for (const [t, info] of baseline.single) remaining.set(t, new Map(info.rows));
  // new manifest accumulators
  const newSingle = new Map<string, { pkCol: string; pkIndex: number; rows: Map<string, number> }>();
  const newComposite = new Map<string, { count: number; sum: bigint }>();

  const stmts: string[] = [];
  const changed = new Set<string>();
  let replaces = 0;
  let deletes = 0;

  for await (const ev of parseDumpStream(lines)) {
    if (ev.kind === 'extended') throw new ExtendedInsertError();
    if (ev.kind === 'schema') { schemas.set(ev.table, ev.schema); ddlBlocks.push(normalizeDdl(ev.ddl)); continue; }
    const sch = schemas.get(ev.table);
    const h = cyrb53(ev.tuple);
    if (sch && sch.pkCol != null && sch.pkIndex >= 0) {
      const pk = splitSqlTuple(ev.tuple)[sch.pkIndex];
      let nt = newSingle.get(ev.table);
      if (!nt) { nt = { pkCol: sch.pkCol, pkIndex: sch.pkIndex, rows: new Map() }; newSingle.set(ev.table, nt); }
      nt.rows.set(pk, h);

      const baseRows = remaining.get(ev.table);
      if (baseRows && baseRows.has(pk)) {
        if (baseRows.get(pk) !== h) {
          stmts.push(`REPLACE INTO \`${remap(ev.table)}\` VALUES (${ev.tuple});`);
          replaces++;
          changed.add(ev.table);
        }
        baseRows.delete(pk); // seen → not a DELETE
      } else {
        stmts.push(`REPLACE INTO \`${remap(ev.table)}\` VALUES (${ev.tuple});`);
        replaces++;
        changed.add(ev.table);
      }
    } else {
      let agg = newComposite.get(ev.table);
      if (!agg) { agg = { count: 0, sum: 0n }; newComposite.set(ev.table, agg); }
      agg.count++;
      agg.sum += BigInt(h);
    }
  }

  const newManifest = emptyManifest();
  newManifest.fingerprint = fingerprintFromBlocks(ddlBlocks);
  newManifest.single = newSingle;
  newManifest.composite = new Map([...newComposite].map(([t, a]) => [t, { count: a.count, sum: a.sum.toString() }]));

  if (newManifest.fingerprint !== baseline.fingerprint) {
    return { mode: 'full', reason: 'schema/DDL changed since the baseline', newManifest };
  }

  // composite / no-PK tables: detect change via aggregate; can't row-diff.
  const compTables = new Set<string>([...newComposite.keys(), ...baseline.composite.keys()]);
  for (const t of compTables) {
    const cur = newComposite.get(t);
    const curCount = cur ? cur.count : 0;
    const curSum = cur ? cur.sum : 0n;
    const base = baseline.composite.get(t);
    const baseCount = base ? base.count : 0;
    const baseSum = base ? BigInt(base.sum) : 0n;
    if (curCount !== baseCount || curSum !== baseSum) {
      return { mode: 'full', reason: `table \`${t}\` changed but has no single-column primary key`, newManifest };
    }
  }

  // DELETEs: baseline single-PK rows not present in current.
  for (const [t, rows] of remaining) {
    if (!rows.size) continue;
    const pkCol = baseline.single.get(t)?.pkCol ?? schemas.get(t)?.pkCol;
    if (!pkCol) continue;
    const remTable = remap(t);
    for (const pk of rows.keys()) {
      stmts.push(`DELETE FROM \`${remTable}\` WHERE \`${pkCol}\`=${pk};`);
      deletes++;
      changed.add(t);
    }
  }

  const stats = { tablesChanged: changed.size, replaces, deletes };
  const sql = stmts.length
    ? `SET FOREIGN_KEY_CHECKS=0;\nSET sql_mode='NO_AUTO_VALUE_ON_ZERO';\n${stmts.join('\n')}\n`
    : '';
  return { mode: 'delta', sql, stats, newManifest };
}

/** Serialize a manifest to a compact JSON string (Maps → arrays). */
export function serializeManifest(m: Manifest): string {
  return JSON.stringify({
    version: m.version,
    fingerprint: m.fingerprint,
    single: [...m.single].map(([t, info]) => [t, info.pkCol, info.pkIndex, [...info.rows]]),
    composite: [...m.composite].map(([t, agg]) => [t, agg.count, agg.sum]),
  });
}

/** Inverse of serializeManifest. */
export function deserializeManifest(s: string): Manifest {
  const o = JSON.parse(s);
  const single = new Map<string, { pkCol: string; pkIndex: number; rows: Map<string, number> }>(
    (o.single ?? []).map((e: any) => [e[0], { pkCol: e[1], pkIndex: e[2], rows: new Map(e[3]) }]),
  );
  const composite = new Map<string, { count: number; sum: string }>(
    (o.composite ?? []).map((e: any) => [e[0], { count: e[1], sum: e[2] }]),
  );
  return { version: o.version ?? 1, fingerprint: o.fingerprint ?? '', single, composite };
}
