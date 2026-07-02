import { describe, it, expect } from 'vitest';
import { normalizeRunCmd, chunkString } from '../lib/api-exec.js';

describe('normalizeRunCmd', () => {
  it('reads an array of {output, exit_code}', () => {
    expect(normalizeRunCmd([{ output: 'hello\n', exit_code: 0 }])).toEqual({ stdout: 'hello\n', exitCode: 0 });
    expect(normalizeRunCmd([{ output: 'boom', exit_code: 2 }])).toEqual({ stdout: 'boom', exitCode: 2 });
  });

  it('strips the leading run-cmd echo timestamp line', () => {
    const out = '2026-07-02 12:00:00 wp db export\nBASE64DATA==';
    expect(normalizeRunCmd([{ output: out, exit_code: 0 }])).toEqual({ stdout: 'BASE64DATA==', exitCode: 0 });
  });

  it('handles a bare string payload', () => {
    expect(normalizeRunCmd('just text')).toEqual({ stdout: 'just text', exitCode: 0 });
  });

  it('handles an object with output', () => {
    expect(normalizeRunCmd({ output: 'x', exit_code: 1 })).toEqual({ stdout: 'x', exitCode: 1 });
  });

  it('coerces a missing exit code to 0', () => {
    expect(normalizeRunCmd([{ output: 'y' }]).exitCode).toBe(0);
  });
});

describe('chunkString', () => {
  it('splits into fixed-size pieces preserving order and content', () => {
    const parts = chunkString('abcdefg', 3);
    expect(parts).toEqual(['abc', 'def', 'g']);
    expect(parts.join('')).toBe('abcdefg');
  });

  it('returns a single piece when smaller than the chunk size', () => {
    expect(chunkString('ab', 10)).toEqual(['ab']);
  });

  it('returns [] for an empty string', () => {
    expect(chunkString('', 10)).toEqual([]);
  });

  it('round-trips base64 across chunk boundaries', () => {
    const b64 = Buffer.from('the quick brown fox '.repeat(50)).toString('base64');
    const rebuilt = chunkString(b64, 7).join('');
    expect(Buffer.from(rebuilt, 'base64').toString()).toBe('the quick brown fox '.repeat(50));
  });

  it('throws on a non-positive chunk size', () => {
    expect(() => chunkString('x', 0)).toThrow();
  });
});
