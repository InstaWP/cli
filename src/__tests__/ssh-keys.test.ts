import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { homedir } from 'node:os';

// Track mock state
let mockFiles: Record<string, string> = {};
let mockSshCache: Record<string, any> = {};
let mockUnreachableHosts: string[] = []; // hosts the mocked TCP preflight treats as down
let mockSshOverride: string | null = null; // controls getSshHostOverride
let mockWebDir: string | null = null;    // controls resolveRemoteWebDir
const mockPrintUnreachable = vi.fn();
const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: string) => p in mockFiles,
    readFileSync: (p: string) => {
      if (p in mockFiles) return mockFiles[p];
      throw new Error(`ENOENT: ${p}`);
    },
    mkdirSync: vi.fn(),
  };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../lib/api.js', () => ({
  getClient: () => ({ get: mockGet, post: mockPost }),
}));

vi.mock('../lib/config.js', () => ({
  getSshCache: (siteId: number) => mockSshCache[siteId] || null,
  setSshCache: (siteId: number, entry: any) => { mockSshCache[siteId] = entry; },
  clearSshCache: (siteId?: number) => {
    if (siteId !== undefined) delete mockSshCache[siteId];
    else mockSshCache = {};
  },
  getSshHostOverride: () => mockSshOverride,
}));

vi.mock('../lib/ssh-connection.js', () => ({
  resolveRemoteWebDir: () => mockWebDir,
}));

vi.mock('../lib/ssh-preflight.js', () => ({
  probeTcp: (host: string) => Promise.resolve(!mockUnreachableHosts.includes(host)),
  printSshUnreachable: (...args: any[]) => mockPrintUnreachable(...args),
  SshUnreachableError: class SshUnreachableError extends Error {
    constructor(public host: string, public port: number) {
      super(`Can't reach ${host}:${port}`);
      this.name = 'SshUnreachableError';
    }
  },
}));

vi.mock('../lib/output.js', () => ({
  error: vi.fn(),
  info: vi.fn(),
  spinner: () => ({
    text: '',
    start() { return this; },
    succeed() {},
    fail() {},
    stop() {},
  }),
}));

const mockExit = vi.spyOn(process, 'exit').mockImplementation((code) => {
  throw new Error(`process.exit(${code})`);
});

const { ensureSshAccess } = await import('../lib/ssh-keys.js');

const CLI_KEY_PATH = path.join(homedir(), '.instawp', 'cli_key');
const CLI_KEY_PUB = CLI_KEY_PATH + '.pub';

beforeEach(() => {
  mockFiles = {};
  mockSshCache = {};
  mockUnreachableHosts = [];
  mockSshOverride = null;
  mockWebDir = null;
  mockPrintUnreachable.mockClear();
  mockGet.mockReset();
  mockPost.mockReset();
  mockExit.mockClear();
});

