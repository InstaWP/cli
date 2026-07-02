#!/usr/bin/env node

import { createRequire } from 'node:module';
import { Command } from 'commander';
import chalk from 'chalk';
import { setJsonMode } from './lib/output.js';
import { registerLoginCommand } from './commands/login.js';
import { registerWhoamiCommand } from './commands/whoami.js';
import { registerSitesCommand, registerCreateAlias } from './commands/sites.js';
import { registerVersionsCommand } from './commands/versions.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerSshCommand } from './commands/ssh.js';
import { registerExecCommand, registerWpCommand, registerSqlCommand } from './commands/exec.js';
import { registerPluginCommand } from './commands/plugin.js';
import { registerTeamsCommand } from './commands/teams.js';
import { registerLocalCommand } from './commands/local.js';
import { registerMigrateCommand } from './commands/migrate.js';
import { registerDbCommand } from './commands/db.js';
import { registerCacheCommand } from './commands/cache.js';
import { registerOpenCommand } from './commands/open.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerUpgradeCommand } from './commands/upgrade.js';
import { maybeNotifyUpdate } from './lib/update-notifier.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

// Early --json detection so it works in any argv position
if (process.argv.includes('--json')) {
  setJsonMode(true);
  // Remove --json from argv so Commander doesn't choke on it as unknown option
  process.argv = process.argv.filter(a => a !== '--json');
}

const program = new Command();

program
  .name('instawp')
  .description('InstaWP CLI - Create and manage WordPress sites from the terminal')
  .version(version)
  .enablePositionalOptions()
  .option('--json', 'Output results as JSON');

// -- Auth --
registerLoginCommand(program);
registerWhoamiCommand(program);

// -- Sites --
registerSitesCommand(program);
registerCreateAlias(program);
registerVersionsCommand(program);

// -- Remote access --
registerWpCommand(program);
registerExecCommand(program);
registerSqlCommand(program);
registerSshCommand(program);
registerSyncCommand(program);
registerDbCommand(program);
registerCacheCommand(program);
registerPluginCommand(program);
registerLogsCommand(program);
registerOpenCommand(program);

// -- Teams --
registerTeamsCommand(program);

// -- Local dev --
registerLocalCommand(program);

// -- Migration (local WP dir → new hosted site) --
registerMigrateCommand(program);

// -- Self-update --
registerUpgradeCommand(program);

// -- Changelog --
program
  .command('changelog')
  .description('Show recent changes')
  .action(() => {
    const changelogPath = new URL('../CHANGELOG.md', import.meta.url);
    try {
      const fs = require('fs');
      const content = fs.readFileSync(changelogPath, 'utf-8');
      // Show only the latest version
      const sections = content.split(/\n## /);
      const latest = sections[1] ? `## ${sections[1]}` : content;
      console.log(latest.trim());
    } catch {
      console.log(`Changelog: https://github.com/InstaWP/cli/blob/main/CHANGELOG.md`);
    }
  });

// Custom help layout
program.configureHelp({
  sortSubcommands: false,
  subcommandTerm: (cmd) => cmd.name() + ' ' + cmd.usage(),
});

program.addHelpText('after', () => {
  const d = chalk.dim;
  const c = chalk.cyan;
  return `
${d('Auth')}
  ${c('login')}              Authenticate with InstaWP (browser or --token)
  ${c('whoami')}             Show current session info

${d('Sites')}
  ${c('create')}             Create a new WordPress site
  ${c('sites list')}         List all sites
  ${c('sites creds')}        Show WP admin credentials + Magic Login URL
  ${c('sites php')}          View or update PHP version/settings
  ${c('sites delete')}       Delete a site
  ${c('open')}   ${d('<site>')}         Open site (or --admin / --magic) in browser

${d('Versions')} ${d('(restorable point-in-time site copies)')}
  ${c('versions create')}    Create a version before risky changes
  ${c('versions list')}      List a site's versions
  ${c('versions restore')}   Roll a site back to a version
  ${c('versions delete')}    Delete versions

${d('Remote Access')}
  ${c('wp')}     ${d('<site>')} ${d('<args>')} WP-CLI on a remote site (primary)
  ${c('ssh')}    ${d('<site>')}         Interactive SSH session
  ${c('sync')}   ${d('push|pull')}      Sync wp-content via rsync
  ${c('db')}     ${d('push|pull')}      Push/pull MySQL database (auto-backup)
  ${c('cache purge')} ${d('<site>')}      Purge the site CDN cache (--object: object cache too)
  ${c('logs')}   ${d('<site>')}         Tail WP / PHP / nginx logs
  ${c('exec')}   ${d('<site>')} ${d('<cmd>')}  Run arbitrary shell (escape hatch for non-WP)
  ${c('sql')}    ${d('<site>')} ${d('<query>')} Run SQL via WP-CLI (hits MySQL, cache-immune)
  ${c('plugin install')}     Install a plugin from a local .zip or directory

${d('Local Development')}
  ${c('local create')}       Create and start a local WordPress site
  ${c('local clone')}        Clone an InstaWP cloud site to local
  ${c('local start')}        Start an existing local site
  ${c('local stop')}         Stop a background local site
  ${c('local push')}         Push local wp-content to InstaWP cloud
  ${c('local pull')}         Pull cloud wp-content to local site
  ${c('local list')}         List local sites
  ${c('local delete')}       Delete a local site

${d('Migration')}
  ${c('migrate push')}  ${d('[path]')}   Mirror a local WP install to a new hosted InstaWP site

${d('Teams')}
  ${c('teams list')}         List teams
  ${c('teams switch')}       Switch active team
  ${c('teams members')}      List team members

${d('Updating')}
  ${c('upgrade')}            Update the CLI to the latest version
  ${d('(checks once/day and shows a hint; INSTAWP_NO_UPDATE_NOTIFIER=1 to silence)')}

${d('Examples')}
  $ instawp login
  $ instawp create --name my-site
  $ instawp local create --name blog
  $ instawp wp my-site plugin list
  $ instawp wp my-site -- post list --post_type=page
  $ instawp versions create my-site --name "before plugin update"
  $ instawp versions restore my-site 1234
  $ instawp open my-site --admin
  $ instawp db pull my-site
  $ instawp logs my-site --follow
  $ instawp sites creds my-site
`;
});

// Override default help to only show options (commands are in custom section)
program.configureHelp({
  sortSubcommands: false,
  formatHelp: (cmd, helper) => {
    const title = helper.padWidth(cmd, helper);
    const desc = cmd.description();
    const ver = cmd.version() ? `v${cmd.version()}` : '';

    let output = '';
    output += `${desc}${ver ? '  ' + chalk.dim(ver) : ''}\n\n`;
    output += `${chalk.dim('Usage:')} ${cmd.name()} [options] [command]\n`;

    const opts = helper.visibleOptions(cmd);
    if (opts.length) {
      output += `\n${chalk.dim('Options')}\n`;
      for (const opt of opts) {
        const flags = opt.flags;
        const desc = opt.description;
        output += `  ${flags.padEnd(30)} ${desc}\n`;
      }
    }

    return output;
  },
});

// Once-a-day update check (stderr banner; suppressed in --json/CI/non-TTY).
// Skip for `upgrade`/`update` (it checks itself) and version/help.
const firstArg = process.argv[2];
const skipNotify = !firstArg || ['upgrade', 'update'].includes(firstArg)
  || ['-V', '--version', '-h', '--help'].includes(firstArg);

if (skipNotify) {
  program.parse();
} else {
  maybeNotifyUpdate(version).finally(() => program.parse());
}
