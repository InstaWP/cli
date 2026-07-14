# InstaWP CLI

Create and manage WordPress sites from the terminal.

```
npm install -g @instawp/cli
```

This installs the latest release. The CLI checks for updates once a day and `instawp upgrade` keeps you current (see [Updating](#updating)).

> **Beta** — early release. Report issues at [github.com/InstaWP/cli/issues](https://github.com/InstaWP/cli/issues).

## What you can do

InstaWP CLI is the connective tissue between your terminal, your InstaWP account, and a real running WordPress — no hosting panel, no FTP, no Docker.

- **🤖 Give an AI agent a real WordPress, then ship it** — Claude Code / Cursor gets a genuine WP sandbox (WASM PHP + SQLite, zero setup), builds against it, and deploys to a live site:
  ```bash
  instawp local create --name app     # real WordPress on your laptop, no Docker
  instawp local deploy app            # provisions a cloud site + pushes files AND database
  ```
- **🌉 Run WP-CLI on any site — no SSH** — pipes WP-CLI over HTTPS, so it works behind firewalls and in CI, addressed by name:
  ```bash
  instawp wp acme-site plugin update woocommerce --api
  ```
- **🛟 Snapshot before risky changes, roll back in one command** — restorable site versions (files + DB), in-place:
  ```bash
  instawp versions create acme-site --name "before update"
  instawp versions restore acme-site <version-id>
  ```
- **💻 Clone a live site to your laptop and back** — DB export → SQLite → URL rewrite → file sync, all automatic:
  ```bash
  instawp local clone client-store    # work offline; then `local push` to sync back
  ```
- **⚙️ Throwaway preview sites in CI** — spin one up per PR and tear it down:
  ```bash
  instawp create --name "pr-$PR_NUMBER" --json   # … run tests … then delete --force
  ```

## Quick Start

```bash
# Authenticate (opens browser)
instawp login

# Or use an API token (for CI/CD)
instawp login --token <your-api-token>

# Check your session
instawp whoami
```

`<site>` in any command can be a site **ID**, **name**, or **domain** — the CLI resolves it automatically.

## Commands

### Sites

```bash
# List all sites
instawp sites list
instawp sites list --status active --all

# Create a new site (waits until the site answers HTTP; --no-wait to skip)
instawp create --name my-site
instawp create --name my-site --php 8.3
instawp create --name my-site --temporary     # auto-expiring site

# Update label / description / expiration
instawp sites update <site> --label "New name"
instawp sites update <site> --expires never

# View or change PHP version / settings
instawp sites php <site>
instawp sites php <site> --version 8.3 --memory-limit 512

# Re-fetch admin credentials + Magic Login URL
instawp sites creds <site>

# Open the site (or admin / magic login) in your browser
instawp open <site>
instawp open <site> --admin
instawp open <site> --magic

# Delete a site
instawp sites delete <site>
instawp sites delete <site> --force
```

### Versions (snapshots & rollback)

Restorable point-in-time copies of a site's files + database. Unlike backups, a version can be rolled back to **in-place** — snapshot before a risky change, then undo it in one command. (Distinct from InstaWP's *Snapshots* product.)

```bash
# Snapshot a site (waits until it's restorable; --no-wait to return immediately)
instawp versions create <site> --name "before plugin update"

# List a site's versions (ID, name, size, status, created)
instawp versions list <site>

# Roll back to a version (OVERWRITES current files + DB; asks to confirm)
instawp versions restore <site> <version-id>
instawp versions restore <site> <version-id> --force

# Delete versions
instawp versions delete <site> <version-id> [<version-id> ...]
```

### Local Development

Run a real WordPress site on your machine via [WordPress Playground](https://wordpress.github.io/wordpress-playground/) (WASM PHP + SQLite) — **no Docker, no MySQL**. Playground is fetched automatically with `npx`; install it globally (`npm i -g @wp-playground/cli`) to skip the first-run download. Works on macOS, Linux, and Windows with zero extra installs.

```bash
# Create and start a fresh local site
instawp local create --name blog
instawp local create --name blog --wp 6.8 --php 8.3 --background

# Clone a live InstaWP cloud site to local (DB + plugins + themes + uploads)
instawp local clone <cloud-site>

# Start / stop an existing local site
instawp local start [name]
instawp local stop [name]

# Deploy a local site to the cloud in one shot (creates the site, pushes files + DB)
instawp local deploy <local-name>                       # alias of `local push` — the one-command "make this live"
instawp local deploy <local-name> --no-db               # files only — the new site keeps its empty WordPress DB

# Sync between local and cloud
instawp local push <local-name> [cloud-site]            # push wp-content (files) up; pushes back to the cloned origin by default
instawp local push <local-name> --with-db               # ALSO overwrite the cloud database with your local one (backs it up first)
instawp local push <local-name> --with-db --dry-run     # preview the DB push (tables/rows/URL rewrite), no cloud writes
instawp local pull <local-name> <cloud-site>            # pull cloud wp-content down

# Manage local sites
instawp local list
instawp local delete <name> --force
```

**Deploying vs. syncing.** With no cloud site given (and no cloned origin), `local push` — or its alias **`local deploy`** — *provisions* the cloud site for you and pushes **files + database**, so a site you built locally goes live in one command. Pushing into an **existing** site is the opposite default: files only, because overwriting a live database is destructive. Add `--with-db` to include it there, or `--no-db` to keep a deploy files-only.

**Files vs. database:** `local push` into an existing site syncs **files** (`wp-content`) — so plugins/themes/uploads, but **not** content like pages or posts (those live in the database). Add **`--with-db`** to also overwrite the cloud database with your local one. It backs up the cloud DB first, converts the local Playground SQLite to MySQL (data-only — it reuses the cloud's existing schema), imports it, and rewrites local→cloud URLs (serialization-safe). Best used on a cloned site, where local and cloud schemas match; tables that exist only locally (e.g. a plugin's custom tables created after cloning) are reported and skipped. Use `--dry-run` to preview, `--no-backup` to skip the safety backup (not recommended).

### Run Commands (WP-CLI + shell)

`wp` is the **primary** command for a remote site. `exec` is the escape hatch for non-WP shell commands.

```bash
# WP-CLI on a remote site
instawp wp <site> plugin list
instawp wp <site> option get siteurl

# Pass raw args to WP-CLI with --
instawp wp <site> -- post list --post_type=page --format=json

# eval / PHP payloads — wrap in single quotes; args are shell-escaped for you
instawp wp <site> eval '\MyClass::init(["force" => true]);'

# Escape hatch for non-WP commands
instawp exec <site> ls -la
instawp exec <site> cat wp-config.php

# --api transport (no SSH setup required; works behind firewalls / in CI)
instawp wp <site> option get siteurl --api
instawp exec <site> php -v --api
```

### SQL & Plugins

```bash
# Run SQL directly (via WP-CLI; hits MySQL, bypasses object cache)
instawp sql <site> "SELECT option_value FROM wp_options WHERE option_name='siteurl'"

# Install a plugin from a local .zip or directory — no base64-over-exec needed
instawp plugin install <site> ./my-plugin.zip --activate
instawp plugin install <site> ./my-plugin/ --activate
```

For bulk file transfer (themes, plugins, uploads), use `sync push` (rsync) — it streams file contents, unlike `exec`, which is for commands and hits the OS argument-size limit on large inline payloads.

### SSH

```bash
# Open an interactive SSH session
instawp ssh <site>
```

The CLI manages SSH keys automatically — it generates a key, uploads it, and caches the connection.

### Sync (rsync)

```bash
# Push local wp-content to remote
instawp sync push <site> --path ./wp-content/

# Pull remote wp-content to local
instawp sync pull <site>

# Dry run first
instawp sync push <site> --dry-run
```

### Database (mysqldump)

`db push` always backs up the remote database before overwriting (use `--no-backup` to skip).

```bash
# Pull remote DB to a gzipped SQL dump
instawp db pull <site>
instawp db pull <site> --output ./backup.sql.gz
instawp db pull <site> --no-compress      # write .sql instead of .sql.gz

# Push a local dump back (auto-backs up the remote first)
instawp db push <site> ./backup.sql.gz
instawp db push <site> ./backup.sql --force   # skip confirmation
```

### Logs

```bash
# Tail the WP debug.log (default)
instawp logs <site>
instawp logs <site> --follow             # tail -f

# Tail PHP-FPM or nginx error logs
instawp logs <site> --php
instawp logs <site> --nginx
instawp logs <site> --php --nginx -f     # multi-tail

# Custom line count
instawp logs <site> --lines 500
```

### Teams

```bash
instawp teams list
instawp teams switch [team]      # set the active team for subsequent commands
instawp teams members <team>
```

## JSON Output

Add `--json` to any command for machine-readable output:

```bash
instawp sites list --json
instawp create --name test-site --json
instawp versions list <site> --json
instawp wp <site> option get siteurl --json
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `INSTAWP_TOKEN` | API token — skips `instawp login` |
| `INSTAWP_API_URL` | Custom API base URL |
| `INSTAWP_NO_UPDATE_NOTIFIER` | Silence the once-a-day update hint |
| `INSTAWP_AUTO_UPGRADE` | Auto-install updates on the daily check (hands-off) |

### CI/CD Example

```bash
export INSTAWP_TOKEN=${{ secrets.INSTAWP_TOKEN }}

# Create a preview site for a PR
instawp create --name "pr-$PR_NUMBER" --json

# Run a smoke test
instawp wp "pr-$PR_NUMBER" option get siteurl --api

# Clean up
instawp sites delete "pr-$PR_NUMBER" --force
```

## Updating

```bash
instawp upgrade          # update to the latest version
instawp upgrade --check  # check only; don't install
```

The CLI checks for a new version **once a day** and prints a one-line hint (to stderr) when one is available. It never auto-installs and never pollutes command output — it's silenced automatically in `--json`, CI, and non-interactive shells. Opt into hands-off updates with `INSTAWP_AUTO_UPGRADE=1`, or silence the hint entirely with `INSTAWP_NO_UPDATE_NOTIFIER=1`.

## Requirements

- Node.js 18+
- `ssh` and `ssh-keygen` (for SSH / `exec` / `sync` / `db` over SSH)
- `rsync` (for `sync` on macOS/Linux; Windows uses built-in SFTP)
- Local development uses WordPress Playground (auto-fetched via `npx`) — no Docker required

## License

MIT
