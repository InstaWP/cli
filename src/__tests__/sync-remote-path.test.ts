import { describe, it, expect } from 'vitest';
import { buildRemotePath } from '../lib/paths.js';

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
