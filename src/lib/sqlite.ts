import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';

const require = createRequire(import.meta.url);

let cached: typeof Database | undefined;

/**
 * Load better-sqlite3 on first use instead of at startup.
 *
 * It is a native addon and an optionalDependency: on a platform/Node combination
 * with no prebuilt binary (and no C++ toolchain) npm skips it rather than failing
 * the whole install. A static import would then crash every command — including
 * `login` — because `index.ts` loads `local.ts` eagerly. Only the commands that
 * actually open a SQLite file (local clone/push) call this, so only they fail.
 */
export function loadSqlite(): typeof Database {
  if (cached) return cached;
  try {
    const Sqlite = require('better-sqlite3') as typeof Database;
    // Requiring the package does not load the native binary; opening a DB does.
    // npm 12 installs the package but BLOCKS its install script by default, so
    // the binary is never downloaded and only the first `new Database()` fails.
    new Sqlite(':memory:').close();
    cached = Sqlite;
    return cached;
  } catch (err: any) {
    const reason = err?.code || String(err?.message ?? err).split('\n')[0].replace(/\s*Tried:\s*$/, '');
    throw new Error(
      `Local-site features need the SQLite native module (better-sqlite3), which failed to load (${reason}). ` +
      'Reinstall the CLI on Node.js 22, 24 or 26, allowing its install script: ' +
      'npm install -g @instawp/cli --allow-scripts=better-sqlite3',
    );
  }
}
