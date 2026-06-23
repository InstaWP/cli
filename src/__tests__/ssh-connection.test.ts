import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SshConnection } from '../types.js';

const mockSpawnSync = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: (...args: any[]) => mockSpawnSync(...args),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: () => true,
    mkdirSync: vi.fn(),
  };
});

const { spawnInteractiveSsh, execViaSsh, execViaSshStreamStdin, rsyncViaSsh } = await import('../lib/ssh-connection.js');

const conn: SshConnection = {
  host: 'test.example.com',
  username: 'testuser',
  port: 2222,
  privateKeyPath: '/home/user/.instawp/cli_key',
  siteId: 100,
  domain: 'site.example.com',
};

beforeEach(() => {
  mockSpawnSync.mockReset();
});

describe('ssh-connection', () => {
  describe('spawnInteractiveSsh', () => {
    it('calls ssh with correct args', () => {
      mockSpawnSync.mockReturnValue({ status: 0 });

      const code = spawnInteractiveSsh(conn);

      expect(code).toBe(0);
      expect(mockSpawnSync).toHaveBeenCalledWith('ssh', expect.arrayContaining([
        '-i', '/home/user/.instawp/cli_key',
        '-p', '2222',
        '-o', 'StrictHostKeyChecking=accept-new',
        'testuser@test.example.com',
      ]), { stdio: 'inherit' });
    });

    it('returns exit code from ssh', () => {
      mockSpawnSync.mockReturnValue({ status: 255 });
      expect(spawnInteractiveSsh(conn)).toBe(255);
    });

    it('returns 1 when status is null', () => {
      mockSpawnSync.mockReturnValue({ status: null });
      expect(spawnInteractiveSsh(conn)).toBe(1);
    });
  });

  describe('execViaSsh', () => {
    it('pipes command via stdin with -T flag', () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: 'testuser\n',
        stderr: '',
      });

      const result = execViaSsh(conn, 'whoami');

      expect(result.stdout).toBe('testuser\n');
      expect(result.exitCode).toBe(0);

      // Check -T flag is present
      const args = mockSpawnSync.mock.calls[0][1] as string[];
      expect(args[0]).toBe('-T');

      // Check command is piped via stdin
      const opts = mockSpawnSync.mock.calls[0][2];
      expect(opts.input).toBe('whoami\n');
      expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    });

    it('returns stderr and non-zero exit code on failure', () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: '',
        stderr: 'command not found',
      });

      const result = execViaSsh(conn, 'badcmd');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('command not found');
    });

    it('handles null stdout/stderr gracefully', () => {
      mockSpawnSync.mockReturnValue({ status: 0, stdout: null, stderr: null });
      const result = execViaSsh(conn, 'test');
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
  });

  describe('execViaSshStreamStdin', () => {
    it('passes the command as an ssh arg (not via stdin) so local stdin can stream', () => {
      mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

      execViaSshStreamStdin(conn, 'cat > /tmp/f', false);

      const callArgs = mockSpawnSync.mock.calls[0][1] as string[];
      expect(callArgs[0]).toBe('-T');
      // command is the LAST argument to ssh
      expect(callArgs[callArgs.length - 1]).toBe('cat > /tmp/f');
      // and is NOT delivered via stdin input
      const opts = mockSpawnSync.mock.calls[0][2];
      expect(opts.input).toBeUndefined();
    });

    it('inherits all stdio in text mode (capture=false) for binary-safe passthrough', () => {
      mockSpawnSync.mockReturnValue({ status: 0 });
      execViaSshStreamStdin(conn, 'tar xzf -', false);
      const opts = mockSpawnSync.mock.calls[0][2];
      expect(opts.stdio).toBe('inherit');
    });

    it('inherits stdin but captures stdout/stderr in JSON mode (capture=true)', () => {
      mockSpawnSync.mockReturnValue({ status: 0, stdout: 'ok', stderr: '' });
      const result = execViaSshStreamStdin(conn, 'whoami', true);
      const opts = mockSpawnSync.mock.calls[0][2];
      expect(opts.stdio).toEqual(['inherit', 'pipe', 'pipe']);
      expect(result.stdout).toBe('ok');
      expect(result.exitCode).toBe(0);
    });

    it('propagates a non-zero exit code (and null → 1)', () => {
      mockSpawnSync.mockReturnValue({ status: 255 });
      expect(execViaSshStreamStdin(conn, 'x', false).exitCode).toBe(255);
      mockSpawnSync.mockReturnValue({ status: null });
      expect(execViaSshStreamStdin(conn, 'x', false).exitCode).toBe(1);
    });
  });

  describe('rsyncViaSsh', () => {
    it('builds correct rsync command for push', () => {
      mockSpawnSync.mockReturnValue({ status: 0 });

      const code = rsyncViaSsh(
        conn,
        './wp-content/',
        'testuser@test.example.com:/home/testuser/web/site.example.com/public_html/wp-content/',
        [],
        false,
        true,
      );

      expect(code).toBe(0);
      expect(mockSpawnSync).toHaveBeenCalledWith('rsync', expect.arrayContaining([
        '-arz',
        '--itemize-changes',
        '--exclude=.git',
        '--exclude=node_modules',
        '--exclude=.DS_Store',
        '-e', expect.stringContaining('-i "/home/user/.instawp/cli_key"'),
        './wp-content/',
        'testuser@test.example.com:/home/testuser/web/site.example.com/public_html/wp-content/',
      ]), expect.any(Object));
    });

    it('includes --dry-run when requested', () => {
      mockSpawnSync.mockReturnValue({ status: 0 });

      rsyncViaSsh(conn, 'src', 'dest', [], true, true);

      const args = mockSpawnSync.mock.calls[0][1] as string[];
      expect(args).toContain('--dry-run');
    });

    it('passes extra exclude args', () => {
      mockSpawnSync.mockReturnValue({ status: 0 });

      rsyncViaSsh(conn, 'src', 'dest', ['--exclude=uploads', '--exclude=cache'], false, true);

      const args = mockSpawnSync.mock.calls[0][1] as string[];
      expect(args).toContain('--exclude=uploads');
      expect(args).toContain('--exclude=cache');
    });

    it('uses inherit stdio when stream=true', () => {
      mockSpawnSync.mockReturnValue({ status: 0 });

      rsyncViaSsh(conn, 'src', 'dest', [], false, true);

      const opts = mockSpawnSync.mock.calls[0][2];
      expect(opts.stdio).toBe('inherit');
    });

    it('captures output when stream=false', () => {
      mockSpawnSync.mockReturnValue({ status: 0, stdout: 'file1\nfile2\n', stderr: '' });
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      rsyncViaSsh(conn, 'src', 'dest', [], false, false);

      const opts = mockSpawnSync.mock.calls[0][2];
      expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
      expect(spy).toHaveBeenCalledWith('file1\nfile2\n');
    });

    it('includes ssh port and known hosts in -e flag', () => {
      mockSpawnSync.mockReturnValue({ status: 0 });

      rsyncViaSsh(conn, 'src', 'dest', [], false, true);

      const args = mockSpawnSync.mock.calls[0][1] as string[];
      const eIndex = args.indexOf('-e');
      const sshCmd = args[eIndex + 1];
      expect(sshCmd).toContain('-p 2222');
      expect(sshCmd).toContain('StrictHostKeyChecking=accept-new');
      expect(sshCmd).toContain('known_hosts');
    });
  });
});
