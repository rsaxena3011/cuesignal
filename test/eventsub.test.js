import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startEventSub } from '../src/eventsub.js';

function harness({ token = {}, subscriptionStatus = 202 } = {}) {
  const sockets = [];
  const requests = [];
  const logs = [];
  const messages = [];
  const timers = new Map();
  let nextTimer = 1;
  class FakeSocket extends EventEmitter {
    constructor(url) { super(); this.url = url; this.closed = false; sockets.push(this); }
    close() { this.closed = true; this.emit('close', 1000); }
    terminate() { this.closed = true; this.emit('close', 1006); }
    receive(message) { this.emit('message', Buffer.from(JSON.stringify(message))); }
  }
  const options = {
    clientId: 'test-client', userToken: 'not-a-real-token', channelId: '123',
    onMessage: message => messages.push(message),
  };
  const dependencies = {
    WebSocketImpl: FakeSocket,
    fetchImpl: async (url, request) => {
      requests.push({ url, ...request });
      const validating = url.endsWith('/validate');
      const status = validating ? 200 : subscriptionStatus;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ client_id: 'test-client', user_id: '456', scopes: ['user:read:chat'], ...token }),
      };
    },
    logger: { log: text => logs.push(text), warn: text => logs.push(text), error: text => logs.push(text) },
    setTimeoutFn: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeoutFn: id => timers.delete(id),
    now: () => 1000,
  };
  return { sockets, requests, logs, messages, timers, options, dependencies };
}

const welcome = (id = 'session-1') => ({
  metadata: { message_type: 'session_welcome' },
  payload: { session: { id, keepalive_timeout_seconds: 10 } },
});
const settle = () => new Promise(resolve => setImmediate(resolve));

test('missing Twitch values disable EventSub without network or exceptions', () => {
  const h = harness();
  assert.equal(startEventSub({ ...h.options, channelId: '' }, h.dependencies), null);
  assert.deepEqual(h.logs, ['EventSub disabled: missing TWITCH_* env values']);
  assert.equal(h.requests.length, 0);
  assert.equal(h.sockets.length, 0);
});

test('welcome subscribes using token owner and broadcaster as distinct IDs', async t => {
  const h = harness();
  const controller = startEventSub(h.options, h.dependencies);
  t.after(() => controller.stop());
  assert.equal(await controller.ready, true);
  assert.equal(h.sockets[0].url, 'wss://eventsub.wss.twitch.tv/ws');
  h.sockets[0].receive(welcome());
  await settle();
  const request = h.requests[1];
  assert.equal(request.url, 'https://api.twitch.tv/helix/eventsub/subscriptions');
  assert.equal(request.method, 'POST');
  assert.deepEqual(JSON.parse(request.body), {
    type: 'channel.chat.message', version: '1',
    condition: { broadcaster_user_id: '123', user_id: '456' },
    transport: { method: 'websocket', session_id: 'session-1' },
  });
  assert.equal(request.headers['Client-Id'], 'test-client');
  assert.ok(!h.logs.join(' ').includes(h.options.userToken));
});

test('chat notifications forward text and timestamp once, ignoring malformed or other events', async t => {
  const h = harness();
  const controller = startEventSub(h.options, h.dependencies);
  t.after(() => controller.stop());
  await controller.ready;
  const socket = h.sockets[0];
  socket.receive(welcome());
  socket.emit('message', Buffer.from('invalid json'));
  socket.receive({ metadata: null, payload: null });
  socket.receive({ metadata: { message_type: 'notification', subscription_type: 'channel.follow' } });
  const notification = {
    metadata: { message_type: 'notification', subscription_type: 'channel.chat.message', message_timestamp: '2026-01-01T12:00:00Z' },
    payload: { event: { message_id: 'chat-1', chatter_user_name: 'SampleViewer', message: { text: 'what sens do you use?' } } },
  };
  socket.receive(notification);
  socket.receive(notification);
  assert.deepEqual(h.messages, [{ user: 'SampleViewer', text: 'what sens do you use?', ts: Date.parse('2026-01-01T12:00:00Z') }]);
});

test('session reconnect keeps old socket until welcome and retains its subscription', async t => {
  const h = harness();
  const controller = startEventSub(h.options, h.dependencies);
  t.after(() => controller.stop());
  await controller.ready;
  const oldSocket = h.sockets[0];
  oldSocket.receive(welcome());
  await settle();
  const reconnectUrl = 'wss://eventsub.wss.twitch.tv/ws?reconnect=example';
  oldSocket.receive({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: reconnectUrl } } });
  assert.equal(h.sockets[1].url, reconnectUrl);
  assert.equal(oldSocket.closed, false);
  h.sockets[1].receive(welcome('session-2'));
  await settle();
  assert.equal(oldSocket.closed, true);
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(h.sockets[1].closed, false);
});

test('unexpected closure reconnects and creates a fresh subscription; stop cancels timers', async () => {
  const h = harness();
  const controller = startEventSub(h.options, h.dependencies);
  await controller.ready;
  h.sockets[0].receive(welcome());
  await settle();
  h.sockets[0].terminate();
  const [id, timer] = [...h.timers].find(([, timer]) => timer.delay === 1000);
  h.timers.delete(id);
  timer.callback();
  h.sockets[1].receive(welcome('session-2'));
  await settle();
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 2);
  controller.stop();
  controller.stop();
  assert.ok(h.sockets.every(socket => socket.closed));
  assert.equal(h.timers.size, 0);
});

test('invalid token scopes prevent connecting and authorization rejection stops retrying', async () => {
  const invalid = harness({ token: { scopes: [] } });
  const rejected = startEventSub(invalid.options, invalid.dependencies);
  assert.equal(await rejected.ready, false);
  assert.equal(invalid.sockets.length, 0);
  assert.equal(invalid.timers.size, 0);

  const forbidden = harness({ subscriptionStatus: 403 });
  const controller = startEventSub(forbidden.options, forbidden.dependencies);
  await controller.ready;
  forbidden.sockets[0].receive(welcome());
  await settle();
  assert.equal(forbidden.sockets[0].closed, true);
  assert.equal(forbidden.timers.size, 0);
});
