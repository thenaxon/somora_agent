// A PDF for analyze_file goes as the document to a worker with `pdf`
// and as page images to a worker that only has `image` — the way
// file_read and chat attachments already hand PDFs to such models.
// Before, every image-only worker of a chain was skipped for a PDF.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeMedia } from './analyze.ts';
import { loadAttachment } from '../../multimodal/load.ts';
import type { Config } from '../../config/types.ts';

/** A small valid PDF with `pages` pages of text. */
function minimalPdf(pages: number): Buffer {
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 24 Tf 72 700 Td (Page ${i + 1}) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R ` +
        `/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`,
    );
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const dir = mkdtempSync(join(tmpdir(), 'somora-vision-pdf-'));
const shortPdf = join(dir, 'short.pdf');
const longPdf = join(dir, 'long.pdf');
writeFileSync(shortPdf, minimalPdf(3));
writeFileSync(longPdf, minimalPdf(25));

type Part = { type: string; text?: string };
const requests: Array<{ model: string; parts: Part[] }> = [];
const failing = new Set<string>();

function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { model: string; messages: Array<{ content: Part[] }> };
        requests.push({ model: parsed.model, parts: parsed.messages[0]!.content });
        if (failing.has(parsed.model)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'down' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: `read by ${parsed.model}` }, finish_reason: 'stop' }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

function config(port: number, worker: string[]): Config {
  const model = (id: string, capabilities: string[]) => ({ id, alias: id, capabilities, contextWindow: 8000 });
  return {
    providers: {
      local: {
        engine: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'x',
        models: [model('eyes', ['text', 'image']), model('reader', ['text', 'image', 'pdf']), model('blind', ['text'])],
      },
    },
    vision: {
      worker,
      timeoutMs: 60_000,
      totalBudgetMs: 90_000,
      maxOutputTokens: 1_500,
      healthCacheMs: 0,
      timeoutCooldownMs: 0,
    },
    attachments: { maxImageBytes: 20_000_000, maxPdfBytes: 32_000_000, maxTextBytes: 1_000_000 },
  } as unknown as Config;
}

const kinds = (parts: Part[]) => parts.map((p) => p.type);
const load = (path: string) => loadAttachment(path, { maxImageBytes: 20_000_000, maxPdfBytes: 32_000_000, maxTextBytes: 1 });

test('PDFs reach image-only workers as pages and PDF readers as the document', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const att = await load(shortPdf);

  await t.test('a worker that only sees images gets one image per page', async () => {
    requests.length = 0;
    const r = await describeMedia({ att, config: config(port, ['local/eyes', 'local/reader']), agent: 'a', caller: 'analyze_file' });
    assert.equal(r.worker, 'local/eyes', 'the first entry answers; the paid or remote reader is not needed');
    assert.equal(requests.length, 1);
    assert.deepEqual(kinds(requests[0]!.parts), ['text', 'image_url', 'image_url', 'image_url']);
  });

  await t.test('a worker that reads PDFs gets the document itself', async () => {
    requests.length = 0;
    const r = await describeMedia({ att, config: config(port, ['local/reader', 'local/eyes']), agent: 'a', caller: 'analyze_file' });
    assert.equal(r.worker, 'local/reader');
    assert.deepEqual(kinds(requests[0]!.parts), ['text', 'file']);
  });

  await t.test('a worker that sees nothing is passed over with the reason', async () => {
    requests.length = 0;
    const r = await describeMedia({ att, config: config(port, ['local/blind', 'local/eyes']), agent: 'a', caller: 'analyze_file' });
    assert.equal(r.worker, 'local/eyes');
    assert.equal(requests.length, 1, 'no request to the blind worker');
    assert.match(r.fellBackFrom?.[0] ?? '', /local\/blind: lacks 'pdf' capability and 'image' for the pages/);
  });

  await t.test('when the image-only worker is down, the reader still gets the document', async () => {
    requests.length = 0;
    failing.add('eyes');
    try {
      const r = await describeMedia({ att, config: config(port, ['local/eyes', 'local/reader']), agent: 'a', caller: 'analyze_file' });
      assert.equal(r.worker, 'local/reader');
      assert.deepEqual(requests.map((q) => [q.model, kinds(q.parts).includes('file') ? 'document' : 'pages']), [
        ['eyes', 'pages'],
        ['reader', 'document'],
      ]);
    } finally {
      failing.delete('eyes');
    }
  });

  await t.test('a long PDF sends the first 20 pages and says so', async () => {
    requests.length = 0;
    const long = await load(longPdf);
    await describeMedia({ att: long, prompt: 'What is on page 1?', config: config(port, ['local/eyes']), agent: 'a', caller: 'analyze_file' });
    const parts = requests[0]!.parts;
    assert.equal(parts.filter((p) => p.type === 'image_url').length, 20);
    assert.match(parts[0]!.text ?? '', /^What is on page 1\?/);
    assert.match(parts[0]!.text ?? '', /The PDF has 25 pages; only the first 20 are included/);
  });
});
