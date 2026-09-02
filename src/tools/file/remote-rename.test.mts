// Unit tests for the SFTP rename-overwrite strategy (remote.ts
// renameOverwrite) using a recording stub instead of a live server.
//
// Run: npx tsx src/tools/file/remote-rename.test.mts

import assert from 'node:assert/strict';
import { renameOverwrite, type SftpRenameOps } from './remote.ts';

let pass = 0;
let fail = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    pass++;
  } catch (err) {
    fail++;
    console.error(`FAIL ${name}: ${(err as Error).message}`);
  }
}

type Cb = (err?: Error | null) => void;

/** ssh2-shaped status error: message + numeric code. */
function sftpErr(message: string, code?: number): Error {
  const e = new Error(message) as Error & { code?: number };
  if (code !== undefined) e.code = code;
  return e;
}
const FAILURE = () => sftpErr('Failure', 4);
const NO_SUCH_FILE = () => sftpErr('No such file or directory', 2);

interface StubOpts {
  /** Omit ext_openssh_rename entirely. */
  noExt?: boolean;
  /** Extension throws SYNCHRONOUSLY (ssh2 behaviour when unadvertised). */
  extThrowsSync?: Error;
  /** Extension calls back with this error. */
  extErr?: Error;
  /** Errors for successive plain rename calls (undefined = success). */
  renameErrs?: (Error | undefined)[];
  /** Errors for successive unlink calls keyed by path. */
  unlinkErrs?: Record<string, Error | undefined>;
}

function makeStub(opts: StubOpts = {}): SftpRenameOps & { calls: string[] } {
  const calls: string[] = [];
  let renameIdx = 0;
  const stub: SftpRenameOps & { calls: string[] } = {
    calls,
    rename(from, to, cb: Cb) {
      calls.push(`rename ${from} -> ${to}`);
      const err = opts.renameErrs?.[renameIdx++];
      setImmediate(() => cb(err ?? null));
    },
    unlink(path, cb: Cb) {
      calls.push(`unlink ${path}`);
      const err = opts.unlinkErrs?.[path];
      setImmediate(() => cb(err ?? null));
    },
  };
  if (!opts.noExt) {
    stub.ext_openssh_rename = (from, to, cb: Cb) => {
      calls.push(`ext_openssh_rename ${from} -> ${to}`);
      if (opts.extThrowsSync) throw opts.extThrowsSync;
      setImmediate(() => cb(opts.extErr ?? null));
    };
  }
  return stub;
}

const TMP = '/srv/app/config.yaml.somora-tmp.1.abc.def';
const TARGET = '/srv/app/config.yaml';
const CTX = { op: 'file_write', resource: 'lucy' };

await check('extension present and succeeds → no fallback', async () => {
  const s = makeStub();
  await renameOverwrite(s, TMP, TARGET, CTX);
  assert.deepEqual(s.calls, [`ext_openssh_rename ${TMP} -> ${TARGET}`]);
});

await check('extension missing → unlink + rename', async () => {
  // No extension: plain rename first (Failure because target exists),
  // then unlink target + rename.
  const s = makeStub({ noExt: true, renameErrs: [FAILURE(), undefined] });
  await renameOverwrite(s, TMP, TARGET, CTX);
  assert.deepEqual(s.calls, [
    `rename ${TMP} -> ${TARGET}`,
    `unlink ${TARGET}`,
    `rename ${TMP} -> ${TARGET}`,
  ]);
});

await check('extension missing, target absent → plain rename succeeds directly', async () => {
  const s = makeStub({ noExt: true });
  await renameOverwrite(s, TMP, TARGET, CTX);
  assert.deepEqual(s.calls, [`rename ${TMP} -> ${TARGET}`]);
});

await check('extension throws "unsupported" synchronously → fallback', async () => {
  const s = makeStub({
    extThrowsSync: new Error('Server does not support this extended request'),
  });
  await renameOverwrite(s, TMP, TARGET, CTX);
  assert.deepEqual(s.calls, [
    `ext_openssh_rename ${TMP} -> ${TARGET}`,
    `unlink ${TARGET}`,
    `rename ${TMP} -> ${TARGET}`,
  ]);
});

await check('extension answers "Operation unsupported" via callback → fallback', async () => {
  const s = makeStub({ extErr: sftpErr('Operation unsupported', 8) });
  await renameOverwrite(s, TMP, TARGET, CTX);
  assert.deepEqual(s.calls, [
    `ext_openssh_rename ${TMP} -> ${TARGET}`,
    `unlink ${TARGET}`,
    `rename ${TMP} -> ${TARGET}`,
  ]);
});

