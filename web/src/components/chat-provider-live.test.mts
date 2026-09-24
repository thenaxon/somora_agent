// Behaviour of the chat provider under load (2026-09-24): a window
// re-renders for its own session only, and a session that grew past
// LIVE_ROWS_MAX is compacted to the newest LIVE_ROWS_KEEP rows after
// its turn ends, with the paging cursor pointing at the dropped rows.
//
// Run: cd web && npx tsx src/components/chat-provider-live.test.mts
//
// jsdom stands in for the browser; EventSource and fetch are fakes
// that the test drives by hand.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
g.HTMLElement = dom.window.HTMLElement;
g.Node = dom.window.Node;
g.MessageEvent = dom.window.MessageEvent;
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number;
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (ev: { data: string }) => void;
const sources = new Map<string, FakeEventSource>();
class FakeEventSource {
  listeners = new Map<string, Set<Listener>>();
  constructor(public url: string) {
    sources.set(url, this);
  }
  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  close(): void {
    sources.delete(this.url);
  }
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.forEach((fn) => fn({ data: JSON.stringify(data) }));
  }
}
g.EventSource = FakeEventSource;

// fetch: history per session (events newest-last), feature flags off.
const historyBySession = new Map<string, Array<{ kind: string; ts: number; text?: string }>>();
const historyCalls: Array<{ session: string; limit: number; before?: number }> = [];
g.fetch = async (input: string | URL) => {
  const url = new URL(String(input), 'http://localhost/');
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/projects/feature') return json({ enabled: false, entityCount: 0 });
  if (url.pathname === '/chat/history') {
    const session = url.searchParams.get('session')!;
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined;
    historyCalls.push({ session, limit, ...(before !== undefined ? { before } : {}) });
    const all = historyBySession.get(session) ?? [];
    const filtered = before === undefined ? all : all.filter((e) => e.ts < before);
    const start = Math.max(0, filtered.length - limit);
    const events = filtered.slice(start);
    return json({ events, hasMore: start > 0, oldestTs: events.length > 0 ? events[0]!.ts : null });
  }
  if (url.pathname.endsWith('/project')) return json({ project: null });
  return json({ error: 'not found' }, 404);
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ChatProvider, useChatSessionFromContext, LIVE_ROWS_MAX, LIVE_ROWS_KEEP } = await import('./ChatProvider');

let ok = 0;
let bad = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    ok++;
    console.log('  ok  ', name);
  } catch (e) {
    bad++;
    console.error('  FAIL', name, '->', (e as Error).message);
  }
};
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
};

const renders = new Map<string, number>();
const rows = new Map<string, number>();
const hasMore = new Map<string, boolean>();
const loaders = new Map<string, () => Promise<boolean>>();
function Win({ agent, session }: { agent: string; session: string }) {
  const chat = useChatSessionFromContext(agent, session);
  renders.set(session, (renders.get(session) ?? 0) + 1);
  rows.set(session, chat.messages.length);
  hasMore.set(session, chat.hasMore);
  loaders.set(session, chat.loadOlder);
  return React.createElement('div', { 'data-session': session }, String(chat.messages.length));
}

const root = createRoot(dom.window.document.getElementById('root')!);
await act(async () => {
  root.render(
    React.createElement(
      ChatProvider,
      null,
      React.createElement(Win, { agent: 'a', session: 's1' }),
      React.createElement(Win, { agent: 'a', session: 's2' }),
    ),
  );
});
await flush();
const es = (session: string) => {
  const src = sources.get(`/chat/stream?agent=a&session=${session}`);
  if (!src) throw new Error(`no stream for ${session}`);
  return src;
};

await t('events of one session re-render only that session window', async () => {
  const before1 = renders.get('s1') ?? 0;
  const before2 = renders.get('s2') ?? 0;
  await act(async () => {
    es('s1').emit('agent', { phase: 'start' });
    for (let i = 0; i < 20; i++) es('s1').emit('chat', { state: 'delta', text: 'hello ' });
    es('s1').emit('chat', { state: 'final', text: 'hello '.repeat(20) });
    es('s1').emit('agent', { phase: 'end' });
  });
  await flush();
  assert((renders.get('s1') ?? 0) > before1, 's1 window did not re-render');
  assert((renders.get('s2') ?? 0) === before2, `s2 window re-rendered ${(renders.get('s2') ?? 0) - before2} times on s1 events`);
  assert(rows.get('s1') === 1, `s1 shows ${rows.get('s1')} rows, expected 1`);
});

await t('rows past the ceiling are compacted after the turn ends and page back', async () => {
  // The window loaded nothing (s2 was empty) and then received 401
  // live rows; the server persisted every one of them, so a fresh
  // history read holds them all with their timestamps.
  const persisted: Array<{ kind: string; ts: number; text: string }> = [];
  const base = 1_000_000;
  const n = LIVE_ROWS_MAX + 1;
  for (let i = 0; i < n; i++) persisted.push({ kind: 'assistant_message', ts: base + i * 10, text: `live ${i}` });
  historyBySession.set('s2', persisted);
  await act(async () => {
    for (let i = 0; i < n; i++) {
      es('s2').emit('user_message', { text: `live ${i}`, ts: base + i * 10, from_agent: 'b', from_session: 'x' });
    }
  });
  await flush();
  assert((rows.get('s2') ?? 0) === n, `s2 holds ${rows.get('s2')} rows before the turn ends, expected ${n}`);
  // Nothing happens while the turn runs.
  await act(async () => {
    es('s2').emit('agent', { phase: 'start' });
  });
  await flush();
  await act(async () => {
    es('s2').emit('agent', { phase: 'end' });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1200));
  });
  await flush();
  assert((rows.get('s2') ?? 0) === LIVE_ROWS_KEEP, `s2 holds ${rows.get('s2')} rows after compaction, expected ${LIVE_ROWS_KEEP}`);
  assert(hasMore.get('s2') === true, 'compacted window must offer "load older"');
  const call = historyCalls[historyCalls.length - 1]!;
  assert(call.session === 's2' && call.limit === LIVE_ROWS_KEEP, `last history call ${JSON.stringify(call)}`);
  assert(rows.get('s1') === 1, 's1 untouched by s2 compaction');
  // "Load older" walks back into the dropped rows.
  await act(async () => {
    await loaders.get('s2')!();
  });
  await flush();
  const older = historyCalls[historyCalls.length - 1]!;
  assert(older.session === 's2' && older.before === base + (n - LIVE_ROWS_KEEP) * 10, `older page asked for ${JSON.stringify(older)}`);
  assert((rows.get('s2') ?? 0) === LIVE_ROWS_KEEP + 100, `s2 holds ${rows.get('s2')} rows after paging back, expected ${LIVE_ROWS_KEEP + 100}`);
  assert(hasMore.get('s2') === true, 'one dropped row is still beyond the page');
});

await t('a session under the ceiling is left alone', async () => {
  const calls = historyCalls.length;
  await act(async () => {
    es('s1').emit('agent', { phase: 'start' });
    es('s1').emit('chat', { state: 'final', text: 'again' });
    es('s1').emit('agent', { phase: 'end' });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1200));
  });
  assert(historyCalls.length === calls, 'no history read for a small session');
  assert(rows.get('s1') === 2, `s1 shows ${rows.get('s1')} rows, expected 2`);
});

await act(async () => root.unmount());
console.log(`\n${ok} passed, ${bad} failed`);
if (bad > 0) process.exit(1);
