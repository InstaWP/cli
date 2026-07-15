import { Command } from 'commander';
import { randomBytes } from 'node:crypto';
import { requireAuth } from '../lib/api.js';
import { resolveSite } from '../lib/site-resolver.js';
import { ensureSshAccess } from '../lib/ssh-keys.js';
import { execViaSsh } from '../lib/ssh-connection.js';
import { shellQuote, sliceAfterMarker } from '../lib/remote-command.js';
import { getMcpToken, setMcpToken } from '../lib/config.js';
import { success, error, spinner, info, isJsonMode } from '../lib/output.js';
import type { SshConnection } from '../types.js';

// Canonical InstaMCP distribution zip (private; not on wordpress.org). Overridable
// for testing a pre-release build via --plugin-zip or INSTAMCP_PLUGIN_ZIP.
const DEFAULT_PLUGIN_ZIP =
  'https://artifacts-iwp.ams3.digitaloceanspaces.com/insta-mcp/insta-mcp-latest.zip';
const PLUGIN_SLUG = 'insta-mcp';
// An administrator's token maps to every scope, including mcp:admin (role→scope
// map lives in the plugin's ScopeRepository / BearerTokenAuth).
const ADMIN_SCOPES = ['mcp:read', 'mcp:write', 'mcp:delete', 'mcp:admin'];
// Label of the token row this CLI owns, so re-running upserts one row (never piles up).
const TOKEN_LABEL = 'InstaWP CLI';

/** wordpress.org plugin slugs: lowercase letters, numbers, hyphens. */
export function isValidPluginSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug);
}

export interface McpConnection {
  site_id: number;
  site_url: string;
  mcp_endpoint: string;
  mcp_endpoint_with_token: string;
  token: string;
  scopes: string[];
  capabilities: { execute_php: boolean; site_files: string };
  rotated: boolean;
}

interface WpResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run a WP-CLI invocation on the site over SSH, MOTD-stripped, and capture output. */
function runWpCli(conn: SshConnection, args: string[]): WpResult {
  const wpRoot = `/home/${conn.username}/web/${conn.domain}/public_html`;
  const quoted = args.map(shellQuote).join(' ');
  const marker = `__IWP_MCP_${randomBytes(6).toString('hex')}__`;
  const res = execViaSsh(
    conn,
    `printf '%s\\n' '${marker}'; cd ${wpRoot} && wp ${quoted}`,
  );
  return {
    stdout: sliceAfterMarker(res.stdout, marker).trim(),
    stderr: res.stderr.trim(),
    exitCode: res.exitCode,
  };
}

function wpFail(label: string, res: WpResult): never {
  error(`${label} failed`, res.stderr || res.stdout || `exit ${res.exitCode}`);
  process.exit(1);
}

/**
 * Make a site MCP-ready and return a connection blob. Idempotent: an already-set-up
 * site re-prints the SAME cached token instead of minting a new one.
 *
 * Uses InstaMCP's simple Bearer-token transport (`/insta-mcp?t=<token>`) — the
 * supported, working connection shape (see the plugin's docs/CLIENTS.md). OAuth 2.1
 * client provisioning is intentionally NOT done: the plugin ships with
 * INSTA_MCP_OAUTH_FEATURE_ENABLED=false, so its OAuth tables/routes don't exist and
 * a client cannot be minted from the CLI. See the PR description for the plugin-side
 * change that would be required.
 */
