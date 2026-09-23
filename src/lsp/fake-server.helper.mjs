// A fake language server for tests: answers initialize, and on every
// didOpen/didChange publishes one error per line containing "BAD" in
// the text it received. Speaks the LSP framing over stdio.
let buf = Buffer.alloc(0);
const docs = new Map();
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const i = buf.indexOf('\r\n\r\n');
    if (i < 0) return;
    const len = Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, i).toString())[1]);
    if (buf.length < i + 4 + len) return;
    const msg = JSON.parse(buf.subarray(i + 4, i + 4 + len).toString());
    buf = buf.subarray(i + 4 + len);
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });
    else if (msg.method === 'shutdown') send({ jsonrpc: '2.0', id: msg.id, result: null });
    else if (msg.method === 'exit') process.exit(0);
    else if (msg.method === 'textDocument/didOpen' || msg.method === 'textDocument/didChange') {
      const uri = msg.params.textDocument.uri;
      const text = msg.method === 'textDocument/didOpen' ? msg.params.textDocument.text : msg.params.contentChanges[0].text;
      docs.set(uri, text);
      const diagsFor = (t, extra) => t.split('\n').flatMap((l, n) => (l.includes('BAD') ? [{ range: { start: { line: n, character: l.indexOf('BAD') }, end: { line: n, character: l.indexOf('BAD') + 3 } }, severity: 1, message: `BAD token on line ${n + 1}` }] : [])).concat(extra);
      const publish = () => {
        send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: diagsFor(text, []) } });
        // Like a real server, other open files get their verdict again; a
        // change containing BREAK adds an error to every other file.
        for (const [other, t] of docs) {
          if (other === uri) continue;
          const extra = text.includes('BREAK') ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: `broken by a change in ${uri.split('/').pop()}` }] : [];
          send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: other, diagnostics: diagsFor(t, extra) } });
        }
      };
      if (process.env.FAKE_LSP_DELAY_MS) setTimeout(publish, Number(process.env.FAKE_LSP_DELAY_MS));
      else publish();
    }
  }
});
