// This is deterministic local NLP-style matching, not an LLM or an AI service.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'for', 'in', 'on', 'at',
  'is', 'are', 'was', 'were', 'be', 'it', 'this', 'that', 'i', 'me', 'my',
  'we', 'our', 'you', 'your', 'do', 'does', 'did', 'can', 'could', 'would',
  'what', 'which', 'when', 'where', 'who', 'why', 'how', 'please',
]);

const SYNONYMS = new Map([
  ['sens', 'sensitivity'],
  ['tourney', 'tournament'],
  ['pls', 'please'],
  ['u', 'you'],
]);

function words(text) {
  return String(text)
    .toLowerCase()
    // Remove bracketed emote labels such as [Kappa] before punctuation.
    .replace(/\[[^\]]*\]|<[^>]*>|\{[^}]*\}/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => SYNONYMS.get(token) ?? token);
}

/** Lowercase, strip punctuation/emote labels, map aliases, and drop stopwords. */
export function normalize(text) {
  return words(text).filter((token) => !STOPWORDS.has(token));
}

/** Jaccard intersection / union over unique tokens; two empty sets score zero. */
export function similarity(a, b) {
  const left = new Set(typeof a === 'string' ? normalize(a) : a);
  const right = new Set(typeof b === 'string' ? normalize(b) : b);
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / union.size;
}

function isQuestionOrRequest(text) {
  // A trailing ?, a leading question/auxiliary word, or a request phrase earns
  // one extra ranking point. This simple heuristic also accepts plain chatter.
  const expanded = text.toLowerCase().replace(/\bu\b/g, 'you');
  return /\?\s*$/.test(expanded)
    || /^(who|what|when|where|why|which|how|can|could|would|will|do|does|did|is|are|should)\b/.test(expanded)
    || /\b(please|pls)\b|\b(can you|could you|would you|how do|show us|tell us)\b/.test(expanded);
}

/**
 * Two points per message, three per boost, one for a question/request.
 * Recency adds up to 3 points, losing 1 point per 20 seconds since lastTs;
 * it reaches zero after 60 seconds. Passing `now` makes scoring reproducible.
 */
export function score(cue, now = Date.now()) {
  const age = Math.max(0, now - cue.lastTs);
  const recency = Math.max(0, 3 - age / 20_000);
  return cue.count * 2 + cue.boosts * 3 + recency + (cue.isQuestion ? 1 : 0);
}

export class CueEngine {
  #cues = new Map();
  #nextId = 1;
  #now;

  constructor({ now = Date.now } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.#now = now;
  }

  #snapshot(cue, now = this.#now()) {
    return { ...cue, users: [...cue.users], score: score(cue, now) };
  }

  score(cue) {
    return score(cue, this.#now());
  }

  addMessage({ user = 'anonymous', text, ts = this.#now() }) {
    if (typeof text !== 'string' || !text.trim()) {
      throw new TypeError('Message text must be a non-empty string');
    }
    text = text.trim();

    if (text.toLowerCase().startsWith('!boost')) {
      const targetWord = words(text.slice(6).trim().split(/\s+/)[0])[0];
      const target = this.list().find((cue) => cue.status === 'open'
        && (!targetWord || words(cue.text).includes(targetWord)));
      if (target) this.#cues.get(target.id).boosts += 1;
      // A boost never creates a cue, and an unmatched target is a no-op.
      return { type: 'boost' };
    }

    const timestamp = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!Number.isFinite(timestamp)) throw new TypeError('Invalid message timestamp');
    const username = typeof user === 'string' && user.trim() ? user.trim() : 'anonymous';
    const tokens = normalize(text);
    let match = null;
    let bestSimilarity = 0.5;
    for (const cue of this.#cues.values()) {
      if (cue.status !== 'open') continue;
      const overlap = similarity(tokens, normalize(cue.text));
      // On a tie, retain the first-created representative.
      if (overlap >= bestSimilarity && (!match || overlap > bestSimilarity)) {
        match = cue;
        bestSimilarity = overlap;
      }
    }

    if (match) {
      match.count += 1;
      match.lastTs = Math.max(match.lastTs, timestamp);
      match.firstTs = Math.min(match.firstTs, timestamp);
      match.isQuestion ||= isQuestionOrRequest(text);
      if (match.users.length < 3 && !match.users.includes(username)) match.users.push(username);
    } else {
      match = {
        id: `cue-${this.#nextId++}`,
        text,
        count: 1,
        boosts: 0,
        users: [username],
        firstTs: timestamp,
        lastTs: timestamp,
        status: 'open',
        isQuestion: isQuestionOrRequest(text),
      };
      this.#cues.set(match.id, match);
    }
    return { type: 'cue', cue: this.#snapshot(match) };
  }

  list() {
    const now = this.#now();
    return [...this.#cues.values()]
      .filter((cue) => cue.status === 'open' || cue.status === 'featured')
      .map((cue) => this.#snapshot(cue, now))
      // Array sort is stable: equal scores keep creation order.
      .sort((a, b) => b.score - a.score);
  }

  feature(id) {
    const selected = this.#cues.get(id);
    if (!selected || selected.status === 'dismissed') return null;
    for (const cue of this.#cues.values()) {
      if (cue.status === 'featured') cue.status = 'open';
    }
    selected.status = 'featured';
    return this.#snapshot(selected);
  }

  dismiss(id) {
    const selected = this.#cues.get(id);
    if (!selected) return null;
    selected.status = 'dismissed';
    return this.#snapshot(selected);
  }
}
