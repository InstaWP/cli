import { Command } from 'commander';
import chalk from 'chalk';
import { requireAuth, getClient } from '../lib/api.js';
import { getApiUrl } from '../lib/config.js';
import { resolveSite } from '../lib/site-resolver.js';
import { waitForHttp } from '../lib/http-ready.js';
import { success, error, table, spinner, info, isJsonMode } from '../lib/output.js';
import { enableMcp, printMcpConnection, isValidPluginSlug, type McpConnection } from './mcp.js';

export function registerSitesCommand(program: Command): void {
  const sites = program
    .command('sites')
    .description('Manage WordPress sites');

  // sites list
  sites
    .command('list')
    .description('List all sites')
    .option('--status <status>', 'Filter by status')
    .option('--page <page>', 'Page number', '1')
    .option('--per-page <count>', 'Results per page', '50')
    .option('--all', 'Fetch all pages')
    .action(async (opts) => {
      requireAuth();
      const spin = spinner('Fetching sites...');
      spin.start();

      try {
        const client = getClient();
        let allSites: any[] = [];
        let page = parseInt(opts.page);
        const perPage = parseInt(opts.perPage);
        let lastPage = 1;
        let total = 0;

        // Fetch first page
        const params: Record<string, any> = { page, per_page: perPage };
        if (opts.status) params.status = opts.status;

        const res = await client.get('/sites', { params });
        allSites = res.data?.data || [];
        const meta = res.data?.meta || {};
        lastPage = meta.last_page || 1;
        total = meta.total || allSites.length;

        // If --all, fetch remaining pages
        if (opts.all && lastPage > page) {
          for (let p = page + 1; p <= lastPage; p++) {
            const r = await client.get('/sites', { params: { ...params, page: p } });
            allSites = allSites.concat(r.data?.data || []);
          }
        }

        spin.stop();

        if (allSites.length === 0) {
          if (isJsonMode()) {
            console.log(JSON.stringify([]));
          } else {
            info('No sites found.');
          }
          return;
        }

        const rows = allSites.map((s: any) => ({
          id: s.id,
          name: s.name || '',
          domain: s.domain?.name || s.sub_domain || '',
          url: s.url || '',
          status: s.status === 0 ? 'Active' : s.is_expired ? 'Expired' : s.status || 'Unknown',
          wp_version: s.wp_version || '',
          php_version: s.php_version || '',
          created_at: s.created_at || '',
        }));

        table(['ID', 'Name', 'URL', 'Status', 'WP Version', 'PHP Version'], rows);

        // Show pagination hint if there are more pages and not fetching all
        if (!opts.all && !isJsonMode() && lastPage > page) {
          info(`Showing ${allSites.length} of ${total} sites (page ${page}/${lastPage}). Use --all to fetch all.`);
        }
      } catch (err: any) {
        spin.fail('Failed to fetch sites');
        error('Could not list sites', err.response?.data?.message || err.message);
        process.exit(1);
      }
    });

  // sites create
  sites
    .command('create')
    .description('Create a new WordPress site')
    .requiredOption('--name <name>', 'Site name')
    .option('--wp <version>', 'WordPress version (e.g., 6.8)')
    .option('--php <version>', 'PHP version (e.g., 8.2)')
    .option('--config <id>', 'Configuration ID')
    .option('--temporary', 'Create as temporary site (default: permanent)')
    .option('--mcp', 'Make the site MCP-ready (install + configure InstaMCP) after creation')
    .option('--plugins <list>', 'Comma-separated wordpress.org plugin slugs to install (with --mcp)')
    .option('--no-wait', 'Do not wait for site to become active')
    .action(createSiteAction);

  // sites delete
  sites
    .command('delete <site>')
    .description('Delete a site (by ID, name, or domain)')
    .option('--force', 'Skip confirmation')
    .action(async (siteIdentifier, opts) => {
      requireAuth();

      const spin = spinner('Resolving site...');
      spin.start();

      let site;
      try {
        site = await resolveSite(siteIdentifier);
        spin.stop();
      } catch {
        spin.fail('Site resolution failed');
        process.exit(1);
      }

      const label = site.name || site.sub_domain || String(site.id);

      if (!opts.force) {
        if (isJsonMode()) {
          error('Use --force flag to delete in JSON mode');
          process.exit(1);
        }

        // Interactive confirmation
        const readline = await import('node:readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`Are you sure you want to delete site "${label}" (ID: ${site.id})? (y/N) `, resolve);
        });
        rl.close();

        if (answer.toLowerCase() !== 'y') {
          info('Cancelled.');
          return;
        }
      }

      const spin2 = spinner(`Deleting site ${label}...`);
      spin2.start();

      try {
        const client = getClient();
        await client.delete(`/sites/${site.id}`);
        spin2.stop();
        success(`Site "${label}" (ID: ${site.id}) has been deleted`);
      } catch (err: any) {
        spin2.fail('Failed to delete site');
        error('Could not delete site', err.response?.data?.message || err.message);
        process.exit(1);
      }
    });

  // sites update <site>
  sites
    .command('update <site>')
    .description('Update site label, description, or expiration')
    .option('--label <label>', 'Site label (max 30 chars)')
    .option('--description <desc>', 'Site description (max 255 chars)')
    .option('--expires <date>', 'Expiration date (YYYY-MM-DD or "never")')
    .action(async (siteIdentifier: string, opts) => {
      requireAuth();

      if (!opts.label && !opts.description && !opts.expires) {
        error('Provide at least one option: --label, --description, or --expires');
        process.exit(1);
      }

      const spin = spinner('Resolving site...');
      spin.start();

      let site;
      try {
        site = await resolveSite(siteIdentifier);
        spin.stop();
      } catch {
        spin.fail('Site resolution failed');
        process.exit(1);
      }

      const payload: Record<string, any> = {};
      if (opts.label) payload.label = opts.label;
      if (opts.description) payload.description = opts.description;
      if (opts.expires) {
        payload.expired_at = opts.expires === 'never' ? null : `${opts.expires} 23:59:59`;
      }

      const updateSpin = spinner('Updating site...');
      updateSpin.start();

      try {
        const client = getClient();
        await client.patch(`/sites/${site.id}`, payload);
        updateSpin.succeed('Site updated');

        if (isJsonMode()) {
          console.log(JSON.stringify({ success: true, site_id: site.id, changes: payload }));
        } else {
          if (opts.label) info(`Label → ${opts.label}`);
          if (opts.description) info(`Description → ${opts.description}`);
          if (opts.expires) info(`Expires → ${opts.expires === 'never' ? 'never' : opts.expires}`);
        }
      } catch (err: any) {
        updateSpin.fail('Failed to update site');
        error(err.response?.data?.message || err.message);
        process.exit(1);
      }
    });

  // sites creds <site>
  sites
    .command('creds <site>')
    .description('Show WP admin username, password, and Magic Login URL for a site')
    .action(async (siteIdentifier: string) => {
      requireAuth();

      const spin = spinner('Resolving site...');
      spin.start();

      let site;
      try {
        site = await resolveSite(siteIdentifier);
        spin.stop();
      } catch {
        spin.fail('Site resolution failed');
        process.exit(1);
      }

      const client = getClient();
      try {
        const res = await client.get(`/sites/${site.id}/details`);
        const data = res.data?.data;
        const siteInfo = data?.site || data;
        let creds = siteInfo?.site_meta || data?.site_meta || {};

        // Fallback: list endpoint exposes credentials some details responses omit
        if (!creds.wp_username) {
          try {
            const listRes = await client.get('/sites', { params: { per_page: 50 } });
            const match = (listRes.data?.data || []).find((s: any) => s.id === site.id);
            if (match?.site_meta?.wp_username) creds = match.site_meta;
          } catch { /* ignore */ }
        }

        const siteUrl = siteInfo?.url || '';
        const adminUrl = siteUrl ? `${siteUrl}/wp-admin` : '';
        const magicUrl = creds.wp_magic_login_url
          || (siteInfo?.hash ? `${getApiUrl()}/wordpress-auto-login?site=${siteInfo.hash}` : '');

        if (isJsonMode()) {
          console.log(JSON.stringify({
            success: true,
            data: {
              site_id: site.id,
              url: siteUrl,
              wp_username: creds.wp_username || '',
              wp_password: creds.wp_password || '',
              wp_admin_url: adminUrl,
              magic_login_url: magicUrl,
            },
          }));
          return;
        }

        if (!creds.wp_username && !magicUrl) {
          error('No credentials available for this site');
          info('The site may still be provisioning. Try again in a moment.');
          process.exit(1);
        }

        success(`${site.name || site.sub_domain} (ID: ${site.id})`);
        if (siteUrl) console.log(`\n  ${chalk.dim('Site URL:')}    ${chalk.cyan.underline(siteUrl)}`);
        if (creds.wp_username) {
          console.log(`  ${chalk.dim('Username:')}    ${creds.wp_username}`);
          console.log(`  ${chalk.dim('Password:')}    ${creds.wp_password}`);
        }
        if (adminUrl) console.log(`  ${chalk.dim('WP Admin:')}    ${chalk.cyan.underline(adminUrl)}`);
        if (magicUrl) console.log(`  ${chalk.dim('Magic Login:')} ${chalk.cyan.underline(magicUrl)}`);
      } catch (err: any) {
        error('Could not fetch site credentials', err.response?.data?.message || err.message);
        process.exit(1);
      }
    });

  // sites php <site>
  sites
    .command('php <site>')
    .description('View or update PHP settings for a site')
    .option('--version <version>', 'Change PHP version (7.4, 8.0, 8.1, 8.2, 8.3)')
    .option('--memory-limit <mb>', 'memory_limit in MB (64-1024)')
    .option('--max-execution-time <sec>', 'max_execution_time in seconds (30-300)')
    .option('--upload-max-filesize <mb>', 'upload_max_filesize in MB (64-512)')
    .option('--post-max-size <mb>', 'post_max_size in MB (64-512)')
    .option('--max-input-vars <n>', 'max_input_vars (1000-10000)')
    .option('--max-input-time <sec>', 'max_input_time in seconds (60-120)')
    .action(async (siteIdentifier: string, opts) => {
      requireAuth();

      const spin = spinner('Resolving site...');
      spin.start();

      let site;
      try {
        site = await resolveSite(siteIdentifier);
        spin.stop();
      } catch {
        spin.fail('Site resolution failed');
        process.exit(1);
      }

      const hasChanges = opts.version || opts.memoryLimit || opts.maxExecutionTime ||
        opts.uploadMaxFilesize || opts.postMaxSize || opts.maxInputVars || opts.maxInputTime;

      if (!hasChanges) {
        // Show current PHP settings
        const client = getClient();
        try {
          const res = await client.get(`/sites/${site.id}/details`);
          const data = res.data?.data;
          const siteData = data?.site || data;

          if (isJsonMode()) {
            console.log(JSON.stringify({
              php_version: siteData.php_version,
              php_config: siteData.php_config_json || {},
            }));
            return;
          }

          success(`${site.name || site.sub_domain} (ID: ${site.id})`);
          console.log(`\n  ${chalk.dim('PHP Version:')} ${siteData.php_version || 'unknown'}`);

          const config = siteData.php_config_json;
          if (config && typeof config === 'object' && Object.keys(config).length > 0) {
            console.log(`\n  ${chalk.dim('PHP Settings:')}`);
            for (const [key, val] of Object.entries(config)) {
              console.log(`    ${key}: ${val}`);
            }
          }
        } catch (err: any) {
          error('Could not fetch site details', err.response?.data?.message || err.message);
          process.exit(1);
        }
        return;
      }

      // Apply changes
      const payload: Record<string, any> = { php: {} };

      if (opts.version) {
        payload.php.version = opts.version;
      }

      const configurations: Record<string, number> = {};
      if (opts.memoryLimit) configurations.memory_limit = parseInt(opts.memoryLimit);
      if (opts.maxExecutionTime) configurations.max_execution_time = parseInt(opts.maxExecutionTime);
      if (opts.uploadMaxFilesize) configurations.upload_max_filesize = parseInt(opts.uploadMaxFilesize);
      if (opts.postMaxSize) configurations.post_max_size = parseInt(opts.postMaxSize);
      if (opts.maxInputVars) configurations.max_input_vars = parseInt(opts.maxInputVars);
      if (opts.maxInputTime) configurations.max_input_time = parseInt(opts.maxInputTime);

      if (Object.keys(configurations).length > 0) {
        payload.php.configurations = configurations;
      }

      const updateSpin = spinner('Updating PHP settings...');
      updateSpin.start();

      try {
        const client = getClient();
        await client.patch(`/sites/${site.id}`, payload);
        updateSpin.succeed('PHP settings update initiated');

        if (isJsonMode()) {
          console.log(JSON.stringify({ success: true, site_id: site.id, changes: payload.php }));
        } else {
          if (opts.version) info(`PHP version → ${opts.version}`);
          for (const [key, val] of Object.entries(configurations)) {
            info(`${key} → ${val}`);
          }
          info('Changes are being applied. This may take a moment.');
        }
      } catch (err: any) {
        updateSpin.fail('Failed to update PHP settings');
        error(err.response?.data?.message || err.message);
        process.exit(1);
      }
    });
}


