import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { detectDumpPrefix, readSqlHead, rewriteDumpPrefix } from '../lib/sql-dump.js';

const temps: string[] = [];
function tmp(ext = '.sql'): string {
  const p = join(tmpdir(), `iwp-test-${randomBytes(6).toString('hex')}${ext}`);
  temps.push(p);
  return p;
}
afterEach(() => {
  for (const p of temps.splice(0)) { if (existsSync(p)) rmSync(p, { force: true }); }
});

describe('detectDumpPrefix', () => {
  it('detects the standard wp_ prefix', () => {
    expect(detectDumpPrefix('CREATE TABLE `wp_options` (id int);')).toBe('wp_');
  });

  it('detects a custom (random) prefix', () => {
    expect(detectDumpPrefix('INSERT INTO `iwpa4c7_posts` VALUES (1);')).toBe('iwpa4c7_');
  });

  it('detects an empty (unprefixed) prefix', () => {
    expect(detectDumpPrefix('CREATE TABLE `options` (id int);')).toBe('');
  });

  it('is case-insensitive and matches lowercase statements', () => {
    expect(detectDumpPrefix('create table `wp_usermeta` (id int);')).toBe('wp_');
  });

  it('does not confuse `posts` inside `postmeta` (trailing backtick anchors it)', () => {
    expect(detectDumpPrefix('CREATE TABLE `wp_postmeta` (id int);')).toBe('wp_');
  });

  it('skips plugin tables and keys off the first core table', () => {
    const dump = [
      'CREATE TABLE `wp_woocommerce_sessions` (id int);',
      'CREATE TABLE `wp_options` (id int);',
    ].join('\n');
    expect(detectDumpPrefix(dump)).toBe('wp_');
  });

  it('returns null when no core WordPress table is present', () => {
    expect(detectDumpPrefix('CREATE TABLE `wp_woocommerce_sessions` (id int);')).toBeNull();
  });
});

describe('readSqlHead', () => {
  it('reads only up to the byte budget', () => {
    const p = tmp();
    writeFileSync(p, 'A'.repeat(100));
    expect(readSqlHead(p, 10)).toBe('A'.repeat(10));
  });

  it('reads the whole file when smaller than the budget', () => {
    const p = tmp();
    writeFileSync(p, 'CREATE TABLE `wp_options`;');
    expect(readSqlHead(p, 1024)).toBe('CREATE TABLE `wp_options`;');
  });
});

describe('rewriteDumpPrefix', () => {
  it('rewrites table identifiers but leaves prefix-bound data values untouched', async () => {
    const src = tmp();
    const dest = tmp();
    const dump = [
      'DROP TABLE IF EXISTS `wp_options`;',
      'CREATE TABLE `wp_options` (option_id int, option_name varchar(191));',
      "INSERT INTO `wp_options` VALUES (1,'wp_user_roles','a:1:{}');",
      'CREATE TABLE `wp_usermeta` (umeta_id int, meta_key varchar(255));',
      "INSERT INTO `wp_usermeta` VALUES (1,'wp_capabilities','a:1:{}');",
    ].join('\n');
    writeFileSync(src, dump);

    await rewriteDumpPrefix(src, dest, 'wp_', 'iwpa4c7_');
    const out = readFileSync(dest, 'utf-8');

    // Backtick-quoted table identifiers are rewritten.
    expect(out).toContain('`iwpa4c7_options`');
    expect(out).toContain('`iwpa4c7_usermeta`');
    expect(out).not.toContain('`wp_options`');
    expect(out).not.toContain('`wp_usermeta`');

    // Single-quoted data VALUES (role/capability keys) are NOT touched — they
    // are remapped server-side after import, not in the dump text.
    expect(out).toContain("'wp_user_roles'");
    expect(out).toContain("'wp_capabilities'");
  });
});
