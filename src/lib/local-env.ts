import { execSync, spawnSync } from 'node:child_process';
// cross-spawn handles Windows quirks: `npx`/`wp-playground-cli` are `.cmd`
// shims, and Node won't spawn .cmd without shell:true (CVE-2024-27980). It also
// quotes args (e.g. mount paths) safely, which shell:true does not.
import spawn from 'cross-spawn';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import net from 'node:net';
import chalk from 'chalk';
import { isJsonMode } from './output.js';
import type { LocalInstance } from '../types.js';

const LOCAL_BASE_DIR = join(homedir(), '.instawp', 'local');
const DEFAULT_PORT_START = 9400;

/**
 * Returns [command, prefixArgs, usingNpx] for running wp-playground-cli.
 * Prefers the global binary (faster) over npx (slower, downloads on first run).
 */
export function getPlaygroundCommand(): [string, string[], boolean] {
  // Check for globally installed binary first (0.7s vs 1.4s npx overhead)
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(cmd, ['wp-playground-cli'], { stdio: 'pipe' });
  if (result.status === 0) {
    return ['wp-playground-cli', [], false];
  }
  return ['npx', ['--yes', '@wp-playground/cli'], true];
}

let npxHintShown = false;
/** Test-only: reset the once-per-process hint guard. */
export function _resetNpxHint(): void { npxHintShown = false; }
/**
 * One-time, dim hint shown when falling back to npx (no global binary). Explains
 * the first-run download and how to skip it. Suppressed in --json mode.
 */
export function maybeShowNpxHint(usingNpx: boolean): void {
  if (!usingNpx || npxHintShown || isJsonMode()) return;
  npxHintShown = true;
  process.stderr.write(
    chalk.dim('# WordPress Playground not found globally — using npx (downloads once, may take ~30s).\n') +
    chalk.dim('# Tip: npm i -g @wp-playground/cli  to skip this on future runs.\n'),
  );
}

export function getLocalBaseDir(): string {
  return LOCAL_BASE_DIR;
}

export function getInstanceDir(name: string): string {
  return join(LOCAL_BASE_DIR, name);
}

/**
 * Check if downloads.w.org is reachable (WordPress Playground downloads from here).
 * Returns null if OK, or an error message string.
 */
export async function checkPlaygroundConnectivity(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    // redirect:'manual' — downloads.w.org 302-redirects to wordpress.org/download/. Following it is
    // fragile (HEAD-follow fails on some networks; GET-follow downloads the whole target and times out),
    // so we don't follow: any response (incl. the 302) proves the host is reachable, which is all we test.
    await fetch('https://downloads.w.org', { signal: controller.signal, method: 'HEAD', redirect: 'manual' });
    clearTimeout(timer);
    return null;
  } catch {
    // Check if the alternative domain works
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      await fetch('https://downloads.wordpress.org', { signal: controller.signal, method: 'HEAD', redirect: 'manual' });
      clearTimeout(timer);
      return 'downloads.w.org is unreachable from your network (downloads.wordpress.org works).\n' +
        'WordPress Playground CLI requires access to downloads.w.org.\n' +
        'Try: adding "192.0.77.48 downloads.w.org" to /etc/hosts, or use a VPN/different network.';
    } catch {
      return 'Cannot reach WordPress download servers (downloads.w.org and downloads.wordpress.org).\n' +
        'Check your internet connection.';
    }
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export async function getNextPort(instances: Record<string, LocalInstance>): Promise<number> {
  const usedPorts = new Set(Object.values(instances).map(i => i.port));
  let port = DEFAULT_PORT_START;
  while (usedPorts.has(port) || !(await isPortAvailable(port))) {
    port++;
    if (port > 9500) throw new Error('No available ports in range 9400-9500');
  }
  return port;
}

const AUTO_LOGIN_MU_PLUGIN = `<?php
/**
 * Auto-login for local development. Injected by InstaWP CLI.
 * Visit /?instawp-login to set the auth cookie and redirect to wp-admin.
 */
error_reporting(E_ERROR | E_PARSE);
@ini_set('display_errors', '0');
add_action('plugins_loaded', function() {
    if (!isset(\$_GET['instawp-login'])) return;
    \$user = get_user_by('login', 'admin');
    if (!\$user) {
        \$admins = get_users(['role' => 'administrator', 'number' => 1]);
        \$user = \$admins[0] ?? null;
    }
    if (\$user) {
        wp_set_current_user(\$user->ID);
        wp_set_auth_cookie(\$user->ID, true);
        wp_safe_redirect(admin_url());
        exit;
    }
});
`;

