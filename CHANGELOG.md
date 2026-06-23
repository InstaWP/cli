# Changelog

## Unreleased

### Added — db push prefix-safety, URL remap, sync mirroring & webroot, exec shell

These address feedback from a real LocalWP → cloud "mirror overwrite" workflow.

- **`db push` now detects a table-prefix mismatch** (e.g. a `wp_` dump pushed to an `iwpa4c7_` site) instead of silently importing orphan tables the site never reads. It warns loudly and offers to rewrite; pass **`--rewrite-prefix`** to remap the dump's table identifiers non-interactively. Rewriting also remaps the prefix-bound role/capability keys (`{prefix}capabilities`, `{prefix}user_level`, `{prefix}user_roles`) after import so admin login survives.
- **`db push --search-replace <from> <to>`** runs a serialization-safe `wp search-replace` across all tables right after import — the near-universal next step after a cross-domain push.
- **`instawp wp`/`exec` no longer leak the server login banner/MOTD** into command stdout (or the `--json` payload). Output is now exactly the command's output, so `--field`, `--format=count`, and value capture are clean.
- **`exec --shell '<cmdline>'`** runs the arguments as one shell command line on the remote (enables pipes, `;`, `>`, globs). The misleading `-- ps aux | grep php` help example (which actually piped locally) is fixed.
- **`sync push/pull --delete`** makes the remote/local a true mirror (removes extraneous files), guarded by a confirmation prompt (skip with `--yes`; preview with `--dry-run`). Additive remains the default. Not supported on Windows (SFTP transport).
- **`sync push/pull --remote-path <path>` / `--webroot`** transfer files outside `wp-content/` (e.g. webroot-level `ABSPATH/variations/`).
- **`versions create`** now echoes the restore/list hint using the same site identifier you typed (no more short-name in, FQDN out).
- `db push --search-replace` now **skips the `guid` column** (WP best practice — post GUIDs are permanent identifiers, not links); same applied to `local push --with-db`.
- `db push` success summary prints readable `rewrote_prefix` / `search_replaced` lines (`from -> to`) instead of `[object Object]`.

## 0.0.1-beta.23 (2026-06-15)

### Added — update notifier + `instawp upgrade`
- The CLI now checks npm for a newer version **at most once a day** (cached in `~/.config/instawp/`) and prints a one-line hint to **stderr** when an update is available — e.g. `⚡ Update available: 0.0.1-beta.22 → beta.23 · run: instawp upgrade`. It's instant on cache hits and only does a short, timeout-bounded network call on the daily refresh.
- **`instawp upgrade`** (alias `update`) self-updates via `npm i -g @instawp/cli@latest`; `--check` reports without installing.
- **Never pollutes output or surprises you**: the hint is suppressed in `--json`, `CI`, and non-interactive shells (so harnesses never see it), and it never auto-installs by default. Opt into hands-off updates with `INSTAWP_AUTO_UPGRADE=1`; silence the hint with `INSTAWP_NO_UPDATE_NOTIFIER=1`.

## 0.0.1-beta.22 (2026-06-15)

### Added — `plugin install`, `sql`, and HTTP-ready `create`
- **`instawp plugin install <site> <zip|dir> [--activate]`** — install a plugin from a local `.zip` (scp + `wp plugin install --force`) or directory (rsync into `wp-content/plugins/`, then activate). Removes the base64-over-exec dance.
- **`instawp sql <site> "<query>"`** — run a SQL query via WP-CLI; hits MySQL directly so it's immune to the object cache (handy for verifying state behind a cache).
- **`instawp create` now waits until the site answers HTTP**, not just until the provisioning task finishes — DNS/edge propagation lags task completion by 30–120s, so "Ready" now means actually reachable (no more hand-rolled curl-retry gates). `--no-wait` still returns immediately; `--json` includes `http_ready`.

