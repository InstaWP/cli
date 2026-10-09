import { Command } from 'commander';
import { createRequire } from 'node:module';
import { fetchLatestVersion, performUpgrade, compareVersions } from '../lib/update-notifier.js';
import { success, error, info, isJsonMode } from '../lib/output.js';

const require = createRequire(import.meta.url);

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .alias('update')
    .description('Update the InstaWP CLI to the latest version')
    .option('--check', 'Only check for an update; do not install')
    .action(async (opts: { check?: boolean }) => {
      const current: string = require('../../package.json').version;
      const json = isJsonMode();

      const latest = await fetchLatestVersion();
      if (!latest) {
        error('Could not reach npm to check for updates.');
        process.exit(1);
      }

      const upToDate = compareVersions(latest, current) <= 0;
      if (upToDate) {
        if (json) console.log(JSON.stringify({ success: true, data: { current, latest, up_to_date: true } }));
        else success(`Already up to date (${current}).`);
        return;
      }

      if (opts.check) {
        if (json) console.log(JSON.stringify({ success: true, data: { current, latest, up_to_date: false } }));
        else info(`Update available: ${current} → ${latest}. Run \`instawp upgrade\` to install.`);
        return;
      }

      if (!json) info(`Updating ${current} → ${latest}…`);
      const code = performUpgrade();
      if (code !== 0) {
        error('Upgrade failed. If this is a permissions error, try: sudo npm install -g @instawp/cli@latest');
        process.exit(code);
      }
      if (json) console.log(JSON.stringify({ success: true, data: { current, latest, upgraded: true } }));
      else success(`Updated to ${latest}.`);
    });
}
