import { existsSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { getClient } from './api.js';
import { getSshCache, setSshCache, clearSshCache, getSshHostOverride } from './config.js';
import { error, info, spinner } from './output.js';
import { probeTcp, printSshUnreachable, SshUnreachableError } from './ssh-preflight.js';
import { resolveRemoteWebDir } from './ssh-connection.js';
import type { SshConnection, SshKeyInfo } from '../types.js';

const INSTAWP_DIR = path.join(homedir(), '.instawp');
const CLI_KEY_PATH = path.join(INSTAWP_DIR, 'cli_key');
const CLI_KEY_PUB_PATH = CLI_KEY_PATH + '.pub';

const KEY_PAGE_SIZE = 100;   // per_page for GET /ssh-keys (API default is 10)
const MAX_KEY_PAGES = 20;    // hard stop, so a bad `meta` can't spin forever

function ensureInstawpDir(): void {
  if (!existsSync(INSTAWP_DIR)) {
    mkdirSync(INSTAWP_DIR, { recursive: true });
  }
}

function findLocalPubKeys(): { privatePath: string; pubContent: string }[] {
  const keys: { privatePath: string; pubContent: string }[] = [];
  const sshDir = path.join(homedir(), '.ssh');

  // Check CLI-managed key first
  if (existsSync(CLI_KEY_PUB_PATH) && existsSync(CLI_KEY_PATH)) {
    keys.push({ privatePath: CLI_KEY_PATH, pubContent: readFileSync(CLI_KEY_PUB_PATH, 'utf-8').trim() });
  }

  // Check common SSH key locations (RSA first — API only accepts ssh-rsa/ssh-dss)
  for (const name of ['id_rsa', 'id_ed25519']) {
    const privPath = path.join(sshDir, name);
    const pubPath = privPath + '.pub';
    if (existsSync(pubPath) && existsSync(privPath)) {
      keys.push({ privatePath: privPath, pubContent: readFileSync(pubPath, 'utf-8').trim() });
    }
  }

  return keys;
}

function parseKeyMaterial(pubContent: string): string {
  // Extract "type base64data" ignoring comment
  const parts = pubContent.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]} ${parts[1]}`;
  }
  return pubContent.trim();
}

function generateCliKey(): { privatePath: string; pubContent: string } {
  ensureInstawpDir();

  // Remove old key if it exists (so ssh-keygen doesn't prompt to overwrite)
  try {
    if (existsSync(CLI_KEY_PATH)) unlinkSync(CLI_KEY_PATH);
    if (existsSync(CLI_KEY_PUB_PATH)) unlinkSync(CLI_KEY_PUB_PATH);
  } catch { /* ignore */ }

  try {
    execSync(`ssh-keygen -t rsa -b 4096 -f "${CLI_KEY_PATH}" -N "" -C "instawp-cli"`, {
      stdio: 'ignore',
    });
  } catch {
    error('Failed to generate SSH key. Ensure ssh-keygen (OpenSSH) is installed.');
    info('Windows: Settings → Apps → Optional Features → OpenSSH Client');
    process.exit(1);
  }
  return {
    privatePath: CLI_KEY_PATH,
    pubContent: readFileSync(CLI_KEY_PUB_PATH, 'utf-8').trim(),
  };
}

/**
 * Every SSH key on the account, across all pages.
 *
 * `GET /ssh-keys` is paginated (10/page by default, newest first) and we only ever read
 * page 1 — so on an account with more keys than that, an already-uploaded CLI key is
 * invisible, we conclude "not uploaded", and upload ANOTHER copy of it. Since the SSH
 * connection cache is per-site, that repeats for every site the user touches: the "InstaWP
 * CLI" key piles up in their account. Ask for a big page and follow `meta.last_page`, so
 * matching sees the whole list.
 */
async function fetchUploadedKeys(): Promise<SshKeyInfo[]> {
  const client = getClient();
  const keys: SshKeyInfo[] = [];

  try {
    for (let page = 1; page <= MAX_KEY_PAGES; page++) {
      const res = await client.get('/ssh-keys', { params: { per_page: KEY_PAGE_SIZE, page } });
      const items = res.data?.data;
      if (!Array.isArray(items)) break;

      for (const k of items) {
        keys.push({ id: k.id, label: k.label || '', ssh_key: k.ssh_key || '' });
      }

      const lastPage = Number(res.data?.meta?.last_page);
      if (!Number.isFinite(lastPage) || page >= lastPage) break;
    }
  } catch {
    // SSH keys endpoint might not exist / transient failure — fall through with whatever
    // we got. An empty list means step 5 uploads; the API is idempotent on identical key
    // material, so that can't duplicate an existing key.
  }

  return keys;
}

export interface EnsureSshOptions {
  /** Override the SSH host (from --ssh-host or INSTAWP_SSH_HOST*); beats the API host. */
  sshHost?: string;
  /** Drop any cached connection and re-resolve (e.g. after the platform starts returning the origin). */
  refresh?: boolean;
  /**
   * On an unreachable host: 'exit' (default — print the diagnostic + exit 1) or
   * 'throw' (SshUnreachableError, for callers like wp/exec that have an --api fallback).
   */
  onUnreachable?: 'exit' | 'throw';
}

export async function ensureSshAccess(siteId: number, opts: EnsureSshOptions = {}): Promise<SshConnection> {
  const override = opts.sshHost?.trim() || getSshHostOverride(siteId);
  if (opts.refresh) clearSshCache(siteId);

  const wasCached = !!getSshCache(siteId);
  let connection = await resolveConnection(siteId, override);

  // Preflight: fail fast (a few seconds) with an actionable diagnostic instead of
  // the raw ~2-minute ssh/rsync connect timeout when the host is unreachable — the
  // classic CDN-fronted-site symptom (proxied host, port 22 filtered).
  let reachable = await probeTcp(connection.host, connection.port, 5000);

  // Self-heal a stale cached host (e.g. a CDN host cached before origin auto-detect
  // shipped, or before the origin IP had synced): drop the cache and re-resolve once
  // so site_meta.ip_addr is picked up — no manual --refresh needed.
  if (!reachable && wasCached && !override) {
    clearSshCache(siteId);
    connection = await resolveConnection(siteId, override);
    reachable = await probeTcp(connection.host, connection.port, 5000);
  }

  if (!reachable) {
    if ((opts.onUnreachable ?? 'exit') === 'throw') {
      throw new SshUnreachableError(connection.host, connection.port);
    }
    printSshUnreachable(connection.host, connection.port);
    process.exit(1);
  }

  // Resolve the REAL web dir (docroot) from the server. The API "domain" can be a
  // custom primary domain (post-cutover) while the HestiaCP web dir keeps the
  // original sub_domain, so `~/web/<api-domain>/public_html` wouldn't exist. Do it
  // once per connection (cached) — best-effort; keep the API domain if it fails.
  if (!connection.webDirResolved) {
    const webDir = resolveRemoteWebDir(connection);
    connection = { ...connection, domain: webDir || connection.domain, webDirResolved: true };
    setSshCache(siteId, { connection, cachedAt: Date.now() });
  }
  return connection;
}

async function resolveConnection(siteId: number, override: string | null): Promise<SshConnection> {
  // 1. Check cache. Apply an override to the cached host too, so a pre-cutover CDN
  //    host cached before the override was set can't linger.
  const cached = getSshCache(siteId);
  if (cached && existsSync(cached.connection.privateKeyPath)) {
    if (override && cached.connection.host !== override) {
      const conn = { ...cached.connection, host: override };
      setSshCache(siteId, { connection: conn, cachedAt: Date.now() });
      return conn;
    }
    return cached.connection;
  }
  if (cached) clearSshCache(siteId);

  const client = getClient();
  const spin = spinner('Setting up SSH access...');
  spin.start();

  try {
    // 2. Find local keys
    let localKeys = findLocalPubKeys();

    // 3. Fetch uploaded keys from API (every page — see fetchUploadedKeys)
    const uploadedKeys = await fetchUploadedKeys();

    // 4. Find a matching key (local key already uploaded)
    let matchedKey: { privatePath: string; keyId: number } | null = null;
    for (const local of localKeys) {
      const localMaterial = parseKeyMaterial(local.pubContent);
      for (const uploaded of uploadedKeys) {
        const uploadedMaterial = parseKeyMaterial(uploaded.ssh_key);
        if (localMaterial === uploadedMaterial) {
          matchedKey = { privatePath: local.privatePath, keyId: uploaded.id };
          break;
        }
      }
      if (matchedKey) break;
    }

    // 5. If no match, generate CLI key if needed, then upload
    if (!matchedKey) {
      let keyToUpload: { privatePath: string; pubContent: string };

      const cliKeyExists = existsSync(CLI_KEY_PUB_PATH) && existsSync(CLI_KEY_PATH);
      const cliKeyIsRsa = cliKeyExists && readFileSync(CLI_KEY_PUB_PATH, 'utf-8').trim().startsWith('ssh-rsa ');

      if (cliKeyExists && cliKeyIsRsa) {
        keyToUpload = {
          privatePath: CLI_KEY_PATH,
          pubContent: readFileSync(CLI_KEY_PUB_PATH, 'utf-8').trim(),
        };
      } else {
        spin.text = 'Generating SSH key...';
        keyToUpload = generateCliKey();
      }

      spin.text = 'Uploading SSH key...';
      try {
        const uploadRes = await client.post('/ssh-keys', {
          label: 'InstaWP CLI',
          ssh_key: keyToUpload.pubContent,
        });
        const keyId = uploadRes.data?.data?.id;
        if (!keyId) {
          spin.fail('SSH key upload failed');
          error('Unexpected response when uploading SSH key');
          process.exit(1);
        }
        matchedKey = { privatePath: keyToUpload.privatePath, keyId };
      } catch (err: any) {
        spin.fail('SSH key upload failed');
        const msg = err.response?.data?.message || err.message;
        if (err.response?.status === 403) {
          error('Payment method required. Add one at app.instawp.io/billing');
        } else {
          error('Failed to upload SSH key', msg);
        }
        process.exit(1);
      }
    }

    // 6. Enable SSH + SFTP on site (must happen before attach — creates Server_ssh record)
    //    SFTP is required for rsync to work (enables the remote command subsystem)
    spin.text = 'Enabling SSH...';
    let sshDetails: { host: string; username: string; port: number };
    try {
      const enableRes = await client.post(`/sites/${siteId}/update-ssh-status`, { status: 1 });
      // API returns host/username at top level or inside data
      const resp = enableRes.data || {};
      const data = resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data) ? resp.data : {};
      sshDetails = {
        host: resp.host || data.host || data.ip || '',
        username: resp.username || data.username || '',
        port: resp.port || data.port || 22,
      };
    } catch (err: any) {
      spin.fail('Failed to enable SSH');
      const msg = err.response?.data?.message || err.message;
      if (err.response?.status === 403) {
        error('SSH requires a paid plan. Upgrade at app.instawp.io/billing');
      } else {
        error('Could not enable SSH on site', msg);
      }
      process.exit(1);
    }

    // Also enable SFTP (needed for rsync remote command execution)
    try {
      await client.post(`/sites/${siteId}/update-sftp-status`, { status: 1 });
    } catch {
      // Non-fatal — SFTP may already be enabled or not available
    }

    // 7. Attach key to site (after SSH enabled so Server_ssh record exists)
    spin.text = 'Attaching SSH key to site...';
    try {
      await client.post(`/sites/${siteId}/ssh-keys/${matchedKey.keyId}`);
    } catch (err: any) {
      // 409/duplicate is fine — key already attached
      if (err.response?.status !== 409 && err.response?.status !== 422) {
        spin.fail('Failed to attach SSH key');
        const msg = err.response?.data?.message || err.message;
        if (err.response?.status === 403) {
          error('Payment method required. Add one at app.instawp.io/billing');
        } else {
          error('Could not attach SSH key to site', msg);
        }
        process.exit(1);
      }
    }

    if (!sshDetails.host || !sshDetails.username) {
      spin.fail('SSH details incomplete');
      error('Could not get SSH connection details from API');
      process.exit(1);
    }

    // 8. Build and cache connection
    const connection: SshConnection = {
      host: sshDetails.host,
      username: sshDetails.username,
      port: sshDetails.port,
      privateKeyPath: matchedKey.privatePath,
      siteId,
      domain: '',
    };

    // Fetch domain for remote path construction
    try {
      const siteRes = await client.get(`/sites/${siteId}/details`);
      const siteData = siteRes.data?.data;
      const site = siteData?.site || siteData;
      connection.domain = site?.main_domain || site?.sub_domain || site?.domain?.name || '';
    } catch {
      // Non-fatal; domain used only for rsync path
    }

    // Auto-resolve the SSH ORIGIN. `update-ssh-status` returns the site's public
    // hostname — for a CDN-fronted site that's the proxied edge (port 22 filtered),
    // so SSH to it hangs. The real origin server IP lives in `site_meta.ip_addr`
    // (exactly what InstaWP's own SSH bridge uses: `ip_addr ?? sub_domain`), and
    // GET /sites/{id}/credentials exposes it to an owner token. Prefer it so SSH
    // works on CDN-fronted sites with NO manual override.
    let originIp = '';
    try {
      const credRes = await client.get(`/sites/${siteId}/credentials`);
      originIp = credRes.data?.data?.ip_addr || '';
    } catch {
      // Older API / no view permission — fall back to the API host below.
    }

    // Host precedence: explicit override (--ssh-host / INSTAWP_SSH_HOST) >
    // auto-detected origin IP > the API host (CDN edge / sub_domain).
    if (override) connection.host = override;
    else if (originIp) connection.host = originIp;

    setSshCache(siteId, { connection, cachedAt: Date.now() });
    spin.succeed('SSH access ready');
    return connection;
  } catch (err: any) {
    // Re-throw if already handled (process.exit above)
    if (err.code === 'ERR_PROCESS_EXIT') throw err;
    spin.fail('SSH setup failed');
    error('Unexpected error during SSH setup', err.message);
    process.exit(1);
  }
}
