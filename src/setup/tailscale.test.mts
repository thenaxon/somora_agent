import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isOperatorError, parseTailscaleStatus } from './tailscale.ts';

test('running, MagicDNS and HTTPS on', () => {
  const s = parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail1234.ts.net.' }, CertDomains: ['box.tail1234.ts.net'] }));
  assert.deepEqual(s, { running: true, dnsName: 'box.tail1234.ts.net', certsEnabled: true, backendState: 'Running' });
});

test('HTTPS certificates not enabled in the tailnet', () => {
  const s = parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail1234.ts.net.' }, CertDomains: null }));
  assert.equal(s.certsEnabled, false);
  assert.equal(s.dnsName, 'box.tail1234.ts.net');
});

test('installed but not logged in', () => {
  const s = parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '' } }));
  assert.deepEqual(s, { running: false, dnsName: null, certsEnabled: false, backendState: 'NeedsLogin' });
});

test('garbage output does not throw', () => {
  assert.equal(parseTailscaleStatus('failed to connect to local tailscaled').running, false);
});

test('operator error is recognised', () => {
  assert.equal(isOperatorError('Access denied: cert access denied'), true);
  assert.equal(isOperatorError('500 Internal Server Error: acme: rate limited'), false);
});
