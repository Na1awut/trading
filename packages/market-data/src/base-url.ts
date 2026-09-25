import { ProviderNotConfiguredError } from './errors';

/**
 * SSRF guard for MARKET_DATA_BASE_URL. The URL comes from operator configuration only
 * (never from API users), but we still refuse anything that could point the server at
 * internal infrastructure: non-HTTPS, embedded credentials, cloud metadata / link-local
 * addresses, and - unless explicitly allowed - hosts outside the vendor's allowlist.
 */
export function resolveBaseUrl(
  configured: string | undefined,
  defaults: { defaultBaseUrl: string; allowedHosts: readonly string[]; vendor: string },
  opts: { allowCustom?: boolean } = {},
): string {
  const raw = configured?.trim() || defaults.defaultBaseUrl;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderNotConfiguredError('MARKET_DATA_BASE_URL is not a valid URL');
  }
  const host = url.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

  if (url.username || url.password) {
    throw new ProviderNotConfiguredError('MARKET_DATA_BASE_URL must not contain credentials');
  }
  if (url.search || url.hash) {
    throw new ProviderNotConfiguredError(
      'MARKET_DATA_BASE_URL must not contain a query string or fragment',
    );
  }
  if (
    /^169\.254\./.test(host) ||
    host === 'metadata.google.internal' ||
    host === '[fd00:ec2::254]'
  ) {
    throw new ProviderNotConfiguredError(
      'MARKET_DATA_BASE_URL points at a metadata/link-local address',
    );
  }
  if (url.protocol !== 'https:' && !(opts.allowCustom && isLoopback && url.protocol === 'http:')) {
    throw new ProviderNotConfiguredError('MARKET_DATA_BASE_URL must use https');
  }
  if (!opts.allowCustom && !defaults.allowedHosts.includes(host)) {
    throw new ProviderNotConfiguredError(
      `MARKET_DATA_BASE_URL host "${host}" is not an allowed ${defaults.vendor} host ` +
        `(${defaults.allowedHosts.join(', ')}). Set MARKET_DATA_ALLOW_CUSTOM_BASE_URL=true for proxies.`,
    );
  }
  return url.toString().replace(/\/$/, '');
}
