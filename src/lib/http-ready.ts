/**
 * Poll a URL until it answers (any HTTP status = DNS resolved + server up), or
 * the budget runs out. A fresh site's DNS/edge lags task completion by 30–120s,
 * and a large DB import can leave the site briefly unreachable (returns 000)
 * right after import/flush — so callers use this instead of hand-rolling a
 * curl-retry gate. Capped at 180s regardless of `maxMs`.
 */
export async function waitForHttp(url: string, maxMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.min(Math.max(maxMs, 0), 180000);
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
        return true; // any HTTP response means it's reachable
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // DNS/connection not ready yet — back off and retry.
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}
