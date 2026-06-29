import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { excludeGlobs, createFilesZip } from '../lib/wp-archive.js';
import { FILE_EXCLUDES } from '../lib/wp-local.js';

describe('excludeGlobs', () => {
  it('emits a bare entry and a /** entry for every excluded dir', () => {
    const globs = excludeGlobs();
    expect(globs).toHaveLength(FILE_EXCLUDES.length * 2);
    for (const ex of FILE_EXCLUDES) {
      expect(globs).toContain(ex);
      expect(globs).toContain(`${ex}/**`);
    }
  });
});

describe('createFilesZip', () => {
  let wpRoot: string;
  let out: string;

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), 'iwp-zip-'));
    wpRoot = join(base, 'public');
    out = join(base, 'backup.zip');

    // Included content
    mkdirSync(join(wpRoot, 'wp-includes'), { recursive: true });
    writeFileSync(join(wpRoot, 'wp-includes', 'version.php'), "<?php $wp_version='6.8';");
    writeFileSync(join(wpRoot, 'wp-config.php'), '<?php // config');
    writeFileSync(join(wpRoot, 'index.php'), '<?php // front controller');
    mkdirSync(join(wpRoot, 'wp-content', 'themes', 'x'), { recursive: true });
    writeFileSync(join(wpRoot, 'wp-content', 'themes', 'x', 'style.css'), 'body{}');
    // A dotfile to confirm dot:true picks it up
    writeFileSync(join(wpRoot, '.htaccess'), '# rules');

    // Excluded content (must NOT inflate the archive)
    mkdirSync(join(wpRoot, 'wp-content', 'instawpbackups'), { recursive: true });
    writeFileSync(join(wpRoot, 'wp-content', 'instawpbackups', 'old.zip'), 'XXXX');
    mkdirSync(join(wpRoot, 'wp-content', 'upgrade'), { recursive: true });
    writeFileSync(join(wpRoot, 'wp-content', 'upgrade', 'tmp.txt'), 'tmp');
    mkdirSync(join(wpRoot, 'wp-content', 'plugins', 'instawp-connect'), { recursive: true });
    writeFileSync(join(wpRoot, 'wp-content', 'plugins', 'instawp-connect', 'loader.php'), '<?php');
  });

  afterAll(() => {
    rmSync(join(wpRoot, '..'), { recursive: true, force: true });
  });

  it('produces a non-empty zip and excludes the plugin skip-list', async () => {
    const res = await createFilesZip({ wpRoot, outPath: out });
    expect(res.path).toBe(out);
    expect(res.bytes).toBeGreaterThan(0);
    expect(statSync(out).size).toBeGreaterThan(0);
    expect(res.entries).toBeGreaterThanOrEqual(5); // the 5 included files (+ maybe dir entries)

    // Zip stores entry filenames uncompressed in the local/central headers, so we
    // can assert exclusion deterministically without unzipping: included paths
    // appear; excluded ones never do.
    const raw = readFileSync(out, 'latin1');
    expect(raw).toContain('wp-config.php');
    expect(raw).toContain('style.css');
    expect(raw).toContain('.htaccess');
    expect(raw).not.toContain('instawpbackups');
    expect(raw).not.toContain('instawp-connect');
    expect(raw).not.toContain('upgrade/tmp.txt');
  });
});
