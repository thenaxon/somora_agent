// Thin barrel for the ssh service. Tools should import from here, not
// from individual files, so the surface stays minimal.

export { getConnection, poolSnapshot, shutdownSshPool } from './pool.ts';
export { remoteExec, type RemoteExecResult, type RemoteExecOptions } from './exec.ts';
export { fingerprint, verifyHostKey } from './known-hosts.ts';
