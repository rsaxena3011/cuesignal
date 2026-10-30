# CueSignal

A live-chat producer for Twitch streamers: turn repeated chat questions into ranked cues, then put the best one on air.

CueSignal uses **local NLP-style clustering and ranking**: text normalization, a tiny synonym map, token similarity, and a transparent scoring rule. It does not use an external LLM, an AI API, a paid service, or a trained model. The default experience is a clearly labeled **SIMULATED FEED**; it is not connected to Twitch.

## Features

- Live ranked cue cards with representative text, message counts, boosts, scores, and up to three sample usernames.
- One-click Feature and Dismiss controls; only one cue can be on air at a time.
- A transparent OBS overlay with a dark glass lower third and Twitch-purple accent.
- Repeated demo questions, requests, hype chatter, and viewer `!boost` commands.
- An optional Twitch EventSub WebSocket adapter, inactive without credentials.
- Plain Node.js 20+ with `ws` as its only runtime dependency. No framework, CDN, or external assets.

## Quickstart

From this directory, with Node.js 20 or newer installed:

```sh
npm install
npm start
```

Open [the dashboard](http://localhost:4737) and [the overlay](http://localhost:4737/overlay). No `.env` file is needed for the demo. The server binds to `127.0.0.1` for use on this computer. Stop it with Ctrl+C. If PowerShell blocks `npm.ps1`, use `npm.cmd install` and `npm.cmd start` instead.

Within a few seconds, simulated messages begin filling the queue. Feature a cue to display it in the ON AIR banner and overlay. Featuring another cue puts the previous one back in the open queue. Dismissing a featured cue clears the overlay.

In OBS, add a **Browser Source** with URL `http://localhost:4737/overlay`, width `1920`, and height `1080`. The page background is fully transparent. The card is hidden until a cue is featured; preview it by featuring a question from the dashboard. Use the configured port in both URLs if you change `PORT`.

## How the demo works

The simulator emits a message every 900–1600 milliseconds from about 14 fictional usernames. Its repeating template sequence makes questions accumulate predictably, with variable timing and usernames. Topics include sensitivity settings, the next tournament, ranked play, and hype chatter. It can be started and stopped independently.

The dashboard polls `/api/cues` every two seconds. The overlay polls `/api/state` every second, displays only the featured cue, and hides on a failed request. Controls update the dashboard immediately after a successful action.

Counts represent **messages**, not unique viewers. The sample usernames are limited to three; repeated messages by the same viewer still count. Hype and other chatter are accepted alongside questions. A featured cue is held steady: new messages only join open cues, so further messages about its topic can create a new open cue. Dismissed cues stay out of the list; future messages on the same topic can create a fresh cue.

## Clustering and ranking

1. Lowercase text, remove bracketed emote labels (such as `[Kappa]`), strip punctuation, collapse whitespace, and remove a small English stopword list.
2. Normalize `sens → sensitivity`, `tourney → tournament`, `pls → please`, and `u → you` before removing stopwords.
3. Compare unique tokens using **Jaccard similarity**: intersection size divided by union size. Empty token sets score zero.
4. Join the most similar **open** cue when similarity is at least **0.5**. Otherwise create a cue. Keep the first-arriving representative text, update timestamps, increment its count, and record up to three distinct sample users.

For example, “what sensitivity do you use?” and “what sens do you use” both normalize to `sensitivity use` and cluster together. “when is the next tournament” and “next tourney when?” both normalize to `next tournament`. This is token matching: not every paraphrase will cluster, and shared wording can sometimes group different meanings.

```text
ageMs = max(0, now - lastTs)
recencyBonus = max(0, 3 - ageMs / 20000)
score = count * 2 + boosts * 3 + recencyBonus + questionBonus
```

The recency bonus starts at 3 and falls linearly to 0 over 60 seconds without a new matching message. Questions and requests get **1 extra point** if a message ends in `?`, begins with a question/auxiliary word (such as what, when, how, can, or would), or includes a request phrase such as please, pls, can you, how do, show us, or tell us. If any message in a cluster qualifies, that cue keeps the bonus. Scores use the current clock; ties keep creation order. Tests inject the clock for reproducibility.

`!boost` increases the boosts on the highest-ranked open cue. `!boost tournament` targets the highest-ranked open cue containing that whole word in its representative text (synonyms also work). Only the first word after the command is used. A missing target or empty queue is a no-op. Boosts do not create chat cues or refresh their recency.

## Architecture

```text
ChatSimulator ───────────────────────┐
                                    ├─→ CueEngine ─→ Node HTTP API ─→ Dashboard
Optional Twitch EventSub WebSocket ─┘                             └─→ OBS overlay
```

`src/cluster.js` contains the independently testable engine. `src/simulator.js` supplies the default feed. `src/eventsub.js` receives Twitch chat when configured. `src/server.js` loads configuration and serves the API and two self-contained HTML pages.

Everything is held in memory; restarting clears the queue, boosts, and featured state. There is no database, account system, chat sending, or automatic moderation. This is a local producer tool and demo; the in-memory queue is not capped or persisted.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/` | Producer dashboard |
| GET | `/overlay` | Transparent OBS overlay |
| GET | `/api/cues` | `{mode, cues}` with scored open/featured cues |
| GET | `/api/state` | `{mode, featured, top}` with up to five ranked cues |
| POST | `/api/cues/:id/feature` | Feature one cue and return updated state |
| POST | `/api/cues/:id/dismiss` | Dismiss one cue and return updated state |
| GET | `/health` | `{ok: true, mode}` |

Unknown cues return 404; unsupported methods on known routes return 405. HTML and JSON responses disable caching. Only the two specified HTML files are served, so configuration files are never exposed. Importing the server module does not start anything.

## Optional real Twitch mode

1. Copy `.env.example` to `.env` in this directory. `.env` is git-ignored; keep your own credentials there and never commit or share them.
2. Register a Twitch application in the [Twitch developer console](https://dev.twitch.tv/console/apps). Set `TWITCH_CLIENT_ID` to its client ID.
3. Obtain a **user access token** for that application with the `user:read:chat` scope, following [Twitch's OAuth documentation](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/). Set `TWITCH_USER_TOKEN` to the raw token. An app access token is not sufficient for this adapter. CueSignal does not implement an OAuth sign-in or refresh flow.
4. Set `TWITCH_CHANNEL_ID` to the broadcaster's numeric Twitch user ID, not their username. Twitch's [Get Users endpoint](https://dev.twitch.tv/docs/api/reference/#get-users) can resolve a login to an ID.
5. Leave `PORT=4737` or choose an available port, then restart with `npm start`.

The tiny `.env` parser supports blank lines, comments, and quoted values for the four documented keys. Values already in the process environment take precedence. Empty or missing Twitch values leave EventSub disabled; the adapter logs `EventSub disabled: missing TWITCH_* env values`.

With all three Twitch values present, the UI reports **LIVE** and EventSub starts **alongside the simulator**. Simulated messages continue to appear in the same cue list, as required for this demo. LIVE indicates configured real mode, not proof of a healthy connection; check the terminal for subscription success or errors. `/health` reports application availability, not Twitch connectivity.

The adapter validates the token to determine its owner's user ID, then subscribes to `channel.chat.message` using the broadcaster ID and token-owner ID. It forwards chat text and handles Twitch reconnect handoffs. Missing scope, expired tokens, and failed subscriptions are logged without displaying credentials. If authorization fails, correct `.env` and restart; simulated chat remains available. See Twitch's [chat subscription requirements](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage), [token validation](https://dev.twitch.tv/docs/authentication/validate-tokens/), and [WebSocket lifecycle](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/).

## Tests

```sh
npm test
```

Tests use Node's built-in test runner. They cover normalization, synonym matching, similarity, clustering, boosts, ranking, cue transitions, simulated feed lifecycle, EventSub behavior using fake transport, configuration, and HTTP route behavior. They do not require Twitch credentials, contact Twitch, or start the application server. API tests invoke the real routing handler directly without listening on a port.

Real Twitch connectivity must be verified with your own authorized credentials; no real credentials are bundled or used in the tests.

## Built with Codex

Built with Codex. The runtime logic is plain JavaScript and deterministic local NLP-style clustering and ranking; no external AI service is used.

## Judge promise, anchor moment, and rubric map

(Section added 2026-10-30, after the main Codex build session, under the team's standing Rishit-pattern rules.)

**Judge promise (one sentence):** CueSignal takes a Twitch chat moving too fast to read and produces a ranked, one-click-to-air cue card for the question chat is actually asking, in under 10 seconds.

**Anchor moment (the first 10 seconds):** Open the dashboard on the simulated feed. Within seconds, repeated questions visibly merge into one cue card whose count climbs live; the streamer clicks Feature and the question is on the OBS overlay as a clean lower-third. No setup, no credentials, no dead air.

**Feature-to-rubric-points map** (Codex x TwitchCon judging: Innovation, Potential Impact, Technological Implementation, Design, equally weighted):

| Feature | Rubric line it wins |
|---|---|
| Near-duplicate question clustering (normalization + synonyms + token similarity) that merges "what sens?" spam into one cue | Innovation: a producer's view of chat, not another chat reader |
| `!boost` audience support counts feeding the ranking | Innovation + Potential Impact: the crowd, not just volume, decides what gets answered |
| One-click Feature/Dismiss with a dedicated OBS browser-source overlay | Design: streamer-grade, zero-friction workflow inside a real broadcast stack |
| EventSub WebSocket adapter (real Twitch mode via `.env`) running alongside a full simulated feed | Technological Implementation: real platform integration, honestly demoable without credentials |
| The whole build executed in one main Codex session (scaffold, engine, adapters, dashboard, tests) | Technological Implementation (Codex use): the session is the build log |
| 31 automated tests (engine, EventSub with fake transport, HTTP routes) | Technological Implementation: verified, rerunnable, no credentials needed |
| Solo and small streamers get a producer they cannot hire | Potential Impact: every small channel with an unread chat qualifies |
