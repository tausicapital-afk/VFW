import { conversationName, isImage, otherParticipant, tickState, type Conversation, type Participant } from './messaging';

function participant(overrides: Partial<Participant>): Participant {
  return {
    id: overrides.id ?? 'p1',
    userId: overrides.userId ?? 'u1',
    isAdmin: false,
    lastReadSeq: 0,
    lastDeliveredSeq: 0,
    user: { id: overrides.userId ?? 'u1', name: 'User', role: 'SALES', colour: '#000' },
    ...overrides,
  };
}

describe('tickState', () => {
  const sender = 'sender-1';

  it('is "sent" in a conversation with no one else in it', () => {
    expect(tickState(5, sender, [participant({ userId: sender })])).toBe('sent');
  });

  it('is "read" once every other participant has read at least that seq', () => {
    const others = [
      participant({ userId: 'a', lastReadSeq: 5, lastDeliveredSeq: 5 }),
      participant({ userId: 'b', lastReadSeq: 9, lastDeliveredSeq: 9 }),
    ];
    expect(tickState(5, sender, [participant({ userId: sender }), ...others])).toBe('read');
  });

  it('is "delivered" when everyone has it delivered but not everyone has read it', () => {
    const others = [
      participant({ userId: 'a', lastReadSeq: 5, lastDeliveredSeq: 5 }),
      participant({ userId: 'b', lastReadSeq: 0, lastDeliveredSeq: 9 }),
    ];
    expect(tickState(5, sender, [participant({ userId: sender }), ...others])).toBe('delivered');
  });

  it('is "sent" when at least one participant has neither delivered nor read it', () => {
    const others = [
      participant({ userId: 'a', lastReadSeq: 5, lastDeliveredSeq: 5 }),
      participant({ userId: 'b', lastReadSeq: 0, lastDeliveredSeq: 0 }),
    ];
    expect(tickState(5, sender, [participant({ userId: sender }), ...others])).toBe('sent');
  });
});

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: 'c1',
    kind: 'DM',
    title: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastMessageAt: '2026-01-01T00:00:00.000Z',
    participants: [],
    ...overrides,
  };
}

describe('conversationName', () => {
  it('uses the group title when set', () => {
    const conv = conversation({ kind: 'GROUP', title: 'Sales Team' });
    expect(conversationName(conv, 'me')).toBe('Sales Team');
  });

  it('falls back to "Group" for an untitled group', () => {
    const conv = conversation({ kind: 'GROUP', title: null });
    expect(conversationName(conv, 'me')).toBe('Group');
  });

  it('uses the other participant\'s name for a DM', () => {
    const conv = conversation({
      kind: 'DM',
      participants: [
        participant({ userId: 'me', user: { id: 'me', name: 'Me', role: 'SALES', colour: '#000' } }),
        participant({ userId: 'them', user: { id: 'them', name: 'Designer Dana', role: 'SALES', colour: '#111' } }),
      ],
    });
    expect(conversationName(conv, 'me')).toBe('Designer Dana');
  });

  it('falls back to "Direct message" when the other participant is missing', () => {
    const conv = conversation({ kind: 'DM', participants: [] });
    expect(conversationName(conv, 'me')).toBe('Direct message');
  });
});

describe('otherParticipant', () => {
  it('returns the participant that is not the viewer', () => {
    const them = participant({ userId: 'them' });
    const conv = conversation({ participants: [participant({ userId: 'me' }), them] });
    expect(otherParticipant(conv, 'me')).toBe(them);
  });

  it('returns undefined when the viewer is the only participant', () => {
    const conv = conversation({ participants: [participant({ userId: 'me' })] });
    expect(otherParticipant(conv, 'me')).toBeUndefined();
  });
});

describe('isImage', () => {
  it('accepts the known image mime types', () => {
    expect(isImage('image/png')).toBe(true);
    expect(isImage('image/jpeg')).toBe(true);
  });

  it('rejects non-image types', () => {
    expect(isImage('application/pdf')).toBe(false);
    expect(isImage('image/svg+xml')).toBe(false); // deliberately not on the allow-list
  });
});
