import test from 'node:test';
import assert from 'node:assert/strict';
import { CueEngine, normalize, similarity, score } from '../src/cluster.js';

const NOW = 1_700_000_000_000;
const makeEngine = () => new CueEngine({ now: () => NOW });
const message = (text, user = 'viewer', ts = NOW) => ({ user, text, ts });

test('normalization strips punctuation/emotes, collapses whitespace, and removes stopwords', () => {
  assert.deepEqual(normalize('  WHAT   Sens do U use?! [Kappa]  '), ['sensitivity', 'use']);
  assert.deepEqual(normalize('Next TOURNEY, pls!'), ['next', 'tournament']);
  assert.deepEqual(normalize('  the and you [PogChamp] !!! '), []);
  assert.deepEqual(normalize('Café setup?'), ['café', 'setup']);
});

test('Jaccard similarity handles synonyms, unique tokens, and empty sets', () => {
  const value = similarity(normalize('what sensitivity do you use'), normalize('what sens do you use'));
  assert.ok(value > 0.5);
  assert.equal(value, 1);
  assert.equal(similarity(['ranked', 'ranked', 'play'], ['ranked', 'please']), 1 / 3);
  assert.equal(similarity([], []), 0);
  assert.equal(similarity(['hello'], []), 0);
  assert.equal(similarity('sensitivity settings', 'next tournament'), 0);
});

test('two near-duplicate questions make one cue; unrelated text makes another', () => {
  const engine = makeEngine();
  engine.addMessage(message('what sensitivity do you use?', 'viewer1', NOW - 1000));
  engine.addMessage(message('what sens do you use', 'viewer2'));
  assert.equal(engine.list().length, 1);
  assert.equal(engine.list()[0].count, 2);
  assert.equal(engine.list()[0].text, 'what sensitivity do you use?');
  assert.equal(engine.list()[0].firstTs, NOW - 1000);
  assert.equal(engine.list()[0].lastTs, NOW);
  engine.addMessage(message('when is the next tournament?', 'viewer3'));
  assert.equal(engine.list().length, 2);
});

test('tourney aliases and polite request variants also cluster', () => {
  const engine = makeEngine();
  engine.addMessage(message('when is the next tournament'));
  engine.addMessage(message('next tourney when?'));
  engine.addMessage(message('play ranked please'));
  engine.addMessage(message('can you play ranked'));
  assert.equal(engine.list().length, 2);
  assert.deepEqual(engine.list().map((cue) => cue.count), [2, 2]);
  assert.ok(engine.list().every((cue) => cue.isQuestion));
});

test('similarity equal to the 0.5 threshold joins the existing cue', () => {
  const engine = makeEngine();
  engine.addMessage(message('sensitivity settings?'));
  engine.addMessage(message('sensitivity?'));
  assert.equal(engine.list().length, 1);
  assert.equal(engine.list()[0].count, 2);
});

test('sample users are distinct, limited to three, and returned as snapshots', () => {
  const engine = makeEngine();
  for (const user of ['alice', 'bob', 'alice', 'cora', 'dan']) {
    engine.addMessage(message('play ranked please', user));
  }
  const cue = engine.list()[0];
  assert.equal(cue.count, 5);
  assert.deepEqual(cue.users, ['alice', 'bob', 'cora']);
  cue.users.push('outsider');
  cue.count = 999;
  assert.equal(engine.list()[0].count, 5);
  assert.deepEqual(engine.list()[0].users, ['alice', 'bob', 'cora']);
});

test('!boost increases the top open cue boosts and score by three', () => {
  const engine = makeEngine();
  engine.addMessage(message('what sensitivity do you use?'));
  engine.addMessage(message('what sens do you use'));
  engine.addMessage(message('next tournament when?'));
  const before = engine.list()[0];
  assert.deepEqual(engine.addMessage(message('!boost')), { type: 'boost' });
  const after = engine.list().find((cue) => cue.id === before.id);
  assert.equal(after.boosts, 1);
  assert.equal(after.score, before.score + 3);
  assert.equal(after.count, before.count);
  assert.equal(engine.list().length, 2);
});

