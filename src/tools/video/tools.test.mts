// video_generate and video_models as tools: media files are read under the
// file_read rules and reach the provider as bytes, never as paths; the model
// list tells an agent which input files a model takes.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../types.ts';

// Its own data folder, for the same reason as src/videogen/media.test.mts.
process.env.SOMORA_HOME = join(process.env.SOMORA_HOME!, 'video-tools-test');
const home = process.env.SOMORA_HOME;
mkdirSync(home, { recursive: true });
const { ConfigSchema } = await import('../../config/types.ts');
const { clearCatalogCache } = await import('../../media/capabilities.ts');
const { videoGenerate, videoModels } = await import('./tools.ts');
mkdirSync(join(home, 'agents', 'ada'), { recursive: true });
writeFileSync(join(home, 'agents', 'ada', 'agent.yaml'), 'model: x\n');
writeFileSync(join(home, 'agents', 'ada', 'AGENTS.md'), '# ada\n');

let parts: string[] = [];
let raw = '';
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c)).on('end', async () => {
    const body = Buffer.concat(chunks);
    raw = body.toString('latin1');
    const ct = String(req.headers['content-type'] ?? '');
    if (ct.startsWith('multipart/form-data')) {
      const fd = await new Response(body, { headers: { 'content-type': ct } }).formData();
      parts = [...fd.keys()];
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'job-1', status: 'queued' }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

beforeEach(() => {
  parts = [];
  raw = '';
  clearCatalogCache();
  rmSync(join(home, 'video-jobs'), { recursive: true, force: true });
});

function ctx(model: Record<string, unknown>): ToolContext {
  const config = ConfigSchema.parse({
    providers: { p: { engine: 'openai-compatible', baseUrl: base, apiKey: 'k', models: [{ id: 'chat', contextWindow: 8192, capabilities: ['text'] }] } },
    videoGen: { enabled: true, maxConcurrent: 32, models: [{ name: 'animate', provider: 'p', model: 'wan-animate-replace', ...model }] },
  });
  return { agent: 'ada', session: 'main', config } as unknown as ToolContext;
}

const dir = mkdtempSync(join(tmpdir(), 'somora-video-'));
const png = join(dir, 'who.png');
writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
const clip = join(dir, 'clip.mp4');
writeFileSync(clip, Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom\0\0\0\0isom', 'latin1'), Buffer.alloc(64)]));
const animate = { wire: 'passthrough', media: { input_video: { field: 'video', min: 1, max: 1 }, character_image: { field: 'character_image', min: 1, max: 1 } } };

test('media files are read from disk and sent as file parts under the model\'s field names', async () => {
  const out = await videoGenerate.handler({ prompt: 'swap the person', media: [{ type: 'input_video', path: clip }, { type: 'character_image', path: png }] }, ctx(animate));
  assert.equal(out.status, 'queued');
  assert.deepEqual(parts, ['model', 'prompt', 'video', 'character_image']);
  assert.ok(!raw.includes(dir), 'the local folder never reaches the provider');
});

test('a missing needed file, a blocked path and both input fields are refused before anything is sent', async () => {
  await assert.rejects(videoGenerate.handler({ prompt: 'p', media: [{ type: 'input_video', path: clip }] }, ctx(animate)), /needs 1 × character_image/);
  await assert.rejects(
    videoGenerate.handler({ prompt: 'p', media: [{ type: 'character_image', path: join(homedir(), '.ssh', 'id_ed25519') }] }, ctx(animate)),
    /video_generate: media character_image/,
  );
  await assert.rejects(videoGenerate.handler({ prompt: 'p', reference_images: [png], media: [{ type: 'character_image', path: png }] }, ctx(animate)), /not both/);
  await assert.rejects(videoGenerate.handler({ prompt: 'p', media: [{ type: 'character_image', path: join(dir, 'nope.png') }] }, ctx(animate)), /could not read/);
  assert.equal(parts.length, 0, 'nothing reached the provider');
});

test('the schema takes only known types and keeps seconds non-negative', () => {
  const ok = (v: unknown) => videoGenerate.inputSchema.safeParse(v).success;
  assert.equal(ok({ prompt: 'p', media: [{ type: 'input_video', path: 'a.mp4' }] }), true);
  assert.equal(ok({ prompt: 'p', media: [{ type: 'driving_video', path: 'a.mp4' }] }), false);
  assert.equal(ok({ prompt: 'p', media: [{ type: 'keyframe_image', path: 'a.png', seconds: -1 }] }), false);
  assert.equal(ok({ prompt: 'p', media: [] }), false);
  const props = (videoGenerate.jsonSchema as { properties: Record<string, { items?: { properties: { type: { enum: string[] } } } }> }).properties;
  assert.deepEqual(props.media!.items!.properties.type.enum.length, 9, 'JSON schema lists the same nine types as Zod');
});

test('video_models shows the input files a model takes', async () => {
  const fromConfig = await videoModels.handler({ model: 'animate' }, ctx({ ...animate, allow: { supported: ['seconds'] } }));
  assert.deepEqual(fromConfig.models[0]!.media, {
    input_video: { kind: 'video', max: 1, min: 1 },
    character_image: { kind: 'image', max: 1, min: 1 },
  });
  const openai = await videoModels.handler({ model: 'animate' }, ctx({ wire: 'openai', allow: { supported: ['seconds'] } }));
  assert.deepEqual(openai.models[0]!.media, { first_frame: { kind: 'image', max: 1 } });
});
