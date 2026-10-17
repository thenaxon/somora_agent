// The installer's --no-service holds for the setup assistant too: its
// start step must not load the LaunchAgent or unit that `somora init`
// wrote (release rehearsal 2026-10-17: on a Mac the assistant started
// the service anyway).
import '../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { serviceAvailable } = await import('./setup.ts');

test('SOMORA_NO_SERVICE: no service, whatever is installed', () => {
  assert.equal(serviceAvailable({ SOMORA_NO_SERVICE: '1' }), false);
});