test('targeted boosts select a matching word with aliases; absent targets are a no-op', () => {
  const engine = makeEngine();
  const first = engine.addMessage(message('sensitivity settings?')).cue;
  const second = engine.addMessage(message('next tournament when?')).cue;
  engine.addMessage(message('!boost tourney'));
  assert.equal(engine.list().find((cue) => cue.id === second.id).boosts, 1);
  assert.equal(engine.list().find((cue) => cue.id === first.id).boosts, 0);
  engine.addMessage(message('!boost missing'));
  assert.equal(engine.list().reduce((sum, cue) => sum + cue.boosts, 0), 1);
  assert.deepEqual(makeEngine().addMessage(message('!boost')), { type: 'boost' });
});

test('featuring replaces the previous feature; dismissing removes a cue from the list', () => {
  const engine = makeEngine();
  const first = engine.addMessage(message('sensitivity settings?')).cue;
  const second = engine.addMessage(message('next tournament when?')).cue;
  assert.equal(engine.feature(first.id).status, 'featured');
  assert.equal(engine.feature(second.id).status, 'featured');
  assert.equal(engine.list().find((cue) => cue.id === first.id).status, 'open');
  assert.equal(engine.list().filter((cue) => cue.status === 'featured').length, 1);
  assert.equal(engine.dismiss(second.id).status, 'dismissed');
  assert.deepEqual(engine.list().map((cue) => cue.id), [first.id]);
  assert.equal(engine.feature(second.id), null);
  assert.equal(engine.feature('missing'), null);
  assert.equal(engine.dismiss('missing'), null);
});

test('featured and dismissed cues are excluded from clustering and boosts', () => {
  const engine = makeEngine();
  const featured = engine.addMessage(message('play ranked please')).cue;
  engine.feature(featured.id);
  engine.addMessage(message('!boost ranked'));
  assert.equal(engine.list()[0].boosts, 0);
  const fresh = engine.addMessage(message('can you play ranked')).cue;
  assert.notEqual(fresh.id, featured.id);
  engine.addMessage(message('!boost'));
  assert.equal(engine.list().find((cue) => cue.id === fresh.id).boosts, 1);
  engine.dismiss(fresh.id);
  const latest = engine.addMessage(message('play ranked pls')).cue;
  assert.notEqual(latest.id, fresh.id);
  assert.equal(latest.count, 1);
});

test('question/request bonus is small and chatter is accepted', () => {
  const engine = makeEngine();
  for (const text of ['Nice clutch!', 'next map?', 'how do wall jumps work', 'play ranked please', 'can you show inventory']) {
    engine.addMessage(message(text));
  }
  const cues = engine.list();
  assert.equal(cues.length, 5);
  const chatter = cues.find((cue) => cue.text === 'Nice clutch!');
  assert.equal(chatter.isQuestion, false);
  assert.equal(chatter.score, 5);
  assert.ok(cues.filter((cue) => cue.id !== chatter.id).every((cue) => cue.score === 6));
});

test('recency decays to zero at 60 seconds and cannot exceed three for future timestamps', () => {
  const cue = { count: 2, boosts: 1, lastTs: NOW, isQuestion: true };
  assert.equal(score(cue, NOW), 11);
  assert.equal(score(cue, NOW + 20_000), 10);
  assert.equal(score(cue, NOW + 60_000), 8);
  assert.equal(score(cue, NOW + 120_000), 8);
  assert.equal(score(cue, NOW - 5000), 11);
});

test('empty normalized content does not cluster unrelated punctuation-only messages', () => {
  const engine = makeEngine();
  engine.addMessage(message('!!!'));
  engine.addMessage(message('[Kappa]'));
  assert.equal(engine.list().length, 2);
});

test('bad input is rejected and out-of-order timestamps cannot move lastTs backward', () => {
  const engine = makeEngine();
  assert.throws(() => engine.addMessage(message('   ')), /non-empty/);
  assert.throws(() => engine.addMessage(message('hello', 'viewer', 'invalid')), /timestamp/);
  engine.addMessage(message('play ranked please'));
  engine.addMessage(message('play ranked pls', 'late-viewer', NOW - 1000));
  assert.equal(engine.list()[0].lastTs, NOW);
  assert.equal(engine.list()[0].firstTs, NOW - 1000);
});
