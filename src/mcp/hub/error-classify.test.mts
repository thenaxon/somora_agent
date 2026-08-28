// How a connect failure is classified (2026-08-28).
// Run: npx tsx src/mcp/hub/error-classify.test.mts
//
// Two decisions hang off these predicates, and both were wrong for the
// same kind of error:
//
//   permanent? → whether the handshake gives up or retries on the other
//                transport. Retrying an auth refusal means the SECOND
//                transport's error is the one reported, which buried a
//                "your token lacks a scope" behind a meaningless 405.
//   auth?      → whether the server parks as `needs-auth` (go log in)
//                or `failed` (go find an outage).
//
// The trap is that the MCP SDK puts the response BODY in its message
// and drops the status code, so a 403 arrives as prose. The strings
// below are verbatim from the live Claude Design endpoint.

import assert from 'node:assert/strict';
import { __classifiers } from './manager.ts';

const { isPermanentError, isAuthError } = __classifiers;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else { fail++; console.error(`FAIL: ${name} ${detail}`); }
}

// Verbatim from the SDK on 2026-08-28 — note: no status code anywhere.
const DESIGN_403 =
  'Streamable HTTP error: Error POSTing to endpoint: {"error":"needs_design_scopes",' +
  '"scopes":["user:design:read","user:design:write"],"prompt":"This token doesn\'t include ' +
  'Claude Design access. In Claude Code, run /design-login"}';

check('scope refusal is permanent — do not retry on SSE',
  isPermanentError(new Error(DESIGN_403)));
check('scope refusal is an auth problem — say "log in", not "failed"',
  isAuthError(new Error(DESIGN_403)));

// The older shape the same endpoint used to return.
const CONSENT = 'Error POSTing to endpoint: {"error":"needs_consent","consent":"agent_design_projects"}';
check('the earlier needs_consent shape counts too', isPermanentError(new Error(CONSENT)));
check('and reads as auth as well', isAuthError(new Error(CONSENT)));

// Status codes still work where a server does send one.
check('401 stays permanent', isPermanentError(new Error('HTTP 401 Unauthorized')));
check('401 stays auth', isAuthError(new Error('HTTP 401 Unauthorized')));
check('403 stays permanent', isPermanentError(new Error('Non-200 status code (403)')));
check('403 now reads as auth', isAuthError(new Error('Non-200 status code (403)')));

// And the ones that must NOT be mistaken for auth, or a temporarily
// unreachable server would be parked waiting for a login that fixes
// nothing.
check('a 405 is not an auth problem', !isAuthError(new Error('SSE error: Non-200 status code (405)')));
check('a 405 is not permanent', !isPermanentError(new Error('SSE error: Non-200 status code (405)')));
check('a 500 is neither', !isAuthError(new Error('Non-200 status code (500)')));
check('a timeout is neither', !isPermanentError(new Error('connect (sse) timed out after 8000ms')));
check('a dropped socket is neither', !isAuthError(new Error('socket hang up')));

// Unresolvable host stays permanent — retrying a typo is pointless.
check('ENOTFOUND stays permanent', isPermanentError(new Error('getaddrinfo ENOTFOUND nope.invalid')));
check('but ENOTFOUND is not an auth problem', !isAuthError(new Error('getaddrinfo ENOTFOUND nope.invalid')));

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} classifier test(s) failed`);
