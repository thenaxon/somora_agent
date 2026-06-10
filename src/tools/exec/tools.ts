// `exec` and `process` tool definitions — Phase 5a.
//
// Two tools, both with target='local'|<resource-name> pattern:
//
//   - exec    : single-shot command. sync (default) or background.
//   - process : interact with running background jobs. action enum:
//               list, poll, log, write, kill.
//
// The model is steered (via tool descriptions) toward file_write for
// remote file writing and file_read for paging through big captured
// outputs — exec is for COMMANDS, not for moving file contents.

import { z } from 'zod';
import { logger } from '../../server/logger.ts';
import type { ToolDefinition } from '../types.ts';
import { resolveVisibleResourceFresh } from '../resources/visibility.ts';
import { auditPrivilegedExec, checkAllowBlocked } from './allowlist.ts';
import { checkBlacklist } from './blacklist.ts';
import { releaseRemoteSlot, tryAcquireExecSlot } from './concurrency.ts';
import {
  clearLivePid,
  clearLiveStdin,
  completeJob,
  failJob,
  getLivePid,
  getLiveStdin,
  listJobsForAgent,
  markJobKilled,
  readJobLog,
  readMeta,
  type JobMeta,
} from './job-store.ts';
import { killLocalJob, localExecBackground, localExecSync } from './local.ts';
import {
  killRemoteJob,
  pollRemoteJob,
  remoteExecBackground,
  remoteExecSync,
  tailRemoteJobLog,
} from './remote.ts';

// ─────────────────────────────────────────────────────────────────────
// exec
// ─────────────────────────────────────────────────────────────────────

const ExecInput = z
  .object({
    command: z
      .string()
      .min(1)
      .describe('Shell command to run. Interpreted by the target machine\'s default shell (bash/zsh/dash).'),
    target: z
      .string()
      .min(1)
      .default('local')
      .describe(
        '"local" (default) = the somora server\'s machine. Otherwise a configured ' +
          'resource name from resource_list. Resources must be set up in config.yaml — exec ' +
          'cannot dial ad-hoc SSH targets.',
      ),
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Working directory on the target machine. Absolute path, "~/..." or relative ' +
          '(both resolved against the target user\'s home). Must be an existing directory — ' +
          'exec fails with a cwd error otherwise.',
      ),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe('Extra environment variables to merge into the command shell. Local target only in v1.'),
    background: z
      .boolean()
      .default(false)
      .describe(
        'true = fire-and-forget. Returns a job_id immediately; output streams to disk; ' +
          'use process tool to poll/kill/read. Only supported on target="local" in v1.',
      ),
    timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(3_600_000)
      .default(60_000)
      .describe(
        'Sync only. Kill after this. Default 60s, max 1h. Ignored when background:true. ' +
          'When you intentionally run a long-blocking command, set this above the expected ' +
          'duration — e.g. for `sleep N` use `timeout_ms: (N+5)*1000`. The 60s default exists ' +
          'so a runaway command can\'t lock a tool slot for an hour.',
      ),
    pty: z
      .boolean()
      .default(false)
      .describe(
        'Allocate a pseudo-terminal so TUI tools and tools that check isatty() ' +
          '(vim, htop, claude, codex, color/cursor handling, progress bars) work correctly. ' +
          'Works on both target=local (via node-pty) and target=<resource> (via ssh2 native ' +
          'pty allocation). When pty is on, stdout and stderr merge into one stream ' +
          '(= same behavior as a real terminal). Background mode ignores this flag — ' +
          'TUI tools running in the background nobody can see; use tmux for that.',
      ),
    description: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Short human-readable label for this command. Surfaces in process_list and logs.'),
    inherit_agent_env: z
      .boolean()
      .default(false)
      .describe(
        'local target only. When false (default), somora-internal env vars ' +
          '(CLAUDE_CONFIG_DIR, SOMORA_CLAUDE_BIN) are stripped before spawn so a `claude` / ' +
          '`codex` invocation behaves like in the user\'s normal terminal. Set true only when ' +
          'you intentionally want somora\'s isolated claude tree visible to the spawned process.',
      ),
  })
  .strict();

interface ExecSyncResult {
  ok: boolean;
  background: false;
  target: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  ms: number;
  hint?: string;
}

interface ExecBackgroundResult {
  ok: true;
  background: true;
  job_id: string;
  pid: number;
  target: string;
  hint: string;
}

interface ExecBlockedResult {
  ok: false;
  background: false;
  blocked: true;
  reason: string;
  pattern: string;
}

