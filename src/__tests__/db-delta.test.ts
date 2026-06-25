import { describe, it, expect } from 'vitest';
import {
  splitSqlTuple,
  parseInsertStatement,
  hasExtendedInsert,
  parseCreateTables,
  schemaFingerprint,
  computeDelta,
} from '../lib/db-delta.js';

const OPTIONS_DDL = (autoInc = 120) => `CREATE TABLE \`wp_options\` (
  \`option_id\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  \`option_name\` varchar(191) NOT NULL DEFAULT '',
  \`option_value\` longtext NOT NULL,
  PRIMARY KEY (\`option_id\`),
  UNIQUE KEY \`option_name\` (\`option_name\`)
) ENGINE=InnoDB AUTO_INCREMENT=${autoInc} DEFAULT CHARSET=utf8mb4;`;

const dump = (ddl: string, rows: string[]) => [ddl, ...rows].join('\n') + '\n';

describe('splitSqlTuple', () => {
  it('splits top-level fields', () => {
    expect(splitSqlTuple("1,'siteurl','http://x'")).toEqual(['1', "'siteurl'", "'http://x'"]);
  });
  it('respects commas and parens inside strings', () => {
    expect(splitSqlTuple("5,'a, b (c)',7")).toEqual(['5', "'a, b (c)'", '7']);
  });
  it('respects escaped quotes', () => {
    expect(splitSqlTuple("1,'it\\'s ok',2")).toEqual(['1', "'it\\'s ok'", '2']);
  });
});

describe('parseInsertStatement / hasExtendedInsert', () => {
  it('parses a single-row insert', () => {
    const r = parseInsertStatement("INSERT INTO `wp_options` VALUES (1,'siteurl','http://x');");
    expect(r?.table).toBe('wp_options');
    expect(r?.tuples).toEqual(["1,'siteurl','http://x'"]);
  });
  it('detects an extended (multi-row) insert', () => {
    expect(hasExtendedInsert("INSERT INTO `wp_options` VALUES (1,'a'),(2,'b');")).toBe(true);
  });
  it('does not false-positive on a single row containing ),(', () => {
    expect(hasExtendedInsert("INSERT INTO `wp_options` VALUES (1,'a),(b');")).toBe(false);
  });
});

describe('parseCreateTables', () => {
  it('extracts ordered columns and a single-column PK', () => {
    const t = parseCreateTables(OPTIONS_DDL()).get('wp_options')!;
    expect(t.columns).toEqual(['option_id', 'option_name', 'option_value']);
    expect(t.pkCol).toBe('option_id');
    expect(t.pkIndex).toBe(0);
  });
  it('reports composite PK as not delta-eligible (pkCol null)', () => {
    const ddl = `CREATE TABLE \`wp_term_relationships\` (
  \`object_id\` bigint(20) NOT NULL,
  \`term_taxonomy_id\` bigint(20) NOT NULL,
  PRIMARY KEY (\`object_id\`,\`term_taxonomy_id\`)
) ENGINE=InnoDB;`;
    const t = parseCreateTables(ddl).get('wp_term_relationships')!;
    expect(t.pkCol).toBeNull();
    expect(t.pkIndex).toBe(-1);
  });
});

describe('schemaFingerprint', () => {
  it('is stable across AUTO_INCREMENT drift', () => {
    expect(schemaFingerprint(OPTIONS_DDL(120))).toBe(schemaFingerprint(OPTIONS_DDL(999)));
  });
  it('changes when a column is added', () => {
    const withCol = OPTIONS_DDL().replace('`option_value` longtext NOT NULL,', '`option_value` longtext NOT NULL,\n  `autoload` varchar(20) NOT NULL DEFAULT \'yes\',');
    expect(schemaFingerprint(withCol)).not.toBe(schemaFingerprint(OPTIONS_DDL()));
  });

  // Regression: "CREATE TABLE … );" text inside row data must NOT count as schema.
  // Un-anchored, it swept volatile row content into the fingerprint → it changed
  // on every data edit → --incremental always fell back to a full push (no-op).
  const adversarialDump = (contentVer: string) => [
    'CREATE TABLE `wp_posts` (',
    '  `ID` bigint(20) NOT NULL AUTO_INCREMENT,',
    '  `post_content` longtext NOT NULL,',
    '  PRIMARY KEY (`ID`)',
    ') ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4;',
    `INSERT INTO \`wp_posts\` VALUES (1,'a doc that says CREATE TABLE \`evil\` (x int); ${contentVer}');`,
    'CREATE TABLE `wp_options` (',
    '  `option_id` bigint(20) NOT NULL AUTO_INCREMENT,',
    '  `option_name` varchar(191) NOT NULL DEFAULT \'\',',
    '  PRIMARY KEY (`option_id`)',
    ') ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4;',
    "INSERT INTO `wp_options` VALUES (1,'siteurl','http://x');",
  ].join('\n') + '\n';

  it('ignores "CREATE TABLE" inside row data — stable across a data-only change', () => {
    expect(schemaFingerprint(adversarialDump('v1'))).toBe(schemaFingerprint(adversarialDump('v2')));
  });

  it('computeDelta emits a delta (not a full fallback) when only adversarial-row data changed', () => {
    const r = computeDelta({
      baselineSql: adversarialDump('v1'),
      currentSql: adversarialDump('v2'),
      dumpPrefix: 'wp_',
      remotePrefix: 'wp_',
    });
    expect(r.mode).toBe('delta');
    expect(r.stats).toEqual({ tablesChanged: 1, replaces: 1, deletes: 0 });
    expect(r.sql).toContain('REPLACE INTO `wp_posts`');
  });
});

