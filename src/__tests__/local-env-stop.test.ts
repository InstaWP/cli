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
const childCode = process.argv[3] === 'ignore-term'
  ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
  : "setInterval(() => {}, 1000)";
// Both carry the instance's --port=, like the npx wrapper and Playground do
// ('--' so node does not parse it as its own option).
// A long token before --port=, like Playground's real argv (install paths, flags).
const child = spawn(process.execPath, ['-e', childCode, '--', 'x'.repeat(200), process.argv[2]], { stdio: 'ignore' });
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
const w = spawn(process.execPath, ['-e', ${JSON.stringify(WRAPPER)}, '--', ...process.argv.slice(1, 2), ...process.argv.slice(3)], { detached: true, stdio: 'ignore' });
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

  async function launch(mode = 'normal'): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'iwp-stop-'));
    const port = 40000 + Math.floor(Math.random() * 20000);
    instance = { name: 't', path: dir, port } as unknown as LocalInstance;
    const childPidFile = join(dir, 'child.pid');
    const pidFile = join(dir, 'server.pid');
    await new Promise(r => spawn(process.execPath, ['-e', LAUNCHER, '--', childPidFile, pidFile, `--port=${port}`, mode], { stdio: 'ignore' }).on('exit', r));
    wrapperPid = parseInt(readFileSync(pidFile, 'utf-8'), 10);
    await waitFor(() => existsSync(childPidFile) && readFileSync(childPidFile, 'utf-8').length > 0);
    childPid = parseInt(readFileSync(childPidFile, 'utf-8'), 10);
    expect(alive(childPid)).toBe(true);
  }

  afterEach(() => {
    for (const p of [childPid, wrapperPid]) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  });

  it('stops the wrapper AND its child, and removes the pid file', async () => {
    await launch();
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
    await launch();
    process.kill(wrapperPid, 'SIGKILL');
    await waitFor(() => !alive(wrapperPid));
    expect(isServerRunning(instance)).toBe(true);
    expect(stopServer(instance)).toBe(true);
    await waitFor(() => !alive(childPid));
    expect(alive(childPid)).toBe(false);
  });
  it('SIGKILLs a server that ignores SIGTERM once the grace period runs out', async () => {
    await launch('ignore-term');
    expect(stopServer(instance, 300)).toBe(true);
    expect(alive(childPid)).toBe(false);
  });

  it('still finds --port= when ps would truncate to the terminal width (COLUMNS set)', async () => {
    await launch();
    process.kill(wrapperPid, 'SIGKILL'); // only the long-argv child carries the marker now
    await waitFor(() => !alive(wrapperPid));
    const prev = process.env.COLUMNS;
    process.env.COLUMNS = '40';
    try {
      expect(isServerRunning(instance)).toBe(true);
      expect(stopServer(instance)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.COLUMNS; else process.env.COLUMNS = prev;
    }
    expect(alive(childPid)).toBe(false);
  });

  it('a process in ANOTHER group carrying the same --port= does not make this pid ours', async () => {
    await launch();
    // Point the pid file at a group leader without the marker; the server with this port lives in another group.
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    other.unref();
    try {
      writeFileSync(join(dir, 'server.pid'), String(other.pid));
      expect(stopServer(instance)).toBe(false);
      expect(alive(other.pid!)).toBe(true);
    } finally {
      process.kill(other.pid!, 'SIGKILL');
    }
  });

  it('leaves a recycled pid alone: a group without this instance\'s --port= is not ours', async () => {
    await launch();
    instance = { ...instance, port: instance.port + 1 } as LocalInstance;
    expect(isServerRunning(instance)).toBe(false);
    writeFileSync(join(dir, 'server.pid'), String(wrapperPid));
    expect(stopServer(instance)).toBe(false);
    expect(alive(childPid)).toBe(true);
    expect(alive(wrapperPid)).toBe(true);
    expect(existsSync(join(dir, 'server.pid'))).toBe(false);
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
