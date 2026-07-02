# CLAUDE.md - InstaWP CLI

## Overview

TypeScript CLI for InstaWP. Lets users create/manage WordPress sites from the terminal.

- **Stack**: TypeScript, ESM, Commander.js, Axios, Node 18+
- **Package**: `@instawp/cli` on npm (scoped, public)
- **Entry**: `src/index.ts` → compiled to `dist/index.js`
- **Binary**: `instawp` (registered via `bin` in package.json)

## Project Structure

```
src/
├── index.ts                 # CLI entry point, command registration
├── types.ts                 # All TypeScript interfaces
├── commands/
│   ├── login.ts             # OAuth browser flow + --token
│   ├── whoami.ts            # Show current session
│   ├── sites.ts             # sites list/create/delete + top-level create alias
│   ├── exec.ts              # exec + wp commands (merged, --api/--ssh transport)
│   ├── ssh.ts               # Interactive SSH shell
│   ├── sync.ts              # rsync push/pull via SSH
│   ├── teams.ts             # teams list/switch/members
│   ├── local.ts             # local create/clone/start/stop/push/pull/list/delete
│   └── migrate.ts           # migrate push (local WP dir → brand-new hosted site)
├── lib/
│   ├── api.ts               # Axios client, auth interceptor, team_id injection
│   ├── auth.ts              # OAuth flow (local HTTP server for callback)
│   ├── config.ts            # Conf-based persistent config (~/.config/instawp/)
│   ├── wp-local.ts          # WP-root/wp-config/version detection (pure, for migrate push)
│   ├── wp-archive.ts        # zip (archiver) + DB export (wp/mysqldump) for migrate push
│   ├── local-env.ts         # Playground server management, background mode
│   ├── output.ts            # chalk/ora output helpers, --json mode
│   ├── site-resolver.ts     # Resolve site by ID/name/domain with caching
│   ├── ssh-keys.ts          # SSH key generation, upload, caching
│   └── ssh-connection.ts    # SSH/rsync spawn helpers
├── __tests__/               # Vitest tests (148 tests)
scripts/
└── mysql2sqlite             # MySQL→SQLite dump converter (vendored)
```

## Commands

```
# Auth
instawp login [--token <t>] [--api-url <url>]
instawp whoami

# Sites (cloud)
instawp sites list [--status <s>] [--page <n>] [--per-page <n>] [--all]
instawp sites creds <site>
instawp create --name <n> [--php <v>] [--config <id>]
instawp sites delete <site> [--force]
instawp open <site> [--admin] [--magic] [--print]

# Versions (restorable point-in-time site copies)
instawp versions create <site> [--name <label>] [--no-wait]
instawp versions list <site>
instawp versions restore <site> <version-id> [--force] [--no-wait]
instawp versions delete <site> <version-id...> [--force]

# Remote access (wp is the primary command; exec is the escape hatch)
instawp wp <site> <args...> [--api]           # WP-CLI on the site
instawp ssh <site>                            # Interactive shell
instawp sync push <site> [--path] [--exclude] [--dry-run]
instawp sync pull <site> [--path] [--exclude] [--dry-run]
instawp cache purge <site> [--object]                  # purge CDN edge cache (+ object cache)
instawp db push <site> <file> [--force] [--no-backup]
instawp db pull <site> [--output <path>] [--no-compress]
instawp logs <site> [--wp] [--php] [--nginx] [--follow] [--lines <n>]
instawp exec <site> <cmd...> [--api] [--timeout <s>]   # Raw shell (non-WP)
instawp sql <site> "<query>"                           # SQL via WP-CLI (hits MySQL, cache-immune)
instawp plugin install <site> <zip|dir> [--activate]   # install plugin (scp+wp for zip; rsync for dir)

# Self-update (notifier checks npm once/day; suppressed in --json/CI/non-TTY)
instawp upgrade [--check]                              # npm i -g @instawp/cli@latest

# Teams
instawp teams list
instawp teams switch [team]          # client-side team context
instawp teams members <team>

# Local development (powered by WordPress Playground)
instawp local create [--name <n>] [--wp <v>] [--php <v>] [--background] [--no-open]
instawp local clone <cloud-site> [--name <n>] [--no-start]
instawp local start [name] [--background] [--no-open]
instawp local stop [name]
instawp local push <local-name> [cloud-site] [--dry-run]
instawp local pull <local-name> <cloud-site> [--dry-run]
instawp local list
instawp local delete <name> [--force]

# Migration (local WordPress dir → brand-new hosted site)
instawp migrate push [path] [--path <dir>] [--name <n>] [--source-url <url>] [--wp <v>] [--php <v>] [--keep-archives] [--dry-run]
```

