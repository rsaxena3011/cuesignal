import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatSimulator, USERNAMES, TEMPLATES } from '../src/simulator.js';

function harness(random = () => 0) {
  const timers = new Map();
  let nextId = 0;
  const simulator = new ChatSimulator({
    random, now: () => 12345,
    setTimeoutFn: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeoutFn: id => timers.delete(id),
  });
  const messages = [];
  simulator.on('message', message => messages.push(message));
  function tick() {
    const [id, timer] = timers.entries().next().value;
    assert.ok(timer.delay >= 900 && timer.delay <= 1600);
    timers.delete(id);
    timer.callback();
  }
  return { simulator, timers, messages, tick };
}

test('simulator emits recurring demo topics on a single 900–1600ms timer and can stop/restart', () => {
  const h = harness();
  assert.equal(h.timers.size, 0);
  h.simulator.start().start();
  assert.equal(h.timers.size, 1);
  for (let i = 0; i <= TEMPLATES.length; i++) h.tick();
  assert.deepEqual(h.messages[0], { user: USERNAMES[0], text: TEMPLATES[0], ts: 12345 });
  assert.equal(h.messages.at(-1).text, TEMPLATES[0]);
  assert.equal(USERNAMES.length, 14);
  assert.ok(h.messages.some(message => message.text.startsWith('!boost')));
  assert.ok(h.messages.some(message => message.text === 'can you play ranked'));
  h.simulator.stop().stop();
  assert.equal(h.timers.size, 0);
  h.simulator.start();
  assert.equal(h.timers.size, 1);
  h.tick();
  assert.equal(h.messages.at(-1).text, TEMPLATES[1]);
  h.simulator.stop();
});

test('stopping from a message listener does not schedule another emission', () => {
  const h = harness(() => 0.999999);
  h.simulator.once('message', () => h.simulator.stop());
  h.simulator.start();
  assert.equal([...h.timers.values()][0].delay, 1600);
  h.tick();
  assert.equal(h.messages[0].user, USERNAMES.at(-1));
  assert.equal(h.timers.size, 0);
});
