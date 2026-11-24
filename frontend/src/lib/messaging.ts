import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from './api';
import { connectSocket, disconnectSocket } from './socket';
import type { Role } from './types';

// --- Types -----------------------------------------------------------------

export type ConversationKind = 'DM' | 'GROUP';

export interface ChatUser {
  id: string;
  name: string;
  role: Role;
  colour?: string;
  department?: string | null;
  lastSeenAt?: string | null;
  online?: boolean;
}

export interface Participant {
  id: string;
  userId: string;
  isAdmin: boolean;
  lastReadSeq: number;
  lastDeliveredSeq: number;
  user: {
    id: string;
    name: string;
    role: Role;
    colour: string;
    department?: string | null;
    lastSeenAt?: string | null;
  };
  online?: boolean;
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size?: number | null;
  width?: number | null;
  height?: number | null;
}

export interface Reaction {
  emoji: string;
  userId: string;
}

// The fixed reaction set (no emoji-picker dependency in frontend/package.json,
// and an internal chat tool does not need the full Unicode table — see
// backend/src/messaging/dto.ts REACTION_EMOJIS, which this mirrors and the
// server enforces).
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉'] as const;

// Mirrors backend/src/messaging/messaging.service.ts EDIT_WINDOW_MINUTES — the
// server is the one that actually enforces this; here it only decides when to
// show the Edit control so a stale button never has to round-trip to 400.
export const EDIT_WINDOW_MINUTES = 15;

export interface ChatMessage {
  id: string;
  seq: number;
  conversationId: string;
  senderId: string;
  body: string | null;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  sender: { id: string; name: string; colour: string };
  attachments: Attachment[];
  reactions: Reaction[];
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string | null;
  dmKey?: string | null;
  createdAt: string;
  lastMessageAt: string;
  participants: Participant[];
  lastMessage?: ChatMessage | null;
  unreadCount?: number;
}

export interface Presence {
  online: boolean;
  lastSeenAt: string | null;
}

export interface AttachmentInput {
  storageKey: string;
  filename: string;
  contentType: string;
  size?: number;
  width?: number;
  height?: number;
}

export type TickState = 'sent' | 'delivered' | 'read';

// Mirror of backend/src/messaging/receipts.ts — the render-only copy, so a bubble
// can show the right ticks without a round-trip. The server owns the cursors.
export function tickState(
  messageSeq: number,
  senderId: string,
  participants: Participant[],
): TickState {
  const others = participants.filter((p) => p.userId !== senderId);
  if (others.length === 0) return 'sent';
  if (others.every((p) => p.lastReadSeq >= messageSeq)) return 'read';
  if (others.every((p) => p.lastDeliveredSeq >= messageSeq)) return 'delivered';
  return 'sent';
}

/** The display name of a conversation from a given viewer's seat. */
export function conversationName(conv: Conversation, myId: string): string {
  if (conv.kind === 'GROUP') return conv.title || 'Group';
  const other = conv.participants.find((p) => p.userId !== myId);
  return other?.user.name ?? 'Direct message';
}

export function otherParticipant(conv: Conversation, myId: string): Participant | undefined {
  return conv.participants.find((p) => p.userId !== myId);
}

// --- REST client -----------------------------------------------------------

interface PresignResponse {
  uploadUrl: string;
  storageKey: string;
  method: 'PUT';
  headers: Record<string, string>;
}

