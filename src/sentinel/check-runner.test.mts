// The check runner: the JSON contract, errors that are errors, the whole
// process tree dying on a timeout (setsid escapees included), capped
// output, blacked-out secrets, the copy's fingerprint, three languages
// and the environment a check gets.
import '../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConfigSchema } from '../config/types.ts';
import { installCheckScript, checkScriptDir } from './check-store.ts';
import { parseCheckOutput, runCheck, type CheckRunInput } from './check-runner.ts';

const home = process.env.SOMORA_HOME!;
mkdirSync(join(home, 'agents', 'ada'), { recursive: true });
writeFileSync(join(home, 'agents', 'ada', 'agent.yaml'), 'model: x\n');
writeFileSync(join(home, 'agents', 'ada', 'AGENTS.md'), '# ada\n');
const work = mkdtempSync(join(home, 'work-'));
const config = ConfigSchema.parse({
  providers: { p: { engine: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test-ABCDEFGHIJKLMNOP', models: [{ id: 'x', contextWindow: 1000 }] } },
  workspace: { default: work },
});

let n = 0;
async function check(body: string, ext = 'sh', over: Partial<CheckRunInput> = {}) {
  const id = `t${n++}`;
  const src = join(work, `${id}.${ext}`);
  writeFileSync(src, body);
  const script = await installCheckScript(id, src);
  return { id, script, run: () => runCheck({ triggerId: id, agent: 'ada', script, art: 1, timeoutMs: 5000, maxOutputBytes: 65536, config, ...over }) };
}

test('the contract: ready with summary and data; a debug line before the JSON is forgiven', async () => {
  const a = await (await check('echo \'{"ready": true, "summary": "glm loaded", "data": {"profile": "glm"}}\'')).run();
  assert.equal(a.ok, true, JSON.stringify(a));
  if (a.ok) assert.deepEqual(a.answer, { ready: true, summary: 'glm loaded', data: { profile: 'glm' } });
  const b = await (await check('echo "checking…"\necho \'{"ready": false}\'')).run();
  assert.equal(b.ok && b.answer.ready, false);
});

test('errors are errors: missing ready, not JSON, bad final, exit code, nothing printed', async () => {
  for (const [body, re] of [
    ['echo \'{"summary": "x"}\'', /missing "ready"/],
    ['echo \'{"data": [1]}\'', /judged check: pass decision/],
    ['echo hello', /not JSON/],
    ['echo \'{"ready": true, "final": "done"}\'', /"final" can only be "failed"/],
    ['echo boom >&2; exit 3', /exit code 3: boom/],
    ['true', /printed nothing/],
    ['echo \'[1,2]\'', /one JSON object/],
  ] as const) {
    const r = await (await check(body)).run();
    assert.equal(r.ok, false, body);
    if (!r.ok) {
      assert.match(r.error, re, body);
      assert.equal(r.errorClass, 'temporary');
    }
  }
  const failed = await (await check('echo \'{"final": "failed", "summary": "switch aborted"}\'')).run();
  assert.equal(failed.ok && failed.answer.final, 'failed', 'final:failed needs no ready');
});

test('Art 2 needs data', async () => {
  assert.equal(parseCheckOutput('{"summary":"x"}', 2).ok, false);
  assert.equal(parseCheckOutput('{"data":[]}', 2).ok, true);
});

test('timeout kills the whole tree, setsid escapees included, and resolves at the deadline', async () => {
  const marker = join(work, 'alive-marker');
  const c = await check(`setsid bash -c 'sleep 30; touch ${marker}' &\nsleep 30\necho '{"ready": true}'`, 'sh', { timeoutMs: 1500 });
  const t0 = Date.now();
  const r = await c.run();
  const took = Date.now() - t0;
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /timed out after 2 s|timed out after 1 s/);
  assert.ok(took < 9000, `resolved after ${took} ms`);
  await new Promise((res) => setTimeout(res, 500));
  const left = spawnSync('pgrep', ['-f', `touch ${marker}`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(left, '', 'no escaped sleeper left');
});

test('a script that exits but leaves a setsid child holding the pipe still answers, and the child dies', async () => {
  const marker = join(work, 'orphan-marker');
  const c = await check(`setsid bash -c 'sleep 20; touch ${marker}' &\necho '{"ready": true}'`);
  const t0 = Date.now();
  const r = await c.run();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Date.now() - t0 < 4000, 'did not wait for the orphan');
  await new Promise((res) => setTimeout(res, 300));
  if (process.platform === 'linux') {
    assert.equal(spawnSync('pgrep', ['-f', `touch ${marker}`], { encoding: 'utf8' }).stdout.trim(), '', 'the orphan was killed');
  }
});

test('output over the cap is an error', async () => {
  const r = await (await check('head -c 5000 /dev/zero | tr "\\0" a; echo', 'sh', { maxOutputBytes: 1024 })).run();
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /output over 1024 bytes/);
});

test('secrets are blacked out before anyone reads the output', async () => {
  const r = await (await check('echo \'{"ready": true, "summary": "key sk-test-ABCDEFGHIJKLMNOP and Bearer abcdefghijklmnop"}\'')).run();
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.doesNotMatch(r.answer.summary ?? '', /ABCDEFGHIJKLMNOP|abcdefghijklmnop/);
    assert.match(r.answer.summary ?? '', /\[redacted\]/);
  }
});

test('the copy runs, not the workspace file; a changed copy is a permanent error', async () => {
  const c = await check('echo \'{"ready": true}\'');
  writeFileSync(join(work, `${c.id}.sh`), 'echo \'{"ready": false}\'');
  const r1 = await c.run();
  assert.equal(r1.ok && r1.answer.ready, true, 'editing the workspace file changes nothing');
  appendFileSync(join(checkScriptDir(c.id), c.script.file), '\n# tampered\n');
  const r2 = await c.run();
  assert.equal(r2.ok, false);
  if (!r2.ok) {
    assert.equal(r2.errorClass, 'permanent');
    assert.match(r2.error, /changed outside somora/);
  }
});

test('python and node checks run; the environment carries the state folder, not the login key', async () => {
  process.env.SOMORA_KEY = 'somora_ShouldNeverReachAChildProcess0000000000000';
  const py = await (await check('import json, os\nprint(json.dumps({"ready": True, "data": {"state": os.environ["SOMORA_SENTINEL_STATE_DIR"], "key": os.environ.get("SOMORA_KEY", "")}}))', 'py')).run();
  assert.equal(py.ok, true, JSON.stringify(py));
  if (py.ok) {
    const d = py.answer.data as { state: string; key: string };
    assert.ok(existsSync(d.state), 'state folder exists');
    assert.equal(d.key, '', 'SOMORA_KEY is stripped');
  }
  const js = await (await check('console.log(JSON.stringify({ ready: process.env.SOMORA_AGENT === "ada" }))', 'mjs')).run();
  assert.equal(js.ok && js.answer.ready, true, JSON.stringify(js));
  delete process.env.SOMORA_KEY;
});

test('the state folder survives between runs', async () => {
  const c = await check('f="$SOMORA_SENTINEL_STATE_DIR/n"; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f"; echo "{\\"ready\\": $([ $n -ge 2 ] && echo true || echo false)}"');
  const r1 = await c.run();
  const r2 = await c.run();
  assert.equal(r1.ok && r1.answer.ready, false);
  assert.equal(r2.ok && r2.answer.ready, true);
  void readFileSync;
});
