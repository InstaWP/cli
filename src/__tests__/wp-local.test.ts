import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseWpConfig,
  parseDbHost,
  normalizeSourceDomain,
  matchesExclude,
  findWpRoot,
  findWpConfig,
  detectWpVersion,
  FILE_EXCLUDES,
} from '../lib/wp-local.js';

describe('parseWpConfig', () => {
  const cfg = `<?php
define( 'DB_NAME', 'local' );
define('DB_USER', "root");
define( 'DB_PASSWORD', 'r@ot:pw' );
define( 'DB_HOST', 'localhost:/tmp/mysql.sock' );
define('WP_HOME', 'https://my-shop.local');
$table_prefix = 'wp_abc_';
`;

  it('parses DB creds, prefix, and constants tolerant of spacing/quotes', () => {
    const c = parseWpConfig(cfg);
    expect(c.dbName).toBe('local');
    expect(c.dbUser).toBe('root');
    expect(c.dbPassword).toBe('r@ot:pw');
    expect(c.dbHost).toBe('localhost:/tmp/mysql.sock');
    expect(c.tablePrefix).toBe('wp_abc_');
    expect(c.wpHome).toBe('https://my-shop.local');
    expect(c.wpSiteUrl).toBeUndefined();
  });

  it('defaults table prefix to wp_ when absent', () => {
    const c = parseWpConfig(`<?php
define('DB_NAME','d'); define('DB_USER','u'); define('DB_PASSWORD','p'); define('DB_HOST','h');`);
    expect(c.tablePrefix).toBe('wp_');
    expect(c.dbPassword).toBe('p');
  });

  it('throws when required DB defines are missing', () => {
    expect(() => parseWpConfig(`<?php $table_prefix = 'wp_';`)).toThrow();
  });
});

describe('parseDbHost', () => {
  it('handles a bare host', () => {
    expect(parseDbHost('localhost')).toEqual({ host: 'localhost' });
  });
  it('handles host:port', () => {
    expect(parseDbHost('127.0.0.1:3307')).toEqual({ host: '127.0.0.1', port: 3307 });
  });
  it('handles host:/socket', () => {
    expect(parseDbHost('localhost:/var/run/mysqld/mysqld.sock')).toEqual({
      host: 'localhost',
      socket: '/var/run/mysqld/mysqld.sock',
    });
  });
  it('handles a socket with an empty host', () => {
    expect(parseDbHost(':/tmp/x.sock')).toEqual({ host: 'localhost', socket: '/tmp/x.sock' });
  });
});

describe('normalizeSourceDomain', () => {
  it('strips scheme, www, and trailing slash', () => {
    expect(normalizeSourceDomain('https://www.example.com/')).toBe('example.com');
    expect(normalizeSourceDomain('http://example.test')).toBe('example.test');
    expect(normalizeSourceDomain('https://my-shop.local/')).toBe('my-shop.local');
  });
  it('keeps a subdirectory install path', () => {
    expect(normalizeSourceDomain('https://example.com/blog/')).toBe('example.com/blog');
  });
  it('is idempotent on an already-normalized value', () => {
    expect(normalizeSourceDomain('example.com')).toBe('example.com');
  });
  it('produces a value the server regex accepts (no http/https/www prefix)', () => {
    const re = /^(?!http:\/\/)(?!https:\/\/)(?!www\.).+$/;
    for (const u of ['https://www.a.com/', 'http://b.test', 'https://c.io/path']) {
      expect(re.test(normalizeSourceDomain(u))).toBe(true);
    }
  });
});

describe('matchesExclude', () => {
  it('matches the excluded dir and anything under it', () => {
    expect(matchesExclude('wp-content/instawpbackups')).toBe(true);
    expect(matchesExclude('wp-content/instawpbackups/2026/x.zip')).toBe(true);
    expect(matchesExclude('wp-content/plugins/instawp-connect/loader.php')).toBe(true);
    expect(matchesExclude('wp-content/upgrade/tmp')).toBe(true);
  });
  it('does NOT match unrelated paths or prefix look-alikes', () => {
    expect(matchesExclude('wp-content/uploads/2026/img.png')).toBe(false);
    expect(matchesExclude('wp-content/themes/twentytwentyfour/style.css')).toBe(false);
    // "upgrade" must not match "upgraded"/"upgrade-helper"
    expect(matchesExclude('wp-content/upgraded/x')).toBe(false);
    // a third-party plugin that merely starts similarly is kept
    expect(matchesExclude('wp-content/plugins/instawp-connect-pro/x.php')).toBe(false);
  });
  it('handles backslashes and leading slashes', () => {
    expect(matchesExclude('\\wp-content\\upgrade\\x')).toBe(true);
    expect(matchesExclude('/wp-content/instawpbackups')).toBe(true);
  });
  it('FILE_EXCLUDES is the plugin skip-list', () => {
    expect(FILE_EXCLUDES).toContain('wp-content/plugins/instawp-connect');
    expect(FILE_EXCLUDES).toContain('wp-content/plugins/iwp-migration');
    expect(FILE_EXCLUDES).toHaveLength(5);
  });
});

describe('findWpRoot / findWpConfig / detectWpVersion', () => {
  let root: string;
  let wpRoot: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'iwp-wproot-'));
    // Simulate a Local-style layout: <root>/app/public is the WP root.
    wpRoot = join(root, 'app', 'public');
    mkdirSync(join(wpRoot, 'wp-includes'), { recursive: true });
    writeFileSync(join(wpRoot, 'wp-includes', 'version.php'), "<?php\n$wp_version = '6.8.1';\n$wp_db_version = 57155;\n");
    writeFileSync(join(wpRoot, 'wp-config.php'), "<?php\ndefine('DB_NAME','x');define('DB_USER','u');define('DB_PASSWORD','p');define('DB_HOST','localhost');\n");
    mkdirSync(join(wpRoot, 'wp-content', 'themes'), { recursive: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the WP root by walking up to wp-includes/version.php', () => {
    // Start from a nested subdir; should resolve back to wpRoot.
    expect(findWpRoot(join(wpRoot, 'wp-content', 'themes'))).toBe(wpRoot);
    expect(findWpRoot(wpRoot)).toBe(wpRoot);
  });

  it('returns null when there is no WP install above the start dir', () => {
    expect(findWpRoot(tmpdir())).toBe(null);
  });

  it('locates wp-config.php in the WP root', () => {
    expect(findWpConfig(wpRoot)).toBe(join(wpRoot, 'wp-config.php'));
  });

  it('reads the WP version (and not wp_db_version)', () => {
    expect(detectWpVersion(wpRoot)).toBe('6.8.1');
  });
});
