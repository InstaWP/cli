import { Command } from 'commander';
import { statSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { requireAuth } from '../lib/api.js';
import { resolveSite } from '../lib/site-resolver.js';
import { ensureSshAccess } from '../lib/ssh-keys.js';
import { remoteDocRoot } from '../lib/paths.js';
import { execViaSsh, scpUpload, syncFiles } from '../lib/ssh-connection.js';
import { success, error, spinner, info, isJsonMode } from '../lib/output.js';

/** Plugin slug from a path: my-plugin.zip / my-plugin/ → my-plugin. */
function pluginSlug(p: string): string {
  return basename(p.replace(/[\\/]+$/, '')).replace(/\.zip$/i, '');
}

export function registerPluginCommand(program: Command): void {
  const plugin = program
    .command('plugin')
    .description('Manage plugins on a remote site');

  // plugin install <site> <zip|dir>
  plugin
    .command('install <site> <path>')
    .description('Install a plugin from a local .zip or directory (no base64-over-exec needed)')
    .option('--activate', 'Activate the plugin after install')
    .action(async (siteIdentifier: string, path: string, opts: { activate?: boolean }) => {
      requireAuth();

      if (!existsSync(path)) {
        error(`Path not found: ${path}`);
        process.exit(1);
      }
      const isDir = statSync(path).isDirectory();
      const isZip = !isDir && /\.zip$/i.test(path);
      if (!isDir && !isZip) {
        error('Path must be a .zip file or a directory.');
        process.exit(1);
      }
      const slug = pluginSlug(path);
      // slug is interpolated into remote shell commands and a remote path — keep
      // it to safe plugin-slug characters (rejects spaces, quotes, `;`, `/`, etc.).
      if (!/^[A-Za-z0-9._-]+$/.test(slug)) {
        error(`Unsafe plugin name "${slug}" (from ${path}). Rename it to use only letters, numbers, '.', '_', '-'.`);
        process.exit(1);
      }

      const rspin = spinner('Resolving site...');
      rspin.start();
      let site;
      try {
        site = await resolveSite(siteIdentifier);
        rspin.succeed(`Site: ${site.name || site.sub_domain} (ID: ${site.id})`);
      } catch {
        rspin.fail('Site resolution failed');
        process.exit(1);
      }

      const conn = await ensureSshAccess(site.id);
      const wpPath = remoteDocRoot(conn);

      if (isZip) {
        // Upload the zip and let WP-CLI install it (handles overwrite + activation).
        const remoteZip = `/tmp/iwp-plugin-${randomBytes(6).toString('hex')}.zip`;
        const upSpin = spinner(`Uploading ${basename(path)}...`);
        upSpin.start();
        const scpExit = scpUpload(conn, path, remoteZip);
        if (scpExit !== 0) {
          upSpin.fail(`Upload failed (scp exit ${scpExit})`);
          process.exit(1);
        }
        upSpin.succeed('Upload complete');

        const inSpin = spinner(`Installing ${slug}...`);
        inSpin.start();
        const flags = `--force${opts.activate ? ' --activate' : ''}`;
        const res = execViaSsh(conn, `cd ${wpPath} && wp plugin install ${remoteZip} ${flags}`);
        execViaSsh(conn, `rm -f ${remoteZip}`);
        if (res.exitCode !== 0) {
          inSpin.fail('Install failed');
          if (res.stderr) error(res.stderr.trim());
          else if (res.stdout) error(res.stdout.trim());
          process.exit(1);
        }
        inSpin.succeed(`Plugin ${slug} installed${opts.activate ? ' + activated' : ''}`);
      } else {
        // Directory: rsync straight into wp-content/plugins/<slug>, then activate.
        const remoteDir = `${wpPath}/wp-content/plugins/${slug}/`;
        const localDir = path.replace(/[\\/]*$/, '') + '/';
        const target = `${conn.username}@${conn.host}:${remoteDir}`;
        const upSpin = spinner(`Syncing ${slug} to wp-content/plugins/...`);
        upSpin.start();
        const code = await syncFiles(conn, localDir, target, ['--exclude=.git', '--exclude=node_modules'], false, false);
        if (code !== 0) {
          upSpin.fail(`Sync failed (exit ${code})`);
          process.exit(1);
        }
        upSpin.succeed('Files synced');

        if (opts.activate) {
          const actSpin = spinner(`Activating ${slug}...`);
          actSpin.start();
          const res = execViaSsh(conn, `cd ${wpPath} && wp plugin activate ${slug}`);
          if (res.exitCode !== 0) {
            actSpin.fail('Activation failed');
            if (res.stderr) error(res.stderr.trim());
            else if (res.stdout) error(res.stdout.trim());
            process.exit(1);
          }
          actSpin.succeed(`Plugin ${slug} activated`);
        }
      }

      if (isJsonMode()) {
        console.log(JSON.stringify({ success: true, data: { site_id: site.id, plugin: slug, activated: !!opts.activate } }));
      } else {
        success(`Done: ${slug} on ${site.name || site.sub_domain}`);
      }
    });
}