describe('ssh-keys', () => {
  describe('ensureSshAccess', () => {
    it('returns cached connection when valid', async () => {
      const conn = {
        host: 'test.com',
        username: 'user1',
        port: 22,
        privateKeyPath: '/tmp/test_key',
        siteId: 100,
        domain: 'test.com',
        webDirResolved: true, // already resolved → returned as-is, no SSH web-dir lookup
      };
      mockSshCache[100] = { connection: conn, cachedAt: Date.now() };
      mockFiles['/tmp/test_key'] = 'private key';

      const result = await ensureSshAccess(100);
      expect(result).toEqual(conn);
      // Should not make any API calls
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('clears cache when private key file is missing', async () => {
      const conn = {
        host: 'test.com',
        username: 'user1',
        port: 22,
        privateKeyPath: '/nonexistent/key',
        siteId: 100,
        domain: 'test.com',
      };
      mockSshCache[100] = { connection: conn, cachedAt: Date.now() };

      // Set up for the full flow after cache miss
      mockFiles[CLI_KEY_PUB] = 'ssh-rsa AAAA== instawp-cli';
      mockFiles[CLI_KEY_PATH] = 'private key';

      // API: ssh-keys list (no uploaded keys)
      mockGet.mockResolvedValueOnce({ data: { data: [] } });
      // API: upload key
      mockPost.mockResolvedValueOnce({ data: { data: { id: 5 } } });
      // API: enable SSH
      mockPost.mockResolvedValueOnce({ data: { host: 'site.com', username: 'siteuser', port: 22, data: [] } });
      // API: enable SFTP
      mockPost.mockResolvedValueOnce({ data: {} });
      // API: attach key
      mockPost.mockResolvedValueOnce({ data: {} });
      // API: site details (for domain)
      mockGet.mockResolvedValueOnce({ data: { data: { site: { main_domain: 'site.com' } } } });

      const result = await ensureSshAccess(100);
      expect(result.host).toBe('site.com');
      expect(result.username).toBe('siteuser');
    });

    it('matches existing local key against uploaded keys', async () => {
      const rsaPub = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQ== user@host';
      mockFiles[path.join(homedir(), '.ssh', 'id_rsa')] = 'private key';
      mockFiles[path.join(homedir(), '.ssh', 'id_rsa.pub')] = rsaPub;

      // API: ssh-keys list (key already uploaded)
      mockGet.mockResolvedValueOnce({
        data: {
          data: [
            { id: 10, label: 'My Key', ssh_key: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQ== other-comment' },
          ],
        },
      });
      // API: enable SSH
      mockPost.mockResolvedValueOnce({ data: { host: 'match.com', username: 'matchuser', port: 2222, data: [] } });
      // API: enable SFTP
      mockPost.mockResolvedValueOnce({ data: {} });
      // API: attach key
      mockPost.mockResolvedValueOnce({ data: {} });
      // API: site details
      mockGet.mockResolvedValueOnce({ data: { data: { site: { main_domain: 'match.com' } } } });

      const result = await ensureSshAccess(200);
      expect(result.host).toBe('match.com');
      expect(result.privateKeyPath).toBe(path.join(homedir(), '.ssh', 'id_rsa'));
      // Should NOT have uploaded a key
      const uploadCalls = mockPost.mock.calls.filter((c: any[]) => c[0] === '/ssh-keys');
      expect(uploadCalls.length).toBe(0);
    });

    it('exits on 403 when SSH requires paid plan', async () => {
      mockFiles[CLI_KEY_PUB] = 'ssh-rsa AAAA== instawp-cli';
      mockFiles[CLI_KEY_PATH] = 'private key';

      mockGet.mockResolvedValueOnce({ data: { data: [] } }); // ssh-keys
      mockPost.mockResolvedValueOnce({ data: { data: { id: 5 } } }); // upload key
      mockPost.mockRejectedValueOnce({ response: { status: 403, data: { message: 'Forbidden' } } }); // enable SSH → 403

      await expect(ensureSshAccess(300)).rejects.toThrow();
    });

    it('handles 409 duplicate on key attach gracefully', async () => {
      mockFiles[CLI_KEY_PUB] = 'ssh-rsa AAAA== instawp-cli';
      mockFiles[CLI_KEY_PATH] = 'private key';

      mockGet.mockResolvedValueOnce({ data: { data: [] } }); // ssh-keys
      mockPost.mockResolvedValueOnce({ data: { data: { id: 5 } } }); // upload
      mockPost.mockResolvedValueOnce({ data: { host: 'ok.com', username: 'okuser', port: 22, data: [] } }); // enable SSH
      mockPost.mockResolvedValueOnce({ data: {} }); // enable SFTP
      mockPost.mockRejectedValueOnce({ response: { status: 409 } }); // attach → 409 duplicate (should be fine)
      mockGet.mockResolvedValueOnce({ data: { data: { site: { main_domain: 'ok.com' } } } }); // details

      const result = await ensureSshAccess(400);
      expect(result.host).toBe('ok.com');
    });

    it('handles 422 on key attach gracefully', async () => {
      mockFiles[CLI_KEY_PUB] = 'ssh-rsa AAAA== instawp-cli';
      mockFiles[CLI_KEY_PATH] = 'private key';

      mockGet.mockResolvedValueOnce({ data: { data: [] } }); // ssh-keys
      mockPost.mockResolvedValueOnce({ data: { data: { id: 5 } } }); // upload
      mockPost.mockResolvedValueOnce({ data: { host: 'ok.com', username: 'okuser', port: 22, data: [] } }); // enable SSH
      mockPost.mockResolvedValueOnce({ data: {} }); // enable SFTP
      mockPost.mockRejectedValueOnce({ response: { status: 422 } }); // attach → 422 (already attached)
      mockGet.mockResolvedValueOnce({ data: { data: { site: { main_domain: 'ok.com' } } } }); // details

      const result = await ensureSshAccess(401);
      expect(result.host).toBe('ok.com');
    });

    it('resolves the real web dir from the server, overriding the API domain (post-cutover)', async () => {
      mockWebDir = 'instawp-marketing.instawp.site'; // the server's actual web dir
      mockFiles[CLI_KEY_PUB] = 'ssh-rsa AAAA== instawp-cli';
      mockFiles[CLI_KEY_PATH] = 'private key';

      mockGet.mockResolvedValueOnce({ data: { data: [] } }); // ssh-keys
      mockPost.mockResolvedValueOnce({ data: { data: { id: 5 } } }); // upload
      mockPost.mockResolvedValueOnce({ data: { host: '10.0.0.5', username: 'u', port: 22, data: [] } }); // enable ssh
      mockPost.mockResolvedValueOnce({ data: {} }); // sftp
      mockPost.mockResolvedValueOnce({ data: {} }); // attach
      // API reports the cutover primary domain — must NOT be used for the web dir.
      mockGet.mockResolvedValueOnce({ data: { data: { site: { main_domain: 'instawp.com', sub_domain: 'instawp.com' } } } });
      mockGet.mockResolvedValueOnce({ data: { data: { ip_addr: '10.0.0.5' } } }); // credentials

      const result = await ensureSshAccess(950);
      expect(result.domain).toBe('instawp-marketing.instawp.site'); // real docroot, not instawp.com
      expect(result.webDirResolved).toBe(true);
    });

    it('applies the SSH host override over the API host (CDN-fronted site)', async () => {
      mockSshOverride = 'origin.internal.host';
      mockFiles[CLI_KEY_PUB] = 'ssh-rsa AAAA== instawp-cli';
      mockFiles[CLI_KEY_PATH] = 'private key';

      mockGet.mockResolvedValueOnce({ data: { data: [] } }); // ssh-keys
      mockPost.mockResolvedValueOnce({ data: { data: { id: 5 } } }); // upload key
      // API returns the CDN edge host — the override must win.
      mockPost.mockResolvedValueOnce({ data: { host: 'cdn-edge.instawp.site', username: 'u', port: 22, data: [] } });
      mockPost.mockResolvedValueOnce({ data: {} }); // enable SFTP
      mockPost.mockResolvedValueOnce({ data: {} }); // attach
      mockGet.mockResolvedValueOnce({ data: { data: { site: { main_domain: 'cdn-edge.instawp.site' } } } });

      const result = await ensureSshAccess(600);
      expect(result.host).toBe('origin.internal.host');
      // and the cache stores the overridden host
      expect(mockSshCache[600].connection.host).toBe('origin.internal.host');
    });

    it('auto-resolves the SSH origin from site_meta.ip_addr (no override needed)', async () => {
      mockFiles[CLI_KEY_PUB] = 'ssh-rsa AAAA== instawp-cli';
      mockFiles[CLI_KEY_PATH] = 'private key';

      mockGet.mockResolvedValueOnce({ data: { data: [] } }); // ssh-keys
      mockPost.mockResolvedValueOnce({ data: { data: { id: 5 } } }); // upload
      // update-ssh-status returns the CDN edge host...
      mockPost.mockResolvedValueOnce({ data: { host: 'cdn-edge.instawp.site', username: 'u', port: 22, data: [] } });
      mockPost.mockResolvedValueOnce({ data: {} }); // sftp
      mockPost.mockResolvedValueOnce({ data: {} }); // attach
      mockGet.mockResolvedValueOnce({ data: { data: { site: { main_domain: 'cdn-edge.instawp.site' } } } }); // details
      mockGet.mockResolvedValueOnce({ data: { data: { ip_addr: '103.180.115.9' } } }); // credentials → origin IP

      const result = await ensureSshAccess(700);
      expect(result.host).toBe('103.180.115.9'); // the origin IP, not the CDN host
      expect(result.domain).toBe('cdn-edge.instawp.site'); // remote path still uses the domain
    });

    it('explicit override beats the auto-detected origin IP', async () => {
      mockSshOverride = 'manual.override.host';
      mockFiles[CLI_KEY_PUB] = 'ssh-rsa AAAA== instawp-cli';
      mockFiles[CLI_KEY_PATH] = 'private key';

      mockGet.mockResolvedValueOnce({ data: { data: [] } });
      mockPost.mockResolvedValueOnce({ data: { data: { id: 5 } } });
      mockPost.mockResolvedValueOnce({ data: { host: 'cdn-edge.instawp.site', username: 'u', port: 22, data: [] } });
      mockPost.mockResolvedValueOnce({ data: {} });
      mockPost.mockResolvedValueOnce({ data: {} });
      mockGet.mockResolvedValueOnce({ data: { data: { site: { main_domain: 'cdn-edge.instawp.site' } } } });
      mockGet.mockResolvedValueOnce({ data: { data: { ip_addr: '103.180.115.9' } } }); // credentials

      const result = await ensureSshAccess(702);
      expect(result.host).toBe('manual.override.host'); // override wins over ip_addr
    });

    it('rewrites a stale cached (pre-cutover CDN) host when an override is set', async () => {
      const stale = {
        host: 'cdn-edge.instawp.site',
        username: 'user1',
        port: 22,
        privateKeyPath: '/tmp/test_key',
        siteId: 100,
        domain: 'cdn-edge.instawp.site',
      };
      mockSshCache[100] = { connection: stale, cachedAt: Date.now() };
      mockFiles['/tmp/test_key'] = 'private key';
      mockSshOverride = 'origin.internal.host';

      const result = await ensureSshAccess(100);
      expect(result.host).toBe('origin.internal.host');
      expect(mockSshCache[100].connection.host).toBe('origin.internal.host');
      // No re-resolution needed — override applied to the cached entry.
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('--refresh drops the cache and re-resolves', async () => {
      const cached = {
        host: 'old.host', username: 'u', port: 22,
        privateKeyPath: '/tmp/test_key', siteId: 100, domain: 'old.host',
      };
      mockSshCache[100] = { connection: cached, cachedAt: Date.now() };
      mockFiles['/tmp/test_key'] = 'private key';
      mockFiles[CLI_KEY_PUB] = 'ssh-rsa AAAA== instawp-cli';
      mockFiles[CLI_KEY_PATH] = 'private key';

      mockGet.mockResolvedValueOnce({ data: { data: [] } });
      mockPost.mockResolvedValueOnce({ data: { data: { id: 5 } } });
      mockPost.mockResolvedValueOnce({ data: { host: 'fresh.host', username: 'u', port: 22, data: [] } });
      mockPost.mockResolvedValueOnce({ data: {} });
      mockPost.mockResolvedValueOnce({ data: {} });
      mockGet.mockResolvedValueOnce({ data: { data: { site: { main_domain: 'fresh.host' } } } });

      const result = await ensureSshAccess(100, { refresh: true });
      expect(result.host).toBe('fresh.host'); // re-resolved, not the cached 'old.host'
    });

    // Helper: mock a full fresh resolve that lands on the given host (no origin IP).
    const mockFreshResolve = (host: string) => {
      mockFiles[CLI_KEY_PUB] = 'ssh-rsa AAAA== instawp-cli';
      mockFiles[CLI_KEY_PATH] = 'private key';
      mockGet.mockResolvedValueOnce({ data: { data: [] } }); // ssh-keys
      mockPost.mockResolvedValueOnce({ data: { data: { id: 5 } } }); // upload
      mockPost.mockResolvedValueOnce({ data: { host, username: 'u', port: 22, data: [] } }); // enable ssh
      mockPost.mockResolvedValueOnce({ data: {} }); // sftp
      mockPost.mockResolvedValueOnce({ data: {} }); // attach
      mockGet.mockResolvedValueOnce({ data: { data: { site: { main_domain: host } } } }); // details
      mockGet.mockResolvedValueOnce({ data: { data: { ip_addr: '' } } }); // credentials — no origin
    };

    it('preflight failure (fresh resolve): default mode prints the diagnostic and exits', async () => {
      mockUnreachableHosts = ['unreachable.host'];
      mockFreshResolve('unreachable.host');
      await expect(ensureSshAccess(800)).rejects.toThrow('process.exit(1)');
      expect(mockPrintUnreachable).toHaveBeenCalledWith('unreachable.host', 22);
    });

    it('preflight failure: onUnreachable=throw throws SshUnreachableError (for --api fallback)', async () => {
      mockUnreachableHosts = ['unreachable.host'];
      mockFreshResolve('unreachable.host');
      await expect(ensureSshAccess(801, { onUnreachable: 'throw' })).rejects.toThrow(/Can't reach/);
      expect(mockPrintUnreachable).not.toHaveBeenCalled();
    });

    it('self-heals a stale cached CDN host by re-resolving to the origin IP', async () => {
      const stale = {
        host: 'cdn-edge.instawp.site', username: 'u', port: 22,
        privateKeyPath: '/tmp/test_key', siteId: 900, domain: 'cdn-edge.instawp.site',
      };
      mockSshCache[900] = { connection: stale, cachedAt: Date.now() };
      mockFiles['/tmp/test_key'] = 'private key';
      mockUnreachableHosts = ['cdn-edge.instawp.site']; // cached CDN host down; origin IP is up

      // The re-resolve (after the stale cache is dropped) picks up the origin IP.
      mockFiles[CLI_KEY_PUB] = 'ssh-rsa AAAA== instawp-cli';
      mockFiles[CLI_KEY_PATH] = 'private key';
      mockGet.mockResolvedValueOnce({ data: { data: [] } }); // ssh-keys
      mockPost.mockResolvedValueOnce({ data: { data: { id: 5 } } }); // upload
      mockPost.mockResolvedValueOnce({ data: { host: 'cdn-edge.instawp.site', username: 'u', port: 22, data: [] } }); // enable ssh
      mockPost.mockResolvedValueOnce({ data: {} }); // sftp
      mockPost.mockResolvedValueOnce({ data: {} }); // attach
      mockGet.mockResolvedValueOnce({ data: { data: { site: { main_domain: 'cdn-edge.instawp.site' } } } }); // details
      mockGet.mockResolvedValueOnce({ data: { data: { ip_addr: '24.199.112.156' } } }); // credentials → origin IP

      const result = await ensureSshAccess(900);
      expect(result.host).toBe('24.199.112.156');
      expect(mockPrintUnreachable).not.toHaveBeenCalled();
    });

    it('exits when SSH details are incomplete', async () => {
      mockFiles[CLI_KEY_PUB] = 'ssh-rsa AAAA== instawp-cli';
      mockFiles[CLI_KEY_PATH] = 'private key';

      mockGet.mockResolvedValueOnce({ data: { data: [] } }); // ssh-keys
      mockPost.mockResolvedValueOnce({ data: { data: { id: 5 } } }); // upload
      // Enable SSH returns no host/username
      mockPost.mockResolvedValueOnce({ data: { data: [], status: true } });
      mockPost.mockResolvedValueOnce({ data: {} }); // enable SFTP
      mockPost.mockResolvedValueOnce({ data: {} }); // attach

      await expect(ensureSshAccess(500)).rejects.toThrow();
    });
  });
});
