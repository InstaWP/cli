import { describe, it, expect } from 'vitest';
import { sanitizeName, defaultInstanceName, pushTargetRef, shouldPushDb, parseTablePrefix, parseSqlTableNames } from '../lib/local-instance.js';

describe('sanitizeName', () => {
  it('lowercases and replaces non [a-z0-9_-] with -', () => {
    expect(sanitizeName('Client Store 1234')).toBe('client-store-1234');
    expect(sanitizeName('foo.instawp.site')).toBe('foo-instawp-site');
    expect(sanitizeName('Keep_me-1')).toBe('keep_me-1');
  });
});

describe('defaultInstanceName', () => {
  it('prefers the site name when present', () => {
    expect(defaultInstanceName({ id: 1, name: 'My Site', sub_domain: 'x.instawp.site' })).toBe('my-site');
  });

  it('uses the first DNS label of the subdomain when name is empty (the bug fix)', () => {
    // Previously sanitized the whole domain → "client-store-1234-instawp-site".
    expect(defaultInstanceName({ id: 1, name: '', sub_domain: 'client-store-1234.instawp.site' }))
      .toBe('client-store-1234');
  });

  it('handles a bare subdomain with no dots', () => {
    expect(defaultInstanceName({ id: 1, sub_domain: 'client-store-1234' })).toBe('client-store-1234');
  });

  it('falls back to site-<id> when nothing usable', () => {
    expect(defaultInstanceName({ id: 42, name: '', sub_domain: '' })).toBe('site-42');
  });
});

describe('pushTargetRef', () => {
  it('prefers an explicit cloud-site argument', () => {
    expect(pushTargetRef('other-site', { cloudSiteId: 99 })).toBe('other-site');
  });

  it('falls back to the cloned origin site id when no arg', () => {
    expect(pushTargetRef(undefined, { cloudSiteId: 2510661 })).toBe('2510661');
  });

  it('returns undefined (caller creates) when no arg and not a cloned instance', () => {
    expect(pushTargetRef(undefined, {})).toBeUndefined();
  });

  it('treats a blank arg as no arg, deferring to the origin', () => {
    expect(pushTargetRef('   ', { cloudSiteId: 7 })).toBe('7');
    expect(pushTargetRef('  ', {})).toBeUndefined();
  });
});

describe('shouldPushDb', () => {
  // commander's --no-db default: `db` is true unless the user passes --no-db.
  const base = { db: true };

  it('pushes the DB by default when this push creates the site', () => {
    expect(shouldPushDb(base, true)).toBe(true);
  });

  it('keeps the DB opt-in when pushing into an existing site', () => {
    expect(shouldPushDb(base, false)).toBe(false);
    expect(shouldPushDb({ ...base, withDb: true }, false)).toBe(true);
  });

  it('lets --no-db win over both the auto-include and an explicit --with-db', () => {
    expect(shouldPushDb({ db: false }, true)).toBe(false);
    expect(shouldPushDb({ db: false, withDb: true }, true)).toBe(false);
    expect(shouldPushDb({ db: false, withDb: true }, false)).toBe(false);
  });
});

describe('parseTablePrefix (MOTD-resilient)', () => {
  it('returns the prefix on a clean single line', () => {
    expect(parseTablePrefix('wp_\n')).toBe('wp_');
    expect(parseTablePrefix('wp_abc_')).toBe('wp_abc_');
  });
  it('ignores an SSH banner and takes the last identifier-only line', () => {
    const stdout = 'Welcome to Ubuntu 22.04 LTS\nLast login: Tue Jun 3\n* Docs: https://help.example\nwp_\n';
    expect(parseTablePrefix(stdout)).toBe('wp_');
  });
  it('falls back when nothing looks like a prefix', () => {
    expect(parseTablePrefix('** banner only: see https://x **', 'wp_')).toBe('wp_');
    expect(parseTablePrefix('', 'wp_')).toBe('wp_');
  });
});

describe('parseSqlTableNames (MOTD-resilient)', () => {
  it('keeps valid table names and drops banner/junk lines', () => {
    const stdout = [
      'Welcome to Ubuntu 22.04 LTS',
      'Last login: Tue Jun 3 from 10.0.0.1',
      'wp_options',
      'wp_posts',
      'wp_wc_orders',
      '',
    ].join('\n');
    const set = parseSqlTableNames(stdout);
    expect(set.has('wp_options')).toBe(true);
    expect(set.has('wp_posts')).toBe(true);
    expect(set.has('wp_wc_orders')).toBe(true);
    // banner lines (contain spaces/punctuation) are excluded
    expect([...set].some((t) => t.includes(' '))).toBe(false);
    expect(set.has('Welcome')).toBe(false); // multi-word line dropped entirely
  });
});