export function createInstanceDir(name: string): string {
  const dir = getInstanceDir(name);
  if (existsSync(dir)) {
    throw new Error(`Instance "${name}" already exists at ${dir}`);
  }

  const wpContentDir = join(dir, 'wp-content');
  const muPluginsDir = join(wpContentDir, 'mu-plugins');
  mkdirSync(muPluginsDir, { recursive: true });
  writeFileSync(join(muPluginsDir, '0-instawp-auto-login.php'), AUTO_LOGIN_MU_PLUGIN);
  return dir;
}

/**
 * Ensure auto-login mu-plugin exists (for instances created before this was added).
 */
export function ensureAutoLogin(instance: LocalInstance): void {
  const muPluginsDir = join(instance.path, 'wp-content', 'mu-plugins');
  const pluginPath = join(muPluginsDir, '0-instawp-auto-login.php');
  if (!existsSync(pluginPath)) {
    mkdirSync(muPluginsDir, { recursive: true });
    writeFileSync(pluginPath, AUTO_LOGIN_MU_PLUGIN);
  }
}

export function deleteInstanceDir(name: string): void {
  const dir = getInstanceDir(name);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Build the wp-playground-cli argument(s) to mount a host path at a VFS path.
 *
 * `--mount` / `--mount-before-install` take a single `host:vfs` value, which
 * wp-playground-cli splits on `:`. On Windows the host path contains a
 * drive-letter colon (e.g. `C:\Users\...\wp-content`), so the split yields 3+
 * parts and Playground rejects it with "Invalid mount format". On Windows we
 * instead use `--mount-dir` / `--mount-dir-before-install`, which take the host
 * and vfs paths as two separate args (`nargs: 2`) and avoid the colon entirely.
 * Both forms resolve to the same `{ hostPath, vfsPath }` mount in Playground
 * (no file-vs-directory distinction), so this works for files and directories.
 *
 * macOS/Linux keep the long-standing colon form unchanged (their absolute paths
 * have no drive-letter colon). `platform` is injectable for testing.
 */
export function buildMountArgs(
  hostPath: string,
  vfsPath: string,
  opts: { beforeInstall?: boolean; platform?: NodeJS.Platform } = {},
): string[] {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') {
    return [opts.beforeInstall ? '--mount-dir-before-install' : '--mount-dir', hostPath, vfsPath];
  }
  return [`${opts.beforeInstall ? '--mount-before-install' : '--mount'}=${hostPath}:${vfsPath}`];
}

function buildServerArgs(instance: LocalInstance, blueprint?: string): string[] {
  const wpContentDir = join(instance.path, 'wp-content');
  const isClone = existsSync(join(instance.path, 'sqlite-import.sql')) ||
                  existsSync(join(wpContentDir, 'database', '.ht.sqlite'));

  const args = [
    'server',
    `--port=${instance.port}`,
    `--php=${instance.php}`,
    `--wp=${instance.wp}`,
    '--login',
  ];

  if (isClone) {
    // For cloned sites: mount subdirs individually AFTER install.
    // This lets Playground set up db.php internally while our data persists.
    const subdirs = ['database', 'plugins', 'themes', 'uploads', 'mu-plugins'];
    for (const subdir of subdirs) {
      const hostDir = join(wpContentDir, subdir);
      if (existsSync(hostDir)) {
        args.push(...buildMountArgs(hostDir, `/wordpress/wp-content/${subdir}`));
      }
    }
    // Mount non-core root files (CLAUDE.md, .htaccess, etc.)
    const skipFiles = new Set(['wp-content', 'database.sql', 'sqlite-import.sql', 'clone-blueprint.json', 'import-blueprint.json', 'import-db.php']);
    for (const file of readdirSync(instance.path)) {
      if (skipFiles.has(file) || file.startsWith('.')) continue;
      const filePath = join(instance.path, file);
      const stat = statSync(filePath);
      if (stat.isFile()) {
        args.push(...buildMountArgs(filePath, `/wordpress/${file}`));
      }
    }

    // Use clone blueprint if it exists (has AST driver + login step)
    if (!blueprint) {
      const cloneBlueprintPath = join(instance.path, 'clone-blueprint.json');
      if (existsSync(cloneBlueprintPath)) {
        blueprint = cloneBlueprintPath;
      }
    }
  } else {
    // For fresh sites: mount entire wp-content before install for persistence
    args.push(...buildMountArgs(wpContentDir, '/wordpress/wp-content', { beforeInstall: true }));
  }

  if (blueprint) {
    args.push(`--blueprint=${blueprint}`);
  }

  return args;
}

