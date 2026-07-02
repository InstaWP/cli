import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { probeTcp, SshUnreachableError } from '../lib/ssh-preflight.js';

describe('probeTcp', () => {
  it('resolves true for a listening port', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(await probeTcp('127.0.0.1', port, 2000)).toBe(true);
    } finally {
      server.close();
    }
  });

  it('resolves false for a refused port, well within the timeout', async () => {
    const start = Date.now();
    const ok = await probeTcp('127.0.0.1', 1, 2000); // port 1 → connection refused (fast)
    expect(ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe('SshUnreachableError', () => {
  it('carries host/port and is instanceof-detectable', () => {
    const e = new SshUnreachableError('cdn.host', 22);
    expect(e).toBeInstanceOf(SshUnreachableError);
    expect(e.host).toBe('cdn.host');
    expect(e.port).toBe(22);
  });
});