describe('computeDelta', () => {
  const ddl = OPTIONS_DDL();
  const base = dump(ddl, [
    "INSERT INTO `wp_options` VALUES (1,'siteurl','http://localhost:10115');",
    "INSERT INTO `wp_options` VALUES (2,'blogname','Old Name');",
    "INSERT INTO `wp_options` VALUES (3,'gone','x');",
  ]);

  it('emits nothing when nothing changed', () => {
    const r = computeDelta({ baselineSql: base, currentSql: base, dumpPrefix: 'wp_', remotePrefix: 'wp_' });
    expect(r.mode).toBe('delta');
    expect(r.sql).toBe('');
    expect(r.stats).toEqual({ tablesChanged: 0, replaces: 0, deletes: 0 });
  });

  it('emits REPLACE for changed + new rows, DELETE for removed, remapping the prefix', () => {
    const cur = dump(ddl, [
      "INSERT INTO `wp_options` VALUES (1,'siteurl','http://localhost:10115');", // unchanged
      "INSERT INTO `wp_options` VALUES (2,'blogname','New Name');",             // changed
      // row 3 removed
      "INSERT INTO `wp_options` VALUES (4,'new_opt','v');",                      // new
    ]);
    const r = computeDelta({ baselineSql: base, currentSql: cur, dumpPrefix: 'wp_', remotePrefix: 'iwpa4c7_' });
    expect(r.mode).toBe('delta');
    expect(r.stats).toEqual({ tablesChanged: 1, replaces: 2, deletes: 1 });
    expect(r.sql).toContain("REPLACE INTO `iwpa4c7_options` VALUES (2,'blogname','New Name');");
    expect(r.sql).toContain("REPLACE INTO `iwpa4c7_options` VALUES (4,'new_opt','v');");
    expect(r.sql).toContain('DELETE FROM `iwpa4c7_options` WHERE `option_id`=3;');
    expect(r.sql).not.toContain('siteurl'); // unchanged row not touched
    expect(r.sql).not.toContain('`wp_options`'); // table identifier remapped to remote prefix
  });

  it('falls back to full when the schema changed', () => {
    const cur = dump(OPTIONS_DDL().replace('`option_value` longtext NOT NULL,', '`option_value` longtext NOT NULL,\n  `autoload` varchar(20) NOT NULL DEFAULT \'yes\','), [
      "INSERT INTO `wp_options` VALUES (1,'siteurl','http://x','yes');",
    ]);
    const r = computeDelta({ baselineSql: base, currentSql: cur, dumpPrefix: 'wp_', remotePrefix: 'wp_' });
    expect(r.mode).toBe('full');
    expect(r.reason).toMatch(/schema/i);
  });

  it('falls back to full when a populated table lacks a single-column PK', () => {
    const ddl2 = `CREATE TABLE \`wp_term_relationships\` (
  \`object_id\` bigint(20) NOT NULL,
  \`term_taxonomy_id\` bigint(20) NOT NULL,
  PRIMARY KEY (\`object_id\`,\`term_taxonomy_id\`)
) ENGINE=InnoDB;`;
    const b = dump(ddl2, ['INSERT INTO `wp_term_relationships` VALUES (1,2);']);
    const c = dump(ddl2, ['INSERT INTO `wp_term_relationships` VALUES (1,3);']);
    const r = computeDelta({ baselineSql: b, currentSql: c, dumpPrefix: 'wp_', remotePrefix: 'wp_' });
    expect(r.mode).toBe('full');
    expect(r.reason).toMatch(/primary key/i);
  });
});
