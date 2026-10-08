// The original-path line: names the stored original, never the scaled copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageOriginalNotes } from './attachment-note.ts';

function png(width: number, height: number): Buffer {
  // Signature + IHDR is all readDimensions needs.
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

test('an image line names the original with its size, not the scaled copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'somora-note-'));
  const original = join(dir, 'abc.png');
  writeFileSync(original, png(6000, 4000));
  const notes = imageOriginalNotes([
    { hash: 'abc', path: `${original}.model-2048-x.png`, originalPath: original, name: 'car.png', mime: { kind: 'image', mimeType: 'image/png' }, size: 33 } as never,
    { hash: 'def', path: join(dir, 'def.pdf'), originalPath: join(dir, 'def.pdf'), name: 'doc.pdf', mime: { kind: 'pdf', mimeType: 'application/pdf' }, size: 1 } as never,
  ]);
  assert.match(notes, /^\[Image attachment "car\.png" \(6000×4000\) — original, full resolution: .*abc\.png — /);
  assert.doesNotMatch(notes.split('never pass')[0]!, /\.model-2048/, 'the scaled copy is not offered');
  assert.equal(notes.split('\n').length, 1, 'PDFs get no image line');
});

test('without an original path the sent path is named; no images, no text', () => {
  const notes = imageOriginalNotes([{ hash: 'x', path: '/nowhere/x.png', name: 'x.png', mime: { kind: 'image', mimeType: 'image/png' }, size: 1 } as never]);
  assert.match(notes, /^\[Image attachment "x\.png" — original, full resolution: \/nowhere\/x\.png/);
  assert.equal(imageOriginalNotes([]), '');
});

test('a phone photo stored landscape but tagged to show portrait is named by its shown size', async () => {
  const sharp = (await import('sharp')).default;
  const dir = mkdtempSync(join(tmpdir(), 'somora-note-'));
  const photo = join(dir, 'phone.jpg');
  writeFileSync(photo, await sharp({ create: { width: 400, height: 300, channels: 3, background: '#0a0' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer());
  const notes = imageOriginalNotes([{ hash: 'p', path: photo, originalPath: photo, name: 'IMG.jpg', mime: { kind: 'image', mimeType: 'image/jpeg' }, size: 1 } as never]);
  assert.match(notes, /\(300×400\)/);
});
