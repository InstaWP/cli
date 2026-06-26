import { describe, it, expect } from 'vitest';
import {
  splitSqlTuple,
  parseInsertStatement,
  prefixFromTableNames,
  buildManifest,
  diffAgainstManifest,
  serializeManifest,
  deserializeManifest,
  ExtendedInsertError,
} from '../lib/db-delta.js';

const OPTIONS_DDL = (autoInc = 120) => `CREATE TABLE \`wp_options\` (
  \`option_id\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  \`option_name\` varchar(191) NOT NULL DEFAULT '',
  \`option_value\` longtext NOT NULL,
  PRIMARY KEY (\`option_id\`)
) ENGINE=InnoDB AUTO_INCREMENT=${autoInc} DEFAULT CHARSET=utf8mb4;`;

const TR_DDL = `CREATE TABLE \`wp_term_relationships\` (
  \`object_id\` bigint(20) NOT NULL,
  \`term_taxonomy_id\` bigint(20) NOT NULL,
  PRIMARY KEY (\`object_id\`,\`term_taxonomy_id\`)
) ENGINE=InnoDB;`;

const lines = (s: string) => s.split('\n');
const dump = (ddl: string, rows: string[]) => lines([ddl, ...rows].join('\n'));
const opts = { dumpPrefix: 'wp_', remotePrefix: 'iwpa4c7_' };

describe('splitSqlTuple', () => {
  it('respects commas/parens/quotes inside strings', () => {
    expect(splitSqlTuple("5,'a, b (c)',7")).toEqual(['5', "'a, b (c)'", '7']);
    expect(splitSqlTuple("1,'it\\'s ok',2")).toEqual(['1', "'it\\'s ok'", '2']);
  });
});

describe('parseInsertStatement', () => {
  it('parses a single-row insert and flags extended', () => {
    expect(parseInsertStatement("INSERT INTO `t` VALUES (1,'a');")?.tuples).toEqual(["1,'a'"]);
    expect(parseInsertStatement("INSERT INTO `t` VALUES (1,'a'),(2,'b');")?.tuples.length).toBe(2);
  });
});

describe('prefixFromTableNames', () => {
  it('derives the table prefix from core table names', () => {
    expect(prefixFromTableNames(['iwpa4c7_postmeta', 'iwpa4c7_options'])).toBe('iwpa4c7_');
    expect(prefixFromTableNames(['wp_users'])).toBe('wp_');
    expect(prefixFromTableNames(['random_table'])).toBeNull();
  });
});