All commands support `--json` for machine-readable output.

## Key Design Decisions

### wp (primary) + exec (escape hatch)
- **`wp <site>`** is the canonical way to run anything on a remote site — prepends `wp` to args, integrates with WP-CLI.
- **`exec <site>`** is the escape hatch for non-WP shell commands (`ls`, `tail`, `ps`, …). Same transport, no `wp` prefix.
- Both accept `--` as a POSIX end-of-options marker so users can forward raw args: `instawp wp my-site -- post list --post_type=page`
- Both shell-escape each arg via single-quote wrapping before piping to remote stdin — fixes the `eval '...'` parens issue.
- `--ssh` (default): real SSH connection, proper exit codes, real-time output
- `--api`: uses `POST /sites/{id}/run-cmd` API → cloud-app → InstaCP `v-instawp-run-cmd`
- Both transports can run arbitrary commands (API is not WP-only despite the name)

### Site resolution + caching
- `resolveSite()` accepts ID (numeric), name, or domain
- Numeric → direct `GET /sites/{id}/details`
- String → fetches list, matches by name/sub_domain/domain, then fetches details
- **Caches** name→ID mappings for 10 minutes (avoids list call on repeat lookups)

### Team context
- `teams switch` stores team_id locally (no server-side change)
- API interceptor injects `team_id` as query param on all requests
- Client-app `SiteService::getList()` already accepts `team_id` parameter

### Local development architecture
- Uses **WordPress Playground** (`@wp-playground/cli`) — WASM PHP + SQLite, no Docker needed
- NOT a hard dependency — auto-downloaded via `npx`, faster if installed globally (`npm i -g @wp-playground/cli`)
- Instance data stored at `~/.instawp/local/<name>/`
- Fresh sites: mount entire `wp-content` before install (`--mount-before-install`)
- Cloned sites: mount subdirs individually after install (`--mount`) so Playground sets up `db.php` internally

### Clone flow (local clone)
1. Export MySQL dump via SSH (`wp db export`)
2. Strip SSH MOTD from dump output
3. Convert MySQL → SQLite using `mysql2sqlite` (awk script)
4. Import directly into `.ht.sqlite` via `sqlite3` CLI
5. Rename table prefix to `wp_` (tables + meta keys + option names)
6. Search-replace cloud URL → `http://127.0.0.1:<port>` across all tables
7. Pull wp-content via rsync (plugins, themes, uploads)
8. Pull non-core root files (CLAUDE.md, .htaccess, etc.)
9. Generate blueprint with `WP_SQLITE_AST_DRIVER=true` + `login` step with actual admin username
10. Write error suppression mu-plugin

