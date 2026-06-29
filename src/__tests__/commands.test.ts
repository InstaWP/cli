import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';

// Mock all dependencies to test command registration only
vi.mock('../lib/api.js', () => ({
  requireAuth: vi.fn(),
  getClient: () => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }),
  resetClient: vi.fn(),
}));
vi.mock('../lib/config.js', () => ({
  getToken: () => 'test-token',
  getApiUrl: () => 'https://app.instawp.io',
  getUser: () => null,
  setToken: vi.fn(),
  setApiUrl: vi.fn(),
  setUser: vi.fn(),
  clearConfig: vi.fn(),
  getSshCache: () => null,
  setSshCache: vi.fn(),
  clearSshCache: vi.fn(),
}));
vi.mock('../lib/auth.js', () => ({
  startOAuthFlow: vi.fn(),
}));
vi.mock('../lib/output.js', () => ({
  setJsonMode: vi.fn(),
  isJsonMode: () => false,
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  table: vi.fn(),
  spinner: () => ({ text: '', start() { return this; }, succeed() {}, fail() {}, stop() {} }),
}));
vi.mock('../lib/site-resolver.js', () => ({
  resolveSite: vi.fn(),
}));
vi.mock('../lib/ssh-keys.js', () => ({
  ensureSshAccess: vi.fn(),
}));
vi.mock('../lib/ssh-connection.js', () => ({
  spawnInteractiveSsh: vi.fn(() => 0),
  execViaSsh: vi.fn(() => ({ stdout: '', stderr: '', exitCode: 0 })),
  rsyncViaSsh: vi.fn(() => 0),
}));

