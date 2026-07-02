# Site controls — implementation spec (target: an upcoming beta)

New site-scoped commands to add to `@instawp/cli`, from an audit of the client-app
`sites/{site}/…` endpoints (2026-07-02). Everything here is drivable by the CLI's
**personal API token on an owned site** (routes the token can't reach were excluded —
see *Skipped*). Endpoints are `/api/v2` unless a path says `/api/v1`.

Current CLI surface (do not duplicate): `sites list/create/delete/update/creds/php`,
`versions`, `wp`/`exec`/`sql`/`ssh`, `sync`, `db push/pull` + `db backups`, `cache purge`,
`plugin`, `logs`, `open`, `teams`, `local`, `migrate push`.

> Note `db backups` (local `~/.instawp/*.sql.gz` from `db push`) is **different** from the
> new `backups` group below (InstaWP server snapshots). Keep the names distinct.

---

## Build order

1. **Batch A — quick wins (Tier 1).** Safe, mostly plan-gate-free, broad value:
   `backups`, `sites tools`, `sites domains`, `sites protect/unprotect`, and the read-only
   diagnostics (`sites usage/monitor/sftp/mcp`, `sites security reports`).
2. **Batch B — Tier 2** (plan-gated / heavier config): `shield`, extended `cache`
   (object-cache/cdn/exclusions/optimize), lifecycle (`clone`/`plan`/`suspend`/`reserve`),
   `sites config`, `sites export`, `sites perf`, `sites tags`, `domains dns` (registrar).
3. **Batch C — Tier 3** (niche): `backups restore --as-new`, `backups settings`, shield
   `metrics`/`activate`/`bypass`.

---

## Cross-cutting implementation notes (apply to all)

- **Plan-gating is pervasive.** Many endpoints `403`/`422` when the plan lacks a feature
  (CDN, Shield, object cache, image optimizer, cloning, reserve). Handle like `cache purge`
  did: a clean *"not on your plan"* message, **not** a crash. Never treat a plan `403` as a
  hard error in `--json` unless the user explicitly requested that action alone.
- **Async endpoints** return a `task_id` (or just email the user): `backups create`,
  `sites clone`, `domains add`, `sites export`, `perf run`, `backups restore --as-new`.
  Poll `GET /tasks/{id}/status` where a task id is returned; where it's email-only, say so.
- **Full-replace payloads** (omitting a field resets/removes it): `cache exclusions set`,
  `cache optimize`, `sites config`, `sites tags set`. Do **GET-then-merge**, or expose every
  field, or provide an explicit `clear`. Warn on replace semantics.
- **site_id in the BODY, not the URI**: `backups delete`, `backups restore --as-new` — send
  both the `{site}` path param and `site_id` in the body.
- **V1 routes return HTTP 500 with an `errors[]` array** on validation failure (not 422):
  `sites protect`, `sites wp-creds`, `sites config`. Parse the response body for messages.
- **Email-only delivery** (no link in the API response): `sites export` — the CLI can only
  trigger + inform.
- All commands support `--json`. Destructive ones take `--yes` to skip confirmation.

---

## Tier 1 — quick wins (Batch A)

### `instawp backups …` — InstaWP site snapshots
| Command | Method + endpoint | Params / notes | Destructive |
|---|---|---|---|
| `backups list <site>` | `GET /sites/{site}/backups` | Ownership-gated, not plan-gated. Empty → `{message:'backup_not_available'}` with **no `data` key** — handle. `--json`. | no |
| `backups create <site>` | `POST /sites/{site}/create-backup` | Async. cloud-app caps **3 manual/site + 1 in-progress** → surface the 422 verbatim. | no |
| `backups download <site> <id> [--type file\|db\|full] [-o <path>]` | `GET /sites/{site}/{backup}/{type}/download-backup` | Returns a **signed URL**, not bytes — CLI fetches+streams to disk. Default `--type full`. `--json` prints the URL. | no |
| `backups delete <site> <id> [--yes]` | `POST /sites/{site}/delete-site-backup` | Confirm. **site_id in body**, not URI. | **yes** |

### `instawp sites tools <site> <tool> [--value on\|off] [--yes]`
One endpoint `POST /sites/{site}/tools` → **13 InstaCP actions**. `value` is **required** for
every tool (toggles send `on`/`off`; actions send `true`).
- Toggles: `maintenance_mode`, `search_engine_visibility`, `xmlrpc`, `rest_api`,
  `users_endpoint`, `password_protection`, `system_cron`.
- Actions: `flush_permalinks`, `fix_permissions`, `clear_temp_files`,
  `verify_core_checksum`, `optimize_database`, `reset_wordpress`.
