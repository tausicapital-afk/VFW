import { ParticipantCursor, tickState, unreadCount } from './receipts';

// A is the sender throughout; the cursors describe the other participants.
const A = 'userA';
const B = 'userB';
const C = 'userC';

function cursor(userId: string, delivered: number, read: number): ParticipantCursor {
  return { userId, lastDeliveredSeq: delivered, lastReadSeq: read };
}

describe('tickState (DM)', () => {
  it('is "sent" when the message has not reached the recipient', () => {
    const parts = [cursor(A, 10, 10), cursor(B, 4, 4)];
    expect(tickState(5, A, parts)).toBe('sent');
  });

  it('is "delivered" when the recipient has it but has not read it', () => {
    const parts = [cursor(A, 10, 10), cursor(B, 5, 4)];
    expect(tickState(5, A, parts)).toBe('delivered');
  });

  it('is "read" when the recipient has read up to or past it', () => {
    const parts = [cursor(A, 5, 5), cursor(B, 5, 5)];
    expect(tickState(5, A, parts)).toBe('read');
  });

  it('the sender\'s own cursor never affects the state', () => {
    // A has read nothing (lastReadSeq 0) but B has read the message.
    const parts = [cursor(A, 0, 0), cursor(B, 9, 9)];
    expect(tickState(5, A, parts)).toBe('read');
  });
});

describe('tickState (group)', () => {
  it('is "read" only once EVERY other participant has read it', () => {
    const readByAll = [cursor(A, 9, 9), cursor(B, 9, 9), cursor(C, 9, 9)];
    expect(tickState(5, A, readByAll)).toBe('read');

    // C has only had it delivered, not read → the group is still "delivered".
    const oneStillUnread = [cursor(A, 9, 9), cursor(B, 9, 9), cursor(C, 9, 4)];
    expect(tickState(5, A, oneStillUnread)).toBe('delivered');
  });

  it('is "sent" while even one participant has not received it', () => {
    const parts = [cursor(A, 9, 9), cursor(B, 9, 9), cursor(C, 4, 4)];
    expect(tickState(5, A, parts)).toBe('sent');
  });
});

describe('tickState (edge)', () => {
  it('cannot advance past "sent" when there is no one else', () => {
    expect(tickState(5, A, [cursor(A, 100, 100)])).toBe('sent');
  });
});

describe('unreadCount', () => {
  const msgs = [
    { seq: 1, senderId: B },
    { seq: 2, senderId: A },
    { seq: 3, senderId: B },
    { seq: 4, senderId: B },
  ];

  it('counts only inbound messages after the read cursor', () => {
    // A read up to seq 1: seq 3 and 4 are unread (seq 2 is A's own).
    expect(unreadCount(msgs, A, 1)).toBe(2);
  });

  it('is zero when caught up', () => {
    expect(unreadCount(msgs, A, 4)).toBe(0);
  });

  it('never counts your own messages', () => {
    expect(unreadCount([{ seq: 9, senderId: A }], A, 0)).toBe(0);
  });
});
