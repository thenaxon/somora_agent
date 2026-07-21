// Display helpers for session ids.
//
// Server convention (DECISIONS #13, storage/sessions.ts): non-main
// sessions are created as `<YYYYMMDD-HHMMSS>_<slug>` — the timestamp is
// part of the id from birth, nothing ever renames a session. For humans
// the slug is the name; the full id is plumbing. The sessions list
// already shows "slug + small id"; these helpers let the taskbar and
// the chat header render the same way without an extra fetch per
// window (pure string formatting of a documented id shape, no logic
// duplicated from the server).

const EXACT_ID_PREFIX = /^\d{8}-\d{6}_/;

/** Human-facing name for a session id: the slug part of a
 *  `<ts>_<slug>` id, or the id itself when it has no timestamp prefix
 *  (`main`, legacy/externally-created ids). */
export function sessionSlug(sessionId: string): string {
  return EXACT_ID_PREFIX.test(sessionId)
    ? sessionId.replace(EXACT_ID_PREFIX, '')
    : sessionId;
}

/** True when the id carries more than the slug (i.e. showing the full
 *  id next to the slug adds information). */
export function hasTechnicalId(sessionId: string): boolean {
  return sessionSlug(sessionId) !== sessionId;
}
