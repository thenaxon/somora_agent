import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ScreencastHub, type ViewerSocket } from './screencast.ts';

test('capture teardown precedes reconnect; stale frames and slow viewers are dropped', async () => {
  let generation = 1;
  let releaseDetach!: () => void;
  const sessions: Array<EventEmitter & { send: (name: string) => Promise<void>; detach: () => Promise<void> }> = [];
  const page = {
    url: () => 'http://test/',
    context: () => ({ newCDPSession: async () => {
      const session = Object.assign(new EventEmitter(), {
        send: async (_name: string) => {},
        detach: async () => { if (sessions.length === 1) await new Promise<void>((r) => { releaseDetach = r; }); },
      });
      sessions.push(session);
      return session;
    } }),
  };
  const frames: Buffer[] = [];
  const viewer: ViewerSocket = { send: (frame) => { if (Buffer.isBuffer(frame)) frames.push(frame); }, buffered: () => 0, close: () => {} };
  const slow: ViewerSocket = { send: () => assert.fail('slow viewer received frame'), buffered: () => 3 * 1024 * 1024, close: () => {} };
  const hub = new ScreencastHub('b', 't', page as never, () => generation, 60, 100, 100);
  await hub.add(viewer);
  await hub.add(slow);
  const frame = { data: Buffer.from('jpeg').toString('base64'), sessionId: 1, metadata: { deviceWidth: 100, deviceHeight: 100, scrollOffsetX: 0, scrollOffsetY: 0 } };
  sessions[0]!.emit('Page.screencastFrame', frame);
  assert.equal(frames.length, 1);
  generation++;
  sessions[0]!.emit('Page.screencastFrame', frame);
  assert.equal(frames.length, 1, 'old document is never relabelled as the new generation');
  hub.refresh();
  await new Promise((r) => setImmediate(r));
  assert.equal(sessions.length, 1);
  const reconnect = hub.add(viewer);
  releaseDetach();
  await reconnect;
  assert.equal(sessions.length, 2);
  sessions[0]!.emit('Page.screencastFrame', frame);
  assert.equal(frames.length, 1);
  sessions[1]!.emit('Page.screencastFrame', frame);
  assert.equal(frames.length, 2);
  await hub.closeAll(1000, 'done');
});
