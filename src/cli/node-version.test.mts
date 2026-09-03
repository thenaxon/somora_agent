// Run: npx tsx src/cli/node-version.test.mts
import assert from 'node:assert/strict';
import { minimumNodeVersion, satisfiesNode, nodeUpgradeHint } from '../../bin/node-version.mjs';
let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { if (c) pass++; else { fail++; console.error('FAIL', n); } };
check('parse >=22.13.0', JSON.stringify(minimumNodeVersion('>=22.13.0')) === '[22,13,0]');
check('parse >=20', JSON.stringify(minimumNodeVersion('>=20')) === '[20,0,0]');
check('parse ^22.13', JSON.stringify(minimumNodeVersion('^22.13')) === '[22,13,0]');
check('20.19.0 fails >=22.13.0', !satisfiesNode('>=22.13.0', '20.19.0'));
check('22.12.0 fails >=22.13.0', !satisfiesNode('>=22.13.0', '22.12.0'));
check('22.13.0 passes >=22.13.0', satisfiesNode('>=22.13.0', '22.13.0'));
check('22.23.2 passes >=22.13.0', satisfiesNode('>=22.13.0', '22.23.2'));
check('24.1.0 passes >=22.13.0', satisfiesNode('>=22.13.0', '24.1.0'));
check('unparseable range never blocks', satisfiesNode('lts/*', '18.0.0'));
check('current node passes our own engines', satisfiesNode('>=22.13.0', process.versions.node));
const hint = nodeUpgradeHint('>=22.13.0', '20.19.0', '/usr/bin/node');
check('hint names found + required + path', hint.includes('found v20.19.0') && hint.includes('>=22.13.0') && hint.includes('/usr/bin/node') && hint.includes('somora init'));
console.log(`${pass} passed, ${fail} failed`); assert.equal(fail, 0);
