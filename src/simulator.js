import { EventEmitter } from 'node:events';

export const USERNAMES = Object.freeze([
  'pixelpilot', 'novafox', 'lunarloot', 'bytebloom', 'aimatlas', 'cozycrit',
  'orbitowl', 'neonnoodle', 'questcat', 'mossmage', 'turbotea', 'cloudcombo',
  'mintymain', 'echoember',
]);

// An ordered loop guarantees recurring topics; only timing and usernames vary.
export const TEMPLATES = Object.freeze([
  'what sensitivity do you use?',
  'when is the next tournament',
  'what sens do you use',
  'play ranked please',
  'that clutch was incredible!',
  'which sensitivity settings??',
  'next tourney when?',
  'can you play ranked',
  '!boost',
  'what sensitivity do u use?',
  'how do you practice your aim?',
  'play ranked pls',
  'LET’S GO [PogChamp]',
  'when is the next tournament?',
  'what sens do you use',
  '!boost tournament',
  'can you explain your warmup?',
  'how do you practice aim?',
  'play ranked please',
  'that clutch was incredible!',
  'can you explain your warmup routine?',
  '!boost ranked',
  'next tourney when?',
  'what sensitivity do you use?',
]);

export class ChatSimulator extends EventEmitter {
  constructor({
    random = Math.random,
    now = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    super();
    this.random = random;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.running = false;
    this.timer = null;
    this.index = 0;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.schedule();
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer !== null) this.clearTimeoutFn(this.timer);
    this.timer = null;
    return this;
  }

  schedule() {
    if (!this.running) return;
    const delay = 900 + Math.floor(this.random() * 701);
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      if (!this.running) return;
      const user = USERNAMES[Math.floor(this.random() * USERNAMES.length)];
      const text = TEMPLATES[this.index++ % TEMPLATES.length];
      this.emit('message', { user, text, ts: this.now() });
      this.schedule();
    }, delay);
  }
}
