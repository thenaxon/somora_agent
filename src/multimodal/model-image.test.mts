// Every image a model gets is scaled to attachments.maxImageEdge first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { fitImageFileForModel, fitImageForModel, imageSourceCap } from './model-image.ts';
import { readDimensions } from './dimensions.ts';

const make = (w: number, h: number, fmt: 'png' | 'jpeg' | 'webp' | 'gif') =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 40, b: 60 } } })[fmt]().toBuffer();

test('a big PNG is scaled to the longer side, keeps its aspect ratio and format', async () => {
  const r = await fitImageForModel(await make(5120, 2880, 'png'), 'image/png', 2048);
  assert.equal(r.resized, true);
  assert.equal(r.mimeType, 'image/png');
  assert.deepEqual(readDimensions(r.bytes), { width: 2048, height: 1152 });
  assert.deepEqual(r.from, { width: 5120, height: 2880 });
});

test('portrait images are limited by their height', async () => {
  const r = await fitImageForModel(await make(1500, 4000, 'jpeg'), 'image/jpeg', 2048);
  assert.equal(r.mimeType, 'image/jpeg');
  assert.deepEqual(readDimensions(r.bytes), { width: 768, height: 2048 });
});

test('an image that fits, scaling off, and unreadable bytes pass unchanged', async () => {
  const small = await make(1920, 1080, 'png');
  assert.equal((await fitImageForModel(small, 'image/png', 2048)).bytes, small);
  const big = await make(4000, 3000, 'webp');
  assert.equal((await fitImageForModel(big, 'image/webp', 0)).bytes, big);
  const junk = Buffer.from('not an image at all');
  const r = await fitImageForModel(junk, 'image/png', 2048);
  assert.equal(r.bytes, junk);
  assert.equal(r.resized, false);
});

test('webp stays webp, a large GIF becomes a PNG', async () => {
  assert.equal((await fitImageForModel(await make(3000, 3000, 'webp'), 'image/webp', 1000)).mimeType, 'image/webp');
  const gif = await fitImageForModel(await make(3000, 1000, 'gif'), 'image/gif', 1000);
  assert.equal(gif.mimeType, 'image/png');
  assert.deepEqual(readDimensions(gif.bytes), { width: 1000, height: 333 });
});

test('file variant: a scaled copy is made once next to the original and reused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'somora-model-image-'));
  const src = join(dir, 'abc.png');
  writeFileSync(src, await make(4000, 2000, 'png'));
  const before = statSync(src).mtimeMs;
  const a = await fitImageFileForModel(src, 'image/png', 2048);
  assert.equal(a.resized, true);
  assert.notEqual(a.path, src);
  assert.deepEqual(readDimensions((await import('node:fs')).readFileSync(a.path)), { width: 2048, height: 1024 });
  const b = await fitImageFileForModel(src, 'image/png', 2048);
  assert.equal(b.path, a.path);
  assert.equal(readdirSync(dir).length, 2, 'original + one copy');
  assert.equal(statSync(src).mtimeMs, before, 'the original is untouched');
  const small = join(dir, 'small.png');
  writeFileSync(small, await make(800, 600, 'png'));
  assert.equal((await fitImageFileForModel(small, 'image/png', 2048)).path, small);
});

test('source cap: 50 MB with scaling on, maxImageBytes without', () => {
  assert.equal(imageSourceCap({ maxImageBytes: 5_000_000, maxImageEdge: 2048 }), 50 * 1024 * 1024);
  assert.equal(imageSourceCap({ maxImageBytes: 5_000_000, maxImageEdge: 0 }), 5_000_000);
  assert.equal(imageSourceCap({ maxImageBytes: 80_000_000, maxImageEdge: 2048 }), 80_000_000);
});