export const messagingApi = {
  users: () => api.get<ChatUser[]>('/api/messaging/users'),
  conversations: () => api.get<Conversation[]>('/api/messaging/conversations'),
  conversation: (id: string) => api.get<Conversation>(`/api/messaging/conversations/${id}`),
  create: (body: { kind: ConversationKind; userIds: string[]; title?: string }) =>
    api.post<{ conversation: Conversation; created: boolean }>('/api/messaging/conversations', body),
  messages: (id: string, before?: number) =>
    api.get<{ messages: ChatMessage[]; hasMore: boolean }>(
      `/api/messaging/conversations/${id}/messages${before ? `?before=${before}` : ''}`,
    ),
  send: (id: string, body: { body?: string; attachments?: AttachmentInput[] }) =>
    api.post<ChatMessage>(`/api/messaging/conversations/${id}/messages`, body),
  presign: (id: string, body: { filename: string; contentType: string; size?: number }) =>
    api.post<PresignResponse>(`/api/messaging/conversations/${id}/attachments/presign`, body),
  attachmentUrl: (attachmentId: string) =>
    api.get<{ url: string; filename: string; contentType: string }>(
      `/api/messaging/attachments/${attachmentId}`,
    ),
  markRead: (id: string, seq?: number) =>
    api.post(`/api/messaging/conversations/${id}/read`, { seq }),
  rename: (id: string, title: string) =>
    api.patch<Conversation>(`/api/messaging/conversations/${id}`, { title }),
  addParticipants: (id: string, userIds: string[]) =>
    api.post(`/api/messaging/conversations/${id}/participants`, { userIds }),
  removeParticipant: (id: string, userId: string) =>
    api.del(`/api/messaging/conversations/${id}/participants/${userId}`),
  editMessage: (conversationId: string, messageId: string, body: string) =>
    api.patch<ChatMessage>(`/api/messaging/conversations/${conversationId}/messages/${messageId}`, { body }),
  deleteMessage: (conversationId: string, messageId: string) =>
    api.del<ChatMessage>(`/api/messaging/conversations/${conversationId}/messages/${messageId}`),
  addReaction: (conversationId: string, messageId: string, emoji: string) =>
    api.post<{ messageId: string; reactions: Reaction[] }>(
      `/api/messaging/conversations/${conversationId}/messages/${messageId}/reactions`,
      { emoji },
    ),
  removeReaction: (conversationId: string, messageId: string, emoji: string) =>
    api.del<{ messageId: string; reactions: Reaction[] }>(
      `/api/messaging/conversations/${conversationId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    ),
  search: (q: string, conversationId?: string) =>
    api.get<ChatMessage[]>(
      `/api/messaging/search?q=${encodeURIComponent(q)}` +
        (conversationId ? `&conversationId=${conversationId}` : ''),
    ),
};

/** Read an image's natural dimensions so the bubble can reserve space. */
function imageDims(file: File): Promise<{ width?: number; height?: number }> {
  if (!file.type.startsWith('image/')) return Promise.resolve({});
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({});
    };
    img.src = url;
  });
}

/** Presign → PUT the bytes straight to R2 → return the row input to register. */
export async function uploadAttachment(conversationId: string, file: File): Promise<AttachmentInput> {
  const presign = await messagingApi.presign(conversationId, {
    filename: file.name,
    contentType: file.type || 'application/octet-stream',
    size: file.size,
  });
  const put = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: presign.headers,
    body: file,
  });
  if (!put.ok) throw new Error('Upload failed');
  const dims = await imageDims(file);
  return {
    storageKey: presign.storageKey,
    filename: file.name,
    contentType: file.type || 'application/octet-stream',
    size: file.size,
    ...dims,
  };
}

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const isImage = (t: string) => IMAGE_TYPES.includes(t);

// --- Query keys ------------------------------------------------------------

export const qk = {
  conversations: ['conversations'] as const,
  messages: (id: string) => ['messages', id] as const,
  presence: ['presence'] as const,
  typing: ['typing'] as const,
  users: ['msg-users'] as const,
};

type PresenceMap = Record<string, Presence>;
type TypingMap = Record<string, string[]>; // conversationId -> userIds typing

// --- Cache mutations driven by socket events -------------------------------

function upsertMessage(qc: QueryClient, conversationId: string, message: ChatMessage) {
  qc.setQueryData<{ messages: ChatMessage[]; hasMore: boolean }>(
    qk.messages(conversationId),
    (prev) => {
      if (!prev) return prev;
      if (prev.messages.some((m) => m.id === message.id)) return prev;
      return { ...prev, messages: [...prev.messages, message] };
    },
  );
}

/** Merge a partial update (edit, delete, reaction set) into one cached message. */
function patchMessage(
  qc: QueryClient,
  conversationId: string,
  messageId: string,
  patch: Partial<ChatMessage>,
) {
  qc.setQueryData<{ messages: ChatMessage[]; hasMore: boolean }>(
    qk.messages(conversationId),
    (prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        messages: prev.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
      };
    },
  );
}

function applyReceipt(
  qc: QueryClient,
  r: { conversationId: string; userId: string; lastReadSeq?: number; lastDeliveredSeq?: number },
) {
  qc.setQueryData<Conversation[]>(qk.conversations, (prev) =>
    prev?.map((c) => {
      if (c.id !== r.conversationId) return c;
      return {
        ...c,
        participants: c.participants.map((p) =>
          p.userId === r.userId
            ? {
                ...p,
                lastReadSeq: Math.max(p.lastReadSeq, r.lastReadSeq ?? p.lastReadSeq),
                lastDeliveredSeq: Math.max(p.lastDeliveredSeq, r.lastDeliveredSeq ?? p.lastDeliveredSeq),
              }
            : p,
        ),
      };
    }),
  );
}

/**
 * The one place socket events touch app state. Mounted once (in the Shell), it
 * keeps the react-query cache — conversations, open threads, presence, typing —
 * in sync so both the nav badge and the Messages screen react in real time.
 */
export function useMessagingRealtime() {
  const qc = useQueryClient();

  useEffect(() => {
    const socket = connectSocket();
    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const onMessage = ({ conversationId, message }: { conversationId: string; message: ChatMessage }) => {
      upsertMessage(qc, conversationId, message);
      // Preview, ordering and unread count are easiest to get exactly right from
      // the server; a message is infrequent enough that a refetch is cheap.
      void qc.invalidateQueries({ queryKey: qk.conversations });
    };

    const onReceipt = (r: {
      conversationId: string;
      userId: string;
      lastReadSeq?: number;
      lastDeliveredSeq?: number;
    }) => applyReceipt(qc, r);

    const onPresence = (p: { userId: string; online: boolean; lastSeenAt: string | null }) => {
      qc.setQueryData<PresenceMap>(qk.presence, (prev) => ({
        ...(prev ?? {}),
        [p.userId]: { online: p.online, lastSeenAt: p.lastSeenAt },
      }));
    };

    const onTyping = ({ conversationId, userId, isTyping }: { conversationId: string; userId: string; isTyping: boolean }) => {
      const key = `${conversationId}:${userId}`;
      const existing = typingTimers.get(key);
      if (existing) clearTimeout(existing);

      qc.setQueryData<TypingMap>(qk.typing, (prev) => {
        const map = { ...(prev ?? {}) };
        const set = new Set(map[conversationId] ?? []);
        if (isTyping) set.add(userId);
        else set.delete(userId);
        map[conversationId] = [...set];
        return map;
      });

      if (isTyping) {
        // Self-heal if a "stopped" event is ever lost.
        typingTimers.set(
          key,
          setTimeout(() => onTyping({ conversationId, userId, isTyping: false }), 5000),
        );
      }
    };

    const onConversation = () => void qc.invalidateQueries({ queryKey: qk.conversations });

    const onMessageEdited = ({ conversationId, message }: { conversationId: string; message: ChatMessage }) => {
      patchMessage(qc, conversationId, message.id, { body: message.body, editedAt: message.editedAt });
      void qc.invalidateQueries({ queryKey: qk.conversations });
    };

    const onMessageDeleted = ({ conversationId, message }: { conversationId: string; message: ChatMessage }) => {
      patchMessage(qc, conversationId, message.id, {
        body: null,
        deletedAt: message.deletedAt,
        attachments: [],
        reactions: [],
      });
      void qc.invalidateQueries({ queryKey: qk.conversations });
    };

    const onReactions = ({
      conversationId,
      messageId,
      reactions,
    }: {
      conversationId: string;
      messageId: string;
      reactions: Reaction[];
    }) => patchMessage(qc, conversationId, messageId, { reactions });

    socket.on('message', onMessage);
    socket.on('receipt', onReceipt);
    socket.on('presence', onPresence);
    socket.on('typing', onTyping);
    socket.on('conversation', onConversation);
    socket.on('message:edited', onMessageEdited);
    socket.on('message:deleted', onMessageDeleted);
    socket.on('message:reactions', onReactions);

    return () => {
      socket.off('message', onMessage);
      socket.off('receipt', onReceipt);
      socket.off('presence', onPresence);
      socket.off('typing', onTyping);
      socket.off('conversation', onConversation);
      socket.off('message:edited', onMessageEdited);
      socket.off('message:deleted', onMessageDeleted);
      socket.off('message:reactions', onReactions);
      typingTimers.forEach((t) => clearTimeout(t));
      // Tear the socket down entirely when the Shell unmounts (i.e. on sign-out),
      // so the next user does not inherit this one's connection.
      disconnectSocket();
    };
  }, [qc]);
}
