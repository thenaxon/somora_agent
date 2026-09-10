// What the eye in the Abilities window does to an agent's deny-list.
//
// Kept out of the component because the interesting part is not the
// click, it is the list arithmetic: the deny-list is operator policy
// that also holds hand-written pattern entries, so a toggle must touch
// EXACT names only and leave everything else — order included —
// untouched. See ability-gating.test.mts.

export interface AbilityRow {
  name: string;
  visible: boolean;
}

/** The deny-list after clicking the eye on a group of abilities.
 *
 *  Hides the group while anything in it is still visible, otherwise
 *  brings all of it back. That is what makes a half-hidden group
 *  behave: one click to go dark, a second to come back — as opposed to
 *  inverting each row, where a mixed group would look unchanged.
 *
 *  Existing entries keep their position and unknown ones (globs,
 *  `toolset:` rules, names from another group) are never dropped, so
 *  the agent.yaml diff stays limited to what the user actually clicked.
 *
 *  A single row's eye is the same call with a group of one, so the two
 *  can never drift apart. */
export function toggleGroupVisibility(
  deny: readonly string[],
  rows: readonly AbilityRow[],
): string[] {
  if (rows.length === 0) return [...deny];
  const names = new Set(rows.map((r) => r.name));
  if (!rows.some((r) => r.visible)) return deny.filter((d) => !names.has(d));
  const out = [...deny];
  for (const r of rows) if (!out.includes(r.name)) out.push(r.name);
  return out;
}

