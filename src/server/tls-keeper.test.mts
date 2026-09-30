import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { createSecureServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

const made: string[] = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
import { join } from 'node:path';
import { connect } from 'node:tls';

import { certDaysLeft, tailscaleCertArgs, TlsKeeper } from './tls-keeper.ts';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

function selfSigned(dir: string, name: string, days: number): { cert: string; key: string } {
  const cert = join(dir, `${name}.crt`);
  const key = join(dir, `${name}.key`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', String(days), '-subj', `/CN=${name}.test`], { stdio: 'ignore' });
  return { cert, key };
}

function servedFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect({ port, host: '127.0.0.1', rejectUnauthorized: false, ALPNProtocols: ['h2'] }, () => {
      const fp = s.getPeerX509Certificate()?.fingerprint256 ?? '';
      s.destroy();
      resolve(fp);
    });
    s.on('error', reject);
  });
}

test('tailscale cert arguments', () => {
  assert.deepEqual(tailscaleCertArgs('/c', '/k', 'h.ts.net', '720h'), ['cert', '--min-validity', '720h', '--cert-file', '/c', '--key-file', '/k', 'h.ts.net']);
  assert.deepEqual(tailscaleCertArgs('/c', '/k', 'h.ts.net', null), ['cert', '--cert-file', '/c', '--key-file', '/k', 'h.ts.net']);
});

test('certDaysLeft: unreadable input is null, not a throw', () => {
  assert.equal(certDaysLeft('not a cert'), null);
});

test('a renewed certificate is served without restarting the listener', { skip: !hasOpenssl }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'somora-tls-test-'));
  made.push(dir);
  const a = selfSigned(dir, 'first', 5);
  const b = selfSigned(dir, 'second', 80);
  const live = { cert: join(dir, 'live.crt'), key: join(dir, 'live.key') };
  copyFileSync(a.cert, live.cert);
  copyFileSync(a.key, live.key);
  assert.equal(certDaysLeft(readFileSync(a.cert)), 4);

  const loaded = readFileSync(live.cert);
  const server = createSecureServer({ cert: loaded, key: readFileSync(live.key), allowHTTP1: true });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const logs: Array<Record<string, unknown>> = [];
  const log = { info: (o: Record<string, unknown>) => logs.push(o), warn: (o: Record<string, unknown>) => logs.push(o) };
  const calls: string[][] = [];
  const keeper = new TlsKeeper({
    server, certPath: live.cert, keyPath: live.key, publicHost: 'first.test', renew: 'tailscale', log, loadedCert: loaded,
    // First call: an old Tailscale that rejects the flag; the retry "renews".
    runRenew: async (args) => {
      calls.push(args);
      if (args.includes('--min-validity')) return { code: 2, stderr: 'flag provided but not defined: -min-validity' };
      copyFileSync(b.cert, live.cert);
      copyFileSync(b.key, live.key);
      return { code: 0, stderr: '' };
    },
  });
  try {
    const before = await servedFingerprint(port);
    assert.equal(before, new X509Certificate(readFileSync(a.cert)).fingerprint256);

    assert.equal(await keeper.check(), 'reloaded');
    assert.equal(calls.length, 2, 'retried without --min-validity');
    assert.equal(await servedFingerprint(port), new X509Certificate(readFileSync(b.cert)).fingerprint256);
    assert.equal(logs.at(-1)?.msg, 'server.tls.reloaded');

    // Nothing new: no reload, and 79 days left is no warning.
    calls.length = 0; logs.length = 0;
    const quiet = new TlsKeeper({ server, certPath: live.cert, keyPath: live.key, publicHost: 'x', log, loadedCert: readFileSync(live.cert) });
    assert.equal(await quiet.check(), 'unchanged');
    assert.equal(logs.length, 0);

    // A failing renewal is reported with the reason and does not throw.
    const failing = new TlsKeeper({
      server, certPath: a.cert, keyPath: a.key, publicHost: 'x', renew: 'tailscale', log, loadedCert: readFileSync(a.cert),
      runRenew: async () => ({ code: 1, stderr: 'Access denied: cert access denied' }),
    });
    assert.equal(await failing.check(), 'unchanged');
    assert.deepEqual(logs.map((l) => l.msg), ['server.tls.renew_failed', 'server.tls.expires_soon']);
  } finally {
    server.close();
  }
});
