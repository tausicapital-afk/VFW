import { SocketThrottle, socketBuckets, type SocketBucket } from './socket-throttle';

/**
 * The socket limiter, tested pure — the clock is injected, so there is no timer,
 * no socket server and no sleeping. Same style as receipts.ts.
 */

// A clock we drive by hand.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const MINUTE = 60_000;

/** A single small bucket, so a breach takes three events rather than sixty. */
const tiny: SocketBucket[] = [
  { name: 'events', ttlMs: MINUTE, limit: 2, blockMs: 30_000, appliesTo: () => true },
];

describe('SocketThrottle', () => {
  it('allows events up to the limit and refuses the one past it', () => {
    const c = clock();
    const t = new SocketThrottle(tiny, c.now);

    expect(t.check('u1', 'typing').allowed).toBe(true);
    expect(t.check('u1', 'typing').allowed).toBe(true);

    const verdict = t.check('u1', 'typing');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.bucket).toBe('events');
      expect(verdict.retryAfterMs).toBe(30_000);
    }
  });

  it('throttles the flooder alone — a second user in the same conversation is untouched', () => {
    const c = clock();
    const t = new SocketThrottle(tiny, c.now);

    // u1 floods until they are blocked.
    t.check('u1', 'typing');
    t.check('u1', 'typing');
    expect(t.check('u1', 'typing').allowed).toBe(false);

    // u2 has spent nothing. Keying on userId (not IP) is what makes this true
    // even when both sit behind the same office NAT.
    expect(t.check('u2', 'typing').allowed).toBe(true);
    expect(t.check('u2', 'typing').allowed).toBe(true);
  });

  it('keeps the door shut for the whole block, then reopens', () => {
    const c = clock();
    const t = new SocketThrottle(tiny, c.now);

    t.check('u1', 'read');
    t.check('u1', 'read');
    expect(t.check('u1', 'read').allowed).toBe(false);

    // Still blocked most of the way through...
    c.advance(29_000);
    const still = t.check('u1', 'read');
    expect(still.allowed).toBe(false);
    if (!still.allowed) expect(still.retryAfterMs).toBe(1_000);

    // ...and released once the block expires.
    c.advance(1_001);
    expect(t.check('u1', 'read').allowed).toBe(true);
  });

  it('cannot be reset by reconnecting — the window is the user\'s, not the socket\'s', () => {
    const c = clock();
    const t = new SocketThrottle(tiny, c.now);

    t.check('u1', 'typing');
    t.check('u1', 'typing');
    expect(t.check('u1', 'typing').allowed).toBe(false);

    // A dropped and re-established socket is still the same user. There is
    // deliberately no forget()/reset() for a disconnect to call: if there were,
    // a flooder would just cycle their connection and carry on.
    expect(t).not.toHaveProperty('forget');
    expect(t.check('u1', 'typing').allowed).toBe(false);
  });

  it('rolls the counter over at the end of the window', () => {
    const c = clock();
    const t = new SocketThrottle(tiny, c.now);

    t.check('u1', 'typing');
    t.check('u1', 'typing');

    // A minute later the window has rolled and the budget is fresh — without
    // ever having been blocked, because the third event never came.
    c.advance(MINUTE + 1);
    expect(t.check('u1', 'typing').allowed).toBe(true);
    expect(t.check('u1', 'typing').allowed).toBe(true);
    expect(t.check('u1', 'typing').allowed).toBe(false);
  });
});

describe('the shipped bucket table', () => {
  it('trips the tighter typing bucket before the events backstop', () => {
    const c = clock();
    const t = new SocketThrottle(socketBuckets, c.now);

    // typing is 60/min, events 240/min: a typing flood must be stopped by
    // `typing`, not grind on to the backstop.
    for (let i = 0; i < 60; i++) expect(t.check('u1', 'typing').allowed).toBe(true);

    const verdict = t.check('u1', 'typing');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.bucket).toBe('typing');
  });

  it('a typing block does not stop that user sending read receipts', () => {
    const c = clock();
    const t = new SocketThrottle(socketBuckets, c.now);

    for (let i = 0; i < 61; i++) t.check('u1', 'typing');
    expect(t.check('u1', 'typing').allowed).toBe(false);

    // `read` is not in the typing bucket, and the events backstop is nowhere
    // near — receipts keep flowing, so ticks stay correct for a chatty client.
    expect(t.check('u1', 'read').allowed).toBe(true);
  });

  it('the events backstop catches a flood spread across every event type', () => {
    const c = clock();
    const t = new SocketThrottle(socketBuckets, c.now);

    // Alternate read/delivered, neither of which the typing bucket applies to,
    // until the 240/min backstop bites.
    let blocked: string | undefined;
    for (let i = 0; i < 400 && !blocked; i++) {
      const v = t.check('u1', i % 2 ? 'read' : 'delivered');
      if (!v.allowed) blocked = v.bucket;
    }
    expect(blocked).toBe('events');
  });
});
