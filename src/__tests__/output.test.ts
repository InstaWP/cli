import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setJsonMode, isJsonMode, success, error, info, table, spinner } from '../lib/output.js';

beforeEach(() => {
  setJsonMode(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('output', () => {
  describe('jsonMode', () => {
    it('defaults to false', () => {
      expect(isJsonMode()).toBe(false);
    });

    it('can be toggled on', () => {
      setJsonMode(true);
      expect(isJsonMode()).toBe(true);
    });

    it('can be toggled off', () => {
      setJsonMode(true);
      setJsonMode(false);
      expect(isJsonMode()).toBe(false);
    });
  });

  describe('success()', () => {
    it('prints JSON when json mode is on', () => {
      setJsonMode(true);
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      success('Created site');
      expect(spy).toHaveBeenCalledOnce();
      const parsed = JSON.parse(spy.mock.calls[0][0]);
      expect(parsed).toEqual({ success: true, message: 'Created site' });
    });

    it('includes data in JSON output', () => {
      setJsonMode(true);
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      success('Done', { id: 123 });
      expect(spy).toHaveBeenCalledOnce();
      const parsed = JSON.parse(spy.mock.calls[0][0]);
      expect(parsed).toEqual({ success: true, message: 'Done', data: { id: 123 } });
    });

    it('prints human-readable output with checkmark', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      success('All good');
      expect(spy.mock.calls[0][0]).toContain('All good');
      expect(spy.mock.calls[0][0]).toContain('\u2713');
    });
  });

  describe('error()', () => {
    it('prints JSON to stderr in json mode', () => {
      setJsonMode(true);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      error('Something broke');
      expect(spy).toHaveBeenCalledOnce();
      const parsed = JSON.parse(spy.mock.calls[0][0]);
      expect(parsed).toEqual({ success: false, error: 'Something broke' });
    });

    it('includes details in JSON error output', () => {
      setJsonMode(true);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      error('Fail', 'timeout');
      expect(spy).toHaveBeenCalledOnce();
      const parsed = JSON.parse(spy.mock.calls[0][0]);
      expect(parsed).toEqual({ success: false, error: 'Fail', details: 'timeout' });
    });

    it('prints human-readable error with cross mark', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      error('Bad thing');
      expect(spy.mock.calls[0][0]).toContain('Bad thing');
      expect(spy.mock.calls[0][0]).toContain('\u2717');
    });
  });

  describe('info()', () => {
    it('prints info in human mode', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      info('Heads up');
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0]).toContain('Heads up');
      expect(spy.mock.calls[0][0]).toContain('\u2139');
    });

    it('is silent in json mode', () => {
      setJsonMode(true);
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      info('Ignored');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('table()', () => {
    it('prints JSON array in json mode', () => {
      setJsonMode(true);
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      table(['ID', 'Name'], [{ id: 1, name: 'foo' }]);
      expect(spy).toHaveBeenCalledOnce();
      const parsed = JSON.parse(spy.mock.calls[0][0]);
      expect(parsed).toEqual([{ id: 1, name: 'foo' }]);
    });

    it('prints formatted table in human mode', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      table(['ID', 'Name'], [{ id: 1, name: 'foo' }]);
      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0][0];
      expect(output).toContain('1');
      expect(output).toContain('foo');
    });
  });

  describe('spinner()', () => {
    it('returns a noop spinner in json mode', () => {
      setJsonMode(true);
      const s = spinner('Loading...');
      expect(s.start).toBeTypeOf('function');
      expect(s.succeed).toBeTypeOf('function');
      expect(s.fail).toBeTypeOf('function');
      expect(s.stop).toBeTypeOf('function');
      s.start();
      s.succeed('done');
      s.fail('err');
      s.stop();
    });

    it('returns a working spinner in human mode', () => {
      const s = spinner('Loading...');
      expect(s.start).toBeTypeOf('function');
      expect(s.succeed).toBeTypeOf('function');
    });

    it('emits a phase marker to stderr in non-TTY mode (heartbeat for long ops)', () => {
      // The vitest runner is non-TTY, so spinner() returns the marker stub.
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      spinner('Uploading...').start();
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0][0]).toContain('Uploading...');
    });

    it('emits no marker in json mode (machine output stays clean)', () => {
      setJsonMode(true);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const s = spinner('Uploading...');
      s.start();
      s.succeed('done');
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