### Notes (from heavy CLI-driven test-harness use)
- `exec`/`wp` faithfully forward argv with per-arg shell-quoting (since beta.21) — quoted multi-word args and `wp db query "…"` work without `--`. For **bulk file transfer use `sync push`** (rsync), not `exec`: passing large data as a command argument hits the OS `ARG_MAX` limit (that's a kernel limit, not a CLI cap), which is what made base64-over-exec unreliable.

## 0.0.1-beta.21 (2026-06-04)

### Fixed — `local push --with-db` broke wp-admin on sites with a custom table prefix
- After a DB push, wp-admin became inaccessible on sites whose cloud table prefix isn't `wp_` (which is **most** InstaWP sites — they use a random prefix like `iwpa797_`). WordPress stores roles/capabilities under the table prefix (`{prefix}capabilities`, `{prefix}user_level` in usermeta; `{prefix}user_roles` in options). The local Playground DB is normalized to `wp_`, so the imported keys were `wp_capabilities` etc. — which the cloud (looking for `iwpa797_capabilities`) ignored, leaving the admin with no capabilities.
- **Fix**: after import, `local push --with-db` now remaps those access-critical keys to the cloud's prefix (exact key names only — never touches plugin options). Verified end-to-end on a real custom-prefix site (admin role resolves, wp-admin accessible). If you hit this on beta.20, restore the cloud DB from the `~/db-backup-*.sql.gz` the push saved, update to beta.21, and re-push.

## 0.0.1-beta.20 (2026-06-03)

### Added — `local push --with-db` (push the database back to the cloud)
- `instawp local push <local>` was **files-only** (it synced `wp-content` but not the database), so content changes — new pages, posts, settings — never reached the cloud. New **`--with-db`** flag also pushes the local Playground database, OVERWRITING the cloud MySQL.
- How it works: backs up the cloud DB first (`--no-backup` to skip), converts the local SQLite to MySQL **data-only** (reuses the cloud's existing schema — no fragile type-mapping), imports it, and runs a serialization-safe `wp search-replace` to fix local→cloud URLs. Only tables present on both sides are synced; local-only tables (e.g. a plugin's tables created after cloning) are reported and skipped. `--dry-run` previews with zero cloud writes; `--force` skips the confirmation; `--json` requires `--force`.
- A plain `local push` now prints a one-line reminder that the database wasn't pushed (use `--with-db`).
- Validated end-to-end against a real InstaWP site (clone → add page → push --with-db → page + correct URLs on cloud). There is no official WordPress SQLite→MySQL exporter ([sqlite-database-integration#36](https://github.com/WordPress/sqlite-database-integration/issues/36)); this is a self-contained, data-safe implementation.

## 0.0.1-beta.19 (2026-06-03)

### Fixed — `local push` after `local clone` created a new site instead of pushing back
- A cloned instance didn't remember which cloud site it came from, so `instawp local push <local>` (with no cloud-site argument) fell into the "create a new site" path and provisioned a **new** site named after the local instance — instead of pushing to the original. `local clone` now records the origin (`cloudSiteId`) on the instance, and `local push` targets it by default (explicit arg → cloned origin → otherwise create). Pushing with an explicit cloud site once also backfills the link on instances cloned before this fix.
- **Also fixed** the cloned instance name: `local clone` derived it from the full domain, so `client-store-1234.instawp.site` became `client-store-1234-instawp-site`. It now uses the site name, or the first DNS label of the subdomain (`client-store-1234`).

## 0.0.1-beta.18 (2026-06-03)

### Fixed — `local push --dry-run` provisioned a real cloud site
- `instawp local push <name> --dry-run` with no cloud-site argument ran the "create a cloud site" path — so a dry run **provisioned a real, permanent cloud site**, then tried to connect to its not-yet-resolvable hostname and failed with `connect: Address lookup failed for host` / `rsync exited with code 1`. (Reported by QA on Windows; the bug was cross-platform.)
- **Fix**: a dry run is now side-effect free. With no cloud site specified, it previews the local `wp-content` files that *would* be pushed (a pure local filesystem walk respecting the same excludes — no provisioning, no network) and reports that no site was created. Passing an existing cloud site (`local push <name> <site> --dry-run`) is unchanged.

## 0.0.1-beta.17 (2026-06-02)

### Fixed — `local start` / `local create` mount failure on Windows
- On Windows, `instawp local start` (and `local create`) failed with `Invalid mount format: C:\...\wp-content:/wordpress/wp-content`. wp-playground-cli's `--mount=<host>:<vfs>` splits the value on `:`, and a Windows host path's drive-letter colon (`C:\...`) produced 3+ parts, so Playground rejected the mount.
- **Fix**: on Windows the CLI now uses Playground's `--mount-dir` / `--mount-dir-before-install` flags, which take the host and vfs paths as two separate arguments (no colon to split). Applies to fresh sites, cloned-site subdirectory mounts, and individual file mounts. macOS/Linux keep the existing `--mount=<host>:<vfs>` form unchanged. (Reported by QA on Windows; `@wp-playground/cli` ≥ the version exposing `--mount-dir`.)

## 0.0.1-beta.16 (2026-06-02)

### Changed — renamed `snapshot` → `versions`
- The command added in beta.15 is now **`instawp versions create|list|restore|delete`** (alias `version`). Renamed from `snapshot` to avoid confusion with InstaWP's separate **Snapshots** product — these are a site's restorable **versions**. Same flags and behavior; only the command name changed.

## 0.0.1-beta.15 (2026-06-01)

### Added — `snapshot` command (restorable site versions)
- New `instawp snapshot create|list|restore|delete` (alias `snapshots`) for managing **site snapshots** — InstaWP's restorable "site versions", point-in-time copies of a site's files + database. Unlike backups, a snapshot can be rolled back to **in-place**.
- Built for the AI-agent workflow: take a snapshot *before* letting an agent run a batch of changes, then roll back the one that broke it in a single command.
  - `snapshot create <site> [--name <label>] [--no-wait]` — waits for the snapshot to finish by default; `--no-wait` returns as soon as it's queued.
  - `snapshot list <site>` — ID, name, size, status, and creation date.
  - `snapshot restore <site> <version-id> [--force] [--no-wait]` — **overwrites** the live site's files + database; prompts for confirmation unless `--force`.
  - `snapshot delete <site> <version-id...> [--force]`.
- All subcommands support `--json`. Long-running create/restore poll task status with a progress spinner.

## 0.0.1-beta.14 (2026-05-28)

### Improved — clearer first-run for `local` commands
- When `local create/start/clone` falls back to `npx` (no global `wp-playground-cli`), the CLI now prints a one-time dim hint explaining the first-run download (~30s) and how to skip it on future runs (`npm i -g @wp-playground/cli`). Previously users just saw npm's raw download output with no context. Shown once per run, on stderr, and suppressed in `--json` mode.

## 0.0.1-beta.13 (2026-05-28)

### Fixed — `wp` / `exec` site resolution (issue #3)
- `instawp wp <site>` / `instawp exec <site>` could fail to resolve a site by name with "No site found" (or, on older builds, hang at "Resolving site…") on accounts where the `/sites` list didn't return the site in a single `per_page=100` page.
- **Fix**: `resolveSite` now paginates the `/sites` endpoint (`per_page=20`, walking `meta.last_page`) instead of relying on one large page. This is robust for accounts with 100+ sites and resilient to environments where the API returns fewer rows than requested for large `per_page` values. Matches how `sites list` paginates.

## 0.0.1-beta.12 (2026-05-26)

### Fixed — `local create/start/clone` on Windows (`spawn npx ENOENT`)
- WordPress Playground launch failed on Windows with `spawn npx ENOENT`. On Windows `npx`/`wp-playground-cli` are `.cmd` shims, and Node refuses to spawn `.cmd` without `shell: true` (since the CVE-2024-27980 fix) — so the bare `spawn('npx', …)` failed.
- **Fix**: route the Playground spawns through `cross-spawn`, which resolves `.cmd` shims and quotes arguments (e.g. `--mount` paths with spaces) safely. macOS/Linux behavior is unchanged.

## 0.0.1-beta.11 (2026-05-26)

### Improved — parallel SFTP transfers on Windows
- Windows file sync now transfers files across a **pool of parallel SSH connections** instead of one-at-a-time. Measured ~2.9× speedup (a 238-file wp-content pull dropped from ~369s to ~129s).
- Concurrency defaults to 4, configurable via `INSTAWP_SFTP_CONCURRENCY` (capped at 8).
- Two-phase design: a single control connection walks the tree and pre-creates directories, then files transfer in parallel. Per-file errors are collected and reported without aborting the whole sync.

## 0.0.1-beta.10 (2026-05-26)

### Fixed — Windows file sync now works
- `instawp sync push/pull`, `local push/pull`, and `local clone` failed on Windows with `rsync: connection unexpectedly closed (0 bytes)` + `sigpacket: Suppressing signal 30 to win32 process`. Root cause: the bundled **msys2 rsync.exe couldn't drive native Windows OpenSSH** (incompatible pipe/signal semantics). The DLL "entry point" fix in beta.6 got rsync.exe to *load*, but the SSH transport still died instantly.
- **Fix**: Windows now transfers files over a **pure-JS SFTP client** (`ssh2-sftp-client`) instead of rsync-over-ssh. macOS/Linux are unchanged (still rsync, with delta sync). New `syncFiles()` dispatcher picks the transport per-platform.

### Changed
- **Removed `rsync.exe` + all msys2 runtime DLLs from the bundle** (~11 MB). The Windows bundle is now just `busybox.exe` (660 KB, statically linked, for the `mysql2sqlite` awk step in `local clone`). Total package shrinks accordingly.
- SFTP transfer honors the same exclude/include patterns as the rsync paths (`.git`, `node_modules`, `cache`, `backup*`, etc.).

### Trade-off
- SFTP does full-file copy (no rsync delta algorithm). Fine for typical wp-content; repeat syncs of large sites are slower than rsync on macOS/Linux. We chose this over bundling an msys ssh (which would have dragged in the ~3.5 MB Heimdal/Kerberos DLL chain).

## 0.0.1-beta.9 (2026-05-23)

### Internals
- CI smoke test now verifies the bundle by extracting the packed tarball directly (via `tar -xzf`) and running `rsync.exe` from the extract dir. Replaces the `npm install -g` step, which was failing on the GHA Windows runner due to Defender quarantine interactions (tamper protection prevented our exclusion settings from taking effect). Real-user installs are not affected — Defender on individual developer machines is configurable and the first reported Windows install showed the bundle landing at the correct path.

## 0.0.1-beta.8 (2026-05-23)

### Bug Fixes (Windows)
- Moved bundled Windows binaries from `bin/win32/` to `vendor/win32/`. With `bin/` and the `bin` field in package.json both set, npm's global install on Windows dropped the `bin/win32/` subdirectory — leaving the CLI unable to find rsync.exe at runtime. macOS/Linux installs were unaffected. Renaming sidesteps the collision entirely.

## 0.0.1-beta.7 (2026-05-23)

### Internals
- Smoke-windows CI job now runs the bundled `rsync.exe` and `busybox.exe` directly from the workspace bundle **before** the npm-install step, so a passing smoke test proves the DLL chain is correct independent of whether antivirus interferes with the global install path.
- Adds Windows Defender exclusions before `npm i -g` to prevent msys DLLs from being quarantined during install.
- Publish job now skips on `workflow_dispatch` (manual triggers), so maintainers can re-test the smoke job without bumping the version.

## 0.0.1-beta.6 (2026-05-23)

### Bug Fixes (Windows)
- Bundled `rsync.exe` now actually loads. beta.4/beta.5 shipped with `msys-2.0.dll` from the legacy `msys2-runtime-3.3` fork, which is missing the `fallocate` symbol that rsync 3.4 needs — produced `Entry Point Not Found: fallocate` on launch and exit code `3221225785` (`STATUS_DLL_INIT_FAILED`) when invoked indirectly via `sync push/pull` or `local clone`.
- Rebuilt the Windows bundle against current MSYS2 packages: `msys2-runtime-3.6.9-1`, `libopenssl-3.6.2-1`, `libiconv-1.19-1`, `libxxhash-0.8.3-1`, `libzstd-1.5.7-1`, `popt-1.19-1`, `libintl-0.22.5-1`. Includes `msys-popt-0.dll` and `msys-intl-8.dll` which the newer rsync now requires.
- Upgraded bundled rsync from 3.4.0 → 3.4.2-2.

### Internals
- `scripts/fetch-windows-binaries.sh` now verifies DLL closure (every referenced `msys-*.dll` is present) and asserts `fallocate` is exported from `msys-2.0.dll` before declaring the bundle valid. Catches "wrong runtime fork" regressions at build time.
- Added `smoke-windows` job to the publish workflow — runs on `windows-latest` and actually executes the bundled `rsync.exe` and `busybox.exe` before npm publish. Publish is now gated on this passing.

## 0.0.1-beta.5 (2026-05-23)

### New Commands
- `db push <site> <file>` — Push a local SQL dump (`.sql` or `.sql.gz`) to the remote MySQL database. Always backs up the remote DB to `~/db-backup-{ISO}.sql.gz` first (skip with `--no-backup`). Confirmation prompt unless `--force`. Closes the #1 gap blocking full-site deploys from the CLI.
- `db pull <site>` — Stream the remote MySQL database to a local gzipped dump. `--output <path>` and `--no-compress` flags.
- `open <site>` — Open the site URL in the default browser. `--admin` opens `/wp-admin`, `--magic` opens the Magic Login URL, `--print` pipes the URL to stdout instead.
- `logs <site>` — Tail logs via SSH. `--wp` (default, debug.log), `--php` (PHP-FPM error log), `--nginx` (nginx error log), `--follow` / `-f`, `--lines <n>`. Multiple flags multi-tail. Probes HestiaCP path variations automatically.
- `sites creds <site>` — Re-fetch WP admin credentials + Magic Login URL for an existing site (previously only available in the `create` output).

### Improvements
- `wp <site>` is now positioned as the primary remote-access command; `exec` is documented as the escape hatch for non-WP shell commands.
- `wp` / `exec` accept POSIX `--` to forward raw args verbatim: `instawp wp my-site -- post list --post_type=page`.
- Spinners are suppressed in non-TTY contexts, CI environments (`CI` env var), `--json` mode, `NO_COLOR`, and `INSTAWP_QUIET` — fixes "Resolving site..." leaking into piped output.

### Bug Fixes
- `instawp wp <site> eval '...'` no longer breaks on parens, quotes, or other shell metacharacters. Each arg is now POSIX shell-quoted before being piped to the remote shell's stdin (previously `args.join(' ')` left metacharacters unescaped, causing remote `bash: syntax error near unexpected token '('`).

### Docs
- New `ROADMAP.md` capturing 15 forward-looking improvement areas (multi-site bulk ops, cost transparency, CI/CD deploy command, shell completion, `doctor`, config file, snapshot/migration CLI, self-update, etc.) ranked by ROI.
- README + CLAUDE.md updated with `wp`-primary positioning and examples for all new commands.

## 0.0.1-beta.4 (2026-05-22)

### Windows — Zero-Install Support
- Bundled `rsync.exe` (with msys2 runtime DLLs) and BusyBox-w64 (`awk` provider) in `bin/win32/`. No more "install Git for Windows / cwRsync" prerequisite — `instawp local clone`, `local push/pull`, and `sync push/pull` work out of the box on Windows.
- Replaced the external `sqlite3` CLI dependency with the `better-sqlite3` Node module.
- New `src/lib/windows-binaries.ts` resolves bundled binaries; falls back to PATH then common Git-for-Windows install dirs.

### Bug Fixes (Windows)
- `instawp local clone` now resolves the bundled `mysql2sqlite` script correctly (was broken by `new URL(import.meta.url).pathname` returning `/C:/...`).
- `mysql2sqlite` is invoked as `awk -f script` explicitly; no longer relies on shebang interpretation.
- `rsync` no longer treats Windows drive paths (`C:\...`) as remote hostnames — paths are converted to msys style (`/c/...`) inside `rsyncViaSsh`.
- `-e ssh -i <key>` argument uses forward slashes + quoted paths so msys/cygwin sh inside rsync parses the key path correctly.
- Eliminated the SQL injection risk in `local clone`'s URL search-replace (now uses bound parameters via better-sqlite3).

### Internals
- New `scripts/fetch-windows-binaries.sh` (maintainer-only) refreshes the Windows bundle from MSYS2 + frippery.org.
- 32 new tests covering path conversion and bundled-binary resolution.

## 0.0.1-beta.3 (2026-04-12)

### New Commands
- `local create` — Create local WordPress sites (powered by WordPress Playground, no Docker needed)
- `local clone <site>` — Clone an InstaWP cloud site to local (files + database)
- `local start/stop` — Start in foreground or `--background` mode
- `local push/pull` — Sync wp-content between local and cloud (incremental rsync)
- `local list` — Show local sites with running/stopped status
- `local delete` — Remove local sites
- `sites php <site>` — View or update PHP version and settings
- `sites update <site>` — Update site label, description, or expiration
- `teams switch <team>` — Switch active team context

### Improvements
- `create --wp <version>` — Specify WordPress version when creating sites
- `sites list` — 50 per page default, `--all` flag, pagination hints
- Login now shows user name and team after success
- Site resolver caches name-to-ID lookups for 10 minutes
- rsync only shows actually changed files (`--itemize-changes`)
- Magic login URL fixed to use correct `/wordpress-auto-login` endpoint

### Bug Fixes
- Windows: SSH key generation now works (removed Unix-specific shell commands)
- Windows: command detection uses `where` instead of `which`
- `exec/wp --api` flag now works at any position in the command
- Terminal restored after local site Ctrl+C (`stty sane`)

## 0.0.1-beta.2 (2026-03-23)

### New Commands
- `local create/clone/start/stop/push/pull/list/delete` — Full local development workflow
- `teams switch` — Client-side team context

### Improvements
- Site resolver caching
- Incremental rsync output

## 0.0.1-beta.1 (2026-03-02)

### Initial Release
- `login` — OAuth browser flow or `--token`
- `whoami` — Show current session
- `create` — Create WordPress sites with provisioning progress
- `sites list/delete` — Manage sites
- `exec/wp` — Run commands via SSH or API
- `ssh` — Interactive SSH sessions
- `sync push/pull` — rsync wp-content via SSH
- `teams list/members` — View teams
- `--json` mode for all commands
