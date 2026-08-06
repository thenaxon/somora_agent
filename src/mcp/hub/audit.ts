// Audit trail for NOTABLE external-MCP calls (design §5) — upstream
// isError, transport failures, calls against non-connected servers.
// Routine successful calls only get the Pino `mcp.hub.call` line.
//
// Same fire-and-forget posture as the exec audit
// (src/tools/exec/allowlist.ts): audit I/O must never block or fail the
// actual call. UNLIKE the exec audit this one rotates: rotate-on-write
// at 5 MB, one `.1` generation kept (decided 2026-08-06 — external
// servers can produce far more entries than privileged execs).

import { existsSync } from 'node:fs';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const AUDIT_DIR = join(SOMORA_HOME, 'audit');
export const MCP_AUDIT_PATH = join(AUDIT_DIR, 'mcp-calls.jsonl');
const MAX_AUDIT_BYTES = 5 * 1024 * 1024;

export interface McpAuditEntry {
  ts: number;
  server: string;
  tool: string;
  /** First 200 chars of the JSON-stringified args — full args never persisted. */
  args_head: string;
  kind: 'is_error' | 'call_failed' | 'server_unavailable';
  detail: string;
  ms?: number;
}

export async function auditMcpCall(entry: McpAuditEntry): Promise<void> {
  try {
    if (!existsSync(AUDIT_DIR)) await mkdir(AUDIT_DIR, { recursive: true });
    try {
      const s = await stat(MCP_AUDIT_PATH);
      if (s.size > MAX_AUDIT_BYTES) {
        await rename(MCP_AUDIT_PATH, `${MCP_AUDIT_PATH}.1`);
      }
    } catch {
      // ENOENT — first write.
    }
    await appendFile(MCP_AUDIT_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Intentional swallow — audit logging must NOT block the call path.
  }
}

export function argsHead(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args).slice(0, 200);
  } catch {
    return '[unserializable]';
  }
}
