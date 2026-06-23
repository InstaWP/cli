import { describe, it, expect } from 'vitest';
import { shellQuote, buildRemoteCommandString, sliceAfterMarker } from '../lib/remote-command.js';

describe('shellQuote', () => {
  it('passes shell-safe tokens through unquoted', () => {
    expect(shellQuote('post')).toBe('post');
    expect(shellQuote('--format=count')).toBe('--format=count');
  });

  it('single-quotes tokens with metacharacters', () => {
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote('echo hi; whoami')).toBe("'echo hi; whoami'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe('buildRemoteCommandString', () => {
  it('forwards normal wp-cli args verbatim', () => {
    expect(buildRemoteCommandString(['post', 'list', '--format=count'])).toBe('post list --format=count');
  });

  it('treats a single metacharacter-laden arg as one literal token (default)', () => {
    // This is the documented footgun: without --shell, the whole string is one command name.
    expect(buildRemoteCommandString(['echo hi; whoami'])).toBe("'echo hi; whoami'");
  });

  it('wraps the whole line in bash -lc when shell=true', () => {
    expect(buildRemoteCommandString(['ps aux | grep php'], true)).toBe("bash -lc 'ps aux | grep php'");
  });

  it('joins multiple args before wrapping in shell mode', () => {
    expect(buildRemoteCommandString(['ps', 'aux', '|', 'grep', 'php'], true)).toBe("bash -lc 'ps aux | grep php'");
  });
});

describe('sliceAfterMarker', () => {
  const M = '__IWP_OUT_abc123__';

  it('strips a leading banner/MOTD up to and including the marker line', () => {
    const raw = `Welcome to Ubuntu\nInstaWP banner\n${M}\nmysite.instawp.site`;
    expect(sliceAfterMarker(raw, M)).toBe('mysite.instawp.site');
  });

  it('returns the value when the marker is the first line', () => {
    expect(sliceAfterMarker(`${M}\nblogname`, M)).toBe('blogname');
  });

  it('handles CRLF after the marker', () => {
    expect(sliceAfterMarker(`banner\n${M}\r\nvalue`, M)).toBe('value');
  });

  it('returns the original string unchanged when the marker is absent', () => {
    expect(sliceAfterMarker('plain output', M)).toBe('plain output');
  });
});
