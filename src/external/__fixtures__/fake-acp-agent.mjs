#!/usr/bin/env node
// A small ACP agent for tests (stdio). What it does depends on the prompt:
//   default      thought, one tool call (exec), reply "You said: <text>"
//   "permission" asks for permission first; replies "allowed" / "denied"
//   "slow"       streams for ~10 s, honours session/cancel
//   "crash"      exits in the middle of the turn
//   "remember X" / "recall"  session memory across turns
//   images       the reply counts the image blocks
// Env: FAKE_AGENT_NAME (agentInfo.name), FAKE_NO_RESUME=1 (offer load only),
//      FAKE_STDERR (written to stderr at start), FAKE_FAIL_INIT=1.
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR + '\n');
if (process.env.FAKE_FAIL_INIT) {
  process.stderr.write('fake agent: refusing to start\n');
  process.exit(7);
}

const sessions = new Map();
let n = 0;
const cancelled = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t) => ({ type: 'text', text: t });

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((conn) => {
  const update = (sessionId, u) => conn.sessionUpdate({ sessionId, update: u });
  return {
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: process.env.FAKE_AGENT_NAME ?? 'fake-agent', title: 'Fake Agent', version: '1.2.3' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          sessionCapabilities: { list: {}, ...(process.env.FAKE_NO_RESUME ? {} : { resume: {} }), close: {} },
        },
        authMethods: [],
      };
    },
    async authenticate() {},
    async newSession() {
      const id = `fake-${++n}-${process.pid}`;
      sessions.set(id, { memory: null, history: [] });
      return { sessionId: id };
    },
    async resumeSession(p) {
      if (!sessions.has(p.sessionId)) throw new Error(`unknown session ${p.sessionId}`);
      return {};
    },
    async loadSession(p) {
      const s = sessions.get(p.sessionId);
      if (!s) throw new Error(`unknown session ${p.sessionId}`);
      for (const h of s.history) {
        await update(p.sessionId, { sessionUpdate: 'user_message_chunk', content: text(h.user) });
        await update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: text(h.agent) });
      }
      return {};
    },
    async listSessions() {
      return { sessions: [...sessions.keys()].map((id) => ({ sessionId: id, cwd: '/', title: id })) };
    },
    async cancel(p) {
      cancelled.add(p.sessionId);
    },
    async prompt(p) {
      const sid = p.sessionId;
      const s = sessions.get(sid);
      if (!s) throw new Error(`unknown session ${sid}`);
      cancelled.delete(sid);
      const t = p.prompt.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      const images = p.prompt.filter((b) => b.type === 'image').length;
      const say = async (reply) => {
        for (const piece of reply.match(/.{1,6}/gs) ?? []) await update(sid, { sessionUpdate: 'agent_message_chunk', content: text(piece) });
        s.history.push({ user: t, agent: reply });
      };
      await update(sid, { sessionUpdate: 'agent_thought_chunk', content: text(`thinking about: ${t.slice(0, 40)}`) });

      if (t.includes('crash')) {
        await update(sid, { sessionUpdate: 'agent_message_chunk', content: text('about to') });
        setTimeout(() => process.exit(3), 50);
        await sleep(10_000);
      }
      if (t.includes('slow')) {
        for (let i = 0; i < 40; i++) {
          if (cancelled.has(sid)) return { stopReason: 'cancelled' };
          await update(sid, { sessionUpdate: 'agent_message_chunk', content: text(`${i} `) });
          await sleep(250);
        }
        return { stopReason: 'end_turn' };
      }
      if (t.includes('permission')) {
        await update(sid, { sessionUpdate: 'tool_call', toolCallId: 'p1', title: 'exec: rm -rf /tmp/x', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf /tmp/x' } });
        const res = await conn.requestPermission({
          sessionId: sid,
          toolCall: { toolCallId: 'p1', title: 'exec: rm -rf /tmp/x', rawInput: { command: 'rm -rf /tmp/x' } },
          options: [
            { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        });
        const allowed = res.outcome.outcome === 'selected' && res.outcome.optionId === 'yes';
        await update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'p1', status: allowed ? 'completed' : 'failed', content: [{ type: 'content', content: text(allowed ? 'removed' : 'not allowed') }] });
        await say(allowed ? 'allowed' : 'denied');
        return { stopReason: 'end_turn' };
      }
      const m = /remember (\w+)/.exec(t);
      if (m) {
        s.memory = m[1];
        await say(`ok, ${m[1]}`);
        return { stopReason: 'end_turn' };
      }
      if (t.includes('recall')) {
        await say(`you said ${s.memory ?? 'nothing'}`);
        return { stopReason: 'end_turn' };
      }
      await update(sid, { sessionUpdate: 'tool_call', toolCallId: `c${s.history.length}`, title: 'exec: echo hi', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo hi' } });
      await update(sid, { sessionUpdate: 'tool_call_update', toolCallId: `c${s.history.length}`, status: 'completed', content: [{ type: 'content', content: text('hi') }] });
      await update(sid, { sessionUpdate: 'usage_update', used: 1234, size: 100000 });
      await say(`You said: ${t}${images ? ` (+${images} image${images > 1 ? 's' : ''})` : ''}`);
      return { stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } };
    },
  };
}, stream);
