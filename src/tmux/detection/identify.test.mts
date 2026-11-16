// Which agent runs in a terminal, from its foreground processes. Rows as
// `ps -o pid=,pgid=,tpgid=,args= -t <tty>` printed them for the four
// agents on 2026-11-16 (paths shortened).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentFromArgv, agentFromName, foregroundIsShell, identifyForeground, parsePs, psCommandForTty } from './identify.ts';

test('the agents as they ran: direct, from a shell, wrapped in sh -c; a bare shell is none', () => {
  const ps = (s: string) => identifyForeground(parsePs(s));
  assert.equal(ps(' 739991  739991  739991 pi\n'), 'pi');
  assert.equal(ps(' 740000  740000  740000 opencode --model llmhost/deepseek-v4.1-flash\n'), 'opencode');
  assert.equal(ps(' 740005  740005  740005 /home/u/.npm-global/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex -m gpt-6-luna\n'), 'codex');
  assert.equal(ps(' 740014  740014  740014 claude --model claude-haiku-5-5\n'), 'claude');
  // A shell that started pi stays in its own group behind it.
  assert.equal(ps(' 740020  740020  740052 -bash\n 740052  740052  740052 pi\n'), 'pi');
  // sh -c "codex …; sleep": one group, the leader is sh.
  assert.equal(ps(' 1000  1000  1000 sh -c codex -m gpt-6-luna; sleep 600\n 1001  1000  1000 codex -m gpt-6-luna\n'), 'codex');
  assert.equal(ps(' 1000  1000  1000 -bash\n'), null);
  // Only the foreground group counts: an agent in the background is not "running here".
  assert.equal(ps(' 1000  1000  1200 -bash\n 1100  1100  1200 pi\n 1200  1200  1200 vim notes.md\n'), null);
});

test('runtimes: node, bun and python run a script; -e / -m run no file', () => {
  assert.equal(agentFromArgv(['node', '/usr/lib/node_modules/@google/gemini-cli/bin/gemini']), 'gemini');
  assert.equal(agentFromArgv(['node', '--no-warnings', '/home/u/.fnm/bin/qwen']), 'qwen');
  assert.equal(agentFromArgv(['bun', '/opt/opencode/bin/opencode.js']), 'opencode');
  assert.equal(agentFromArgv(['python3', '/usr/local/bin/hermes']), 'hermes');
  assert.equal(agentFromArgv(['bash', '-c', 'pi --model x']), 'pi');
  assert.equal(agentFromArgv(['node', '-e', 'require("codex")']), null);
  assert.equal(agentFromArgv(['node', 'server.js']), null);
  assert.equal(agentFromArgv(['vim', 'codex.md']), null);
});

test('names: aliases, paths, extensions; versioned muse binaries', () => {
  assert.equal(agentFromName('claude-code'), 'claude');
  assert.equal(agentFromName('/usr/local/bin/cursor-agent'), 'cursor');
  assert.equal(agentFromName('C:\\Tools\\codex.exe'), 'codex');
  assert.equal(agentFromName('muse-bin-0.1.0-R708.1'), 'muse');
  assert.equal(agentFromName('muse-binary'), null);
  assert.equal(agentFromName('bash'), null);
});

test('the ps command takes only a terminal name', () => {
  assert.equal(psCommandForTty('/dev/pts/3'), 'ps -o pid=,pgid=,tpgid=,args= -t pts/3');
  assert.equal(psCommandForTty('/dev/ttys003'), 'ps -o pid=,pgid=,tpgid=,args= -t ttys003');
  assert.throws(() => psCommandForTty('/dev/pts/3; rm -rf ~'), /unexpected tty/);
});

test('is the foreground a shell at its prompt?', () => {
  assert.equal(foregroundIsShell(parsePs(' 1000  1000  1000 -bash\n')), true);
  assert.equal(foregroundIsShell(parsePs(' 1000  1000  1000 /usr/bin/zsh\n')), true);
  assert.equal(foregroundIsShell(parsePs(' 1000  1000  1200 -bash\n 1200  1200  1200 vim x\n')), false);
  assert.equal(foregroundIsShell(parsePs(' 1000  1000  1200 -bash\n 1200  1200  1200 python3\n')), false);
  assert.equal(foregroundIsShell([]), null, 'no ps: no telling');
});
