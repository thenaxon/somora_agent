// "Is this model unreachable, or did it reject the request?" — the one
// question every fallback path has to answer before switching models.
//
// Unreachable (connection refused, DNS, socket reset, request timeout,
// 5xx, 429 once the SDK's own retries are spent) justifies trying the
// next model: the request was fine, the host was not. A 4xx other than
// 429/408 is the opposite — the host answered and said no (bad
// parameter, unsupported reasoning level, auth, unknown model). Moving
// on would hide a config error behind a different model's answer, so
// callers must NOT fall back on those.
//
// Shared by the REM worker fallback (dream/rem-extract.ts); the chat
// turn chain (server/run-turn-fallback.ts) still retries on any
// pre-content failure and may adopt this later.

const RETRYABLE_STATUS = new Set([408, 429]);
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const NETWORK_MESSAGE = /timed out|timeout|fetch failed|socket hang up|\bterminated\b|connection error|other side closed/i;

/** The chat chain sees failures as TEXT (the engine's error event), not
 *  as an Error object: classify the message the same way. A 5xx / 429 /
 *  408 status in the text or a network phrase means "the host was not
 *  there", a plain 4xx means "the host said no". */
export function isAvailabilityMessage(message: string): boolean {
  if (!message) return false;
  if (NETWORK_MESSAGE.test(message)) return true;
  for (const code of NETWORK_CODES) if (message.includes(code)) return true;
  const status = message.match(/\b(5\d\d|429|408)\b/);
  if (status) return true;
  return false;
}

export function isAvailabilityError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; status?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  // openai SDK: APIConnectionError / APIConnectionTimeoutError carry no
  // status — the request never got an answer.
  if (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError') return true;
  if (typeof e.status === 'number') {
    if (e.status >= 500) return true;
    if (RETRYABLE_STATUS.has(e.status)) return true;
    // Any other 4xx: the backend answered and rejected the request.
    if (e.status >= 400) return false;
  }
  if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) return true;
  const cause = e.cause as { code?: unknown } | undefined;
  if (cause && typeof cause.code === 'string' && NETWORK_CODES.has(cause.code)) return true;
  if (typeof e.message === 'string' && NETWORK_MESSAGE.test(e.message)) return true;
  return false;
}
