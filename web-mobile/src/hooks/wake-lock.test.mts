// Screen wake lock: the parts that are decided, not observed.
//
// Run: cd web-mobile && npx tsx src/hooks/wake-lock.test.mts
//
// Whether the screen actually stays lit can only be seen on a phone.
// What CAN be pinned here is the rule that decides what the UI promises:
// iOS accepted the request inside a home-screen web app long before it
// honoured it (WebKit 254545, fixed in 18.4), so a resolved promise is
// not proof and the version is the only signal there is.
import assert from 'node:assert/strict';

import { iosWakeLockBroken } from './useWakeLock';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name, detail); }
};

const iphone = (v: string): string =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS ${v} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1`;

check('iOS 18.4 is the first that honours it', iosWakeLockBroken(iphone('18_4')) === false);
check('iOS 18.5 too', iosWakeLockBroken(iphone('18_5')) === false);
check('iOS 26 too', iosWakeLockBroken(iphone('26_0')) === false);
check('iOS 18.3 is too old', iosWakeLockBroken(iphone('18_3')) === true);
check('iOS 17.6 is too old', iosWakeLockBroken(iphone('17_6')) === true);
check('iOS 16.4 (tab support only) is too old', iosWakeLockBroken(iphone('16_4')) === true);
check(
  'an iPad counts as iOS',
  iosWakeLockBroken('Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15') === true,
);
check(
  'Android is not iOS and is not warned about',
  iosWakeLockBroken('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36') === false,
);
check(
  'a desktop browser is not warned about',
  iosWakeLockBroken('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140') === false,
);
check('nonsense does not raise a false alarm', iosWakeLockBroken('') === false);

console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
