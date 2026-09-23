// Run: npm test src/server/builder-busy.test.mts
import assert from 'node:assert/strict';
import { claimWorkdir, describeClaim, releaseWorkdir, workdirClaimedBy } from './builder-busy.ts';

assert.equal(workdirClaimedBy('/x/repo'), null);
claimWorkdir({ agent: 'rudi', session: 's1', turnId: 't1', workdir: '/x/repo/' });
assert.equal(workdirClaimedBy('/x/repo')?.turnId, 't1', 'same folder (trailing slash ignored)');
assert.equal(workdirClaimedBy('/x/repo/packages/a')?.turnId, 't1', 'child folder is covered');
assert.equal(workdirClaimedBy('/x')?.turnId, 't1', 'parent folder is covered');
assert.equal(workdirClaimedBy('/x/repo2'), null, 'sibling with a shared prefix is free');
assert.equal(workdirClaimedBy('/x/repo', { exceptTurnId: 't1' }), null, 'a turn does not block itself');
assert.match(describeClaim(workdirClaimedBy('/x/repo')!), /rudi is working in \/x\/repo \(session s1/);
releaseWorkdir('t1');
assert.equal(workdirClaimedBy('/x/repo'), null, 'released with the turn');
console.log('builder-busy.test: ok');
