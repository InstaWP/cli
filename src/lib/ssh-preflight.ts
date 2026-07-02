import net from 'node:net';
import { error, info } from './output.js';

/**
 * Thrown when an SSH host:port can't be reached during preflight. Callers that
 * have an API fallback (wp/exec) catch this to switch transports; callers that
 * don't let ensureSshAccess print the diagnostic and exit.
 */
export class SshUnreachableError extends Error {
  constructor(public readonly host: string, public readonly port: number) {
    super(`Can't reach ${host}:${port} over SSH`);
    this.name = 'SshUnreachableError';
  }
}

/**
 * TCP-connect probe: resolves true if host:port accepts a connection within
 * `timeoutMs`, false on timeout/refused/DNS-fail. This replaces the raw ~2-minute
 * ssh/rsync spawn timeout with a fast fail — a CDN-fronted host (port 22 filtered)
 * is detected in a few seconds instead of hanging.
 */
export function probeTcp(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/** Print the actionable diagnostic for an unreachable SSH host. */
export function printSshUnreachable(host: string, port: number): void {
  error(`Can't reach ${host}:${port} over SSH — the resolved origin isn't reachable from here (the API may not have exposed the origin IP for this site).`);
  info('Fixes: retry with --api (wp/exec/db), set INSTAWP_SSH_HOST=<origin-host> (or INSTAWP_SSH_HOST_<siteId>=<host>) to override, or pass --refresh to re-resolve (e.g. if the origin was cached before it was available).');
}