export async function enableMcp(
  site: { id: number; url?: string; sub_domain?: string; name?: string },
  opts: { pluginZip?: string; rotate?: boolean; sshHost?: string; extraPlugins?: string[] } = {},
): Promise<McpConnection> {
  const conn = await ensureSshAccess(site.id, { sshHost: opts.sshHost });

  // 0. Install any requested extra plugins (wordpress.org slugs), idempotently.
  for (const slug of opts.extraPlugins || []) {
    if (!isValidPluginSlug(slug)) {
      error(`Unsafe plugin slug "${slug}"`, 'Use lowercase letters, numbers, and hyphens only.');
      process.exit(1);
    }
    const pspin = spinner(`Installing ${slug}...`);
    pspin.start();
    const res = runWpCli(conn, ['plugin', 'install', slug, '--activate']);
    pspin.stop();
    if (res.exitCode !== 0) wpFail(`Installing plugin ${slug}`, res);
    info(`Plugin ${slug} installed + activated`);
  }

  // 1. Install + activate the plugin if it isn't already active (idempotent).
  const activeCheck = runWpCli(conn, ['plugin', 'is-active', PLUGIN_SLUG]);
  if (activeCheck.exitCode !== 0) {
    const zip = opts.pluginZip || process.env.INSTAMCP_PLUGIN_ZIP || DEFAULT_PLUGIN_ZIP;
    // The site's WP-CLI fetches this itself, so it must be a URL it can reach.
    if (!/^https?:\/\//.test(zip)) {
      error(`Invalid --plugin-zip "${zip}"`, 'Must be an http(s):// URL the site can fetch.');
      process.exit(1);
    }
    const inSpin = spinner('Installing InstaMCP plugin...');
    inSpin.start();
    const install = runWpCli(conn, ['plugin', 'install', zip, '--activate', '--force']);
    inSpin.stop();
    if (install.exitCode !== 0) wpFail('Plugin install', install);
    const recheck = runWpCli(conn, ['plugin', 'is-active', PLUGIN_SLUG]);
    if (recheck.exitCode !== 0) wpFail('Plugin activation', recheck);
    info('InstaMCP plugin installed + activated');
  } else {
    info('InstaMCP plugin already active');
  }

  // 2. Enable the capability flags (wp option update is naturally idempotent).
  const php = runWpCli(conn, ['option', 'update', 'insta_mcp_execute_php_enabled', '1']);
  if (php.exitCode !== 0) wpFail('Enabling Execute PHP', php);
  const files = runWpCli(conn, ['option', 'update', 'insta_mcp_site_files_mode', 'read_write']);
  if (files.exitCode !== 0) wpFail('Enabling Site Files (read-write)', files);

  // 3. Mint / reuse a token tied to the first administrator (→ mcp:admin scope).
  let token = getMcpToken(site.id);
  let rotated = false;
  if (!token || opts.rotate) {
    token = randomBytes(32).toString('hex'); // 64-char hex, the format the plugin expects
    // Upsert a single labelled row: UPDATE the hash if our row exists, else INSERT.
    // Token is [0-9a-f] only, so it embeds safely in the eval payload.
    const php = [
      'global $wpdb;',
      `$t="${token}";`,
      `$label="${TOKEN_LABEL}";`,
      '$table=$wpdb->prefix."insta_mcp_user_tokens";',
      '$a=get_users(["role"=>"administrator","number"=>1,"orderby"=>"ID","order"=>"ASC"]);',
      'if(empty($a)){echo "ERR:no-admin";return;}',
      '$uid=$a[0]->ID;$h=hash("sha256",$t);',
      '$id=$wpdb->get_var($wpdb->prepare("SELECT id FROM `$table` WHERE user_id=%d AND label=%s",$uid,$label));',
      'if($id){$wpdb->update($table,["token_hash"=>$h,"last_used_at"=>null],["id"=>$id]);}',
      'else{$wpdb->insert($table,["user_id"=>$uid,"token_hash"=>$h,"label"=>$label,"expires_at"=>null,"created_at"=>current_time("mysql")]);}',
      'echo "OK:".$uid;',
    ].join('');
    const mint = runWpCli(conn, ['eval', php]);
    if (mint.exitCode !== 0 || !mint.stdout.startsWith('OK:')) {
      if (mint.stdout.includes('ERR:no-admin')) {
        error('Could not mint token', 'No administrator user found on the site.');
        process.exit(1);
      }
      wpFail('Minting MCP token', mint);
    }
    setMcpToken(site.id, token);
    rotated = !!opts.rotate;
  }

  // 4. Resolve the endpoint URL from WordPress itself (authoritative — handles a
  //    custom endpoint slug and domain drift).
  const endpoint = runWpCli(conn, [
    'eval',
    'echo home_url("/".get_option("insta_mcp_endpoint_slug","insta-mcp"));',
  ]);
  const mcpEndpoint =
    endpoint.exitCode === 0 && /^https?:\/\//.test(endpoint.stdout)
      ? endpoint.stdout
      : `${(site.url || `https://${site.sub_domain}`).replace(/\/$/, '')}/insta-mcp`;
  const siteUrl = mcpEndpoint.replace(/\/[^/]+$/, '');

  return {
    site_id: site.id,
    site_url: site.url || siteUrl,
    mcp_endpoint: mcpEndpoint,
    mcp_endpoint_with_token: `${mcpEndpoint}?t=${token}`,
    token,
    scopes: ADMIN_SCOPES,
    capabilities: { execute_php: true, site_files: 'read_write' },
    rotated,
  };
}

/** Render the connection blob for humans, with ready-to-paste client snippets. */
export function printMcpConnection(c: McpConnection): void {
  if (isJsonMode()) {
    console.log(JSON.stringify({ success: true, data: c }));
    return;
  }

  const mcpJson = {
    mcpServers: {
      wordpress: { type: 'http', url: c.mcp_endpoint_with_token },
    },
  };
  const claudeAdd =
    `claude mcp add --transport http wordpress "${c.mcp_endpoint}" ` +
    `--header "Authorization: Bearer ${c.token}"`;

  console.log('');
  success('MCP-ready');
  console.log(`\n  Site:      ${c.site_url}`);
  console.log(`  Endpoint:  ${c.mcp_endpoint}`);
  console.log(`  Token:     ${c.token}`);
  console.log(`  Scopes:    ${c.scopes.join(', ')}`);
  console.log(`  Execute PHP: on    Site Files: ${c.capabilities.site_files}`);
  console.log('\n  .mcp.json:');
  console.log(
    JSON.stringify(mcpJson, null, 2)
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n'),
  );
  console.log('\n  Claude Code:');
  console.log('    ' + claudeAdd);
  console.log('');
}

export function registerMcpCommand(program: Command): void {
  const mcp = program.command('mcp').description('Make a site MCP-ready (InstaMCP)');

  mcp
    .command('enable <site>')
    .description('Install + configure InstaMCP on a site and print a connection blob')
    .option('--plugin-zip <url|path>', 'Override the InstaMCP plugin zip URL/path')
    .option('--rotate', 'Force-mint a fresh token (invalidates the previously printed one)')
    .option('--ssh-host <host>', 'Override the SSH host (CDN-fronted sites)')
    .addHelpText(
      'after',
      `
Idempotent: re-running re-prints the same cached token (pass --rotate to replace it).

Examples:
  $ instawp mcp enable my-site
  $ instawp mcp enable my-site --json
`,
    )
    .action(async (siteIdentifier: string, opts) => {
      requireAuth();
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

      const conn = await enableMcp(site, {
        pluginZip: opts.pluginZip,
        rotate: opts.rotate,
        sshHost: opts.sshHost,
      });
      printMcpConnection(conn);
    });
}
