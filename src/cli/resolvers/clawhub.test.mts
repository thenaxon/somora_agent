// Tests for ClawHub URL parsing (2026-07-27).
//
// Run: npx tsx src/cli/resolvers/clawhub.test.mts
//
// Regression (Lucy case study 2026-07-24): the resolver extracted only
// the last path segment and dropped the owner, so any contested slug
// (`gog` exists under 3 owners) died with an opaque 409 even when the
// user pasted the fully-qualified URL. parseClawHubUrl keeps the owner
// as the API-side disambiguator.

import assert from 'node:assert/strict';

import { parseClawHubUrl } from './clawhub.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// Canonical current web URL: /<owner>/skills/<slug>
check(
  'owner/skills/slug',
  eq(parseClawHubUrl('https://clawhub.ai/steipete/skills/gog'), { slug: 'gog', owner: 'steipete' }),
);
// Older canonical: /<owner>/<slug>
check(
  'owner/slug',
  eq(parseClawHubUrl('https://clawhub.ai/steipete/gog'), { slug: 'gog', owner: 'steipete' }),
);
// Slug shortcut: /<slug>
check('slug only', eq(parseClawHubUrl('https://clawhub.ai/gog'), { slug: 'gog' }));
// Owner-less skills path: /skills/<slug>
check('skills/slug', eq(parseClawHubUrl('https://clawhub.ai/skills/gog'), { slug: 'gog' }));
// Trailing slash + query tolerated
check(
  'trailing slash',
  eq(parseClawHubUrl('https://clawhub.ai/steipete/skills/gog/'), { slug: 'gog', owner: 'steipete' }),
);
check(
  'query string',
  eq(parseClawHubUrl('https://clawhub.ai/steipete/skills/gog?tab=readme'), {
    slug: 'gog',
    owner: 'steipete',
  }),
);
// www host is validated by isClawHubUrl, parse is host-agnostic — still works
check(
  'www host',
  eq(parseClawHubUrl('https://www.clawhub.ai/steipete/skills/gog'), { slug: 'gog', owner: 'steipete' }),
);
// Invalid slug shapes rejected
check('uppercase slug rejected', parseClawHubUrl('https://clawhub.ai/steipete/skills/GOG') === null);
check('empty path rejected', parseClawHubUrl('https://clawhub.ai/') === null);
check('not a url', parseClawHubUrl('steipete/skills/gog') === null);
// Deep unknown shapes rejected rather than mis-parsed
check(
  'four segments rejected',
  parseClawHubUrl('https://clawhub.ai/a/b/c/gog') === null,
);

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
