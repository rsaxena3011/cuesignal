import WebSocket from 'ws';

const SOCKET_URL = 'wss://eventsub.wss.twitch.tv/ws';
const SUBSCRIPTIONS_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';

/**
 * Optional real Twitch input. The second argument allows fully offline tests.
 * `ready` resolves after validation and opening the socket, not after subscribing.
 * A user access token with user:read:chat is required; its owner can differ from
 * the broadcaster. Secrets, raw API responses, and reconnect URLs are never logged.
 */
export function startEventSub({ clientId, userToken, channelId, onMessage } = {}, {
  WebSocketImpl = WebSocket,
  fetchImpl = globalThis.fetch,
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = Date.now,
} = {}) {
  if (![clientId, userToken, channelId].every(value => typeof value === 'string' && value.trim())) {
    logger.log('EventSub disabled: missing TWITCH_* env values');
    return null;
  }

  clientId = clientId.trim();
  userToken = userToken.trim();
  channelId = channelId.trim();
  let stopped = false;
  let tokenUserId;
  let active = null;
  let migration = null;
  let retryTimer = null;
  let validationTimer = null;
  let retries = 0;
  const connections = new Set();
  const seenMessages = new Set();

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeoutFn(retryTimer);
    clearTimeoutFn(validationTimer);
    for (const connection of connections) {
      connection.retired = true;
      clearTimeoutFn(connection.timer);
      connection.socket.terminate();
    }
    connections.clear();
    active = null;
    migration = null;
    logger.log('EventSub stopped');
  }

  async function validateToken() {
    const response = await fetchImpl(VALIDATE_URL, {
      headers: { Authorization: `OAuth ${userToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (stopped) return false;
    if (!response.ok) {
      logger.error(`EventSub token validation failed (HTTP ${response.status}); check TWITCH_USER_TOKEN.`);
      return false;
    }
    const token = await response.json();
    if (token.client_id !== clientId || !token.user_id || !token.scopes?.includes('user:read:chat')) {
      logger.error('EventSub requires a matching client ID and a user token with user:read:chat scope.');
      return false;
    }
    tokenUserId = token.user_id;
    return true;
  }

  function scheduleValidation() {
    validationTimer = setTimeoutFn(async () => {
      if (stopped) return;
      try {
        if (!await validateToken()) return stop();
        scheduleValidation();
      } catch {
        logger.error('EventSub token revalidation failed; restart after checking your connection and token.');
        stop();
      }
    }, 60 * 60 * 1000);
  }

  function retry() {
    if (stopped || retryTimer !== null || active || migration) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(retries++, 5));
    logger.log(`EventSub reconnecting in ${delay / 1000}s`);
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      if (!stopped && !active && !migration) connect(SOCKET_URL);
    }, delay);
  }

  function armWatchdog(connection) {
    clearTimeoutFn(connection.timer);
    connection.timer = setTimeoutFn(() => {
      if (stopped || connection.retired) return;
      logger.warn('EventSub connection timed out; reconnecting.');
      connection.socket.terminate();
    }, connection.keepaliveMs + 1000);
  }

  async function subscribe(connection, sessionId) {
    try {
      const response = await fetchImpl(SUBSCRIPTIONS_URL, {
        method: 'POST',
        headers: {
          'Client-Id': clientId,
          Authorization: `Bearer ${userToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'channel.chat.message',
          version: '1',
          condition: { broadcaster_user_id: channelId, user_id: tokenUserId },
          transport: { method: 'websocket', session_id: sessionId },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (stopped || connection.retired) return;
      if (!response.ok) {
        logger.error(`EventSub subscription failed (HTTP ${response.status}); verify token scope and channel ID.`);
        // Bad credentials/configuration need intervention, not endless retries.
        if ([400, 401, 403].includes(response.status)) return stop();
        connection.socket.terminate();
        return;
      }
      retries = 0;
      logger.log('EventSub subscribed: channel.chat.message (real Twitch chat active)');
    } catch {
      if (!stopped && !connection.retired) {
        logger.error('EventSub subscription request failed; reconnecting.');
        connection.socket.terminate();
      }
    }
  }

  function connect(url, previous = null) {
    if (stopped) return;
    let socket;
    try {
      socket = new WebSocketImpl(url, { handshakeTimeout: 10000 });
    } catch {
      logger.error('EventSub could not open a WebSocket connection.');
      retry();
      return;
    }
    const connection = { socket, previous, retired: false, welcomed: false, timer: null, keepaliveMs: 15000 };
    connections.add(connection);
    if (previous) migration = connection;
    else active = connection;
    armWatchdog(connection);

    socket.on('open', () => logger.log('EventSub WebSocket connected; waiting for session welcome.'));
    socket.on('error', () => {
      if (!stopped && !connection.retired) logger.error('EventSub WebSocket error; connection will retry.');
    });
    socket.on('close', code => {
      clearTimeoutFn(connection.timer);
      connections.delete(connection);
      if (active === connection) active = null;
      if (migration === connection) migration = null;
      if (stopped || connection.retired) return;
      logger.log(`EventSub WebSocket closed (${code}).`);
      retry();
    });
    socket.on('message', data => {
      if (stopped || connection.retired) return;
      let message;
      try { message = JSON.parse(data.toString()); }
      catch {
        logger.warn('EventSub ignored an invalid JSON message.');
        return;
      }
      const metadata = message?.metadata ?? {};
      const payload = message?.payload ?? {};
      switch (metadata.message_type) {
        case 'session_welcome': {
          if (connection.welcomed) return;
          const session = payload.session;
          if (!session?.id) return;
          connection.welcomed = true;
          connection.keepaliveMs = Math.max(1000, (session.keepalive_timeout_seconds ?? 10) * 1000);
          armWatchdog(connection);
          if (previous) {
            // Twitch transfers subscriptions. Keep the old socket until welcome,
            // then close it without making a duplicate subscription request.
            active = connection;
            migration = null;
            previous.retired = true;
            clearTimeoutFn(previous.timer);
            previous.socket.close();
            retries = 0;
            logger.log('EventSub session reconnected; existing subscription retained.');
          } else {
            void subscribe(connection, session.id);
          }
          break;
        }
        case 'session_keepalive':
          armWatchdog(connection);
          break;
        case 'session_reconnect': {
          const reconnectUrl = payload.session?.reconnect_url;
          if (connection !== active || migration || typeof reconnectUrl !== 'string') return;
          // Use Twitch's URL unchanged, but never connect to an unrelated host.
          try {
            const parsed = new URL(reconnectUrl);
            if (parsed.protocol !== 'wss:' || parsed.hostname !== 'eventsub.wss.twitch.tv') throw new Error();
          } catch {
            logger.warn('EventSub ignored an invalid reconnect URL.');
            return;
          }
          logger.log('EventSub requested a session reconnect.');
          connect(reconnectUrl, connection);
          break;
        }
        case 'notification': {
          armWatchdog(connection);
          if ((metadata.subscription_type ?? payload.subscription?.type) !== 'channel.chat.message') return;
          const event = payload.event;
          if (!event || typeof event.message?.text !== 'string') return;
          const messageId = event.message_id ?? metadata.message_id;
          if (messageId && seenMessages.has(messageId)) return;
          if (messageId) {
            seenMessages.add(messageId);
            if (seenMessages.size > 1000) seenMessages.delete(seenMessages.values().next().value);
          }
          const timestamp = Date.parse(metadata.message_timestamp);
          try {
            onMessage?.({
              user: event.chatter_user_name || event.chatter_user_login || 'viewer',
              text: event.message.text,
              ts: Number.isFinite(timestamp) ? timestamp : now(),
            });
          } catch {
            logger.error('EventSub chat message callback failed.');
          }
          break;
        }
        case 'revocation':
          logger.error('EventSub subscription revoked; check Twitch authorization and restart.');
          stop();
          break;
      }
    });
  }

  const ready = (async () => {
    try {
      if (!await validateToken()) {
        stop();
        return false;
      }
      if (stopped) return false;
      logger.log('EventSub token validated; connecting real Twitch input.');
      connect(SOCKET_URL);
      scheduleValidation();
      return true;
    } catch {
      logger.error('EventSub initialization failed; check your connection and TWITCH_* values.');
      stop();
      return false;
    }
  })();

  return { stop, ready };
}
