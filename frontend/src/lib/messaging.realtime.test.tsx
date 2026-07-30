import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { qk, useMessagingRealtime, type ChatMessage, type Conversation } from './messaging';
import { connectSocket, disconnectSocket } from './socket';

vi.mock('./socket', () => ({
  connectSocket: vi.fn(),
  disconnectSocket: vi.fn(),
}));

/** A minimal stand-in for the socket.io client: on/off/emit is all this hook touches. */
class FakeSocket {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void) {
    (this.listeners.get(event) ?? this.listeners.set(event, new Set()).get(event)!).add(listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
    return true;
  }
}

function Probe() {
  useMessagingRealtime();
  return null;
}

function setup(initialData?: { conversations?: Conversation[] }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (initialData?.conversations) qc.setQueryData(qk.conversations, initialData.conversations);

  const utils = render(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  kind: 'DM',
  title: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastMessageAt: '2026-01-01T00:00:00.000Z',
  participants: [
    { id: 'p1', userId: 'me', isAdmin: false, lastReadSeq: 0, lastDeliveredSeq: 0, user: { id: 'me', name: 'Me', role: 'SALES', colour: '#000' } },
    { id: 'p2', userId: 'them', isAdmin: false, lastReadSeq: 0, lastDeliveredSeq: 0, user: { id: 'them', name: 'Them', role: 'SALES', colour: '#111' } },
  ],
  ...over,
});

describe('useMessagingRealtime', () => {
  let socket: FakeSocket;

  beforeEach(() => {
    socket = new FakeSocket();
    vi.mocked(connectSocket).mockReturnValue(socket as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('connects the socket on mount and disconnects it on unmount', () => {
    const { unmount } = setup();
    expect(connectSocket).toHaveBeenCalledTimes(1);
    expect(disconnectSocket).not.toHaveBeenCalled();

    unmount();
    expect(disconnectSocket).toHaveBeenCalledTimes(1);
  });

  it('invalidates the conversations query whenever a message arrives', () => {
    const { qc } = setup({ conversations: [conv()] });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const message: ChatMessage = {
      id: 'm1', seq: 1, conversationId: 'c1', senderId: 'them', body: 'Hi',
      createdAt: '2026-01-01T00:00:01.000Z', sender: { id: 'them', name: 'Them', colour: '#111' }, attachments: [],
    };
    socket.emit('message', { conversationId: 'c1', message });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.conversations });
  });

  it('appends an incoming message to an already-open thread, without duplicating on a repeat event', () => {
    const { qc } = setup();
    qc.setQueryData(qk.messages('c1'), { messages: [], hasMore: false });

    const message: ChatMessage = {
      id: 'm1', seq: 1, conversationId: 'c1', senderId: 'them', body: 'Hi',
      createdAt: '2026-01-01T00:00:01.000Z', sender: { id: 'them', name: 'Them', colour: '#111' }, attachments: [],
    };
    socket.emit('message', { conversationId: 'c1', message });
    socket.emit('message', { conversationId: 'c1', message }); // duplicate delivery

    const cached = qc.getQueryData<{ messages: ChatMessage[] }>(qk.messages('c1'));
    expect(cached?.messages).toHaveLength(1);
  });

  it('bumps read/delivered cursors on a receipt event, never moving them backwards', () => {
    const { qc } = setup({ conversations: [conv()] });

    socket.emit('receipt', { conversationId: 'c1', userId: 'them', lastReadSeq: 3, lastDeliveredSeq: 3 });
    let cached = qc.getQueryData<Conversation[]>(qk.conversations);
    expect(cached?.[0].participants.find((p) => p.userId === 'them')?.lastReadSeq).toBe(3);

    // A stale/out-of-order receipt must not roll the cursor back.
    socket.emit('receipt', { conversationId: 'c1', userId: 'them', lastReadSeq: 1, lastDeliveredSeq: 1 });
    cached = qc.getQueryData<Conversation[]>(qk.conversations);
    expect(cached?.[0].participants.find((p) => p.userId === 'them')?.lastReadSeq).toBe(3);
  });

  it('tracks typing state per conversation and self-heals if "stopped" is dropped', () => {
    vi.useFakeTimers();
    const { qc } = setup();

    socket.emit('typing', { conversationId: 'c1', userId: 'them', isTyping: true });
    expect(qc.getQueryData<Record<string, string[]>>(qk.typing)?.c1).toEqual(['them']);

    // No "stopped" event ever arrives; the hook's own 5s timer should clear it.
    vi.advanceTimersByTime(5000);
    expect(qc.getQueryData<Record<string, string[]>>(qk.typing)?.c1).toEqual([]);

    vi.useRealTimers();
  });

  it('records presence updates keyed by user id', () => {
    const { qc } = setup();

    socket.emit('presence', { userId: 'them', online: true, lastSeenAt: null });

    expect(qc.getQueryData(qk.presence)).toEqual({ them: { online: true, lastSeenAt: null } });
  });
});