- `reset_wordpress` **WIPES the WP DB** → require `--yes`/`--confirm`.
- Gate: payment-method `403` for card-less PPU/free owners (not a plan-feature gate).
- Sugar aliases (optional): `sites maintenance <site> on|off`, `sites optimize-db <site>`,
  `sites fix-permissions <site>`, `sites flush-permalinks <site>`, `sites reset <site> --yes`.

### `instawp sites domains …` — custom-domain lifecycle
| Command | Method + endpoint | Notes | Destructive |
|---|---|---|---|
| `domains add <site> <domain> [--type alias\|primary] [--www] [--route-www]` | `POST /api/v1/site/add-domain/{site}` | **Plan-gated (403 on free)**. DNS must already point at the site (`422` propagation). `429` if retried within 30 min. Async (SSL emailed). | no |
| `domains ssl-retry <site> <domain>` | `POST /api/v1/site/retry-mapped-domain-ssl/{site}` | Idempotent, **not** plan-gated. Returns `{queued:true}`. | no |
| `domains set-primary <site> <domain> [--skip-search-replace]` | `POST /api/v1/site/set-primary/{site}` | Runs WP search-replace of the URL (changes live URL — warn). Plan-gated; `422` if DNS not propagated. | no |
| `domains delete <site> <domain> [--yes]` | `DELETE /api/v1/site/delete-domain/{site}` | Site stops serving on that domain → confirm. Not plan-gated. | **yes** |

### `instawp sites protect <site> --user <u> --password <p>` / `sites unprotect <site>`
HTTP basic-auth lock for staging. `POST` / `DELETE /api/v1/sites/{site}/htpassword`. Not
plan-gated, ownership-only. Distinct from the `password_protection` *tools* toggle (this sets
the actual creds). **V1 quirk:** validation errors return **HTTP 500 with `errors[]`**;
`unprotect` `404`s if nothing to remove (treat as success/idempotent).

### Read-only diagnostics (all `--json`, safe, not plan-gated)
| Command | Method + endpoint | Notes |
|---|---|---|
| `sites usage <site> [--path <dir>]` | `POST /sites/{site}/fetch-usage` | POST triggers measurement; disk (per-path)/bandwidth/visits. `--path` default `/`. |
| `sites monitor <site>` | `GET /sites/{site}/monitor-stats` | Uptime/health proxied from cloud-app. Under `can:update,site` (default token OK; read-only token 403s). |
| `sites sftp <site>` | `GET /sites/{site}/sftp-ssh` | SFTP/SSH host/user/password + enabled flags. Per-user (creds only if THAT user enabled SFTP/SSH). Complements `sites creds`. |
| `sites mcp <site> [--enable\|--disable]` | `GET /sites/{site}/mcp` · `POST /sites/{site}/update-mcp` | Prints per-site WP MCP token + URL (`https://{domain}/insta-mcp?t=…`) or toggles it. Enable needs PHP ≥ 8.2 (`422`); no-op toggle `422`s. |
| `sites security reports <site>` / `sites security scan <site>` | `GET` / `POST /sites/{site}/security-reports` | `reports` (list scans) not plan-gated; `scan` needs `vulnerability_scanner` feature + non-free (`403` otherwise). |

---

## Tier 2 — useful, mostly plan-gated (Batch B)

- **`instawp shield status|logs|update <site>`** — `GET shield-data` (combined settings+metrics,
  best "status" view), `GET shield-logs` (paginated WAF/bot events, `--page/--per-page`),
  `POST shield-settings` (WAF/bot/DDoS config). Plan-gated `is_shield`; DDoS/bot fields also need
  `shield_type=advanced` (`403 advanced_shield_required`). Enum-constrained fields (e.g.
  `ddos_window ∈ {900,1800,3600,21600,43200,86400}`, sensitivities 0–3). `update` changes live
  security posture (destructive).
- **`instawp cache object-cache <site> --enable|--disable`** — `POST update-object-cache`.
  Plan-gated `hasObjectCache`; idempotent (`422` if already in state); server generates the Redis
  password.
- **`instawp cache cdn settings|set|stats <site>`** — `GET/POST cdn-settings`, `GET cdn-statistics`.
  Plan-gated `hasCdnSettings` (even the GET needs update perm). `set` needs BOTH TTL fields →
  GET-then-merge.
- **`instawp cache exclusions list|set|clear <site>`** — `GET/POST cache-exclusions`. Same CDN gate.
  `set` is **REPLACE** (max 25 patterns, 500 chars each) → warn; provide `clear` for empty.
- **`instawp cache optimize <site> --enable|--disable [flags]` / `cache optimize stats <site>`** —
  `POST update-insta-optimize`, `GET image-optimizer-statistics`. Plan-gated `hasImageOptimizer`;
  **full-replace** payload (GET-then-merge); cloud-app requires CDN enabled first (`500` otherwise).