interface ExecCapDeniedResult {
  ok: false;
  background: true;
  cap_denied: true;
  reason: string;
  per_agent_cap: number;
  global_cap: number;
}

type ExecResult =
  | ExecSyncResult
  | ExecBackgroundResult
  | ExecBlockedResult
  | ExecCapDeniedResult;

export const exec: ToolDefinition<z.infer<typeof ExecInput>, ExecResult> = {
  name: 'exec',
  toolset: 'exec',
  description:
    'Run a shell command on the somora server (target:"local") or on a configured SSH resource ' +
    '(target:<resource-name> from resource_list). Default: synchronous, returns stdout/stderr/exit. ' +
    'Set background:true for long-running tasks (build, test-suite, dev server) — returns a ' +
    'job_id immediately, output streams to disk, interact via the process tool ' +
    '(list/poll/log/write/kill). Background only works on target:"local" in v1. ' +
    '\n\n' +
    'IMPORTANT — to reach a remote host, ALWAYS use target:<resource-name> (from resource_list). ' +
    'NEVER shell out to raw `ssh user@host …` from target:"local" — that bypasses the resource ' +
    'config, hits hosts without keys, and produces "Permission denied (publickey,password)" errors. ' +
    'If a host you need is not in resource_list, ask the user to add it to config.yaml first. ' +
    '\n\n' +
    'IMPORTANT — non-empty stderr does NOT mean failure. Many tools (ssh, git, build systems) write ' +
    'progress / warnings to stderr while still exiting 0. Treat the call as failed ONLY when ' +
    '`ok:false` OR `exit_code != 0`. Do not retry just because stderr has content — read it for ' +
    'context but trust the exit status. ' +
    '\n\n' +
    'IMPORTANT — for writing FILES on a remote target, ALWAYS use file_write with target:<name>. ' +
    'NEVER use exec with heredoc/echo to push file content over SSH — shell escaping breaks for ' +
    'large or complex content. file_write goes through SFTP, binary-clean, no escape pain. ' +
    '\n\n' +
    'Remote targets have NO assumed binaries beyond POSIX core (sh, ls, cat, cp, mv, find, …). ' +
    'jq, python, node, rg etc. may be missing — probe first with `which <bin>` or `command -v` ' +
    'before relying on them, or pipe a JSON post-processor through stdin on the local side. ' +
    '\n\n' +
    'Output cap: 256 KB per stream for sync results and process_log tail reads. If your command ' +
    'produces more output, write it to a file on the target (e.g. ./out.log) and use file_read ' +
    'with offset/limit to page through. ' +
    '\n\n' +
    'Hard-blocked: rm -rf / and other destructive system ops, sudo/doas, fork bombs, system ' +
    'shutdown, chmod world-writable on /etc /usr /bin /sbin /boot /root /var /opt, reading ' +
    'private SSH keys, curl|sh / wget|sh untrusted-remote-exec patterns. Match → blocked:true ' +
    'in result with reason; the model should adapt the command rather than retry. ' +
    '\n\n' +
    'Per-resource override: a configured SSH resource may have an `allowBlocked` list in ' +
    'config.yaml that whitelists specific commands (e.g. `sudo ~/bin/update.sh`, `systemctl ' +
    'reboot`) despite the global block. Check resource_list — entries with allowBlockedCount>0 ' +
    'have privileged overrides. local target is never overridable.',
  inputSchema: ExecInput,
  jsonSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command.' },
      target: { type: 'string', description: '"local" or resource name.', default: 'local' },
      cwd: {
        type: 'string',
        description:
          'Working directory. Absolute, "~/..." or relative-to-target-home; must exist.',
      },
      env: { type: 'object', additionalProperties: { type: 'string' } },
      background: { type: 'boolean', default: false },
      timeout_ms: { type: 'integer', minimum: 100, maximum: 3_600_000, default: 60_000 },
      pty: { type: 'boolean', default: false },
      description: { type: 'string', maxLength: 200 },
      inherit_agent_env: { type: 'boolean', default: false },
    },
    required: ['command'],
    additionalProperties: false,
  },
  // Engine-level race: sync exec gets the caller's timeout_ms +2s
  // buffer (OpenClaw pattern). Background returns instantly so the
  // 30s default is plenty.
  defaultTimeoutMs: 30_000,
  timeoutFromInput: (input) =>
    input.background ? undefined : (input.timeout_ms ?? 60_000) + 2_000,
  maxTimeoutMs: 3_600_000 + 2_000,
  async handler(input, ctx): Promise<ExecResult> {
    // Hard-blacklist runs FIRST — never even reach a target if the
    // command is in the deny list.
    const block = checkBlacklist(input.command);
    let privilegedMatch: { entry: string; resource: string } | null = null;
    if (block.matched) {
      // Per-resource allowlist override: if the target is a configured
      // SSH resource and its `allowBlocked` array has an entry that
      // matches this command, we let it through. `local` target NEVER
      // gets to override — the host where somora runs is not a
      // dedicated-agent-workstation. See src/tools/exec/allowlist.ts.
      if (input.target !== 'local') {
        const resource = await resolveVisibleResourceFresh(ctx.agent, input.target);
        if (resource && resource.type === 'ssh' && resource.allowBlocked.length > 0) {
          const match = checkAllowBlocked(input.command, resource.allowBlocked);
          if (match) {
            privilegedMatch = { entry: match.entry, resource: input.target };
            logger.info({
              msg: 'exec.privileged_allowed',
              agent: ctx.agent,
              target: input.target,
              matched_entry: match.entry,
              blacklist_reason: block.reason,
              command_head: input.command.slice(0, 120),
            });
            // Audit-trail JSONL — fire-and-forget. We deliberately log
            // the AUTH event (matched + about-to-execute), not the
            // completion: the rest of somora's exec logging captures
            // exit codes, and one line per privileged-allow is the
            // simplest after-the-fact review surface.
            void auditPrivilegedExec({
              ts: Date.now(),
              agent: ctx.agent,
              session: ctx.session ?? 'unknown',
              resource: input.target,
              command_head: input.command.slice(0, 200),
              matched_entry: match.entry,
              blacklist_reason: block.reason,
              blacklist_pattern: block.pattern,
            });
          }
        }
      }
      if (!privilegedMatch) {
        logger.warn({
          msg: 'exec.blocked',
          agent: ctx.agent,
          target: input.target,
          reason: block.reason,
          pattern: block.pattern,
          command_head: input.command.slice(0, 120),
        });
        return {
          ok: false,
          background: false,
          blocked: true,
          reason: block.reason,
          pattern: block.pattern,
        };
      }
    }

    if (input.background) {
      // Concurrency cap — protects the host from runaway-loop spawn.
      // Counted across both local AND remote BG jobs since the load
      // matters regardless of where it lands. Slot is released in
      // job-store completion paths (job-store handles the lifecycle).
      const slot = tryAcquireExecSlot(ctx.agent);
      if (!slot.ok) {
        logger.warn({
          msg: 'exec.background.cap_denied',
          agent: ctx.agent,
          target: input.target,
          per_agent_now: slot.perAgentNow,
          global_now: slot.globalNow,
          reason: slot.reason,
        });
        return {
          ok: false,
          background: true,
          cap_denied: true,
          reason: slot.reason,
          per_agent_cap: slot.perAgentCap,
          global_cap: slot.globalCap,
        };
      }
      try {
        if (input.target === 'local') {
          const result = await localExecBackground({
            agent: ctx.agent,
            command: input.command,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.env ? { env: input.env } : {}),
            ...(input.description ? { description: input.description } : {}),
            releaseSlot: slot.release,
            stripSomoraInternalEnv: !input.inherit_agent_env,
          });
          return {
            ok: true,
            background: true,
            job_id: result.job_id,
            pid: result.pid,
            target: 'local',
            hint:
              `Job started in the background. Use process({action:"poll", job_id:"${result.job_id}"}) ` +
              `to check status, process({action:"log", job_id:"${result.job_id}"}) for output, ` +
              `process({action:"kill", job_id:"${result.job_id}"}) to terminate.`,
          };
        }
        // Remote target — nohup-pattern, slot is released when the
        // job is detected complete via process({action:"poll"}) or
        // explicitly killed. process tool calls completeJob/failJob/
        // markJobKilled which can in turn signal release; for v1 we
        // accept that the slot remains held until either a poll
        // resolves the job or it's killed. The cap protects against
        // floods, not against long-running jobs.
        const remote = await remoteExecBackground({
          agent: ctx.agent,
          target: input.target,
          command: input.command,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.description ? { description: input.description } : {}),
          releaseSlot: slot.release,
        });
        return {
          ok: true,
          background: true,
          job_id: remote.job_id,
          pid: remote.remote_pid,
          target: input.target,
          hint:
            `Remote job started on ${input.target} (pid=${remote.remote_pid}). Output streams to ` +
            `${remote.remote_out_file} / ${remote.remote_err_file} on the remote host. Use ` +
            `process({action:"poll", job_id:"${remote.job_id}"}) to check status, ` +
            `process({action:"log", job_id:"${remote.job_id}"}) for tail, ` +
            `process({action:"kill", job_id:"${remote.job_id}"}) to terminate. ` +
            `Note: ${remote.remote_out_file} stays on the remote host even after the job ends — ` +
            `clean up via exec({command:"rm /tmp/somora-exec-${remote.job_id}.*", target:"${input.target}"}) when done.`,
        };
      } catch (err) {
        // Spawn failed — release the slot so the cap doesn't leak.
        slot.release();
        throw err;
      }
    }

    // ── sync path ──
    if (input.target === 'local') {
      const r = await localExecSync({
        command: input.command,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
        timeoutMs: input.timeout_ms ?? 60_000,
        pty: input.pty,
        stripSomoraInternalEnv: !input.inherit_agent_env,
      });
      return {
        ok: r.exit_code === 0,
        background: false,
        target: 'local',
        exit_code: r.exit_code,
        stdout: r.stdout,
        stderr: r.stderr,
        truncated: r.truncated,
        ms: r.ms,
        ...(r.truncated
          ? {
              hint:
                'Output truncated at 256 KB per stream. For full content, redirect the command\'s ' +
                'output to a file on the target and use file_read with offset/limit.',
            }
          : {}),
      };
    }

    // Remote sync — env not threaded yet (ssh2 exec doesn't take it
    // as easily as local; would need shell-quoting). Surface a hint
    // if the model tries to set env on remote.
    if (input.env) {
      logger.info({
        msg: 'exec.remote.env_ignored',
        target: input.target,
        keys: Object.keys(input.env),
        hint: 'env-on-remote requires shell-quoted prefix; v1 ignores. Use cwd or cd in command.',
      });
    }
    const rr = await remoteExecSync({
      agent: ctx.agent,
      target: input.target,
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      timeoutMs: input.timeout_ms ?? 60_000,
      ...(input.pty ? { pty: true } : {}),
    });
    return {
      ok: rr.exit_code === 0,
      background: false,
      target: input.target,
      exit_code: rr.exit_code,
      stdout: rr.stdout,
      stderr: rr.stderr,
      truncated: rr.truncated,
      ms: rr.ms,
      ...(rr.truncated
        ? {
            hint:
              'Output truncated at 256 KB per stream. For full content, redirect the command\'s ' +
              'output to a file on the target and use file_read with target:"' +
              input.target +
              '" + offset/limit.',
          }
        : {}),
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// process — action enum for interacting with background exec jobs
// ─────────────────────────────────────────────────────────────────────

const ProcessInput = z
  .object({
    action: z
      .enum(['list', 'poll', 'log', 'write', 'kill'])
      .describe(
        'list (no other fields) | poll (job_id) | log (job_id, tail_lines?) | ' +
          'write (job_id, text) | kill (job_id, signal?)',
      ),
    job_id: z
      .string()
      .min(1)
      .optional()
      .describe('Required for poll/log/write/kill. From the job_id returned by exec({background:true}).'),
    text: z
      .string()
      .optional()
      .describe('write only — text to send to the job\'s stdin. Append \\n yourself if needed.'),
    tail_lines: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .default(50)
      .describe('log only — how many lines from the END of stdout/stderr each. Default 50.'),
    signal: z
      .enum(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'])
      .default('SIGTERM')
      .describe('kill only — signal to send. Default SIGTERM (graceful).'),
  })
  .strict();

interface ProcessListResult {
  action: 'list';
  count: number;
  jobs: Array<{
    job_id: string;
    target: string;
    state: JobMeta['state'];
    started_at: number;
    ended_at?: number;
    exit_code?: number | null;
    description?: string;
    command_head: string;
    ms?: number;
  }>;
}

interface ProcessPollResult {
  action: 'poll';
  job_id: string;
  state: JobMeta['state'];
  exit_code: number | null | undefined;
  pid: number | null;
  ms: number;
  error?: string;
}

interface ProcessLogResult {
  action: 'log';
  job_id: string;
  stdout_tail: string;
  stderr_tail: string;
  total_stdout_bytes: number;
  total_stderr_bytes: number;
  truncated: boolean;
  hint?: string;
}

interface ProcessWriteResult {
  action: 'write';
  job_id: string;
  ok: boolean;
  bytes_written: number;
  error?: string;
}

interface ProcessKillResult {
  action: 'kill';
  job_id: string;
  ok: boolean;
  signal_sent: string;
  was_running: boolean;
}

type ProcessResult =
  | ProcessListResult
  | ProcessPollResult
  | ProcessLogResult
  | ProcessWriteResult
  | ProcessKillResult;

function tailLines(text: string, n: number): string {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= n) return text;
  return lines.slice(-n).join('\n');
}

export const processTool: ToolDefinition<z.infer<typeof ProcessInput>, ProcessResult> = {
  name: 'process',
  toolset: 'exec',
  description:
    'Interact with background exec jobs. action="list" shows your agent\'s known jobs (newest ' +
    'first). action="poll" returns the current state of one job. action="log" returns the tail ' +
    'of stdout+stderr. action="write" pipes text into the job\'s stdin (local only). action="kill" ' +
    'sends a signal. Use exec({background:true}) to spawn jobs first; the job_id from that result ' +
    'feeds back into the actions here.',
  inputSchema: ProcessInput,
  jsonSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'poll', 'log', 'write', 'kill'] },
      job_id: { type: 'string' },
      text: { type: 'string' },
      tail_lines: { type: 'integer', minimum: 1, maximum: 2000, default: 50 },
      signal: {
        type: 'string',
        enum: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'],
        default: 'SIGTERM',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async handler(input, ctx): Promise<ProcessResult> {
    if (input.action === 'list') {
      const jobs = await listJobsForAgent(ctx.agent);
      return {
        action: 'list',
        count: jobs.length,
        jobs: jobs.map((j) => ({
          job_id: j.job_id,
          target: j.target,
          state: j.state,
          started_at: j.started_at,
          ...(j.ended_at !== undefined ? { ended_at: j.ended_at } : {}),
          ...(j.exit_code !== undefined ? { exit_code: j.exit_code } : {}),
          ...(j.description ? { description: j.description } : {}),
          command_head: j.command.slice(0, 120),
          ...(j.ended_at !== undefined ? { ms: j.ended_at - j.started_at } : {}),
        })),
      };
    }

    // poll/log/write/kill all need job_id
    if (!input.job_id) {
      throw new Error(`process: action='${input.action}' requires job_id`);
    }
    const meta = await readMeta(ctx.agent, input.job_id);
    if (!meta) {
      throw new Error(`process: job '${input.job_id}' not found for agent '${ctx.agent}'`);
    }

    if (input.action === 'poll') {
      // For remote running jobs, do an active probe — kill -0 +
      // exit-file check on the remote host. Updates meta.state to
      // done/failed when the remote process has finished. Local
      // jobs already have accurate live state via the child-process
      // close handler, so we trust meta as-is.
      if (meta.target !== 'local' && meta.state === 'running' && meta.pid != null) {
        try {
          const probe = await pollRemoteJob(ctx.agent, meta.target, meta.pid, input.job_id);
          if (!probe.alive) {
            if (probe.exit_code === null) {
              await failJob(ctx.agent, input.job_id, 'remote process gone without exit-file');
            } else {
              await completeJob(ctx.agent, input.job_id, probe.exit_code);
            }
            // Free the concurrency slot — remote jobs have no
            // local close-handler equivalent.
            releaseRemoteSlot(input.job_id);
            // Re-read meta to surface updated state in this same call.
            const fresh = await readMeta(ctx.agent, input.job_id);
            if (fresh) {
              return {
                action: 'poll',
                job_id: input.job_id,
                state: fresh.state,
                exit_code: fresh.exit_code,
                pid: fresh.pid,
                ms: (fresh.ended_at ?? Date.now()) - fresh.started_at,
                ...(fresh.error ? { error: fresh.error } : {}),
              };
            }
          }
        } catch (err) {
          logger.warn({
            msg: 'exec.process.remote_poll_failed',
            job_id: input.job_id,
            target: meta.target,
            err: (err as Error).message,
          });
        }
      }
      return {
        action: 'poll',
        job_id: input.job_id,
        state: meta.state,
        exit_code: meta.exit_code,
        pid: meta.pid,
        ms: (meta.ended_at ?? Date.now()) - meta.started_at,
        ...(meta.error ? { error: meta.error } : {}),
      };
    }

    if (input.action === 'log') {
      const lines = input.tail_lines ?? 50;
      // Remote: tail the files on the remote host via short ssh exec.
      if (meta.target !== 'local') {
        const remote = await tailRemoteJobLog(ctx.agent, meta.target, input.job_id);
        return {
          action: 'log',
          job_id: input.job_id,
          stdout_tail: tailLines(remote.stdout, lines),
          stderr_tail: tailLines(remote.stderr, lines),
          total_stdout_bytes: remote.stdout.length,
          total_stderr_bytes: remote.stderr.length,
          truncated: remote.truncated,
          ...(remote.truncated
            ? {
                hint:
                  `Tail capped at 256 KB per stream. Full logs live on the remote host at ` +
                  `/tmp/somora-exec-${input.job_id}.{out,err} on ${meta.target} — ` +
                  `use file_read with target:"${meta.target}" + offset/limit to page through.`,
              }
            : {}),
        };
      }
      // Local
      const log = await readJobLog(ctx.agent, input.job_id);
      if (!log) {
        throw new Error(`process: log not available for job '${input.job_id}'`);
      }
      const stdoutTail = tailLines(log.stdout_tail, lines);
      const stderrTail = tailLines(log.stderr_tail, lines);
      return {
        action: 'log',
        job_id: input.job_id,
        stdout_tail: stdoutTail,
        stderr_tail: stderrTail,
        total_stdout_bytes: log.total_stdout_bytes,
        total_stderr_bytes: log.total_stderr_bytes,
        truncated: log.truncated,
        ...(log.truncated
          ? {
              hint:
                'Tail capped at 256 KB per stream. Full output is on disk at ' +
                `~/.somora/agents/${ctx.agent}/exec-jobs/${input.job_id}/{stdout,stderr}.log — ` +
                'use file_read with offset/limit to page through.',
            }
          : {}),
      };
    }

    if (input.action === 'write') {
      if (input.text === undefined) {
        throw new Error('process: action="write" requires text');
      }
      if (meta.state !== 'running') {
        return {
          action: 'write',
          job_id: input.job_id,
          ok: false,
          bytes_written: 0,
          error: `job is ${meta.state}, not running — can't write to its stdin`,
        };
      }
      const stdin = getLiveStdin(input.job_id);
      if (!stdin) {
        return {
          action: 'write',
          job_id: input.job_id,
          ok: false,
          bytes_written: 0,
          error:
            'no live stdin handle for this job — likely orphaned across restart, ' +
            'or job is remote (remote stdin not supported in v1)',
        };
      }
      const buf = Buffer.from(input.text, 'utf8');
      const ok = stdin.write(buf);
      return {
        action: 'write',
        job_id: input.job_id,
        ok,
        bytes_written: buf.length,
      };
    }

    // kill
    if (meta.state !== 'running') {
      return {
        action: 'kill',
        job_id: input.job_id,
        ok: true,
        signal_sent: input.signal ?? 'SIGTERM',
        was_running: false,
      };
    }
    const sig = (input.signal ?? 'SIGTERM') as NodeJS.Signals;

    if (meta.target === 'local') {
      const pid = getLivePid(input.job_id) ?? meta.pid;
      if (!pid) {
        throw new Error('process: no pid recorded for job — cannot kill');
      }
      const r = killLocalJob(pid, sig);
      if (r.delivered) {
        await markJobKilled(ctx.agent, input.job_id, sig);
        clearLivePid(input.job_id);
        clearLiveStdin(input.job_id);
      }
      return {
        action: 'kill',
        job_id: input.job_id,
        ok: r.delivered,
        signal_sent: sig,
        was_running: r.delivered,
      };
    }

    // Remote kill via short ssh exec. We strip the SIG- prefix that
    // Node uses (`SIGTERM`) since `kill -SIGTERM` is non-portable on
    // some shells; the bare name (`TERM`) works everywhere.
    if (meta.pid == null) {
      throw new Error('process: no pid recorded for remote job — cannot kill');
    }
    const remoteSig = sig.replace(/^SIG/, '');
    const r = await killRemoteJob(ctx.agent, meta.target, meta.pid, remoteSig);
    if (r.delivered) {
      await markJobKilled(ctx.agent, input.job_id, sig);
      releaseRemoteSlot(input.job_id);
    }
    return {
      action: 'kill',
      job_id: input.job_id,
      ok: r.delivered,
      signal_sent: sig,
      was_running: r.delivered,
    };
  },
};

export function execTools(): ToolDefinition[] {
  return [exec, processTool] as ToolDefinition[];
}
