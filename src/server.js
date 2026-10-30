import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CueEngine } from './cluster.js';
import { ChatSimulator } from './simulator.js';
import { startEventSub } from './eventsub.js';

const ENV_KEYS = new Set(['TWITCH_CLIENT_ID', 'TWITCH_USER_TOKEN', 'TWITCH_CHANNEL_ID', 'PORT']);
const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

// Intentionally small .env parser: known keys only, optional quotes/comments,
// no interpolation or evaluation. Existing process environment values win.
export function parseEnv(source) {
  const values = {};
  for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)$/);
    if (!match || !ENV_KEYS.has(match[1])) continue;
    const raw = match[2].trim();
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const end = raw.indexOf(raw[0], 1);
      if (end === -1 || !/^\s*(?:#.*)?$/.test(raw.slice(end + 1))) continue;
      values[match[1]] = raw.slice(1, end);
    } else {
      values[match[1]] = raw.replace(/\s+#.*$/, '').trim();
    }
  }
  return values;
}

export async function loadEnv(path = resolve(PROJECT_ROOT, '.env'), env = process.env) {
  try {
    const values = parseEnv(await readFile(path, 'utf8'));
    for (const [key, value] of Object.entries(values)) {
      if (env[key] === undefined) env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return env;
}

export function readConfig(env = process.env) {
  const port = Number(env.PORT?.trim() || 4737);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const clientId = env.TWITCH_CLIENT_ID?.trim() || '';
  const userToken = env.TWITCH_USER_TOKEN?.trim() || '';
  const channelId = env.TWITCH_CHANNEL_ID?.trim() || '';
  return { port, clientId, userToken, channelId, mode: clientId && userToken && channelId ? 'LIVE' : 'SIMULATED FEED' };
}

function send(response, statusCode, body, contentType = 'application/json; charset=utf-8', extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(contentType.startsWith('application/json') ? JSON.stringify(body) : body);
}

// Importing this module never binds a port or starts a chat source. Tests can
// exercise the actual routing handler directly, with no running server.
export async function createApp({ env = process.env, engine = new CueEngine() } = {}) {
  const config = readConfig(env);
  const { mode } = config;
  const [dashboard, overlay] = await Promise.all([
    readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/overlay.html', import.meta.url), 'utf8'),
  ]);
  const state = () => {
    const cues = engine.list();
    return { mode, featured: cues.find((cue) => cue.status === 'featured') ?? null, top: cues.slice(0, 5) };
  };

  function handler(request, response) {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      return send(response, 400, { error: 'Invalid URL.' });
    }
    const action = /^\/api\/cues\/([^/]+)\/(feature|dismiss)$/.exec(pathname);
    const isGetRoute = ['/', '/overlay', '/api/cues', '/api/state', '/health'].includes(pathname);
    if ((isGetRoute && request.method !== 'GET') || (action && request.method !== 'POST')) {
      return send(response, 405, { error: 'Method not allowed.' }, undefined, { Allow: action ? 'POST' : 'GET' });
    }
    if (request.method === 'GET') {
      if (pathname === '/') return send(response, 200, dashboard, 'text/html; charset=utf-8');
      if (pathname === '/overlay') return send(response, 200, overlay, 'text/html; charset=utf-8');
      if (pathname === '/health') return send(response, 200, { ok: true, mode });
      if (pathname === '/api/cues') return send(response, 200, { mode, cues: engine.list() });
      if (pathname === '/api/state') return send(response, 200, state());
    }
    if (request.method === 'POST' && action) {
      // Browser actions are same-origin. Block cross-site form posts to this
      // local producer console; command-line clients need no Origin header.
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) {
        return send(response, 403, { error: 'Actions must come from this dashboard.' });
      }
      request.resume();
      let id;
      try {
        id = decodeURIComponent(action[1]);
      } catch {
        return send(response, 400, { error: 'Invalid cue ID.' });
      }
      const cue = engine[action[2]](id);
      if (!cue) return send(response, 404, { error: 'Cue not found or no longer available.' });
      return send(response, 200, state());
    }
    return send(response, 404, { error: 'Not found.' });
  }
  return { handler, state, engine, mode, config };
}

async function main() {
  await loadEnv();
  const app = await createApp();
  const simulator = new ChatSimulator();
  simulator.on('message', (message) => app.engine.addMessage(message));
  const server = http.createServer(app.handler);
  await new Promise((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(app.config.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolveListening();
    });
  });
  server.on('error', (error) => console.error(`HTTP server error: ${error.code || 'unknown error'}`));
  console.log(`CueSignal dashboard: http://localhost:${app.config.port}`);
  console.log(`OBS overlay: http://localhost:${app.config.port}/overlay`);
  console.log('SIMULATED FEED is running. Clustering and ranking are local; no AI API is used.');
  simulator.start();
  if (app.mode === 'LIVE') {
    console.log('LIVE mode is on: Twitch EventSub is enabled alongside the simulated feed. Watch EventSub logs for connection status.');
  }
  const eventSub = startEventSub({
    clientId: app.config.clientId,
    userToken: app.config.userToken,
    channelId: app.config.channelId,
    onMessage: (message) => app.engine.addMessage(message),
  });
  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    console.log('Stopping CueSignal.');
    simulator.stop();
    eventSub?.stop();
    server.close();
    server.closeIdleConnections();
    const timeout = setTimeout(() => server.closeAllConnections(), 2000);
    timeout.unref();
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Do not include config values or request bodies in startup errors.
    console.error(`CueSignal could not start: ${error.code || error.message}`);
    process.exitCode = 1;
  });
}
