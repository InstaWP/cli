export interface CliConfig {
  api_url: string;
  token: string | null;
  user: UserInfo | null;
}

export interface UserInfo {
  id: number;
  name: string;
  email: string;
}

export interface Site {
  id: number;
  domain: string;
  url: string;
  status: string;
  wp_version: string;
  php_version: string;
  created_at: string;
}

export interface SiteCreateParams {
  site_name: string;
  php_version?: string;
  plan_id?: number;
  configuration_id?: number;
}

export interface SftpCredentials {
  host: string;
  username: string;
  password: string;
  port: number;
}

export interface RunCmdResult {
  output: string;
  exit_code: number;
}

export interface ApiResponse<T = any> {
  status: boolean;
  data: T;
  message?: string;
}

export interface SiteDetails {
  id: number;
  name: string;
  sub_domain: string;
  url: string;
  status: number;
  wp_version: string;
  php_version: string;
  domain?: { name: string };
  server_username?: string;
  main_domain?: string;
}

export interface SiteVersion {
  id: number;
  name: string | null;
  site_id: number;
  status: string;
  size_mb?: number;
  file_size_mb?: number;
  db_size_mb?: number;
  created_at?: string;
}

export interface SshKeyInfo {
  id: number;
  label: string;
  ssh_key: string;
}

export interface SshConnection {
  host: string;
  username: string;
  port: number;
  privateKeyPath: string;
  siteId: number;
  /** The REAL web-dir name (`~/web/<domain>/public_html`). Post-cutover this is the
   *  original sub_domain, NOT the API's primary domain — resolved from the server. */
  domain: string;
  /** True once the web dir has been resolved from the server (cached; resolve once). */
  webDirResolved?: boolean;
}

export interface SshConnectionCache {
  connection: SshConnection;
  cachedAt: number;
}

export interface TeamInfo {
  id: number;
  name: string;
  created_at: string;
}

export interface LocalInstance {
  name: string;
  port: number;
  php: string;
  wp: string;
  path: string;
  createdAt: string;
  /** Cloud site this instance was cloned from — `local push` targets it by default. */
  cloudSiteId?: number;
  /** Display name of the origin cloud site (for messaging). */
  cloudSiteName?: string;
}
