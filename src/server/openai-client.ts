// Shared OpenAI SDK client factory for somora.
//
// Why this exists: somora new's `OpenAI` from the `openai` package in
// at least five places (engine adapter, vision worker, compaction
// summarizer, deep dream LLM, REM extract). Each instantiation that
// goes through Node's globalThis.fetch ends up on undici's default
// dispatcher, which has headersTimeout=300_000 and bodyTimeout=300_000
// (5 min each). Local model providers like omlx routinely take 10–20
// minutes per response when the model is "thinking"; the SDK call
// then dies mid-response with `TypeError: fetch failed (cause:
// UND_ERR_BODY_TIMEOUT)` and somora retries / falls back even though
// the model would have answered eventually.
//
// Solution: dedicated undici Agent with both timeouts disabled, and a
// custom fetch passed to the OpenAI client so all SDK requests use it.
// AbortController is honored normally — caller-side cancellation still
// works, the change only removes the implicit 5-min ceiling.

import OpenAI, { type ClientOptions } from 'openai';
import { Agent, fetch as undiciFetch } from 'undici';

let dispatcher: Agent | undefined;

function getDispatcher(): Agent {
  if (!dispatcher) {
    dispatcher = new Agent({
      // Disable both ends of undici's request lifetime cap. Long
      // local-model thinking ("omlx, 20 min") and slow-start API
      // providers both require this.
      headersTimeout: 0,
      bodyTimeout: 0,
      // Keepalive tuning: the SDK reuses connections via the dispatcher
      // pool. 60s/600s mirrors loopback-fetch.ts.
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
    });
  }
  return dispatcher;
}

const patientFetch: ClientOptions['fetch'] = async (input, init) => {
  const withDispatcher = { ...(init ?? {}), dispatcher: getDispatcher() } as Parameters<
    typeof undiciFetch
  >[1];
  const res = (await undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    withDispatcher,
  )) as unknown as Response;
  return normalizeErrorBody(res);
};

/**
 * vLLM (and other bare servers) answer errors as a TOP-LEVEL
 * `{ "object": "error", "message": "…" }`. The OpenAI SDK only reads
 * `body.error.message`, so through it such a 400 surfaces as
 * "400 status code (no body)" and every message-based classifier
 * downstream (context overflow, reasoning-effort rejection) goes blind.
 * LiteLLM and OpenAI wrap as `{ "error": { "message" } }` and are left
 * alone. Re-wrapping at the fetch layer keeps the SDK untouched.
 */
async function normalizeErrorBody(res: Response): Promise<Response> {
  if (res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) return res;
  let text: string;
  try {
    text = await res.text();
  } catch {
    return res;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  const wrapped =
    body && typeof body === 'object' && !('error' in body) && 'message' in body
      ? JSON.stringify({ error: body })
      : text;
  return new Response(wrapped, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * Build an OpenAI client with somora's patient dispatcher applied.
 * Drop-in replacement for `new OpenAI(opts)` — same options, just no
 * implicit 5-min undici timeout.
 */
export function createPatientOpenAIClient(opts: ClientOptions): OpenAI {
  return new OpenAI({ ...opts, fetch: opts.fetch ?? patientFetch });
}
