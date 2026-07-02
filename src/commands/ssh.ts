import { Command } from 'commander';
import { requireAuth } from '../lib/api.js';
import { resolveSite } from '../lib/site-resolver.js';
import { ensureSshAccess } from '../lib/ssh-keys.js';
import { spawnInteractiveSsh } from '../lib/ssh-connection.js';
import { error, spinner, isJsonMode } from '../lib/output.js';

export function registerSshCommand(program: Command): void {
  program
    .command('ssh <site>')
    .description('Open an interactive SSH shell on a site')
    .option('--ssh-host <host>', 'Override the SSH host (CDN-fronted sites; also via INSTAWP_SSH_HOST)')
    .option('--refresh', 'Re-resolve SSH access, ignoring the cached host')
    .action(async (siteIdentifier: string, opts: any) => {
      requireAuth();

      const spin = spinner('Resolving site...');
      spin.start();

      let site;
      try {
        site = await resolveSite(siteIdentifier);
        spin.succeed(`Site: ${site.name || site.sub_domain} (ID: ${site.id})`);
      } catch (err: any) {
        spin.fail('Site resolution failed');
        process.exit(1);
      }

      const conn = await ensureSshAccess(site.id, { sshHost: opts.sshHost, refresh: opts.refresh });

      if (isJsonMode()) {
        console.log(JSON.stringify({
          success: true,
          data: {
            host: conn.host,
            username: conn.username,
            port: conn.port,
            private_key: conn.privateKeyPath,
            command: `ssh -i ${conn.privateKeyPath} -p ${conn.port} ${conn.username}@${conn.host}`,
          },
        }));
        return;
      }

      const exitCode = spawnInteractiveSsh(conn);
      process.exit(exitCode);
    });
}
