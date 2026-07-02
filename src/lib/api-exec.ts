import { getClient } from './api.js';

/**
 * The non-SSH transport: run a shell command on a site via the platform's
 * `POST /sites/{id}/run-cmd` API. This is the only channel that works for a
 * CDN-fronted site whose SSH port is unreachable. run-cmd is a single
 * request/response — no streaming, no raw binary — so callers that move files
 * base64-encode and chunk (see `chunkString`).
 */

export interface ApiExecResult {
  stdout: string;
  exitCode: number;
  raw: any;
}

/**
 * Run one command via run-cmd and return its (echo-stripped) stdout + exit code.
 * The per-call HTTP timeout is raised past the shared axios client's 30s default
 * so long operations (DB dump/import) aren't cut off mid-flight.
 */
export async function runViaApi(
  siteId: number,
  command: string,
  opts: { timeoutSeconds?: number } = {},
): Promise<ApiExecResult> {
  const client = getClient();
  const timeoutSeconds = opts.timeoutSeconds ?? 30;
  const res = await client.post(
    `/sites/${siteId}/run-cmd`,
    { commands: [command], timeout_seconds: timeoutSeconds },
    // Give the HTTP call headroom over the remote command budget (client default is 30s).
    { timeout: Math.max(30000, (timeoutSeconds + 20) * 1000) },
  );
  const data = res.data?.data;
  return { ...normalizeRunCmd(data), raw: data };
}

/** Strip the leading `YYYY-MM-DD …` echo line run-cmd prepends, if present. */
function stripEcho(s: string): string {
  const lines = s.split('\n');
  if (lines[0] && /^\d{4}-\d{2}-\d{2}\s/.test(lines[0])) {
    return lines.slice(1).join('\n');
  }
  return s;
}

/**
 * run-cmd responses come back as an array of `{output, exit_code}`, a bare string,
 * or `{output}`. Normalize to `{stdout, exitCode}`. Exported for unit testing.
 */
export function normalizeRunCmd(data: any): { stdout: string; exitCode: number } {
  const asString = (v: any): string => (typeof v === 'string' ? stripEcho(v) : v == null ? '' : JSON.stringify(v));
  if (Array.isArray(data)) {
    const first = data[0];
    if (first && typeof first === 'object') {
      return { stdout: asString(first.output), exitCode: Number(first.exit_code ?? 0) };
    }
    return { stdout: asString(first), exitCode: 0 };
  }
  if (typeof data === 'string') return { stdout: stripEcho(data), exitCode: 0 };
  if (data && data.output != null) {
    return { stdout: asString(data.output), exitCode: Number(data.exit_code ?? 0) };
  }
  return { stdout: asString(data), exitCode: 0 };
}

/** Split a string into fixed-size pieces (used to chunk base64 across run-cmd calls). */
export function chunkString(s: string, size: number): string[] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
