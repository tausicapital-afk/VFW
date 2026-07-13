/**
 * The tick logic — kept pure and separate so it can be tested in isolation, the
 * way reports/score.ts is. This is the whole meaning of a "read receipt": no
 * network, no database, just message ordinals versus participant cursors.
 *
 * The cursor model (WhatsApp's): rather than a row per message per recipient, a
 * participant carries the ordinal (Message.seq) of the last message delivered to
 * and read by them. A message's state for its sender is then a comparison.
 */

export type TickState = 'sent' | 'delivered' | 'read';

export interface ParticipantCursor {
  userId: string;
  lastDeliveredSeq: number;
  lastReadSeq: number;
}

/**
 * The tick state of a message as its SENDER sees it.
 *
 * - `sent`      — stored, but not yet confirmed on anyone else's client (✓).
 * - `delivered` — reached every *other* participant's client (✓✓ grey).
 * - `read`      — opened by every *other* participant (✓✓ blue).
 *
 * "Every other participant" is deliberate: in a group the message is only `read`
 * once the last person has read it — the state tracks the minimum cursor across
 * everyone who is not the sender. A conversation with no one else in it (a note
 * to self, or a group you are alone in) can never advance past `sent`.
 */
export function tickState(
  messageSeq: number,
  senderId: string,
  participants: ParticipantCursor[],
): TickState {
  const others = participants.filter((p) => p.userId !== senderId);
  if (others.length === 0) return 'sent';

  if (others.every((p) => p.lastReadSeq >= messageSeq)) return 'read';
  if (others.every((p) => p.lastDeliveredSeq >= messageSeq)) return 'delivered';
  return 'sent';
}

/**
 * Unread count for a viewer: messages after their read cursor that they did not
 * send themselves. A message you sent is never "unread" to you.
 */
export function unreadCount(
  messages: { seq: number; senderId: string }[],
  viewerId: string,
  viewerLastReadSeq: number,
): number {
  return messages.filter((m) => m.seq > viewerLastReadSeq && m.senderId !== viewerId).length;
}
