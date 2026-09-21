// sentinel create: where does the trigger fire?
//
// Run: npx tsx src/tools/sentinel/current-session.test.mts
//
// 2026-09-15: an agent set a "resume my work" trigger from its working
// session, left dispatch.session out, and the trigger fired in `main` —
// a second instance of the agent ran next to the first on the same
// machines. It could not have named its session: nothing told it.
// Since 2026-09-21 a left-out session on a trigger for yourself means
// the session you are in (sub-agent turns excepted).

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = join(tmpdir(), `somora-sentinel-current-${process.pid}`);
process.env.SOMORA_HOME = HOME;
for (const a of ['worker', 'other']) {
  mkdirSync(join(HOME, 'agents', a), { recursive: true });
  writeFileSync(join(HOME, 'agents', a, 'AGENTS.md'), `# ${a}\n`);
  writeFileSync(join(HOME, 'agents', a, 'agent.yaml'), 'model: x\n');
}

const { sentinel } = await import('./tools.ts');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const WORK = '20260915-101500_gpu-migration';
function create(dispatch: Record<string, unknown>, session?: string, subagentDepth = 0) {
  const input = sentinel.inputSchema.parse({
    action: 'create',
    name: 'resume',
    source: { type: 'time', spec: { type: 'daily', time: '08:00' } },
    dispatch,
  });
  return sentinel.handler(input as never, { agent: 'worker', ...(session ? { session } : {}), ...(subagentDepth ? { subagentDepth } : {}), config: {} } as never) as Promise<Record<string, any>>;
}

{
  const r = await create({ agent: 'worker', session: 'current', prompt: 'resume' }, WORK);
  check('current: ok', r.ok === true, JSON.stringify(r));
  check('current: bound to the calling session', r.trigger?.dispatch?.session === WORK, r.trigger?.dispatch?.session);
  check('current: no warning', r.session_note === undefined);
}
{
  // The 2026-09-15 incident, now: session left out in a work session.
  const r = await create({ agent: 'worker', prompt: 'resume' }, WORK);
  check('omitted in a work session: fires HERE, not in main', r.trigger?.dispatch?.session === WORK, r.trigger?.dispatch?.session);
  check('omitted in a work session: says which session and how to get main', r.session_note?.includes(WORK) && /session: "main"/.test(r.session_note), r.session_note);
  check('omitted in a work session: note is in the hint too', (r.hint ?? '').includes(WORK));
}
{
  // A sub-agent's session is a sealed room nobody watches afterwards.
  const r = await create({ agent: 'worker', prompt: 'remind the user' }, '20260915-110000_sub-naxon-1-abcd', 1);
  check('omitted as a sub-agent: main, so a person sees it', r.trigger?.dispatch?.session === 'main', r.trigger?.dispatch?.session);
  check('omitted as a sub-agent: says why', /sub-agent/.test(r.session_note ?? '') && /"current"/.test(r.session_note ?? ''), r.session_note);
  const explicit = await create({ agent: 'worker', session: 'current', prompt: 'x' }, '20260915-110000_sub-naxon-1-abcd', 1);
  check('a sub-agent can still ask for its own session explicitly', explicit.trigger?.dispatch?.session === '20260915-110000_sub-naxon-1-abcd');
}
{
  const r = await create({ agent: 'worker', prompt: 'morning mail check' }, 'main');
  check('omitted in main: main, no warning', r.trigger?.dispatch?.session === 'main' && r.session_note === undefined);
}
{
  const r = await create({ agent: 'worker', session: 'main', prompt: 'x' }, WORK);
  check('explicit main from a work session: respected, no warning', r.trigger?.dispatch?.session === 'main' && r.session_note === undefined);
}
{
  const r = await create({ agent: 'other', session: 'current', prompt: 'x' }, WORK);
  check('current for ANOTHER agent: refused', r.ok === false && /YOUR current session/.test(r.error ?? ''), JSON.stringify(r));
}
{
  const r = await create({ agent: 'other', prompt: 'x' }, WORK);
  check('omitted for another agent: main, no warning (not our session)', r.ok === true && r.trigger?.dispatch?.session === 'main' && r.session_note === undefined, JSON.stringify(r));
}
{
  const r = await create({ agent: 'worker', session: 'current', prompt: 'x' });
  check('current without a session context: refused, not main', r.ok === false && /not available/.test(r.error ?? ''), JSON.stringify(r));
}

rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
