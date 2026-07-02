import { Command } from 'commander';
import chalk from 'chalk';
import { requireAuth, getClient } from '../lib/api.js';
import { resolveSite } from '../lib/site-resolver.js';
import { error, info, spinner, isJsonMode } from '../lib/output.js';

type Outcome = 'purged' | 'cleared' | 'skipped' | 'failed';

/**
 * `instawp cache purge <site>` — purge the site's caches. Mirrors the dashboard's
 * "Purge Cache" action (the Bunny CDN edge purge via POST /sites/{id}/purge-cache);
 * `--object` additionally clears the server object cache (Redis, via
 * clear-object-cache). Both endpoints are plan-gated and 422 when the feature
 * isn't on the plan — that's reported as a "skipped" no-op, not a hard failure,
 * so purging a no-CDN site doesn't look like a crash.
 */
export function registerCacheCommand(program: Command): void {
  const cache = program
    .command('cache')
    .description('Purge site caches (CDN edge cache; --object also clears the object cache)');

  cache
    .command('purge <site>')
    .description('Purge the site CDN cache (add --object to also clear the WordPress object cache)')
    .option('--object', 'Also clear the server object cache (Redis) when the plan has it')
    .action(async (siteIdentifier: string, opts: any) => {
      requireAuth();
      const json = isJsonMode();

      const spin = spinner('Resolving site...');
      spin.start();
      let site;
      try {
        site = await resolveSite(siteIdentifier);
        spin.succeed(`Site: ${site.name || site.sub_domain} (ID: ${site.id})`);
      } catch {
        spin.fail('Site resolution failed');
        process.exit(1);
      }

      const client = getClient();
      const results: Record<string, Outcome> = {};
      let hardFail = false;

      // CDN edge cache purge — the canonical "Purge Cache" action.
      const cdnSpin = spinner('Purging CDN cache...');
      cdnSpin.start();
      try {
        await client.post(`/sites/${site.id}/purge-cache`);
        cdnSpin.succeed('CDN cache purged');
        results.cdn = 'purged';
      } catch (err: any) {
        const status = err.response?.status;
        if (status === 422) {
          // Feature not on plan — a no-op, not an error.
          cdnSpin.stop();
          info('CDN is not enabled on this site — nothing to purge at the edge.');
          results.cdn = 'skipped';
        } else {
          cdnSpin.fail('CDN cache purge failed');
          if (!json) error(err.response?.data?.message || err.message);
          results.cdn = 'failed';
          hardFail = true;
        }
      }

      // Optional: clear the server object cache (Redis).
      if (opts.object) {
        const objSpin = spinner('Clearing object cache...');
        objSpin.start();
        try {
          await client.post(`/sites/${site.id}/clear-object-cache`);
          objSpin.succeed('Object cache cleared');
          results.object = 'cleared';
        } catch (err: any) {
          const status = err.response?.status;
          if (status === 422) {
            objSpin.stop();
            info('Object cache is not enabled on this site — skipped.');
            results.object = 'skipped';
          } else {
            objSpin.fail('Object cache clear failed');
            if (!json) error(err.response?.data?.message || err.message);
            results.object = 'failed';
            hardFail = true;
          }
        }
      }

      if (json) {
        console.log(JSON.stringify({ success: !hardFail, data: { site_id: site.id, ...results } }));
      } else if (results.cdn === 'skipped' && results.object !== 'cleared') {
        // Nothing was purged at the edge — point them at the WordPress-level cache,
        // which works on any site regardless of plan.
        info(`For the WordPress object cache, run: ${chalk.cyan(`instawp wp ${siteIdentifier} cache flush`)}`);
      }

      if (hardFail) process.exit(1);
    });
}
