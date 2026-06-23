import { createReadStream, createWriteStream, openSync, readSync, closeSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Detect the table prefix used inside a MySQL dump by matching the first
 * statement that references a WordPress *core* table (whose suffix is fixed,
 * e.g. `options`, `posts`, `usermeta`). Returns the prefix string (which may be
 * empty for an unprefixed dump), or `null` if no core table is found in the
 * given text — pass a generous head of the file (`wp db export`/mysqldump emit
 * CREATE/INSERT for these tables near the top). Identifiers are backtick-quoted,
 * so we anchor on the trailing backtick to avoid `posts` matching `postmeta`.
 */
export function detectDumpPrefix(sqlHead: string): string | null {
  const re =
    /(?:CREATE TABLE(?: IF NOT EXISTS)?|INSERT INTO|REPLACE INTO|LOCK TABLES|DROP TABLE(?: IF EXISTS)?)\s+`([A-Za-z0-9_]*?)(commentmeta|comments|links|options|postmeta|posts|term_relationships|term_taxonomy|termmeta|terms|usermeta|users)`/i;
  const m = sqlHead.match(re);
  return m ? m[1] : null;
}

/** Read up to `bytes` from the start of a (plain, decompressed) file as UTF-8. */
export function readSqlHead(path: string, bytes = 4 * 1024 * 1024): string {
  const fd = openSync(path, 'r');
  try {
    const size = Math.min(bytes, statSync(path).size);
    const buf = Buffer.alloc(size);
    const read = readSync(fd, buf, 0, size, 0);
    return buf.toString('utf-8', 0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Stream-rewrite a SQL dump, replacing the table-identifier prefix
 * `` `<from>… `` → `` `<to>… ``. `wp db export`/mysqldump backtick-quote table
 * names, so anchoring on the leading backtick rewrites identifiers
 * (CREATE/INSERT/LOCK/DROP) without touching ordinary string data. Done line by
 * line to avoid loading large dumps fully into memory.
 *
 * Note: this rewrites table *names* only. Prefix-bound *values* (the
 * `{prefix}capabilities` / `{prefix}user_level` usermeta keys and the
 * `{prefix}user_roles` option) live in the row data and must be remapped after
 * import — see the `db push` caller.
 */
export async function rewriteDumpPrefix(src: string, dest: string, fromPrefix: string, toPrefix: string): Promise<void> {
  const input = createReadStream(src, { encoding: 'utf-8' });
  const output = createWriteStream(dest, { encoding: 'utf-8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const fromTok = '`' + fromPrefix;
  const toTok = '`' + toPrefix;
  for await (const line of rl) {
    output.write((line.includes(fromTok) ? line.split(fromTok).join(toTok) : line) + '\n');
  }
  await new Promise<void>((resolve, reject) => {
    output.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
}
