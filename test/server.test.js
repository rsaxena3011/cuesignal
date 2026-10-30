import test from 'node:test';
import assert from 'node:assert/strict';
import { CueEngine } from '../src/cluster.js';
import { createApp, parseEnv, readConfig, loadEnv } from '../src/server.js';

// Exercise the real request handler without listening on any port or starting
// the server, simulator, or Twitch adapter.
function request(app, url, method = 'GET', headers = {}) {
  const result = {};
  app.handler({ url, method, headers: { host: 'localhost:4737', ...headers }, resume() {} }, {
    writeHead(status, responseHeaders) {
      result.status = status;
      result.headers = responseHeaders;
    },
    end(body) {
      result.text = body;
      if (result.headers['Content-Type'].startsWith('application/json')) result.json = JSON.parse(body);
    },
  });
  return result;
}

test('env parser accepts documented syntax and ignores unrelated or malformed values', () => {
  assert.deepEqual(parseEnv('\uFEFF# demo\nPORT = 4899 # local\nexport TWITCH_CHANNEL_ID=""\nTWITCH_CLIENT_ID=\'\' # optional\nTWITCH_USER_TOKEN=\nUNRELATED=value\nBAD LINE\nPORT="unterminated'), {
    PORT: '4899', TWITCH_CHANNEL_ID: '', TWITCH_CLIENT_ID: '', TWITCH_USER_TOKEN: '',
  });
});

test('missing env file is optional', async () => {
  const env = { PORT: '4999' };
  assert.equal(await loadEnv(new URL('./does-not-exist.env', import.meta.url), env), env);
});

test('mode requires every Twitch value and validates port', () => {
  assert.equal(readConfig({}).mode, 'SIMULATED FEED');
  assert.equal(readConfig({}).port, 4737);
  assert.equal(readConfig({ TWITCH_CLIENT_ID: 'placeholder', TWITCH_USER_TOKEN: 'placeholder' }).mode, 'SIMULATED FEED');
  assert.equal(readConfig({ TWITCH_CLIENT_ID: 'placeholder', TWITCH_USER_TOKEN: 'placeholder', TWITCH_CHANNEL_ID: '123' }).mode, 'LIVE');
  assert.equal(readConfig({ PORT: '5000' }).port, 5000);
  for (const PORT of ['0', '-1', '65536', 'abc', '1.5']) assert.throws(() => readConfig({ PORT }), /PORT/);
});

test('dashboard and overlay routes serve their self-contained HTML', async () => {
  const app = await createApp({ env: {} });
  for (const path of ['/', '/overlay']) {
    const response = request(app, path);
    assert.equal(response.status, 200);
    assert.equal(response.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.match(response.text, /<!doctype html>/i);
  }
});

test('health and initial state advertise simulated mode without any credentials', async () => {
  const app = await createApp({ env: {} });
  assert.deepEqual(request(app, '/health').json, { ok: true, mode: 'SIMULATED FEED' });
  assert.deepEqual(request(app, '/api/cues').json, { mode: 'SIMULATED FEED', cues: [] });
  assert.deepEqual(request(app, '/api/state').json, { mode: 'SIMULATED FEED', featured: null, top: [] });
});

test('API feature and dismiss actions update the state and ranked cue list', async () => {
  const engine = new CueEngine();
  engine.addMessage({ user: 'viewer', text: 'what sensitivity do you use?', ts: Date.now() });
  engine.addMessage({ user: 'another', text: 'when is the tournament?', ts: Date.now() });
  const app = await createApp({ env: {}, engine });
  const cues = request(app, '/api/cues').json.cues;
  assert.equal(cues.length, 2);
  assert.equal(typeof cues[0].score, 'number');
  const first = request(app, `/api/cues/${cues[0].id}/feature`, 'POST');
  assert.equal(first.status, 200);
  assert.equal(first.json.featured.id, cues[0].id);
  const second = request(app, `/api/cues/${cues[1].id}/feature`, 'POST');
  assert.equal(second.json.featured.id, cues[1].id);
  assert.equal(request(app, '/api/cues').json.cues.filter((cue) => cue.status === 'featured').length, 1);
  const dismissed = request(app, `/api/cues/${cues[1].id}/dismiss`, 'POST');
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.json.featured, null);
  assert.equal(request(app, '/api/cues').json.cues.length, 1);
  assert.equal(request(app, `/api/cues/${cues[1].id}/feature`, 'POST').status, 404);
});

test('state top list contains at most five ranked cues', async () => {
  const engine = new CueEngine();
  for (let index = 0; index < 8; index += 1) {
    engine.addMessage({ user: 'viewer', text: `topic${index}?`, ts: Date.now() });
  }
  const app = await createApp({ env: {}, engine });
  assert.equal(request(app, '/api/cues').json.cues.length, 8);
  assert.equal(request(app, '/api/state').json.top.length, 5);
});

test('missing cues, unsupported methods, and unknown files return appropriate errors', async () => {
  const app = await createApp({ env: {} });
  assert.equal(request(app, '/api/cues/missing/feature', 'POST').status, 404);
  assert.equal(request(app, '/api/cues/%ZZ/feature', 'POST').status, 400);
  const wrongMethod = request(app, '/api/cues/missing/feature');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.Allow, 'POST');
  assert.equal(request(app, '/api/state', 'POST').status, 405);
  assert.equal(request(app, '/.env').status, 404);
  assert.equal(request(app, '/package.json').status, 404);
});

test('cross-origin actions are rejected while same-origin actions succeed', async () => {
  const engine = new CueEngine();
  engine.addMessage({ user: 'viewer', text: 'play ranked please', ts: Date.now() });
  const app = await createApp({ env: {}, engine });
  const id = engine.list()[0].id;
  assert.equal(request(app, `/api/cues/${id}/feature`, 'POST', { origin: 'https://elsewhere.example' }).status, 403);
  assert.equal(app.state().featured, null);
  assert.equal(request(app, `/api/cues/${id}/feature`, 'POST', { origin: 'http://localhost:4737' }).status, 200);
});