await check('extension answers Failure → fallback', async () => {
  const s = makeStub({ extErr: FAILURE() });
  await renameOverwrite(s, TMP, TARGET, CTX);
  assert.deepEqual(s.calls, [
    `ext_openssh_rename ${TMP} -> ${TARGET}`,
    `unlink ${TARGET}`,
    `rename ${TMP} -> ${TARGET}`,
  ]);
});

await check('fallback: unlink ENOENT is ignored', async () => {
  const s = makeStub({ noExt: true, renameErrs: [FAILURE(), undefined], unlinkErrs: { [TARGET]: NO_SUCH_FILE() } });
  await renameOverwrite(s, TMP, TARGET, CTX);
  assert.deepEqual(s.calls, [
    `rename ${TMP} -> ${TARGET}`,
    `unlink ${TARGET}`,
    `rename ${TMP} -> ${TARGET}`,
  ]);
});

await check('plain rename Failure, no extension → unlink+rename, final failure → enriched error + tmp cleanup', async () => {
  // Target unlink itself refused (e.g. directory / permission) → we did
  // NOT remove the target, so the tmp file is cleaned up.
  const s = makeStub({
    noExt: true,
    renameErrs: [FAILURE(), FAILURE()],
    unlinkErrs: { [TARGET]: sftpErr('Permission denied', 3) },
  });
  let caught: Error | undefined;
  try {
    await renameOverwrite(s, TMP, TARGET, CTX);
  } catch (err) {
    caught = err as Error;
  }
  assert.ok(caught, 'should throw');
  assert.notEqual(caught!.message, 'Failure', 'raw Failure must not surface');
  assert.ok(caught!.message.startsWith(`file_write on 'lucy': SFTP rename of '${TMP}' onto '${TARGET}' refused (`), caught!.message);
  assert.ok(caught!.message.includes('Permission denied'), caught!.message);
  assert.ok(caught!.message.includes('posix-rename@openssh.com'), caught!.message);
  assert.deepEqual(s.calls, [
    `rename ${TMP} -> ${TARGET}`,
    `unlink ${TARGET}`,
    `unlink ${TMP}`, // best-effort tmp cleanup
  ]);
});

await check('final rename still Failure after unlink → error names the path and KEEPS tmp', async () => {
  const s = makeStub({ noExt: true, renameErrs: [FAILURE(), FAILURE()] });
  let caught: Error | undefined;
  try {
    await renameOverwrite(s, TMP, TARGET, CTX);
  } catch (err) {
    caught = err as Error;
  }
  assert.ok(caught, 'should throw');
  assert.ok(caught!.message.includes(TARGET), caught!.message);
  assert.ok(caught!.message.includes(TMP), caught!.message);
  assert.ok(caught!.message.includes('(Failure)'), caught!.message);
  assert.ok(/target was removed/.test(caught!.message), caught!.message);
  // Target is gone, tmp holds the only copy → NOT unlinked.
  assert.ok(!s.calls.includes(`unlink ${TMP}`), 'tmp must be kept: ' + s.calls.join(', '));
});

await check('extension real error (permission denied) → no fallback, enriched, tmp cleaned', async () => {
  const s = makeStub({ extErr: sftpErr('Permission denied', 3) });
  let caught: Error | undefined;
  try {
    await renameOverwrite(s, TMP, TARGET, CTX);
  } catch (err) {
    caught = err as Error;
  }
  assert.ok(caught, 'should throw');
  assert.ok(caught!.message.includes(`onto '${TARGET}'`), caught!.message);
  assert.ok(caught!.message.includes('Permission denied'), caught!.message);
  assert.deepEqual(s.calls, [
    `ext_openssh_rename ${TMP} -> ${TARGET}`,
    `unlink ${TMP}`,
  ]);
});

await check('plain rename real error (no such dir) → no unlink of target, enriched, tmp cleaned', async () => {
  const s = makeStub({ noExt: true, renameErrs: [NO_SUCH_FILE()] });
  let caught: Error | undefined;
  try {
    await renameOverwrite(s, TMP, TARGET, CTX);
  } catch (err) {
    caught = err as Error;
  }
  assert.ok(caught, 'should throw');
  assert.ok(caught!.message.includes('No such file'), caught!.message);
  assert.deepEqual(s.calls, [`rename ${TMP} -> ${TARGET}`, `unlink ${TMP}`]);
});

await check('tmp cleanup failure does not mask the real error', async () => {
  const s = makeStub({
    noExt: true,
    renameErrs: [FAILURE(), FAILURE()],
    unlinkErrs: { [TARGET]: sftpErr('Permission denied', 3), [TMP]: sftpErr('Permission denied', 3) },
  });
  let caught: Error | undefined;
  try {
    await renameOverwrite(s, TMP, TARGET, CTX);
  } catch (err) {
    caught = err as Error;
  }
  assert.ok(caught!.message.includes(`onto '${TARGET}'`), caught!.message);
});

console.log(`remote-rename: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
