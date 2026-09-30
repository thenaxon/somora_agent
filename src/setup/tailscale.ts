// What the setup assistant needs to know about Tailscale on this host.

import { capture } from './prompt.ts';

export interface TailscaleState {
  installed: boolean;
  /** Logged in and connected. */
  running: boolean;
  /** `host.tailnet.ts.net`, no trailing dot. */
  dnsName: string | null;
  /** HTTPS certificates are switched on for the tailnet. */
  certsEnabled: boolean;
  backendState: string | null;
}

export function parseTailscaleStatus(json: string): Omit<TailscaleState, 'installed'> {
  let j: { BackendState?: string; Self?: { DNSName?: string }; CertDomains?: string[] | null };
  try {
    j = JSON.parse(json);
  } catch {
    return { running: false, dnsName: null, certsEnabled: false, backendState: null };
  }
  const dnsName = (j.Self?.DNSName ?? '').replace(/\.$/, '') || null;
  const certDomains = j.CertDomains ?? [];
  return {
    running: j.BackendState === 'Running',
    dnsName,
    // MagicDNS off → no DNSName; HTTPS off → CertDomains empty.
    certsEnabled: dnsName !== null && certDomains.includes(dnsName),
    backendState: j.BackendState ?? null,
  };
}

export function tailscaleState(): TailscaleState {
  const r = capture('tailscale', ['status', '--json'], 15_000);
  if (r.code === 127) return { installed: false, running: false, dnsName: null, certsEnabled: false, backendState: null };
  return { installed: true, ...parseTailscaleStatus(r.stdout) };
}

/** `tailscale cert` refused because this user may not talk to the
 *  daemon — cured by `sudo tailscale set --operator=<user>`. */
export function isOperatorError(stderr: string): boolean {
  return /access denied|must be root|operator|permission denied/i.test(stderr);
}
