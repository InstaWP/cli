import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// logs.ts imports api/ssh-keys/site-resolver, which pull in `conf` and touch
// the user's config dir at import time. Stub them; only the pure helpers are
// under test here.
vi.mock('../lib/api.js', () => ({ requireAuth: vi.fn(), getClient: vi.fn() }));
vi.mock('../lib/site-resolver.js', () => ({ resolveSite: vi.fn() }));
vi.mock('../lib/ssh-keys.js', () => ({ ensureSshAccess: vi.fn() }));
vi.mock('../lib/ssh-connection.js', () => ({ execViaSsh: vi.fn() }));
vi.mock('../lib/output.js', () => ({ error: vi.fn(), spinner: vi.fn(), isJsonMode: () => false }));

import { buildProbeScript, parseProbeOutput, type LogSpec } from '../commands/logs.js';

// Run the generated probe script under a REAL shell, the way the remote host
// does. The bug this pins: with bash's default `xpg_echo off`, `echo "wp\tP"`
// prints a literal backslash-t, so the tab-splitting parser never matched and
// every log was reported missing (observed on a live sandbox, 2026-10-05).
function runUnder(shell: string, script: string): string {
  const r = spawnSync(shell, ['-c', script], { encoding: 'utf8' });
  if (r.error) throw r.error;
  return r.stdout;
}

function hasShell(shell: string): boolean {
  return spawnSync(shell, ['-c', 'true']).status === 0;
}

describe('logs probe script', () => {
  let dir: string;
  let wpLog: string;
  let phpLog: string;
  let specs: LogSpec[];

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'iwp-logs-probe-'));
    wpLog = path.join(dir, 'debug.log');
    phpLog = path.join(dir, "weird 'name'.error.log"); // exercises shellQuote
    writeFileSync(wpLog, 'x');
    writeFileSync(phpLog, 'x');
    specs = [
      { kind: 'wp', candidates: [path.join(dir, 'missing.log'), wpLog] },
      { kind: 'php', candidates: [phpLog] },
      { kind: 'nginx', candidates: [path.join(dir, 'nope.log')] },
    ];
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits a real TAB separator, not a literal backslash-t', () => {
    const out = runUnder('bash', buildProbeScript(specs));
    expect(out).toContain(`wp\t${wpLog}\n`);
    expect(out).not.toContain('\\t');
  });

  for (const shell of ['bash', 'sh', 'dash']) {
    // skipIf, not a silent return: a CI image without dash must REPORT the
    // lost coverage rather than pass vacuously.
    it.skipIf(!hasShell(shell))(`resolves the first readable candidate per kind under ${shell}`, () => {
      const out = runUnder(shell, buildProbeScript(specs));
      expect(parseProbeOutput(out)).toEqual([
        { kind: 'wp', path: wpLog },
        { kind: 'php', path: phpLog },
      ]);
    });
  }

  it('reports nothing for a kind with no readable candidate', () => {
    const out = runUnder('bash', buildProbeScript([specs[2]]));
    expect(out).toBe('nginx\t\n');
    expect(parseProbeOutput(out)).toEqual([]);
  });

  it('the old echo-based marker is NOT parsed under bash (control for the fix)', () => {
    // What the code used to generate: a bash `echo` does not interpret \t.
    const out = runUnder('bash', `echo "wp\\t${wpLog}"`);
    expect(out).toBe(`wp\\t${wpLog}\n`);
    expect(parseProbeOutput(out)).toEqual([]);
  });

  it('sanity: the temp fixtures exist', () => {
    expect(existsSync(wpLog)).toBe(true);
  });
});
