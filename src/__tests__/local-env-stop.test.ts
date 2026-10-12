import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stopServer, isServerRunning } from '../lib/local-env.js';
import type { LocalInstance } from '../types.js';

// Reproduces the npx fallback: the pid we record is a WRAPPER whose child is the
// real server. A SIGTERM to the wrapper alone leaves the child (and its port) alive.
const WRAPPER = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000)"], { stdio: 'ignore' });
fs.writeFileSync(process.argv[1], String(child.pid));
setInterval(() => {}, 1000);
`;

// `local start --background` and `local stop` are separate CLI processes, so the
// server is never the stopper's own child. Mirror that: a launcher spawns the
// wrapper detached (as startServerBackground does) and exits, so the test runner
// never holds an unreaped zombie that would read as "still alive".
const LAUNCHER = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const w = spawn(process.execPath, ['-e', ${JSON.stringify(WRAPPER)}, process.argv[1]], { detached: true, stdio: 'ignore' });
fs.writeFileSync(process.argv[2], String(w.pid));
w.unref();
`;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 50));
}

describe.skipIf(process.platform === 'win32')('stopServer kills the whole server tree', () => {
  let dir: string;
  let instance: LocalInstance;
  let wrapperPid: number;
  let childPid: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iwp-stop-'));
    instance = { name: 't', path: dir, port: 0 } as unknown as LocalInstance;
    const childPidFile = join(dir, 'child.pid');
    const pidFile = join(dir, 'server.pid');
    await new Promise(r => spawn(process.execPath, ['-e', LAUNCHER, childPidFile, pidFile], { stdio: 'ignore' }).on('exit', r));
    wrapperPid = parseInt(readFileSync(pidFile, 'utf-8'), 10);
    await waitFor(() => existsSync(childPidFile) && readFileSync(childPidFile, 'utf-8').length > 0);
    childPid = parseInt(readFileSync(childPidFile, 'utf-8'), 10);
    expect(alive(childPid)).toBe(true);
  });

  afterEach(() => {
    for (const p of [childPid, wrapperPid]) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  });

  it('stops the wrapper AND its child, and removes the pid file', async () => {
    const t0 = Date.now();
    expect(stopServer(instance)).toBe(true);
    // Synchronous: both are already gone when stopServer returns — the next
    // `local start` must find the port free — and well inside the SIGKILL grace.
    expect(alive(childPid)).toBe(false);
    expect(alive(wrapperPid)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(existsSync(join(dir, 'server.pid'))).toBe(false);
  });

  it('still reports running (and still stops) when only the orphaned child is left', async () => {
    process.kill(wrapperPid, 'SIGKILL');
    await waitFor(() => !alive(wrapperPid));
    expect(isServerRunning(instance)).toBe(true);
    expect(stopServer(instance)).toBe(true);
    await waitFor(() => !alive(childPid));
    expect(alive(childPid)).toBe(false);
  });
});

describe('stopServer pid-file guards', () => {
  let dir: string;
  let instance: LocalInstance;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iwp-stop-'));
    instance = { name: 't', path: dir, port: 0 } as unknown as LocalInstance;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses pid 0 / 1 / garbage (kill(-0) would signal our own group)', () => {
    for (const bad of ['0', '1', 'abc', '']) {
      writeFileSync(join(dir, 'server.pid'), bad);
      expect(stopServer(instance)).toBe(false);
      expect(existsSync(join(dir, 'server.pid'))).toBe(false);
    }
  });

  it('returns false with no pid file', () => {
    expect(stopServer(instance)).toBe(false);
    expect(isServerRunning(instance)).toBe(false);
  });
});