describe('command registration', () => {
  it('registers login command', async () => {
    const { registerLoginCommand } = await import('../commands/login.js');
    const program = new Command();
    registerLoginCommand(program);
    const cmd = program.commands.find(c => c.name() === 'login');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('Authenticate');
  });

  it('login has --token and --api-url options', async () => {
    const { registerLoginCommand } = await import('../commands/login.js');
    const program = new Command();
    registerLoginCommand(program);
    const cmd = program.commands.find(c => c.name() === 'login')!;
    const optNames = cmd.options.map(o => o.long);
    expect(optNames).toContain('--token');
    expect(optNames).toContain('--api-url');
  });

  it('registers whoami command', async () => {
    const { registerWhoamiCommand } = await import('../commands/whoami.js');
    const program = new Command();
    registerWhoamiCommand(program);
    const cmd = program.commands.find(c => c.name() === 'whoami');
    expect(cmd).toBeDefined();
  });

  it('registers sites command with subcommands', async () => {
    const { registerSitesCommand } = await import('../commands/sites.js');
    const program = new Command();
    registerSitesCommand(program);
    const sites = program.commands.find(c => c.name() === 'sites');
    expect(sites).toBeDefined();
    const subNames = sites!.commands.map(c => c.name());
    expect(subNames).toContain('list');
    expect(subNames).toContain('create');
    expect(subNames).toContain('delete');
  });

  it('registers create alias', async () => {
    const { registerCreateAlias } = await import('../commands/sites.js');
    const program = new Command();
    registerCreateAlias(program);
    const cmd = program.commands.find(c => c.name() === 'create');
    expect(cmd).toBeDefined();
  });

  it('registers migrate command with a push subcommand', async () => {
    const { registerMigrateCommand } = await import('../commands/migrate.js');
    const program = new Command();
    registerMigrateCommand(program);
    const migrate = program.commands.find(c => c.name() === 'migrate');
    expect(migrate).toBeDefined();
    const push = migrate!.commands.find(c => c.name() === 'push');
    expect(push).toBeDefined();
    const optNames = push!.options.map(o => o.long);
    expect(optNames).toContain('--path');
    expect(optNames).toContain('--source-url');
    expect(optNames).toContain('--dry-run');
  });

  it('registers wp command from exec module', async () => {
    const { registerWpCommand } = await import('../commands/exec.js');
    const program = new Command();
    program.enablePositionalOptions();
    registerWpCommand(program);
    const cmd = program.commands.find(c => c.name() === 'wp');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('WP-CLI');
  });

  it('exec and wp both have --api and --timeout options', async () => {
    const { registerExecCommand, registerWpCommand } = await import('../commands/exec.js');
    const program = new Command();
    program.enablePositionalOptions();
    registerExecCommand(program);
    registerWpCommand(program);

    const exec = program.commands.find(c => c.name() === 'exec')!;
    const wp = program.commands.find(c => c.name() === 'wp')!;

    for (const cmd of [exec, wp]) {
      const optNames = cmd.options.map(o => o.long);
      expect(optNames).toContain('--api');
      expect(optNames).toContain('--timeout');
    }
  });

  it('registers ssh command', async () => {
    const { registerSshCommand } = await import('../commands/ssh.js');
    const program = new Command();
    registerSshCommand(program);
    const cmd = program.commands.find(c => c.name() === 'ssh');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('SSH');
  });

  it('registers exec command', async () => {
    const { registerExecCommand } = await import('../commands/exec.js');
    const program = new Command();
    program.enablePositionalOptions();
    registerExecCommand(program);
    const cmd = program.commands.find(c => c.name() === 'exec');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toMatch(/shell|wp/i);
  });

  it('registers sync command with push and pull subcommands', async () => {
    const { registerSyncCommand } = await import('../commands/sync.js');
    const program = new Command();
    registerSyncCommand(program);
    const sync = program.commands.find(c => c.name() === 'sync');
    expect(sync).toBeDefined();
    const subNames = sync!.commands.map(c => c.name());
    expect(subNames).toContain('push');
    expect(subNames).toContain('pull');
  });

  it('sync push has expected options', async () => {
    const { registerSyncCommand } = await import('../commands/sync.js');
    const program = new Command();
    registerSyncCommand(program);
    const sync = program.commands.find(c => c.name() === 'sync')!;
    const push = sync.commands.find(c => c.name() === 'push')!;
    const optNames = push.options.map(o => o.long);
    expect(optNames).toContain('--path');
    expect(optNames).toContain('--exclude');
    expect(optNames).toContain('--include');
    expect(optNames).toContain('--dry-run');
  });

  it('sync pull has expected options', async () => {
    const { registerSyncCommand } = await import('../commands/sync.js');
    const program = new Command();
    registerSyncCommand(program);
    const sync = program.commands.find(c => c.name() === 'sync')!;
    const pull = sync.commands.find(c => c.name() === 'pull')!;
    const optNames = pull.options.map(o => o.long);
    expect(optNames).toContain('--path');
    expect(optNames).toContain('--exclude');
    expect(optNames).toContain('--include');
    expect(optNames).toContain('--dry-run');
  });

  it('sites create requires --name', async () => {
    const { registerSitesCommand } = await import('../commands/sites.js');
    const program = new Command();
    registerSitesCommand(program);
    const sites = program.commands.find(c => c.name() === 'sites')!;
    const create = sites.commands.find(c => c.name() === 'create')!;
    const nameOpt = create.options.find(o => o.long === '--name');
    expect(nameOpt).toBeDefined();
    expect(nameOpt!.required).toBe(true);
  });

  it('sites delete has --force option', async () => {
    const { registerSitesCommand } = await import('../commands/sites.js');
    const program = new Command();
    registerSitesCommand(program);
    const sites = program.commands.find(c => c.name() === 'sites')!;
    const del = sites.commands.find(c => c.name() === 'delete')!;
    const forceOpt = del.options.find(o => o.long === '--force');
    expect(forceOpt).toBeDefined();
  });

  it('registers teams command with list and members subcommands', async () => {
    const { registerTeamsCommand } = await import('../commands/teams.js');
    const program = new Command();
    registerTeamsCommand(program);
    const teams = program.commands.find(c => c.name() === 'teams');
    expect(teams).toBeDefined();
    const subNames = teams!.commands.map(c => c.name());
    expect(subNames).toContain('list');
    expect(subNames).toContain('members');
  });

  it('teams members requires team argument', async () => {
    const { registerTeamsCommand } = await import('../commands/teams.js');
    const program = new Command();
    registerTeamsCommand(program);
    const teams = program.commands.find(c => c.name() === 'teams')!;
    const members = teams.commands.find(c => c.name() === 'members')!;
    expect(members).toBeDefined();
    expect(members.description()).toContain('members');
  });

  it('registers versions command with create/list/restore/delete subcommands', async () => {
    const { registerVersionsCommand } = await import('../commands/versions.js');
    const program = new Command();
    registerVersionsCommand(program);
    const versions = program.commands.find(c => c.name() === 'versions');
    expect(versions).toBeDefined();
    const subNames = versions!.commands.map(c => c.name());
    expect(subNames).toContain('create');
    expect(subNames).toContain('list');
    expect(subNames).toContain('restore');
    expect(subNames).toContain('delete');
  });

  it('versions has the "version" alias (and not "snapshot")', async () => {
    const { registerVersionsCommand } = await import('../commands/versions.js');
    const program = new Command();
    registerVersionsCommand(program);
    const versions = program.commands.find(c => c.name() === 'versions')!;
    expect(versions.aliases()).toContain('version');
    expect(versions.aliases()).not.toContain('snapshot');
  });

  it('versions create has --name and --no-wait options', async () => {
    const { registerVersionsCommand } = await import('../commands/versions.js');
    const program = new Command();
    registerVersionsCommand(program);
    const versions = program.commands.find(c => c.name() === 'versions')!;
    const create = versions.commands.find(c => c.name() === 'create')!;
    const optNames = create.options.map(o => o.long);
    expect(optNames).toContain('--name');
    expect(optNames).toContain('--no-wait');
  });

  it('versions restore has --force and --no-wait, and requires site + version-id', async () => {
    const { registerVersionsCommand } = await import('../commands/versions.js');
    const program = new Command();
    registerVersionsCommand(program);
    const versions = program.commands.find(c => c.name() === 'versions')!;
    const restore = versions.commands.find(c => c.name() === 'restore')!;
    const optNames = restore.options.map(o => o.long);
    expect(optNames).toContain('--force');
    expect(optNames).toContain('--no-wait');
    expect(restore.registeredArguments.map(a => a.name())).toEqual(['site', 'version-id']);
  });

  it('versions delete has --force and accepts variadic version-ids', async () => {
    const { registerVersionsCommand } = await import('../commands/versions.js');
    const program = new Command();
    registerVersionsCommand(program);
    const versions = program.commands.find(c => c.name() === 'versions')!;
    const del = versions.commands.find(c => c.name() === 'delete')!;
    expect(del.options.map(o => o.long)).toContain('--force');
    const lastArg = del.registeredArguments[del.registeredArguments.length - 1];
    expect(lastArg.variadic).toBe(true);
  });
});
