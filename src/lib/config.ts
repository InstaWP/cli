import Conf from 'conf';
import type { UserInfo, SshConnectionCache, LocalInstance } from '../types.js';

const SSH_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const SITE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

const config = new Conf({
  projectName: 'instawp',
  schema: {
    api_url: { type: 'string', default: 'https://app.instawp.io' },
    token: { type: 'string', default: '' },
    user: { type: 'object', default: {} },
    ssh_cache: { type: 'object', default: {} },
    site_cache: { type: 'object', default: {} },
    local_instances: { type: 'object', default: {} },
    team_id: { type: 'number', default: 0 },
    update_check: { type: 'object', default: {} },
    mcp_tokens: { type: 'object', default: {} },
  },
});

export function getToken(): string | null {
  const envToken = process.env.INSTAWP_TOKEN;
  if (envToken) return envToken;
  const token = config.get('token') as string;
  return token || null;
}

export function getApiUrl(): string {
  return (process.env.INSTAWP_API_URL || config.get('api_url')) as string;
}

/**
 * SSH/rsync host override for CDN-fronted sites. When a site is behind a CDN
 * (Bunny), the platform API returns the proxied edge hostname — port 22 there is
 * unreachable and the origin is never exposed — so every SSH-backed command hangs.
 * This lets a dev point SSH at the true origin. Per-site `INSTAWP_SSH_HOST_<id>`
 * wins over the global `INSTAWP_SSH_HOST`. Env-only, like getToken/getApiUrl —
 * nothing is persisted. Returns null when neither is set.
 */
export function getSshHostOverride(siteId: number): string | null {
  const perSite = process.env[`INSTAWP_SSH_HOST_${siteId}`];
  if (perSite && perSite.trim()) return perSite.trim();
  const global = process.env.INSTAWP_SSH_HOST;
  return global && global.trim() ? global.trim() : null;
}

export function setToken(token: string): void {
  config.set('token', token);
}

export function setUser(user: UserInfo): void {
  config.set('user', user);
}

export function getUser(): UserInfo | null {
  const user = config.get('user') as UserInfo;
  if (user && user.id) return user;
  return null;
}

export function setApiUrl(url: string): void {
  config.set('api_url', url);
}

export function getTeamId(): number | null {
  const id = config.get('team_id') as number;
  return id || null;
}

export function setTeamId(id: number): void {
  config.set('team_id', id);
}

export function clearTeamId(): void {
  config.set('team_id', 0);
}

export function clearConfig(): void {
  config.clear();
}

// Update-notifier cache: when we last checked npm, and the newest version seen.
interface UpdateCheck {
  lastCheck: number;
  latestVersion: string;
}

export function getUpdateCheck(): UpdateCheck | null {
  const v = config.get('update_check') as Partial<UpdateCheck>;
  if (v && typeof v.lastCheck === 'number') {
    return { lastCheck: v.lastCheck, latestVersion: v.latestVersion || '' };
  }
  return null;
}

export function setUpdateCheck(latestVersion: string): void {
  config.set('update_check', { lastCheck: Date.now(), latestVersion });
}

// Site resolution cache: maps identifier (name/domain) → site ID
interface SiteCacheEntry {
  id: number;
  cachedAt: number;
}

export function getSiteCache(identifier: string): number | null {
  const cache = config.get('site_cache') as Record<string, SiteCacheEntry>;
  const entry = cache?.[identifier.toLowerCase()];
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > SITE_CACHE_TTL) {
    return null;
  }
  return entry.id;
}

export function setSiteCache(identifier: string, siteId: number): void {
  const cache = (config.get('site_cache') as Record<string, SiteCacheEntry>) || {};
  cache[identifier.toLowerCase()] = { id: siteId, cachedAt: Date.now() };
  config.set('site_cache', cache);
}

// Local instance management
export function getLocalInstances(): Record<string, LocalInstance> {
  return (config.get('local_instances') as Record<string, LocalInstance>) || {};
}

export function getLocalInstance(name: string): LocalInstance | null {
  const instances = getLocalInstances();
  return instances[name] || null;
}

export function setLocalInstance(instance: LocalInstance): void {
  const instances = getLocalInstances();
  instances[instance.name] = instance;
  config.set('local_instances', instances);
}

export function removeLocalInstance(name: string): void {
  const instances = getLocalInstances();
  delete instances[name];
  config.set('local_instances', instances);
}

export function getSshCache(siteId: number): SshConnectionCache | null {
  const cache = config.get('ssh_cache') as Record<string, SshConnectionCache>;
  const entry = cache?.[String(siteId)];
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > SSH_CACHE_TTL) {
    clearSshCache(siteId);
    return null;
  }
  return entry;
}

export function setSshCache(siteId: number, entry: SshConnectionCache): void {
  const cache = (config.get('ssh_cache') as Record<string, SshConnectionCache>) || {};
  cache[String(siteId)] = entry;
  config.set('ssh_cache', cache);
}

// InstaMCP connection tokens, keyed by site ID. Cached locally so re-running
// `mcp enable` is a true no-op that re-prints the SAME token — the plugin only
// stores the token's SHA256 hash, so the plaintext is recoverable only here.
export function getMcpToken(siteId: number): string | null {
  const cache = config.get('mcp_tokens') as Record<string, string>;
  const token = cache?.[String(siteId)];
  return token || null;
}

export function setMcpToken(siteId: number, token: string): void {
  const cache = (config.get('mcp_tokens') as Record<string, string>) || {};
  cache[String(siteId)] = token;
  config.set('mcp_tokens', cache);
}

export function clearSshCache(siteId?: number): void {
  if (siteId !== undefined) {
    const cache = (config.get('ssh_cache') as Record<string, SshConnectionCache>) || {};
    delete cache[String(siteId)];
    config.set('ssh_cache', cache);
  } else {
    config.set('ssh_cache', {});
  }
}
