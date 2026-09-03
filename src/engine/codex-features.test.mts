// Run: npx tsx src/engine/codex-features.test.mts
import assert from 'node:assert/strict';
import { parseFeatureNames, filterDisableFlags } from './codex-features.ts';
let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = '') => { if (c) pass++; else { fail++; console.error('FAIL', n, d); } };
// Shape of `codex features list` (0.144.6 excerpt): name, stage, default.
const OLD = `apply_patch_freeform                 removed            false
apps                                 stable             true
browser_use                          stable             true
collaboration_modes                  removed            true
shell_tool                           stable             true
unavailable_dummy_tools              removed            false
unified_exec                         stable             true
`;
const NEW = OLD + `skill_search                             stable             true
view_image                               stable             true
`;
const WANTED = ['shell_tool', 'unified_exec', 'browser_use', 'collaboration_modes', 'unavailable_dummy_tools', 'view_image', 'skill_search'];
{
  const known = parseFeatureNames(OLD);
  check('parses names', known.has('shell_tool') && known.has('collaboration_modes') && known.size === 7, String(known.size));
  const { flags, skipped } = filterDisableFlags(WANTED, known);
  check('old codex: view_image + skill_search skipped', JSON.stringify(skipped) === '["view_image","skill_search"]', JSON.stringify(skipped));
  check('old codex: removed flags still passed', flags.includes('collaboration_modes') && flags.includes('unavailable_dummy_tools'));
}
{
  const { flags, skipped } = filterDisableFlags(WANTED, parseFeatureNames(NEW));
  check('new codex: nothing skipped', skipped.length === 0 && flags.length === WANTED.length);
}
{
  const { flags, skipped } = filterDisableFlags(WANTED, null);
  check('probe failed: full list passed', flags.length === WANTED.length && skipped.length === 0);
}
check('header/blank lines ignored', parseFeatureNames('Feature   Stage   Default\n\nfoo_bar   stable   true\n').has('foo_bar') && !parseFeatureNames('Feature   Stage   Default\n').size);
console.log(`${pass} passed, ${fail} failed`); assert.equal(fail, 0);
