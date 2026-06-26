import { describe, it, expect, vi, afterEach } from 'vitest';
import { waitForHttp } from '../lib/http-ready.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('waitForHttp', () => {
  it('returns true as soon as the URL answers (any HTTP response)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await expect(waitForHttp('https://x.test', 5000)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns false without calling fetch when the budget is already exhausted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(waitForHttp('https://x.test', 0)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
