// How a remote command ends: normal close, an exit whose output a
// leftover background process keeps open, and the deadline. A fake
// ssh2 channel stands in for the connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { HELD_OPEN_GRACE_MS, remoteExec } from './exec.ts';

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  closed = false;
  signals: string[] = [];
  signal(s: string) { this.signals.push(s); }
  close() { this.closed = true; }
  end() {}
}

function fakeClient(script: (ch: FakeChannel) => void): { client: never; channel: FakeChannel } {
  const channel = new FakeChannel();
  const client = {
    exec(_cmd: string, a: unknown, b?: unknown) {
      const cb = (typeof a === 'function' ? a : b) as (err: Error | undefined, ch: FakeChannel) => void;
      cb(undefined, channel);
      script(channel);
    },
  };
  return { client: client as never, channel };
}

test('a command that ends normally returns its exit code and output at once', async () => {
  const { client, channel } = fakeClient((ch) => {
    ch.emit('data', Buffer.from('hi\n'));
    ch.emit('exit', 0);
    ch.emit('close', 0, null);
  });
  const r = await remoteExec(client, 'echo hi');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'hi\n');
  assert.equal(r.stderr, '');
  assert.equal(channel.closed, false, 'nothing to close by hand');
});

test('exit without close: returns after the grace with the exit code and a note, and closes the channel', async () => {
  const { client, channel } = fakeClient((ch) => {
    ch.emit('data', Buffer.from('started\n'));
    ch.emit('exit', 3);
  });
  const t = Date.now();
  const r = await remoteExec(client, '(sleep 600 &); exit 3');
  const ms = Date.now() - t;
  assert.ok(ms >= HELD_OPEN_GRACE_MS - 50 && ms < HELD_OPEN_GRACE_MS + 1000, `${ms} ms`);
  assert.equal(r.code, 3);
  assert.equal(r.stdout, 'started\n');
  assert.match(r.stderr, /background still held its output open/);
  assert.equal(channel.closed, true);
  assert.deepEqual(channel.signals, [], 'a leftover process is not killed');
});

test('a late close after the exit is still a normal end', async () => {
  const { client } = fakeClient((ch) => {
    ch.emit('exit', 0);
    setTimeout(() => ch.emit('close', 0, null), 200);
  });
  const r = await remoteExec(client, 'x');
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
});

test('the deadline returns at the deadline, with the real duration, and closes the channel', async () => {
  const { client, channel } = fakeClient(() => {});
  const t = Date.now();
  const r = await remoteExec(client, 'sleep 600', { timeoutMs: 300 });
  const ms = Date.now() - t;
  assert.ok(ms < 1000, `${ms} ms`);
  assert.equal(r.code, null);
  assert.equal(r.signal, 'TIMEOUT');
  assert.match(r.stderr, /exceeded 300ms — stopped and the channel closed after \d+ms/);
  assert.ok(r.ms >= 300);
  assert.equal(channel.closed, true);
  assert.deepEqual(channel.signals, ['KILL']);
});

test('a close arriving after the result does not resolve twice', async () => {
  const { client } = fakeClient((ch) => {
    setTimeout(() => ch.emit('close', 0, null), 500);
  });
  const r = await remoteExec(client, 'x', { timeoutMs: 100 });
  assert.equal(r.signal, 'TIMEOUT');
  await new Promise((res) => setTimeout(res, 600));
});