- **`instawp sites clone <site> [--name <slug>] [--reserve] [--plan <id>]`** — `POST clone`.
  Plan-gated `cloning` + `hasPaymentMethod` for paid teams. Async `task_id` + email. `--name`
  `[a-zA-Z0-9-]` min3/max30.
- **`instawp sites plan <site> [--plan-id <id>] [--free]`** — `POST upgrade-plan`. Legacy users
  `403`; paid needs payment method; downgrade `422` if CDN/optimizer active or over disk quota.
- **`instawp sites suspend <site> [--yes]` / `sites unsuspend <site>`** — `POST suspend/unsuspend`.
  PPU-only (legacy `403`); status guards `422`. Prefer these V2 routes over the legacy V1 `expire`.
- **`instawp sites reserve <site> [--off]`** — `PUT reserve-toggle` (use V2, not legacy V1 POST).
  Plan-gated `reserve_sites` + payment method.
- **`instawp sites config <site> [--memory --max-execution --upload-max --post-max --max-input-vars --php …]`**
  — `POST /api/v1/site/{site}/update-webapp-configurations`. **Superset of `sites php`** (also
  switches version). Validator requires ALL `php_config` keys → GET-then-merge. Pro fields gated by
  `advance_config`. Errors as **500 + `errors[]`**. Consider having `sites php` delegate here.
- **`instawp sites export <site> --format localwp|instawp|studio`** — three V1 export endpoints
  behind one flag. Async, **email-only** (no link returned) — trigger + inform.
- **`instawp sites perf run|history <site>`** — `POST performance` / `GET performance/history`.
  Async; soft-capped 1/day without a PSI API-key integration (`403`).
- **`instawp sites tags add <site> <tag> [--color]` / `sites tags set <site> <id...>`** —
  `POST tags` (find-or-create, additive) / `POST sync-tags` (**REPLACE**, takes tag **IDs**; `[]`
  clears). Resolve names→IDs for `set`.
- **`instawp domains dns list|add|update|delete <domain>` + `domains link|unlink <domain> <site>`**
  — registrar DNS for **InstaWP-registered** domains (top-level `domains` noun, not `sites`).
  `GET/POST/PUT/DELETE /api/v2/domains/{domain}/dns[/{id}]`, `link-site`/`unlink-site`. Only works
  if the team registered a domain through InstaWP (empty/404 otherwise). `dns delete`/`unlink`
  destructive → confirm.
- **`instawp sites domains purchased <site>`** — `GET purchased-domains`. Lists team's
  InstaWP-registered domains + whether CNAME-linked to this site. Read-only.

---

## Tier 3 — niche (Batch C)

- **`instawp backups restore <site> <id> --as-new`** — `POST backup-restore-new`. Provisions a
  NEW site from a backup (does not overwrite; complements in-place `versions restore`). Quota-gated
  (`403 site_create_limit_api`/`site_disk_limit_api`); **site_id in body**; async.
- **`instawp backups settings <site> [--sync]`** — `GET backup-settings` / `POST sync-backup-settings`.
  Read is diagnostic; `--sync` is self-healing/admin-ish (`422 no_plan_assigned` if none).
- **`instawp sites shield metrics|activate <site>`** — `GET shield-metrics` (largely redundant with
  `shield status`), `POST activate-shield` (re-runs applyPlan; overlaps plan application).
- **`instawp sites shield bypass <site> managewp|shortpixel on|off`** — third-party WAF bypass
  toggles. `managewp` needs advanced shield; `shortpixel` needs basic. `422` if `enabled` missing.

---

## Skipped (not worth building / not reachable)

- **`sites extend-lifetime`** — guest/no-auth route tied to TEMPLATE sites only; not a general
  "extend my site" control.
- **`sites change-suffix`** — policy requires `user.is_legacy=true` → effectively `403` for modern
  PPU/personal-token users.
- **`sites expire` (V1)** — legacy suspend lacking PPU/status guards; superseded by V2
  `suspend`/`unsuspend`.
- **`ftp-instruction` (V1)** — deprecated stub, always `500 "API deprecated"`; superseded by
  `sftp-ssh`.
- **`versions restore` / `sites creds`** — already in the CLI.
- **`sites restore` (V1/V2)** — reactivate mirror of `unsuspend`; duplicate.

---

## Source

Generated from a multi-agent audit of `repos/client-app` site routes/controllers
(`routes/api/site.php`, `app/Http/Controllers/API/V2/SiteController.php`, plus
`SiteSecurityScanController`, `TagController`, domain/registrar controllers), 2026-07-02.
Verify each endpoint's controller before implementing — plan-gates and payload shapes are
called out above but the controllers are the source of truth.
