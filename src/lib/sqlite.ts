import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';

const require = createRequire(import.meta.url);

let cached: typeof BetterSqlite3 | undefined;

/**
 * Load better-sqlite3 on first use instead of at startup.
 *
 * It is a native addon and an optionalDependency: on a platform/Node combination
 * with no prebuilt binary (and no C++ toolchain) npm skips it rather than failing
 * the whole install. A static import would then crash every command — including
 * `login` — because `index.ts` loads `local.ts` eagerly. Only the commands that
 * actually open a SQLite file (local clone/push) call this, so only they fail.
 */
export function loadSqlite(): typeof BetterSqlite3 {
  if (cached) return cached;
  try {
    cached = require('better-sqlite3') as typeof BetterSqlite3;
    return cached;
  } catch (err: any) {
    throw new Error(
      `Local-site features need the SQLite native module (better-sqlite3), which failed to load (${err?.code || err?.message}). ` +
      'Reinstall the CLI on Node.js 22, 24 or 26: npm install -g @instawp/cli',
    );
  }
}
