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

const patientFetch: ClientOptions['fetch'] = (input, init) => {
  const withDispatcher = { ...(init ?? {}), dispatcher: getDispatcher() } as Parameters<
    typeof undiciFetch
  >[1];
  return undiciFetch(input as Parameters<typeof undiciFetch>[0], withDispatcher) as unknown as Promise<Response>;
};

/**
 * Build an OpenAI client with somora's patient dispatcher applied.
 * Drop-in replacement for `new OpenAI(opts)` — same options, just no
 * implicit 5-min undici timeout.
 */
export function createPatientOpenAIClient(opts: ClientOptions): OpenAI {
  return new OpenAI({ ...opts, fetch: opts.fetch ?? patientFetch });
}
