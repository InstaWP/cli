import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Conf before importing config module
vi.mock('conf', () => {
  const store: Record<string, any> = {
    api_url: 'https://app.instawp.io',
    token: '',
    user: {},
    ssh_cache: {},
  };
  return {
    default: class MockConf {
      constructor() {}
      get(key: string) { return store[key]; }
      set(key: string, value: any) { store[key] = value; }
      clear() {
        store.api_url = 'https://app.instawp.io';
        store.token = '';
        store.user = {};
        store.ssh_cache = {};
      }
      // Expose store for test assertions
      get _store() { return store; }
    },
  };
});

// Import after mock
const config = await import('../lib/config.js');

beforeEach(() => {
  // Reset env vars
  delete process.env.INSTAWP_TOKEN;
  delete process.env.INSTAWP_API_URL;
  delete process.env.INSTAWP_SSH_HOST;
  delete process.env.INSTAWP_SSH_HOST_2495716;
  config.clearConfig();
});

describe('config', () => {
  describe('getSshHostOverride', () => {
    it('returns null when no override env is set', () => {
      expect(config.getSshHostOverride(2495716)).toBe(null);
    });

    it('returns the global INSTAWP_SSH_HOST when set', () => {
      process.env.INSTAWP_SSH_HOST = 'origin.example.com';
      expect(config.getSshHostOverride(2495716)).toBe('origin.example.com');
    });

    it('per-site INSTAWP_SSH_HOST_<id> wins over the global', () => {
      process.env.INSTAWP_SSH_HOST = 'global.example.com';
      process.env.INSTAWP_SSH_HOST_2495716 = 'per-site.example.com';
      expect(config.getSshHostOverride(2495716)).toBe('per-site.example.com');
      // a different site still gets the global
      expect(config.getSshHostOverride(999)).toBe('global.example.com');
    });

    it('trims and ignores blank values', () => {
      process.env.INSTAWP_SSH_HOST = '  spaced.example.com  ';
      expect(config.getSshHostOverride(1)).toBe('spaced.example.com');
      process.env.INSTAWP_SSH_HOST = '   ';
      expect(config.getSshHostOverride(1)).toBe(null);
    });
  });

  describe('token management', () => {
    it('returns null when no token set', () => {
      expect(config.getToken()).toBeNull();
    });

    it('returns token after setToken', () => {
      config.setToken('abc123');
      expect(config.getToken()).toBe('abc123');
    });

    it('prefers env var over stored token', () => {
      config.setToken('stored-token');
      process.env.INSTAWP_TOKEN = 'env-token';
      expect(config.getToken()).toBe('env-token');
    });
  });

  describe('API URL', () => {
    it('returns default API URL', () => {
      expect(config.getApiUrl()).toBe('https://app.instawp.io');
    });

    it('returns custom API URL after setApiUrl', () => {
      config.setApiUrl('https://custom.example.com');
      expect(config.getApiUrl()).toBe('https://custom.example.com');
    });

    it('prefers env var over stored URL', () => {
      config.setApiUrl('https://stored.example.com');
      process.env.INSTAWP_API_URL = 'https://env.example.com';
      expect(config.getApiUrl()).toBe('https://env.example.com');
    });
  });

  describe('user management', () => {
    it('returns null when no user set', () => {
      expect(config.getUser()).toBeNull();
    });

    it('returns user after setUser', () => {
      config.setUser({ id: 1, name: 'Test', email: 'test@example.com' });
      const user = config.getUser();
      expect(user).toEqual({ id: 1, name: 'Test', email: 'test@example.com' });
    });
  });

  describe('SSH cache', () => {
    const mockConnection = {
      host: 'example.com',
      username: 'user1',
      port: 22,
      privateKeyPath: '/path/to/key',
      siteId: 100,
      domain: 'test.example.com',
    };

    it('returns null for empty cache', () => {
      expect(config.getSshCache(100)).toBeNull();
    });

    it('stores and retrieves SSH cache', () => {
      const entry = { connection: mockConnection, cachedAt: Date.now() };
      config.setSshCache(100, entry);
      const result = config.getSshCache(100);
      expect(result).toEqual(entry);
    });

    it('returns null for expired cache (>1 hour)', () => {
      const entry = {
        connection: mockConnection,
        cachedAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
      };
      config.setSshCache(100, entry);
      expect(config.getSshCache(100)).toBeNull();
    });

    it('clears cache for specific site', () => {
      config.setSshCache(100, { connection: mockConnection, cachedAt: Date.now() });
      config.setSshCache(200, { connection: { ...mockConnection, siteId: 200 }, cachedAt: Date.now() });
      config.clearSshCache(100);
      expect(config.getSshCache(100)).toBeNull();
      expect(config.getSshCache(200)).not.toBeNull();
    });

    it('clears all SSH cache when no siteId', () => {
      config.setSshCache(100, { connection: mockConnection, cachedAt: Date.now() });
      config.setSshCache(200, { connection: { ...mockConnection, siteId: 200 }, cachedAt: Date.now() });
      config.clearSshCache();
      expect(config.getSshCache(100)).toBeNull();
      expect(config.getSshCache(200)).toBeNull();
    });
  });

  describe('clearConfig', () => {
    it('resets all config to defaults', () => {
      config.setToken('token');
      config.setUser({ id: 1, name: 'User', email: 'u@e.com' });
      config.clearConfig();
      expect(config.getToken()).toBeNull();
      expect(config.getUser()).toBeNull();
    });
  });
});
