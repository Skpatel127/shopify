import { createHmac, timingSafeEqual } from 'node:crypto';

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
const HEX_SHA256 = /^[a-f0-9]{64}$/i;

/**
 * Shopify App Proxy signatures cover decoded query parameters except `signature`.
 * Repeated values are comma-joined; the resulting key/value strings are sorted
 * and concatenated without a separator, matching Shopify's documented format.
 */
export function canonicalizeAppProxyQuery(searchParams) {
  const valuesByKey = new Map();
  for (const [key, value] of searchParams) {
    if (key === 'signature') continue;
    const values = valuesByKey.get(key) ?? [];
    values.push(value);
    valuesByKey.set(key, values);
  }

  return [...valuesByKey.entries()]
    .map(([key, values]) => `${key}=${values.join(',')}`)
    .sort()
    .join('');
}

/** Returns validated proxy identity/context, or null when any check fails. */
export function verifyAppProxyRequest(
  originalUrl,
  sharedSecret,
  { now = Date.now(), maxClockSkewSeconds = 300 } = {},
) {
  if (!sharedSecret || !originalUrl) return null;

  let url;
  try {
    url = new URL(originalUrl, 'http://app-proxy.invalid');
  } catch {
    return null;
  }

  const signatures = url.searchParams.getAll('signature');
  const shops = url.searchParams.getAll('shop');
  const timestamps = url.searchParams.getAll('timestamp');
  if (signatures.length !== 1 || shops.length !== 1 || timestamps.length !== 1) return null;

  const signature = signatures[0];
  const shop = shops[0];
  const timestamp = Number(timestamps[0]);
  if (!HEX_SHA256.test(signature) || !SHOP_DOMAIN.test(shop)) return null;
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  if (Math.abs(Math.floor(now / 1000) - timestamp) > maxClockSkewSeconds) return null;

  const message = canonicalizeAppProxyQuery(url.searchParams);
  const expected = createHmac('sha256', sharedSecret).update(message).digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  return {
    shop,
    customerId: url.searchParams.get('logged_in_customer_id') || null,
    pathPrefix: url.searchParams.get('path_prefix') || null,
    timestamp,
  };
}
