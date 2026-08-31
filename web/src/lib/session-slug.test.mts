// Run: npx tsx web/src/lib/session-slug.test.mts
import assert from 'node:assert/strict';
import { suggestSlug, validateSessionSlug } from './session-slug';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

check('valid simple', validateSessionSlug('research').ok);
check('valid with dash/underscore/digits', validateSessionSlug('cinema-booking_2').ok);
check('trims whitespace', (() => { const r = validateSessionSlug('  notes  '); return r.ok && r.slug === 'notes'; })());
check('empty rejected', !validateSessionSlug('').ok);
check('whitespace-only rejected', !validateSessionSlug('   ').ok);
check('main reserved', !validateSessionSlug('main').ok && /main/.test((validateSessionSlug('main') as { reason: string }).reason));
check('space inside rejected', !validateSessionSlug('my notes').ok);
check('umlaut rejected', !validateSessionSlug('büro').ok);
check('slash rejected', !validateSessionSlug('a/b').ok);
check('suggest: spaces → dashes', suggestSlug('my new notes') === 'my-new-notes');
check('suggest: drops illegal chars', suggestSlug('büro/plan!') === 'broplan');
check('suggest: keeps valid input', suggestSlug('cinema-booking_2') === 'cinema-booking_2');

console.log(`session-slug: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
