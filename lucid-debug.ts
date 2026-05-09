import { query } from '@anthropic-ai/claude-agent-sdk';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LUCID_SYSTEM_PROMPT } from './src/dream/lucid-prompt.ts';

(async () => {
  const wikiAbs = '/mnt/naxon/obsidian/somora';
  const paths: string[] = [];
  for (const s of ['personen','projekte','wissen','orte','infrastruktur']) {
    try { const fs = await readdir(join(wikiAbs, s)); for (const f of fs.filter(x=>x.endsWith('.md')).slice(0,2)) paths.push(`${s}/${f.replace(/\.md$/,'')}`); } catch {}
  }
  const blocks = await Promise.all(paths.map(async p => `<wiki_page slug="${p}">\n${(await readFile(`${wikiAbs}/${p}.md`, 'utf8')).trim()}\n</wiki_page>`));
  const userMsg = blocks.join('\n\n');
  console.log('msg size:', userMsg.length, 'pages:', paths.length);

  const ac = new AbortController();
  let stderrBuf = '';

  async function* userStream() {
    yield { type: 'user' as const, parent_tool_use_id: null, message: { role: 'user' as const, content: userMsg } };
  }

  console.log('--- starting SDK query with stderr capture ---');
  try {
    const stream = query({
      prompt: userStream(),
      options: {
        model: 'claude-opus-4-7',
        systemPrompt: LUCID_SYSTEM_PROMPT,
        settingSources: [],
        tools: [],
        mcpServers: {},
        abortController: ac,
        pathToClaudeCodeExecutable: '/home/suspect/.local/bin/claude',
        stderr: (data: string) => { stderrBuf += data; process.stderr.write(`[STDERR] ${data}`); },
      } as any,
    });
    for await (const msg of stream) {
      console.log('[MSG]', msg.type, JSON.stringify(msg).slice(0,300));
    }
    console.log('--- stream ended ---');
  } catch (e) {
    console.error('CAUGHT:', (e as Error).message);
    console.error('--- stderr buffered:', stderrBuf.length, 'bytes ---');
    if (stderrBuf) console.error(stderrBuf);
  }
})();
