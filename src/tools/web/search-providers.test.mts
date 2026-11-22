// web_search providers (2026-11-22): Brave and SearXNG behind one tool,
// in the operator's order, the next one only when the one before fails.
// Both providers run against a local fake server; nothing goes out.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebConfigSchema, type Config } from '../../config/types.ts';
import {
  braveSearch,
  searchInOrder,
  searchOrder,
  searxngEndpoint,
  searxngSearch,
  SearchProviderError,
  type ProviderCall,
} from './search-providers.ts';

// ── fake providers ────────────────────────────────────────────────────

let handler: (req: IncomingMessage, res: ServerResponse) => void = (_q, r) => r.end();
const server = createServer((req, res) => handler(req, res));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const cfg = (web: unknown): Config => ({ web: WebConfigSchema.parse(web) }) as unknown as Config;

// ── order ─────────────────────────────────────────────────────────────

test('without an order: Brave first, SearXNG second, each only when configured', () => {
  assert.deepEqual(searchOrder(cfg({ brave: { apiKey: 'k' } })), ['brave']);
  assert.deepEqual(searchOrder(cfg({ searxng: { baseUrl: 'http://10.0.0.5:8888' } })), ['searxng']);
  assert.deepEqual(searchOrder(cfg({ brave: { apiKey: 'k' }, searxng: { baseUrl: 'http://10.0.0.5:8888' } })), ['brave', 'searxng']);
  assert.deepEqual(searchOrder(cfg({})), []);
});

test('the order decides, and one entry means no reserve', () => {
  const both = { brave: { apiKey: 'k' }, searxng: { baseUrl: 'http://10.0.0.5:8888' } };
  assert.deepEqual(searchOrder(cfg({ ...both, search: { order: ['searxng', 'brave'] } })), ['searxng', 'brave']);
  assert.deepEqual(searchOrder(cfg({ ...both, search: { order: ['searxng'] } })), ['searxng']);
});

test('config: a provider in the order must be configured, listed once, and known', () => {
  const r1 = WebConfigSchema.safeParse({ brave: { apiKey: 'k' }, search: { order: ['searxng', 'brave'] } });
  assert.equal(r1.success, false);
  assert.match(JSON.stringify(r1.error?.issues), /web\.searxng\.baseUrl is not set/);
  assert.equal(WebConfigSchema.safeParse({ brave: { apiKey: 'k' }, search: { order: ['brave', 'brave'] } }).success, false);
  assert.equal(WebConfigSchema.safeParse({ brave: { apiKey: 'k' }, search: { order: ['google'] } }).success, false);
  assert.equal(WebConfigSchema.safeParse({ brave: { apiKey: 'k' }, search: { order: [] } }).success, false);
  assert.equal(WebConfigSchema.safeParse({ searxng: { baseUrl: 'ftp://x' } }).success, false);
  assert.equal(WebConfigSchema.safeParse({ searxng: { baseUrl: 'not a url' } }).success, false);
  assert.equal(WebConfigSchema.safeParse({}).success, true, 'nothing configured stays valid');
});

// ── in order ──────────────────────────────────────────────────────────

const hit = { title: 't', url: 'https://example.org/', description: 'd' };

test('the first provider answers: the second is never asked', async () => {
  const asked: string[] = [];
  const call: ProviderCall = async (id) => {
    asked.push(id);
    return { results: [hit] };
  };
  const out = await searchInOrder(['searxng', 'brave'], { query: 'q' }, call);
  assert.deepEqual(asked, ['searxng']);
  assert.equal(out.provider, 'searxng');
  assert.deepEqual(out.failed, []);
});

test('the first fails: the next answers and the result says why', async () => {
  const call: ProviderCall = async (id) => {
    if (id === 'searxng') throw new SearchProviderError('searxng', 'searxng search timed out after 30s', true);
    return { results: [hit] };
  };
  const out = await searchInOrder(['searxng', 'brave'], { query: 'q' }, call);
  assert.equal(out.provider, 'brave');
  assert.deepEqual(out.failed, [{ provider: 'searxng', error: 'searxng search timed out after 30s' }]);
});

