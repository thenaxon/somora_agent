// Wait-graph for blocking A2A calls — circular-wait (deadlock)
// detection. Born from the 2026-06-01 feedback (Luca's Gideon↔Donna
// hang); spawn-family waits added 2026-06-10.
//
// ── The failure mode ─────────────────────────────────────────────────
// Agent A's turn blocks waiting on agent B (agent_ask, or a wait:true
// sub-spawn, or subagent_result wait_until_done). While blocked, A's
// SESSION LOCK stays held. If B — directly or via any chain of further
// waits — ends up waiting on A's session, every member of the chain
// queues on a lock that can only be released by another member: a
// classic circular wait. Symptom pre-fix: all involved sessions show
// "streaming" forever, no error, until the per-call timeouts fire
// minutes later. The canonical trigger is an agent "answering" an
// agent_ask by opening a NEW agent_ask back at its caller instead of
// just replying in its turn output. Chains over 3+ agents happen in
// practice, so detection is TRANSITIVE (DFS over the edge set), not
// just pairwise.
//
// ── The model ────────────────────────────────────────────────────────
// Nodes are (agent, session) — the session whose turn holds the lock —
// NOT bare agent names: agent-level edges would false-positive on
// legitimate cross-session traffic (proven by the cross-session case in
// the smoke tests). An edge from→to means "from's turn is blocked until
// to's work completes". Edges are reference-counted because one turn
// can hold several parallel waits on the same target.
//
// Dispatch protocol for every blocking wait:
//   1. findWaitCycle(from, to) — would this edge close a cycle?
//      If yes → REFUSE to wait (reject the call / return pending) with
//      a teaching message; the refusal makes the situation self-healing
//      because the refused agent simply finishes its turn, which is
//      exactly what the waiting chain needs.
//   2. registerWait(from, to) BEFORE starting to block (incl. before
//      queueing on the target's session lock — the caller is already
//      committed to waiting while queued).
//   3. release() in a finally, whatever way the wait ends.
// Check + register run synchronously back-to-back (no await between),
// so two simultaneous calls can't both slip past the cycle check (Node
// is single-threaded).
//
// ── Coverage map — every blocking A2A wait and who registers it ──────
// The graph lives in MAIN-SERVER process memory. That works because
// every wait either happens in the main server itself or announces
// itself to a main-server HTTP route via waiter_agent/waiter_session
// params. (waiter_* is deliberately separate from from_agent: from_agent
// changes message semantics in the target session, waiter_* is pure
// wait-graph bookkeeping.)
//
//   wait                          transport            registered by
//   ────────────────────────────  ───────────────────  ─────────────────
//   agent_ask (any engine —       loopback HTTP        /chat/send-sync
//     the tool always HTTPs)        + waiter_*           route
//   spawn_subagent wait:true,     direct runChatTurn   spawn.ts runOneSpawn
//     in-process (main server)                           (direct import)
//   spawn_subagent wait:true,     loopback HTTP        /chat/send-sync
//     MCP-child fallback            + waiter_*           route
//   subagent_result               direct               status.ts handler
//     wait_until_done,              waitForTask-         (direct import)
//     in-process (main server)      Completion
//   subagent_result               loopback HTTP        /spawn-result
//     wait_until_done,              + waiter_*           route
//     MCP-child fallback
//
//   NOT registered (correctly — they don't block the caller's turn):
//   spawn_subagent wait:false (fire-and-forget), subagent_status,
//   subagent_result without wait_until_done.
//
// Spawn waits skip step 1 (cycle check): the sub-session is created
// fresh immediately before the wait, so no edges can touch it yet and
// the registration cannot close a cycle. subagent_result DOES need the
// check — its target task has been running since an earlier turn and
// may already be waiting on the caller; on a cycle it returns
// state:'pending' with a hint instead of erroring, because "still
// running" is not an error there.
//
// MCP children import this module too (via spawn.ts/status.ts) and get
// their own empty graph instance — harmless, because the in-process
// branches that touch the graph only execute in the main server
// (injectedDeps set / getTask hit), and child waits go through the HTTP
// routes instead. Same cross-process pattern as the sentinel store.
//
// Graceful degradation: a caller that can't name its session (ctx.session
// missing — shouldn't happen) just doesn't participate; its wait is
// invisible but nothing breaks.
//
// Design decisions (discussed 2026-06-10): reject/refuse rather than
// auto-interpret a reverse-ask as the pending answer (no magic), no
// extra watchdog timeout layer (agent_ask/subagent_result already have
// their own timeouts), transitive detection from day one. Full design
// notes: private/A2A-design.md → "Circular-wait detection".

export interface WaitNode {
  agent: string;
  session: string;
}

const keyOf = (n: WaitNode) => `${n.agent}\u0000${n.session}`;
const labelOf = (k: string) => k.replace('\u0000', '/');

/** from-key → (to-key → count of in-flight waits). Counts because one
 *  turn can have several parallel asks to the same target. */
const graph = new Map<string, Map<string, number>>();

/**
 * Record "`from`'s turn is now blocked waiting on `to`". Returns an
 * idempotent release callback — call it when the wait ends (reply,
 * error, or caller gave up).
 */
export function registerWait(from: WaitNode, to: WaitNode): () => void {
  const f = keyOf(from);
  const t = keyOf(to);
  let outs = graph.get(f);
  if (!outs) {
    outs = new Map();
    graph.set(f, outs);
  }
  outs.set(t, (outs.get(t) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const m = graph.get(f);
    if (!m) return;
    const n = (m.get(t) ?? 0) - 1;
    if (n <= 0) m.delete(t);
    else m.set(t, n);
    if (m.size === 0) graph.delete(f);
  };
}

/**
 * Would adding the edge from→to close a wait cycle? True iff a wait
 * path to→…→from already exists. Returns the full cycle as readable
 * "agent/session" labels starting and ending at `from`
 * (e.g. ["donna/main", "gideon/main", "donna/main"]), or null.
 */
export function findWaitCycle(from: WaitNode, to: WaitNode): string[] | null {
  const target = keyOf(from);
  const start = keyOf(to);
  const seen = new Set<string>();
  const path: string[] = [];
  const dfs = (node: string): boolean => {
    if (node === target) {
      path.push(node);
      return true;
    }
    if (seen.has(node)) return false;
    seen.add(node);
    for (const next of graph.get(node)?.keys() ?? []) {
      if (dfs(next)) {
        path.push(node);
        return true;
      }
    }
    return false;
  };
  if (!dfs(start)) return null;
  path.push(keyOf(from)); // path is reversed: [from(target), …, to(start)] → append from-as-origin
  return path.reverse().map(labelOf);
}

/** Diagnostic snapshot for debug endpoints / tests. */
export function waitGraphSnapshot(): Array<{ from: string; to: string; count: number }> {
  const out: Array<{ from: string; to: string; count: number }> = [];
  for (const [f, m] of graph) {
    for (const [t, count] of m) {
      out.push({ from: labelOf(f), to: labelOf(t), count });
    }
  }
  return out;
}
