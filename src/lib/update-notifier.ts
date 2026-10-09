import { spawnSync } from 'node:child_process';
import { getUpdateCheck, setUpdateCheck } from './config.js';
import { isJsonMode } from './output.js';

const PKG = '@instawp/cli';
const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PKG}/dist-tags`;
const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // once per day

/**
 * Compare semver-ish versions ("0.0.1" / "0.0.1-beta.22"). Returns >0 if a>b,
 * <0 if a<b, 0 if equal. A release outranks any prerelease of the same core
 * (so 0.0.1 > 0.0.1-beta.22), and beta.22 > beta.9 (numeric, not string).
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const [core, pre] = v.replace(/^v/, '').split('-');
    const [maj, min, pat] = core.split('.').map((n) => parseInt(n, 10) || 0);
    let preNum = Infinity; // no prerelease = highest
    if (pre) {
      const m = pre.match(/(\d+)/);
      preNum = m ? parseInt(m[1], 10) : 0;
    }
    return [maj || 0, min || 0, pat || 0, preNum];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Fetch the newest published version (the `latest` dist-tag). Null on any failure. */
export async function fetchLatestVersion(timeoutMs = 2500): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(DIST_TAGS_URL, { signal: ctrl.signal });
      if (!res.ok) return null;
      const tags = (await res.json()) as Record<string, string>;
      return tags.latest || null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Run `npm install -g @instawp/cli@<tag>` (inherits stdio). Returns npm's exit code.
 * `--allow-scripts=better-sqlite3`: npm 12 blocks install scripts by default, which
 * would leave the SQLite native binary undownloaded (local clone/push then fail).
 * npm 10 and 11 accept the flag silently.
 */
export function performUpgrade(versionTag = 'latest'): number {
  const res = spawnSync('npm', ['install', '-g', `${PKG}@${versionTag}`, '--allow-scripts=better-sqlite3'], { stdio: 'inherit' });
  return res.status ?? 1;
}

function suppressed(): boolean {
  return Boolean(
    process.env.INSTAWP_NO_UPDATE_NOTIFIER ||
    process.env.NO_UPDATE_NOTIFIER ||
    process.env.CI ||
    isJsonMode() ||
    !process.stderr.isTTY, // non-interactive (scripts, harnesses, pipes) → stay silent
  );
}

/**
 * At most once per day, check npm for a newer version. If found, print a
 * one-line banner to STDERR (so it never pollutes stdout/JSON), or run the
 * upgrade automatically when INSTAWP_AUTO_UPGRADE is set. Cache hits are
 * instant; only the daily refresh does a short, timeout-bounded network call.
 * Never throws — a notifier must never break a real command.
 */
export async function maybeNotifyUpdate(currentVersion: string): Promise<void> {
  if (suppressed()) return;
  try {
    const cache = getUpdateCheck();
    let latest = cache?.latestVersion || '';
    const stale = !cache || Date.now() - cache.lastCheck > CHECK_INTERVAL;
    if (stale) {
      const fetched = await fetchLatestVersion();
      if (fetched) {
        latest = fetched;
        setUpdateCheck(fetched);
      } else if (!cache) {
        return; // first run + offline: nothing cached to show
      }
    }
    if (!latest || compareVersions(latest, currentVersion) <= 0) return;

    if (process.env.INSTAWP_AUTO_UPGRADE) {
      process.stderr.write(`\nUpdating ${PKG} ${currentVersion} → ${latest}…\n`);
      performUpgrade();
      return;
    }
    process.stderr.write(
      `\n⚡ Update available: ${currentVersion} → ${latest}  ·  run: instawp upgrade\n` +
      `   (silence with INSTAWP_NO_UPDATE_NOTIFIER=1)\n\n`,
    );
  } catch {
    // swallow — never let the notifier interfere with the command
  }
}