test('a rejected query does not go to the next provider', async () => {
  const asked: string[] = [];
  const call: ProviderCall = async (id) => {
    asked.push(id);
    throw new SearchProviderError(id, `${id} search 422: bad query`, false);
  };
  await assert.rejects(searchInOrder(['brave', 'searxng'], { query: 'q' }, call), /brave search 422/);
  assert.deepEqual(asked, ['brave']);
});

test('all fail: every error, the first provider first', async () => {
  const call: ProviderCall = async (id) => {
    throw new SearchProviderError(id, `${id} down`, true);
  };
  await assert.rejects(searchInOrder(['searxng', 'brave'], { query: 'q' }, call), /^Error: searxng down \| brave down$/);
});

test('an empty result is an answer, not a failure', async () => {
  const asked: string[] = [];
  const out = await searchInOrder(['brave', 'searxng'], { query: 'q' }, async (id) => {
    asked.push(id);
    return { results: [] };
  });
  assert.equal(out.provider, 'brave');
  assert.deepEqual(asked, ['brave']);
});

// ── SearXNG ───────────────────────────────────────────────────────────

test('searxng: address forms all reach /search', () => {
  assert.equal(searxngEndpoint('http://h:8888'), 'http://h:8888/search');
  assert.equal(searxngEndpoint('http://h:8888/'), 'http://h:8888/search');
  assert.equal(searxngEndpoint('http://h/searx/'), 'http://h/searx/search');
  assert.equal(searxngEndpoint('http://h:8888/search'), 'http://h:8888/search');
  assert.equal(searxngEndpoint('http://h:8888', new URLSearchParams({ q: 'a b' })), 'http://h:8888/search?q=a+b');
});

test('config: an address with ?… or #… is refused', () => {
  assert.equal(WebConfigSchema.safeParse({ searxng: { baseUrl: 'http://h:8888/search?q=old' } }).success, false);
  assert.equal(WebConfigSchema.safeParse({ searxng: { baseUrl: 'http://h:8888/#x' } }).success, false);
});

test('searxng: maps the answer, applies count and freshness, says what it ignored', async () => {
  let seen = '';
  handler = (req, res) => {
    seen = req.url ?? '';
    json(res, 200, {
      results: [
        { title: 'A', url: 'https://a.example/', content: 'about a', publishedDate: '2026-11-01T00:00:00' },
        { title: 'B', url: 'https://b.example/', content: 'about b' },
        { title: 'no url' },
        { title: 'C', url: 'https://c.example/', content: 'about c' },
      ],
      unresponsive_engines: [['wikidata', 'timeout']],
    });
  };
  const out = await searxngSearch({ query: 'somora agents', count: 2, freshness: 'week', country: 'AT' }, `${base}/`);
  const u = new URL(seen, base);
  assert.equal(u.pathname, '/search');
  assert.equal(u.searchParams.get('q'), 'somora agents');
  assert.equal(u.searchParams.get('format'), 'json');
  assert.equal(u.searchParams.get('time_range'), 'week');
  assert.deepEqual(out.results, [
    { title: 'A', url: 'https://a.example/', description: 'about a', age: '2026-11-01T00:00:00' },
    { title: 'B', url: 'https://b.example/', description: 'about b' },
  ]);
  assert.deepEqual(out.ignored, ['country']);
});

test('searxng: nothing found because no engine answered is a failure', async () => {
  handler = (_req, res) => json(res, 200, { results: [], unresponsive_engines: [['google', 'timeout'], ['bing', 'CAPTCHA']] });
  await assert.rejects(searxngSearch({ query: 'q' }, base), (e: unknown) => {
    assert.ok(e instanceof SearchProviderError);
    assert.equal(e.tryNext, true);
    assert.match(e.message, /engines did not answer: google \(timeout\), bing \(CAPTCHA\)/);
    return true;
  });
});

test('searxng: nothing found with every engine answering is an empty answer', async () => {
  handler = (_req, res) => json(res, 200, { results: [], unresponsive_engines: [] });
  assert.deepEqual((await searxngSearch({ query: 'q' }, base)).results, []);
});

test('searxng: 403 says how to allow JSON, and lets the next provider try', async () => {
  handler = (_req, res) => {
    res.writeHead(403);
    res.end('Forbidden');
  };
  await assert.rejects(searxngSearch({ query: 'q' }, base), (e: unknown) => {
    assert.ok(e instanceof SearchProviderError);
    assert.equal(e.tryNext, true);
    assert.match(e.message, /search\.formats/);
    return true;
  });
});

