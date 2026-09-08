// Navigation policy for the shared browser: where may an agent send it?
//
// The page an agent reads is untrusted text, and "open this link" is
// the cheapest prompt injection there is. So the boundary is the same
// one web_fetch draws: public hosts yes, private networks only when the
// operator listed them (`browser.allowPrivate`), a deny list on top, and
// only http(s). Checked BEFORE a navigation is issued (open, click on a
// link) and again on every document request the browser makes (route
// interception in the service), which is what catches redirects.
//
// Not a network firewall: subresources (images, scripts, XHR) are not
// checked, and DNS rebinding after the check is out of scope for V1 —
// the same limits OpenClaw documents for its policy.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { BrowserConfig } from '../config/types.ts';

export interface PolicyVerdict {
  ok: boolean;
  reason?: string;
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** RFC1918, loopback, link-local, CGNAT, IPv6 ULA/link-local/loopback. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7)); // v4-mapped
    return false;
  }
  return false;
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => ((n << 8) + Number(o)) >>> 0, 0);
}

/** `host` matches an allow entry: exact hostname, `*.suffix`, exact IP, or IPv4 CIDR. */
export function matchesEntry(entry: string, host: string, ip: string | null): boolean {
  const e = entry.toLowerCase();
  const h = host.toLowerCase();
  if (e === h) return true;
  if (e.startsWith('*.') && (h === e.slice(2) || h.endsWith(e.slice(1)))) return true;
  if (ip) {
    if (e === ip) return true;
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(e);
    if (m && isIP(ip) === 4) {
      const bits = Number(m[2]);
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (ipToInt(ip) & mask) === (ipToInt(m[1]!) & mask);
    }
  }
  return false;
}

/**
 * Decide whether `url` may be navigated to. Resolves the hostname so a
 * public-looking name that points into the LAN is caught. `resolve` is
 * injectable for tests.
 */
export async function checkNavigationAllowed(
  url: string,
  cfg: Pick<BrowserConfig, 'allowPrivate' | 'deny'>,
  resolve: (host: string) => Promise<string[]> = defaultResolve,
): Promise<PolicyVerdict> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: `not a valid URL: ${url}` };
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) {
    return { ok: false, reason: `scheme '${u.protocol}' is not allowed — only http and https` };
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'URL has no host' };
  for (const d of cfg.deny) {
    if (matchesEntry(d, host, isIP(host) ? host : null)) {
      return { ok: false, reason: `host '${host}' is on browser.deny` };
    }
  }
  const literal = isIP(host) ? [host] : null;
  let addrs: string[];
  try {
    addrs = literal ?? (await resolve(host));
  } catch (err) {
    return { ok: false, reason: `host '${host}' does not resolve: ${(err as Error).message}` };
  }
  if (host === 'localhost' || host.endsWith('.localhost')) addrs = ['127.0.0.1', ...addrs];
  const privateAddrs = addrs.filter(isPrivateAddress);
  if (privateAddrs.length === 0) return { ok: true };
  for (const a of cfg.allowPrivate) {
    if (matchesEntry(a, host, null)) return { ok: true };
    if (privateAddrs.some((ip) => matchesEntry(a, host, ip))) return { ok: true };
  }
  return {
    ok: false,
    reason:
      `host '${host}' resolves to a private address (${privateAddrs.join(', ')}) — ` +
      'add it to browser.allowPrivate in config.yaml if agents may use it',
  };
}

async function defaultResolve(host: string): Promise<string[]> {
  const rows = await lookup(host, { all: true });
  return rows.map((r) => r.address);
}