### DB push flow (`local push --with-db`) — SQLite → MySQL (the reverse of clone)
Pushes the local Playground DB back to the cloud MySQL, OVERWRITING it. Implemented in `pushDatabase()` (`commands/local.ts`) + `lib/sqlite-to-mysql.ts`.
1. Read local siteurl from `wp_options` (authoritative; handles port drift)
2. Discover cloud `table_prefix` + existing tables via SSH — **MOTD-stripped** (`parseTablePrefix`/`parseSqlTableNames` in `lib/local-instance.ts`); a banner leaking in would mismatch every table → silent empty push
3. `generateMysqlDump()`: **data-only** (`TRUNCATE`+`INSERT`, no `CREATE TABLE`) for local `wp_*` tables whose cloud-prefixed name exists on the cloud (intersection — so a missing-table TRUNCATE can't abort the import). Pins `sql_mode` (backslash escaping), `safeIntegers(true)` (no >2^53 loss), BLOB→`0x` hex (empty→`''`), byte-budgeted INSERT batching
4. Refuse if 0 tables intersect (fail loud, never a silent no-op)
5. Back up cloud DB (`wp db export | gzip`), abort if it fails (unless `--no-backup`)
6. scp upload → `wp db import`
7. If cloud prefix ≠ `wp_`: remap role/capability keys to the cloud prefix — `{prefix}capabilities`, `{prefix}user_level` (usermeta), `{prefix}user_roles` (options). Local is `wp_`-normalized, so without this the admin loses all capabilities and **wp-admin becomes inaccessible** (most InstaWP sites use a random prefix). Exact key names only — never touches plugin options.
8. `wp search-replace <local-url> <cloud-url>` (serialization-safe — NOT done in SQL) → `wp cache flush`

**Why no official tool:** WordPress has no SQLite→MySQL exporter — [sqlite-database-integration#36](https://github.com/WordPress/sqlite-database-integration/issues/36) is open since 2023; the community workaround regenerates schema with `text→varchar(255)` (truncates content) + `addslashes`. Our data-only approach (reuse cloud schema) avoids both. `wp db export` can't help (shells to mysqldump, absent in Playground). Caveat: assumes schema parity (true for clones); plugin tables created only-locally are skipped.

### Migrate push flow (`migrate push [path]`) — local WP dir → brand-new hosted site
The standalone-CLI replacement for the plugin's `wp instawp local push`. Mirrors an **arbitrary on-disk WordPress install** (NOT a Playground instance — that's `local push`) up to a fresh hosted site. Implemented in `commands/migrate.ts` + `lib/wp-local.ts` + `lib/wp-archive.ts`.
1. **Locate the WP root** — walk up from `[path]`/`--path`/cwd to `wp-includes/version.php` (`findWpRoot`); parse `wp-config.php` for DB creds + `$table_prefix` + `WP_HOME`/`WP_SITEURL` (`parseWpConfig`).
2. **Detect source URL** — `wp option get home`/`siteurl` (if wp-cli works on the install), else the `WP_HOME`/`WP_SITEURL` constants, else a direct `mysql` query; `--source-url` overrides. Normalized to `source_domain` (no scheme/`www.`/trailing slash) so the server regex accepts it.
3. **Archive files** — stream a zip via `archiver`, excluding EXACTLY the plugin's skip-list (`wp-content/instawpbackups`, `wp-content/upgrade`, plugins `instawp-connect`/`instawp-helper`/`iwp-migration`). Files added relative to the WP root so the restore engine sees a normal WP tree.
4. **Export DB** — `wp db export` if wp-cli works on the install, else `mysqldump` driven by the wp-config creds (password via `MYSQL_PWD`, never in argv). Raw `.sql`, matching the plugin.
5. **Create a reserved site** — `POST /sites { is_reserved: true, wp_version }`, poll `GET /tasks/{id}/status`.
6. **Upload** — `ensureSshAccess()` (key-based), then `scp` both archives into `/home/{user}/web/{sub_domain}/public_html/` — the exact path `restore-raw` reconstructs server-side.
7. **Restore** — `PUT /sites/{id}/restore-raw { file_bkp, db_bkp, source_domain }` → poll the returned `task_id`. The **server-side restore engine** (cloud-app → InstaCP) unzips, imports, and search-replaces `source_domain` → the new domain. This is what makes it a faithful mirror (prefix/URL/serialized-data rewrite happens server-side — the CLI does none of it).
8. Best-effort `rm` of the uploaded archives from the new webroot; `waitForHttp` the new URL; report.

**Auth model (the key decision):** runs entirely on the CLI's personal API token over **site-scoped** routes. The plugin uses connect-scoped routes (`connects/{cid}/sites/...`) because the plugin IS a connect; every one of those has a personal-token site-scoped equivalent (`POST /sites`, `GET /tasks/{id}/status`, `POST /sites/{id}/update-sftp-status`, `GET /sites/{id}/sftp-details`, **`PUT /sites/{id}/restore-raw`**). `CheckConnectApiToken` only gates tokens whose `device_type == TOKEN_TYPE_CONNECT_MANAGE`; a personal token passes through. So **no Connect record and no migration-dashboard/tracking entry are created** — only the files+DB migration, which is identical to the plugin's outcome. (The plugin's `migrates-v3/local-push` + `finish-local-staging` bookkeeping is intentionally skipped.)

**Caveats:** the new site has NO `instawp-connect` plugin (it's excluded, faithful to the local files) — manage via SSH / `instawp wp` / `instawp open`. After restore the site's admin login is the LOCAL site's users (the DB was replaced), not the freshly-minted creds. On Local-by-Flywheel and similar, `wp`/the DB socket usually aren't reachable from the host shell, so run from a shell where `wp` works or pass `--source-url` (the mysqldump fallback still needs DB reachability).

### Background mode
- `--background` flag spawns detached process, polls until server responds, returns immediately
- PID stored at `<instance>/server.pid`, logs at `<instance>/server.log`
- `local stop` kills the background process
- `local list` shows `running`/`stopped` status

### SSH key management
- Auto-generates RSA 4096 key at `~/.instawp/cli_key` if needed
- Checks existing keys (`~/.ssh/id_rsa`, `id_ed25519`) first
- Uploads to InstaWP API, enables SSH+SFTP on site, attaches key
- Caches connection details for 1 hour in conf store

### SSH host resolution + CDN-fronted sites (`ensureSshAccess`)
`POST /sites/{id}/update-ssh-status` returns the site's **public hostname** — for a **CDN-fronted site** (Bunny) that's the proxied edge (port 22 filtered), so SSH would hang ~2 min. `ensureSshAccess(siteId, opts)` resolves the true origin itself, in this host precedence:
1. **Explicit override** — `opts.sshHost` (`--ssh-host`) else `getSshHostOverride()` (`INSTAWP_SSH_HOST_<id>` > `INSTAWP_SSH_HOST`). Manual escape hatch; applied even to a cached host.
2. **Auto-detected origin IP** — `GET /sites/{id}/credentials` returns `site_meta.ip_addr` (the real server IP, exactly what InstaWP's own `SshBridge` uses: `ip_addr ?? sub_domain`). Preferred over the API host, so CDN-fronted sites work with **no override**. Verified: site 2495716 (instawp.com) → `update-ssh-status` gives the CDN host, `/credentials.ip_addr` gives the reachable origin.
3. **API host** (the CDN edge / `sub_domain`) — fallback when no override and no `ip_addr`.
- **Preflight**: `probeTcp(host, port, 5000)` (`lib/ssh-preflight.ts`) TCP-connects before returning. Default `onUnreachable:'exit'` prints the diagnostic + `process.exit(1)` (all SSH commands get fast-fail for free); `'throw'` raises `SshUnreachableError` so `wp`/`exec` catch it and auto-fall-back to `--api`.
- **Self-heal**: if a *cached* host fails preflight (and no override), the cache is dropped and re-resolved once — so a stale CDN host cached before this shipped heals without a manual `--refresh`.
- **`--api` transport** (`lib/api-exec.ts` → `runViaApi`) drives `POST /sites/{id}/run-cmd` (the only non-SSH channel, not behind the CDN). `db pull/push --api` base64-round-trip the dump over it (single/chunked; small-medium DBs). `run-cmd` is request/response — no streaming/binary — per-call `timeout` is raised past the axios 30s default. `sync --api` is NOT implemented (deferred).
- **Gotcha**: `wp`/`exec` use `passThroughOptions()`+`allowUnknownOption()` and re-extract flags from argv — a new SSH flag must be added to `.option()` AND the manual extraction block in `exec.ts`, or it's swallowed.

### Config storage
- Uses `conf` package → `~/.config/instawp/config.json`
- Env overrides: `INSTAWP_TOKEN`, `INSTAWP_API_URL`, `INSTAWP_SSH_HOST` (+ per-site `INSTAWP_SSH_HOST_<siteId>`)
- Stores: auth, SSH cache, site cache, team_id, local instances

## Vendored Dependencies

### `scripts/mysql2sqlite`
- **Source**: https://github.com/dumblob/mysql2sqlite
- **License**: MIT
- **What**: AWK script that converts MySQL dump files to SQLite-compatible SQL
- **Used by**: `local clone` for database import
- **Version**: Vendored from master branch (2026-03-23)
- **Update procedure**: Download latest from `https://raw.githubusercontent.com/dumblob/mysql2sqlite/master/mysql2sqlite` and replace `scripts/mysql2sqlite`. Test with `instawp local clone` on a WooCommerce site to verify compatibility.

## Windows Support

Windows ships with `ssh`/`scp` but not `rsync`, `awk`, or `sqlite3`. The CLI works on Windows with zero extra installs via:

- **`better-sqlite3`** (npm dep) — replaces the sqlite3 CLI. Native module, prebuilt binaries for win32-x64.
- **`vendor/win32/busybox.exe`** — provides `awk` for the `mysql2sqlite` script (invoked as `busybox awk -f ...`). Statically linked, no DLLs. This is the **only** bundled binary.
- **Pure-JS SFTP** (`ssh2-sftp-client`) for file transfers — see below.
- **`cross-spawn`** for launching WordPress Playground (`local create/start/clone`). `npx`/`wp-playground-cli` are `.cmd` shims on Windows; Node won't spawn `.cmd` without `shell:true` (CVE-2024-27980), so `local-env.ts` uses `cross-spawn` (resolves the shim + quotes mount-path args safely). Never use bare `child_process.spawn` for npx/.cmd on Windows.
- **Playground mounts** (`local-env.ts` → `buildMountArgs()`): never colon-join `host:vfs` on Windows. wp-playground-cli's `--mount=<host>:<vfs>` splits on `:`, and a Windows drive-letter colon (`C:\...`) makes the split fail with `Invalid mount format`. On Windows use `--mount-dir` / `--mount-dir-before-install` (host + vfs as two separate `nargs:2` args — identical mount, no colon). macOS/Linux keep the colon form. Works for both directory and file mounts.

### File transfer: rsync (mac/Linux) vs SFTP (Windows)
- `syncFiles()` in `src/lib/ssh-connection.ts` is the dispatcher. On macOS/Linux it shells out to `rsync` (delta sync). On Windows it calls `syncViaSftp()` (`src/lib/sftp-sync.ts`).
- **Why not bundle rsync on Windows?** We tried (betas 4–9). msys2 rsync.exe cannot drive **native Windows OpenSSH** — incompatible pipe/signal semantics produce `connection unexpectedly closed (0 bytes)` + `sigpacket: Suppressing signal 30`. Bundling an msys ssh too would drag in the whole Heimdal/Kerberos DLL chain (~3.5 MB, ~15 brittle DLLs). Pure-JS SFTP sidesteps all of it.
- **Trade-off**: SFTP does full-file copy (no rsync delta). Fine for wp-content; slower on large repeat syncs.
- `syncViaSftp` mirrors rsync's exclude/include patterns via `makeMatcher` (exact names match at any depth; `*` globs don't cross `/`; patterns with `/` are anchored to the relative path).

### Resolution order (busybox)
- `findAwk()` (`src/commands/local.ts`) prefers bundled `busybox.exe` on Windows, then `awk`/`gawk` in PATH, then common Git-for-Windows dirs.
- `bundledBusybox()` (`src/lib/windows-binaries.ts`) returns the path only on win32 when the file exists.

### Refreshing the Windows bundle
```bash
# Maintainer-only — just downloads busybox64u.exe (requires curl)
bash scripts/fetch-windows-binaries.sh
git add vendor/win32 && git commit -m 'chore: refresh busybox'
```
See `vendor/win32/NOTICE.md` for source + license (BusyBox is GPL-2.0).

### Cross-platform path handling (rsync path, mac/Linux only)
- `src/lib/paths.ts` → `toRsyncPath()` converts `C:\foo\bar` → `/c/foo/bar`. Retained for completeness, but only exercised by `rsyncViaSsh` which no longer runs on Windows.

## Known Limitations

### Local clone + SQLite
- **WP_SQLITE_AST_DRIVER=true** is required for complex plugins (WooCommerce). The new AST-based SQLite driver (v2.2.1+) handles 99% of MySQL queries.
- Some MySQL-specific queries may still fail at runtime (rare edge cases in complex plugins)
- PHP deprecation warnings can crash WASM PHP — suppressed via mu-plugin (`error_reporting(E_ERROR | E_PARSE)`)
- `downloads.w.org` is unreachable on some networks — connectivity pre-check warns the user

## API Endpoints Used

| Endpoint | Used By |
|----------|---------|
| `GET /api/v2/sites` | sites list, site resolver |
| `GET /api/v2/sites/{id}/details` | site resolver |
| `POST /api/v2/sites` | sites create, local push (auto-create), migrate push (new site) |
| `PUT /api/v2/sites/{id}/restore-raw` | migrate push (server-side restore of uploaded zip+sql) |
| `POST /api/v2/sites/{id}/purge-cache` | cache purge (CDN edge; 422 if no CDN) |
| `POST /api/v2/sites/{id}/clear-object-cache` | cache purge --object (Redis; 422 if not enabled) |
| `DELETE /api/v2/sites/{id}` | sites delete |
| `POST /api/v2/sites/{id}/run-cmd` | exec --api, wp --api, db pull/push --api (non-SSH transport) |
| `GET /api/v2/site-versions?site_id={id}` | versions list |
| `POST /api/v2/site-versions` | versions create |
| `PUT /api/v2/site-versions/{id}` | versions create (set `--name`) |
| `PUT /api/v2/sites/{id}/restore-versions/{versionId}` | versions restore |
| `DELETE /api/v2/site-versions` | versions delete (body `{ids:[]}`) |
| `GET /api/v2/tasks/{id}/status` | create, versions create/restore (poll task) |
| `GET /api/v2/ssh-keys` | SSH key matching |
| `POST /api/v2/ssh-keys` | SSH key upload |
| `POST /api/v2/sites/{id}/ssh-keys/{keyId}` | attach key to site |
| `POST /api/v2/sites/{id}/update-ssh-status` | enable SSH |
| `POST /api/v2/sites/{id}/update-sftp-status` | enable SFTP |
| `GET /api/v2/teams` | teams list, whoami |
| `GET /api/v2/teams/{id}/members` | teams members |

## Development

```bash
npm install          # Install deps
npm run dev          # Watch mode (tsc --watch)
npm run build        # Build to dist/
npm test             # Run vitest (148 tests)
npm run test:watch   # Watch mode tests
```

### Testing locally
```bash
npm run build
node dist/index.js --help
node dist/index.js login --token <test-token>
node dist/index.js sites list
node dist/index.js local create --name test --background --no-open
node dist/index.js local stop test
```

Or link globally:
```bash
npm link
instawp --help
```

## Publishing

**Workflow**: Push a `v*` tag → GitHub Actions builds, tests, publishes to npm. Full procedure: skill `iwp-cli-release`. **Tag-based, not the Laravel repos' dev→main PR flow.**

```bash
# 1. Bump version in package.json
# 2. Add a "## <version> (YYYY-MM-DD)" entry at the TOP of CHANGELOG.md  (required)
# 3. Commit (explicit paths — repo has unrelated untracked files; dist/ is gitignored)
git tag -a v0.0.1-beta.2 -m "..." && git push origin v0.0.1-beta.2
```

- Publishes with `--tag beta` (install via `npm i -g @instawp/cli@beta`). `latest` stays on an old stable; drop `--tag beta` for stable releases. Uses `NPM_TOKEN`.
- **`publish.yml`** (tag-triggered): Windows smoke test → build → test → npm publish → GitHub Release. **`release-notify.yml`** (also tag-triggered, unlike siblings which fire on PR-merge) → Claude summary to Slack. Both extract the CHANGELOG section by **exact** `## <version> ` header match, so the version in `package.json`, the tag, and the CHANGELOG header must all agree.
- Pushing the tag is the release trigger; pushing `main` alone publishes nothing. Tag dispatch / secret listing needs repo admin (a normal token gets 403).

## Conventions

- All imports use `.js` extension (ESM requirement)
- `process.exit(1)` on fatal errors after printing message via `error()`
- Spinners stop before printing output (no interleaved text)
- JSON mode returns `{ success, data }` or `{ success: false, error }`
- Version reads from package.json at runtime (single source of truth)
- rsync uses `--itemize-changes` (only shows actually changed files)
- Terminal restored with `stty sane` after Playground exits