test('searxng: an HTML page instead of JSON is a failure', async () => {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>login</html>');
  };
  await assert.rejects(searxngSearch({ query: 'q' }, base), /not its JSON/);
});

test('searxng: no answer in time is a failure that tries the next', async () => {
  handler = () => {
    /* never answers */
  };
  await assert.rejects(searxngSearch({ query: 'q' }, base, 200), (e: unknown) => {
    assert.ok(e instanceof SearchProviderError);
    assert.equal(e.tryNext, true);
    assert.match(e.message, /timed out/);
    return true;
  });
});

test('searxng: headers then silence still times out', async () => {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"results": [');
    /* never ends */
  };
  await assert.rejects(searxngSearch({ query: 'q' }, base, 300), (e: unknown) => {
    assert.ok(e instanceof SearchProviderError);
    assert.equal(e.tryNext, true);
    assert.match(e.message, /timed out/);
    return true;
  });
});

test('searxng: 404 is a wrong address, so the next provider may answer', async () => {
  handler = (_req, res) => {
    res.writeHead(404);
    res.end('Not Found');
  };
  await assert.rejects(searxngSearch({ query: 'q' }, base), (e: unknown) => e instanceof SearchProviderError && e.tryNext);
});

test('searxng: nothing listening is a failure that tries the next', async () => {
  await assert.rejects(searxngSearch({ query: 'q' }, 'http://127.0.0.1:1'), (e: unknown) => e instanceof SearchProviderError && e.tryNext);
});

// ── Brave ─────────────────────────────────────────────────────────────

test('brave: sends key and options, maps the answer', async () => {
  let seen: IncomingMessage | null = null;
  handler = (req, res) => {
    seen = req;
    json(res, 200, { web: { results: [{ title: 'A', url: 'https://a.example/', description: 'about a', page_age: '2026-11-01', language: 'de' }] } });
  };
  const out = await braveSearch({ query: 'q', count: 3, country: 'at', freshness: 'month' }, 'KEY', 5000, `${base}/res/v1/web/search`);
  const u = new URL(seen!.url!, base);
  assert.equal(seen!.headers['x-subscription-token'], 'KEY');
  assert.equal(u.searchParams.get('country'), 'AT');
  assert.equal(u.searchParams.get('freshness'), 'pm');
  assert.equal(u.searchParams.get('count'), '3');
  assert.deepEqual(out.results, [{ title: 'A', url: 'https://a.example/', description: 'about a', age: '2026-11-01', language: 'de' }]);
  assert.equal(out.ignored, undefined);
});

test('brave: quota and bad key try the next, a malformed query does not', async () => {
  // Brave's real bodies (2026-11-22): a bad key is a 422 too, told apart by its code.
  const badKey = { type: 'ErrorResponse', error: { status: 422, detail: 'The provided API key is invalid.', meta: { component: 'authentication' }, code: 'SUBSCRIPTION_TOKEN_INVALID' } };
  const badQuery = { type: 'ErrorResponse', error: { status: 422, detail: 'Count should be less than or equal to 20', meta: { component: 'api' }, code: 'VALIDATION' } };
  for (const [status, body, tryNext] of [
    [429, { error: 'x' }, true],
    [401, { error: 'x' }, true],
    [403, { error: 'x' }, true],
    [500, { error: 'x' }, true],
    [503, { error: 'x' }, true],
    [422, badKey, true],
    [422, badQuery, false],
    [400, { error: 'x' }, false],
  ] as const) {
    handler = (_req, res) => json(res, status, body);
    await assert.rejects(braveSearch({ query: 'q' }, 'KEY', 5000, `${base}/b`), (e: unknown) => {
      assert.ok(e instanceof SearchProviderError, String(status));
      assert.equal(e.tryNext, tryNext, `status ${status}`);
      assert.match(e.message, new RegExp(`^brave search ${status}`));
      return true;
    });
  }
  handler = (_req, res) => json(res, 422, badKey);
  await assert.rejects(braveSearch({ query: 'q' }, 'KEY', 5000, `${base}/b`), /^Error: brave search 422: The provided API key is invalid\. \(SUBSCRIPTION_TOKEN_INVALID\)$/);
});
