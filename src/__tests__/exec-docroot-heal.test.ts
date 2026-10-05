import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const STALE = '/home/u/web/cli.example.com/public_html';
const REAL = '/home/u/web/cli-site.instawp.dev/public_html';
const conn = { host: 'h', username: 'u', port: 22, privateKeyPath: '/k', siteId: 7, domain: 'cli.example.com', docRoot: STALE };

const mockExecViaSsh = vi.fn();
const mockResolveDocRoot = vi.fn();

vi.mock('../lib/api.js', () => ({ requireAuth: vi.fn(), getClient: vi.fn() }));
vi.mock('../lib/site-resolver.js', () => ({ resolveSite: vi.fn(async () => ({ id: 7 })) }));
vi.mock('../lib/ssh-keys.js', () => ({
  ensureSshAccess: vi.fn(async () => conn),
  resolveDocRoot: (...a: any[]) => mockResolveDocRoot(...a),
}));
vi.mock('../lib/ssh-connection.js', () => ({
  execViaSsh: (...a: any[]) => mockExecViaSsh(...a),
  execViaSshStreamStdin: vi.fn(),
}));
vi.mock('../lib/output.js', () => ({
  isJsonMode: () => false,
  error: vi.fn(),
  info: vi.fn(),
  spinner: () => ({ text: '', start() { return this; }, succeed() {}, fail() {}, stop() {} }),
}));

vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit(${code})`); });
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

const { registerExecCommand, isMissingDirError } = await import('../commands/exec.js');

// Echo the marker the command printed, so sliceAfterMarker finds it.
const reply = (cmd: string, rest: { stdout?: string; stderr?: string; exitCode: number }) => {
  const marker = cmd.match(/'(__IWP_OUT_[0-9a-f]+__)'/)![1];
  return { stdout: `${marker}\n${rest.stdout ?? ''}`, stderr: rest.stderr ?? '', exitCode: rest.exitCode };
};

async function run(args: string[]) {
  const program = new Command().enablePositionalOptions();
  registerExecCommand(program);
  await program.parseAsync(['node', 'instawp', 'exec', 'site', ...args]);
}

describe('exec self-heals a stale docroot', () => {
  beforeEach(() => {
    mockExecViaSsh.mockReset();
    mockResolveDocRoot.mockReset();
  });

  it('re-resolves the docroot and retries once when the cd fails', async () => {
    mockExecViaSsh
      .mockImplementationOnce((_c, cmd) => reply(cmd, { exitCode: 1, stderr: `-bash: line 1: cd: ${STALE}: No such file or directory\n` }))
      .mockImplementationOnce((_c, cmd) => reply(cmd, { exitCode: 0, stdout: 'ok\n' }));
    mockResolveDocRoot.mockReturnValue({ ...conn, docRoot: REAL });

    await expect(run(['ls'])).rejects.toThrow('exit(0)');
    expect(mockResolveDocRoot).toHaveBeenCalledWith(7, conn);
    expect(mockExecViaSsh).toHaveBeenCalledTimes(2);
    expect(mockExecViaSsh.mock.calls[0][1]).toContain(`cd ${STALE} && `);
    expect(mockExecViaSsh.mock.calls[1][1]).toContain(`cd ${REAL} && `);
  });

  it('does not retry when the command itself failed (not the cd)', async () => {
    mockExecViaSsh.mockImplementationOnce((_c, cmd) => reply(cmd, { exitCode: 2, stderr: 'ls: cannot access x: No such file or directory\n' }));

    await expect(run(['ls', 'x'])).rejects.toThrow('exit(2)');
    expect(mockResolveDocRoot).not.toHaveBeenCalled();
    expect(mockExecViaSsh).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the server lookup fails or returns the same path', async () => {
    const cdFail = { exitCode: 1, stderr: `bash: cd: ${STALE}: No such file or directory\n` };
    mockExecViaSsh.mockImplementation((_c, cmd) => reply(cmd, cdFail));
    mockResolveDocRoot.mockReturnValueOnce(null).mockReturnValueOnce({ ...conn });

    await expect(run(['ls'])).rejects.toThrow('exit(1)');
    await expect(run(['ls'])).rejects.toThrow('exit(1)');
    expect(mockExecViaSsh).toHaveBeenCalledTimes(2); // one attempt per run, no retry
  });

  it('isMissingDirError matches only the cd into that exact dir', () => {
    expect(isMissingDirError(`-bash: line 1: cd: ${STALE}: No such file or directory`, STALE)).toBe(true);
    expect(isMissingDirError(`cd: ${STALE}/wp-content: No such file or directory`, STALE)).toBe(false);
    expect(isMissingDirError('cat: x: No such file or directory', STALE)).toBe(false);
  });
});