describe('buildManifest', () => {
  it('captures single-PK row hashes, composite aggregates, and a schema fingerprint', async () => {
    const m = await buildManifest(dump(OPTIONS_DDL(), [
      "INSERT INTO `wp_options` VALUES (1,'siteurl','http://x');",
      "INSERT INTO `wp_options` VALUES (2,'blogname','S');",
    ]).concat(lines(TR_DDL), ['INSERT INTO `wp_term_relationships` VALUES (5,9);']));
    expect(m.single.get('wp_options')?.rows.size).toBe(2);
    expect(m.single.get('wp_options')?.pkCol).toBe('option_id');
    expect(m.composite.get('wp_term_relationships')?.count).toBe(1);
    expect(m.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fingerprint is stable across AUTO_INCREMENT drift and "CREATE TABLE" in row data (B1)', async () => {
    const adversarial = (v: string) => dump(OPTIONS_DDL(v === 'v1' ? 120 : 988), [
      `INSERT INTO \`wp_options\` VALUES (1,'doc','says CREATE TABLE \`evil\` (x int); ${v}');`,
    ]);
    const a = await buildManifest(adversarial('v1'));
    const b = await buildManifest(adversarial('v2'));
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('throws on an extended-insert dump', async () => {
    await expect(buildManifest(dump(OPTIONS_DDL(), ["INSERT INTO `wp_options` VALUES (1,'a','b'),(2,'c','d');"])))
      .rejects.toBeInstanceOf(ExtendedInsertError);
  });
});

describe('diffAgainstManifest', () => {
  const base = dump(OPTIONS_DDL(), [
    "INSERT INTO `wp_options` VALUES (1,'siteurl','http://localhost:10115');",
    "INSERT INTO `wp_options` VALUES (2,'blogname','Old Name');",
    "INSERT INTO `wp_options` VALUES (3,'gone','x');",
  ]);

  it('emits nothing when nothing changed', async () => {
    const m = await buildManifest(base);
    const r = await diffAgainstManifest(base, m, { dumpPrefix: 'wp_', remotePrefix: 'wp_' });
    expect(r.mode).toBe('delta');
    expect(r.sql).toBe('');
    expect(r.stats).toEqual({ tablesChanged: 0, replaces: 0, deletes: 0 });
  });

  it('REPLACE for changed/new rows, DELETE for removed, remapping the prefix', async () => {
    const m = await buildManifest(base);
    const cur = dump(OPTIONS_DDL(), [
      "INSERT INTO `wp_options` VALUES (1,'siteurl','http://localhost:10115');", // unchanged
      "INSERT INTO `wp_options` VALUES (2,'blogname','New Name');",             // changed
      // row 3 removed
      "INSERT INTO `wp_options` VALUES (4,'new_opt','v');",                      // new
    ]);
    const r = await diffAgainstManifest(cur, m, opts);
    expect(r.mode).toBe('delta');
    expect(r.stats).toEqual({ tablesChanged: 1, replaces: 2, deletes: 1 });
    expect(r.sql).toContain("REPLACE INTO `iwpa4c7_options` VALUES (2,'blogname','New Name');");
    expect(r.sql).toContain("REPLACE INTO `iwpa4c7_options` VALUES (4,'new_opt','v');");
    expect(r.sql).toContain('DELETE FROM `iwpa4c7_options` WHERE `option_id`=3;');
    expect(r.sql).not.toContain('siteurl');
    expect(r.sql).not.toContain('`wp_options`');
  });

  it('falls back to full when the schema changed', async () => {
    const m = await buildManifest(base);
    const cur = dump(OPTIONS_DDL().replace('`option_value` longtext NOT NULL,', '`option_value` longtext NOT NULL,\n  `autoload` varchar(20) NOT NULL DEFAULT \'yes\','), [
      "INSERT INTO `wp_options` VALUES (1,'siteurl','http://x','yes');",
    ]);
    const r = await diffAgainstManifest(cur, m, opts);
    expect(r.mode).toBe('full');
    expect(r.reason).toMatch(/schema/i);
  });

  // B2 regression: unchanged composite-PK table must not force a full push.
  it('ignores an UNCHANGED composite-PK table and still deltas the changed single-PK table', async () => {
    const mk = (name: string) => dump(OPTIONS_DDL(), [`INSERT INTO \`wp_options\` VALUES (1,'blogname','${name}');`])
      .concat(lines(TR_DDL), ['INSERT INTO `wp_term_relationships` VALUES (5,9);']);
    const m = await buildManifest(mk('Old'));
    const r = await diffAgainstManifest(mk('New'), m, opts);
    expect(r.mode).toBe('delta');
    expect(r.stats).toEqual({ tablesChanged: 1, replaces: 1, deletes: 0 });
    expect(r.sql).toContain('REPLACE INTO `iwpa4c7_options`');
    expect(r.sql).not.toContain('term_relationships');
  });

  it('falls back to full when a composite-PK table actually changed', async () => {
    const m = await buildManifest(dump(TR_DDL, ['INSERT INTO `wp_term_relationships` VALUES (1,2);']));
    const r = await diffAgainstManifest(dump(TR_DDL, ['INSERT INTO `wp_term_relationships` VALUES (1,3);']), m, { dumpPrefix: 'wp_', remotePrefix: 'wp_' });
    expect(r.mode).toBe('full');
    expect(r.reason).toMatch(/no single-column primary key/i);
  });

  it('builds a fresh newManifest each diff (for re-basing)', async () => {
    const m = await buildManifest(base);
    const cur = dump(OPTIONS_DDL(), ["INSERT INTO `wp_options` VALUES (1,'siteurl','http://x');"]);
    const r = await diffAgainstManifest(cur, m, opts);
    expect(r.newManifest.single.get('wp_options')?.rows.size).toBe(1);
  });
});

describe('serialize/deserialize manifest', () => {
  it('round-trips single + composite tables', async () => {
    const m = await buildManifest(dump(OPTIONS_DDL(), ["INSERT INTO `wp_options` VALUES (1,'a','b');"]).concat(lines(TR_DDL), ['INSERT INTO `wp_term_relationships` VALUES (5,9);']));
    const back = deserializeManifest(serializeManifest(m));
    expect(back.fingerprint).toBe(m.fingerprint);
    expect(back.single.get('wp_options')?.rows.get('1')).toBe(m.single.get('wp_options')?.rows.get('1'));
    expect(back.composite.get('wp_term_relationships')?.count).toBe(1);
    // a diff using the deserialized manifest behaves identically (no false change)
    const r = await diffAgainstManifest(dump(OPTIONS_DDL(), ["INSERT INTO `wp_options` VALUES (1,'a','b');"]).concat(lines(TR_DDL), ['INSERT INTO `wp_term_relationships` VALUES (5,9);']), back, { dumpPrefix: 'wp_', remotePrefix: 'wp_' });
    expect(r.mode).toBe('delta');
    expect(r.sql).toBe('');
  });
});