// Shared create action used by both `sites create` and top-level `create`
async function createSiteAction(opts: any): Promise<void> {
  requireAuth();

  const json = isJsonMode();
  const startTime = Date.now();
  const elapsed = () => ((Date.now() - startTime) / 1000).toFixed(1);

  // --mcp needs the site provisioned + reachable over SSH, so it forces a wait.
  const mcpPlugins: string[] = opts.plugins
    ? String(opts.plugins).split(',').map((s: string) => s.trim()).filter(Boolean)
    : [];
  // Validate slugs up front so a typo fails before we spend time creating a site.
  const badSlug = mcpPlugins.find((s) => !isValidPluginSlug(s));
  if (badSlug) {
    error(`Unsafe plugin slug "${badSlug}"`, 'Use lowercase letters, numbers, and hyphens only.');
    process.exit(1);
  }
  if (opts.plugins && !opts.mcp && !json) {
    info('--plugins has no effect without --mcp.');
  }
  if (opts.mcp && !opts.wait) {
    if (!json) info('--mcp requires the site to be ready; ignoring --no-wait.');
    opts.wait = true;
  }

  // Step indicator helpers for human mode
  const step = (msg: string) => { if (!json) console.log(chalk.green('\u2713') + ' ' + msg); };
  const heading = (msg: string) => { if (!json) console.log('\n' + chalk.dim('#') + ' ' + msg); };

  const spin = spinner('Submitting site request...');
  spin.start();

  try {
    const client = getClient();
    const payload: Record<string, any> = {
      site_name: opts.name,
      is_reserved: !opts.temporary,
    };
    if (opts.wp) payload.wp_version = opts.wp;
    if (opts.php) payload.php_version = opts.php;
    if (opts.config) payload.configuration_id = parseInt(opts.config);

    const res = await client.post('/sites', payload);
    const site = res.data?.data;

    if (!site?.id) {
      spin.fail('Site creation failed');
      error('Unexpected response from API', res.data);
      process.exit(1);
    }

    spin.stop();

    // If --no-wait or JSON mode without wait, return immediately
    if (!opts.wait) {
      if (json) {
        console.log(JSON.stringify({ success: true, data: { id: site.id, status: 'provisioning' } }));
      } else {
        success('Site creation initiated', {
          id: site.id,
          status: site.status || 'provisioning',
        });
        info('Use --wait to wait for provisioning (default). Pass --no-wait to skip.');
      }
      return;
    }

    // Progressive provisioning output
    heading(`Provisioning WordPress...`);

    const maxWait = 5 * 60 * 1000; // 5 minutes
    const pollInterval = 3000; // 3 seconds
    const taskId = site.task_id;
    // Fetch site details once for php_version (available immediately at creation)
    let phpVersion = opts.php || '8.x';
    try {
      const initDetail = await client.get(`/sites/${site.id}/details`);
      phpVersion = initDetail.data?.data?.php_version || phpVersion;
    } catch { /* use fallback */ }
    const provSpin = spinner('Setting up server environment...');
    provSpin.start();

    // Track which steps we've shown based on task percentage:
    //   ~38% = server environment ready (PHP configured)
    //   ~66% = domain/SSL setup done
    //   ~79% = WordPress being installed
    //   100% = completed
    const shown = { php: false, ssl: false, wp: false };

    // Helper to update spinner with percentage
    const spinText = (label: string, pct: number) =>
      pct > 0 ? `${label} ${chalk.dim(`(${Math.round(pct)}%)`)}` : label;

    while (Date.now() - startTime < maxWait) {
      try {
        // Poll task status for real provisioning progress
        let pct = 0;
        let taskDone = false;
        if (taskId) {
          try {
            const taskRes = await client.get(`/tasks/${taskId}/status`);
            const task = taskRes.data?.data;
            pct = parseFloat(task?.percentage_complete) || 0;
            taskDone = task?.status === 'completed';
            if (task?.status === 'error') {
              provSpin.fail('Provisioning failed');
              error('Site provisioning failed', task?.comment || 'Unknown error');
              process.exit(1);
            }
          } catch { /* task endpoint may not be available, fall through */ }
        }

        // Update spinner with current percentage
        if (!shown.php) {
          provSpin.text = spinText('Setting up server environment...', pct);
        } else if (!shown.ssl) {
          provSpin.text = spinText('Issuing SSL certificate...', pct);
        } else if (!shown.wp) {
          provSpin.text = spinText('Installing WordPress...', pct);
        }

        // Show progressive steps based on actual task percentage
        if (!shown.php && pct >= 38) {
          provSpin.text = 'Setting up server environment...';
          provSpin.stop();
          step(`PHP ${phpVersion} configured`);
          shown.php = true;
          provSpin.start();
        }

        if (!shown.ssl && pct >= 66) {
          if (!shown.php) {
            provSpin.text = 'Setting up server environment...';
            provSpin.stop();
            step(`PHP ${phpVersion} configured`);
            shown.php = true;
          }
          provSpin.text = 'Issuing SSL certificate...';
          provSpin.stop();
          step('SSL certificate issued');
          shown.ssl = true;
          provSpin.start();
        }

        if (taskDone || pct >= 100) {
          if (!shown.php) { provSpin.stop(); step(`PHP ${phpVersion} configured`); shown.php = true; provSpin.start(); }
          if (!shown.ssl) { provSpin.stop(); step('SSL certificate issued'); shown.ssl = true; provSpin.start(); }
          provSpin.stop();
          step('WordPress installed');

          // Fetch final site details for the output
          const detailRes = await client.get(`/sites/${site.id}/details`);
          const siteData = detailRes.data?.data;
          const siteInfo = siteData?.site || siteData;
          const meta = siteInfo?.site_meta || siteData?.site_meta || {};

          const siteUrl = siteInfo?.url || site.wp_url || '';
          const domain = siteInfo?.main_domain || siteInfo?.sub_domain
            || siteInfo?.domain?.name || siteInfo?.domain
            || siteData?.domain?.name || siteData?.domain || '';
          const wpVersion = siteInfo?.wp_version || '';

          // Block until the site actually answers HTTP (DNS/edge lags the task).
          let httpReady = false;
          if (siteUrl) {
            provSpin.start();
            provSpin.text = 'Waiting for the site to respond...';
            httpReady = await waitForHttp(siteUrl, maxWait - (Date.now() - startTime));
            provSpin.stop();
            if (httpReady) step('Site responding');
            else if (!json) info('Provisioned, but not answering over HTTP yet (DNS may still be propagating).');
          }

          // Optionally make the site MCP-ready (install/configure InstaMCP).
          let mcpConn: McpConnection | null = null;
          if (opts.mcp) {
            try {
              mcpConn = await enableMcp(
                { id: site.id, url: siteUrl, sub_domain: domain, name: opts.name },
                { extraPlugins: mcpPlugins },
              );
            } catch (e: any) {
              error('MCP enable failed', e?.message || String(e));
              process.exit(1);
            }
          }

          if (json) {
            // If credentials not yet in details, try list endpoint
            let creds = meta;
            if (!creds.wp_username) {
              try {
                const listRes = await client.get('/sites', { params: { per_page: 50 } });
                const match = (listRes.data?.data || []).find((s: any) => s.id === site.id);
                if (match?.site_meta?.wp_username) creds = match.site_meta;
              } catch { /* ignore */ }
            }
            console.log(JSON.stringify({
              success: true,
              data: {
                id: site.id,
                url: siteUrl,
                domain,
                wp_version: wpVersion,
                php_version: siteInfo?.php_version || '',
                wp_username: creds.wp_username || '',
                wp_password: creds.wp_password || '',
                wp_admin_url: siteUrl ? `${siteUrl}/wp-admin` : '',
                magic_login_url: creds.wp_magic_login_url || (siteInfo?.hash ? `${getApiUrl()}/wordpress-auto-login?site=${siteInfo.hash}` : ''),
                status: 'Active',
                http_ready: httpReady,
                elapsed: elapsed() + 's',
                ...(mcpConn ? { mcp: mcpConn } : {}),
              },
            }));
          } else {
            // Fetch credentials for human output too
            let creds = meta;
            if (!creds.wp_username) {
              try {
                const listRes = await client.get('/sites', { params: { per_page: 50 } });
                const match = (listRes.data?.data || []).find((s: any) => s.id === site.id);
                if (match?.site_meta?.wp_username) creds = match.site_meta;
              } catch { /* ignore */ }
            }

            const displayUrl = siteUrl || (domain ? `https://${domain}` : '');
            console.log(`\n${chalk.bold.green('Ready')} in ${elapsed()}s ${chalk.dim('\u2192')} ${chalk.cyan.underline(displayUrl)}`);

            if (creds.wp_username) {
              console.log(`\n  ${chalk.dim('Username:')} ${creds.wp_username}`);
              console.log(`  ${chalk.dim('Password:')} ${creds.wp_password}`);
            }
            const adminUrl = displayUrl ? `${displayUrl}/wp-admin` : '';
            if (adminUrl) {
              console.log(`  ${chalk.dim('WP Admin:')} ${chalk.cyan.underline(adminUrl)}`);
            }
            const magicUrl = creds.wp_magic_login_url || (siteInfo?.hash ? `${getApiUrl()}/wordpress-auto-login?site=${siteInfo.hash}` : '');
            if (magicUrl) {
              console.log(`  ${chalk.dim('Magic Login:')} ${chalk.cyan.underline(magicUrl)}`);
            }

            if (mcpConn) printMcpConnection(mcpConn);
          }
          return;
        }
      } catch {
        // Ignore polling errors, keep trying
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    provSpin.fail('Timed out waiting for site');
    info(`Site ID ${site.id} was created but may still be provisioning.`);
    info(`Check status with: instawp sites list`);
  } catch (err: any) {
    error('Could not create site', err.response?.data?.message || err.message);
    process.exit(1);
  }
}

// Register top-level `create` alias
export function registerCreateAlias(program: Command): void {
  program
    .command('create')
    .description('Create a new WordPress site (alias for sites create)')
    .requiredOption('--name <name>', 'Site name')
    .option('--wp <version>', 'WordPress version (e.g., 6.8)')
    .option('--php <version>', 'PHP version (e.g., 8.2)')
    .option('--config <id>', 'Configuration ID')
    .option('--temporary', 'Create as temporary site (default: permanent)')
    .option('--mcp', 'Make the site MCP-ready (install + configure InstaMCP) after creation')
    .option('--plugins <list>', 'Comma-separated wordpress.org plugin slugs to install (with --mcp)')
    .option('--no-wait', 'Do not wait for site to become active')
    .action(createSiteAction);
}
