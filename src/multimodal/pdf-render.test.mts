// PDF pages go to models as JPEG (smaller than PNG, text still sharp):
// the bytes are a real JPEG, the type says so, and every consumer that
// builds a data URL uses that type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pdfPagesToOpenAiContent } from './blocks.ts';
import { PDF_PAGE_MEDIA_TYPE, renderPdfPages } from './pdf-render.ts';

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

test('pages come out as JPEG, with the type to match', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'somora-pdf-pages-')), 'a.pdf');
  writeFileSync(file, minimalPdf(2));
  const r = await renderPdfPages(file);
  assert.equal(r.pages.length, 2);
  assert.equal(r.mediaType, PDF_PAGE_MEDIA_TYPE);
  const first = Buffer.from(r.pages[0]!, 'base64');
  assert.deepEqual([...first.subarray(0, 3)], [0xff, 0xd8, 0xff], 'JPEG magic bytes');
  assert.ok(first.length < 60_000, `a text page stays small (${first.length} bytes)`);
});

test('the data URL for a worker carries the page type', () => {
  const parts = pdfPagesToOpenAiContent(['AAAA'], 'read it', undefined, 'image/jpeg');
  assert.equal((parts[1] as { image_url: { url: string } }).image_url.url, 'data:image/jpeg;base64,AAAA');
});