/**
 * Starts the Playground server in the foreground.
 * Watches stdout for the ready URL and calls onReady when detected.
 * Returns a promise that resolves when the server exits.
 */
export function startServer(
  instance: LocalInstance,
  opts?: { blueprint?: string; onReady?: (url: string) => void },
): Promise<number> {
  const args = buildServerArgs(instance, opts?.blueprint);

  const [cmd, prefixArgs, usingNpx] = getPlaygroundCommand();
  maybeShowNpxHint(usingNpx);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...prefixArgs, ...args], {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: instance.path,
    });

    let readyFired = false;

    // Watch stdout for the server URL to detect readiness
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      process.stdout.write(data);

      if (!readyFired && opts?.onReady) {
        // Playground CLI prints the URL when ready (e.g. "http://127.0.0.1:9400")
        const urlMatch = text.match(/https?:\/\/127\.0\.0\.1:\d+/);
        if (urlMatch) {
          readyFired = true;
          opts.onReady(urlMatch[0]);
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(data);
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      // Restore terminal state — Playground CLI can leave it in raw mode
      if (process.stdin.isTTY) {
        process.stdin.setRawMode?.(false);
      }
      if (process.platform !== 'win32') {
        spawnSync('stty', ['sane'], { stdio: 'inherit' });
      }
      resolve(code ?? 0);
    });
  });
}

/**
 * Starts the Playground server in the background.
 * Spawns detached with output going to a log file.
 * Polls until the server is ready, then returns.
 */
export async function startServerBackground(
  instance: LocalInstance,
  blueprint?: string,
): Promise<{ pid: number; url: string }> {
  const args = buildServerArgs(instance, blueprint);
  const [cmd, prefixArgs, usingNpx] = getPlaygroundCommand();
  maybeShowNpxHint(usingNpx);

  const logFile = join(instance.path, 'server.log');
  const pidFile = join(instance.path, 'server.pid');

  // Spawn fully detached with output to log file
  const logFd = openSync(logFile, 'w');
  const child = spawn(cmd, [...prefixArgs, ...args], {
    stdio: ['ignore', logFd, logFd],
    cwd: instance.path,
    detached: true,
  });

  const pid = child.pid!;
  writeFileSync(pidFile, String(pid));
  child.unref();
  closeSync(logFd);

  // Poll the log file for the ready URL
  const url = `http://127.0.0.1:${instance.port}`;
  const maxWait = 120000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 2000));

    // Check if process is still alive
    try { process.kill(pid, 0); } catch {
      const log = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : '';
      throw new Error(`Server exited unexpectedly. Log:\n${log.slice(-500)}`);
    }

    // Check if server is responding
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
      clearTimeout(timer);
      if (res.status === 200 || res.status === 302) {
        return { pid, url };
      }
    } catch {
      // Not ready yet
    }
  }

  throw new Error(`Server did not become ready within 120s. Check ${logFile}`);
}

export function stopServer(instance: LocalInstance): boolean {
  const pidFile = join(instance.path, 'server.pid');
  if (!existsSync(pidFile)) return false;

  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already dead
  }
  rmSync(pidFile, { force: true });
  return true;
}

export function isServerRunning(instance: LocalInstance): boolean {
  const pidFile = join(instance.path, 'server.pid');
  if (!existsSync(pidFile)) return false;
  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    rmSync(pidFile, { force: true });
    return false;
  }
}
