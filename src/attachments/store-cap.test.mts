// An upload stops at the largest attachment somora accepts instead of
// filling the disk first (Fable review 2026-11-10 Nr. 23); a normal one
// is stored with the right hash.
import '../testing/isolated-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { storeAttachment } from './store.ts';

const config = { maxImageBytes: 1024, maxPdfBytes: 2048, maxTextBytes: 1024, maxPerTurn: 10, maxImageEdge: 2048 } as never;

test('an endless upload is cut off', async () => {
  let sent = 0;
  const endless = new Readable({
    read() {
      sent += 65536;
      this.push(Buffer.alloc(65536, 0x61));
    },
  });
  await assert.rejects(storeAttachment({ body: endless, name: 'big.txt', config } as never), /exceeds/);
  assert.ok(sent < 200 * 1024 * 1024, `stopped after ${sent} bytes`);
});

test('a small text file is stored with its hash', async () => {
  const body = Readable.from([Buffer.from('hello attachments\n')]);
  const r = (await storeAttachment({ body, name: 'a.txt', config } as never)) as { hash: string };
  assert.equal(r.hash, createHash('sha256').update('hello attachments\n').digest('hex'));
});
