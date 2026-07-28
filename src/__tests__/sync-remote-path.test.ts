import { describe, it, expect } from 'vitest';
import { buildRemotePath, buildSyncFilterArgs, remoteDocRoot, remoteHomeDir } from '../lib/paths.js';

describe('remoteDocRoot / remoteHomeDir (chroot-aware)', () => {
  it('prefers the server-resolved docRoot over the computed path', () => {
    const conn = { username: 'u', domain: 'foo.instawp.site', docRoot: '/web/foo.instawp.site/public_html' };
    expect(remoteDocRoot(conn)).toBe('/web/foo.instawp.site/public_html'); // chroot: no /home/<user>
  });

  it('falls back to the /home/<user>/web/<domain>/public_html path when docRoot is absent', () => {
    expect(remoteDocRoot({ username: 'u', domain: 'foo.instawp.site' }))
      .toBe('/home/u/web/foo.instawp.site/public_html');
  });

  it('derives the home dir three levels up from the docroot', () => {
    // normal layout → /home/<user>
    expect(remoteHomeDir({ username: 'u', domain: 'foo', docRoot: '/home/u/web/foo/public_html' })).toBe('/home/u');
    // chroot layout → the jail root
    expect(remoteHomeDir({ username: 'u', domain: 'foo', docRoot: '/web/foo/public_html' })).toBe('/');
    // fallback path → /home/<user>
    expect(remoteHomeDir({ username: 'u', domain: 'foo' })).toBe('/home/u');
  });

  it('buildRemotePath uses the resolved docRoot as the webroot base', () => {
    const chroot = { username: 'u', domain: 'foo', docRoot: '/web/foo/public_html' };
    expect(buildRemotePath(chroot)).toBe('/web/foo/public_html/wp-content/');
    expect(buildRemotePath(chroot, { webroot: true })).toBe('/web/foo/public_html/');
    expect(buildRemotePath(chroot, { remotePath: 'wp-content/plugins/x' })).toBe('/web/foo/public_html/wp-content/plugins/x/');
  });
});

const conn = { username: 'iwpuser', domain: 'my-site.instawp.site' };
const base = '/home/iwpuser/web/my-site.instawp.site/public_html';

describe('buildRemotePath', () => {
  it('defaults to wp-content/ with a trailing slash', () => {
    expect(buildRemotePath(conn)).toBe(`${base}/wp-content/`);
  });

  it('targets the webroot with --webroot', () => {
    expect(buildRemotePath(conn, { webroot: true })).toBe(`${base}/`);
  });

  it('resolves a relative --remote-path against public_html/', () => {
    expect(buildRemotePath(conn, { remotePath: 'variations' })).toBe(`${base}/variations/`);
  });

  it('strips a leading ./ on a relative --remote-path', () => {
    expect(buildRemotePath(conn, { remotePath: './variations/' })).toBe(`${base}/variations/`);
  });

  it('uses an absolute --remote-path verbatim', () => {
    expect(buildRemotePath(conn, { remotePath: '/var/www/custom' })).toBe('/var/www/custom/');
  });

  it('lets --remote-path take precedence over --webroot', () => {
    expect(buildRemotePath(conn, { remotePath: 'mu-plugins', webroot: true })).toBe(`${base}/mu-plugins/`);
  });
});

describe('buildSyncFilterArgs (#18 — rsync first-match-wins ordering)', () => {
  it('emits user --include BEFORE user --exclude (include-only idiom works)', () => {
    const args = buildSyncFilterArgs({ include: ['*/', '*.html'], exclude: ['*'] });
    expect(args).toEqual(['--include=*/', '--include=*.html', '--exclude=*']);
    // The catch-all exclude must come last, after every include.
    const lastInclude = args.lastIndexOf('--include=*.html');
    const catchAll = args.indexOf('--exclude=*');
    expect(lastInclude).toBeLessThan(catchAll);
  });

  it('handles exclude-only and include-only sets', () => {
    expect(buildSyncFilterArgs({ exclude: ['node_modules', '*.md'] }))
      .toEqual(['--exclude=node_modules', '--exclude=*.md']);
    expect(buildSyncFilterArgs({ include: ['*.php'] })).toEqual(['--include=*.php']);
    expect(buildSyncFilterArgs({})).toEqual([]);
  });

  it('appends --delete last, after all filters', () => {
    const args = buildSyncFilterArgs({ include: ['*.html'], exclude: ['*'], delete: true });
    expect(args).toEqual(['--include=*.html', '--exclude=*', '--delete']);
    expect(args[args.length - 1]).toBe('--delete');
  });
});
