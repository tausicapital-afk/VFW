import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import {
  Conversation,
  ChatMessage,
  ChatUser,
  Participant,
  Presence,
  conversationName,
  isImage,
  messagingApi,
  otherParticipant,
  qk,
  tickState,
  uploadAttachment,
  type AttachmentInput,
} from '../lib/messaging';
import { getSocket } from '../lib/socket';
import { Page } from '../shell/Shell';
import '../styles/messaging.css';

const initials = (name: string) =>
  name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

function timeShort(iso: string) {
  return new Date(iso).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' });
}
function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: '2-digit' });
}
function lastSeenLabel(iso: string | null | undefined) {
  if (!iso) return 'offline';
  return `last seen ${dayLabel(iso).toLowerCase()} at ${timeShort(iso)}`;
}

function Avatar({ name, colour, online, sm }: { name: string; colour?: string; online?: boolean; sm?: boolean }) {
  return (
    <div className={'msg-av' + (sm ? ' sm' : '')} style={{ background: colour || '#0E0E11' }}>
      {initials(name)}
      {online !== undefined && <span className={'msg-dot' + (online ? ' online' : '')} />}
    </div>
  );
}

// --- Attachments -----------------------------------------------------------

function AttachmentView({ att, onImage }: { att: ChatMessage['attachments'][number]; onImage: (url: string) => void }) {
  const { data } = useQuery({
    queryKey: ['attachment', att.id],
    queryFn: () => messagingApi.attachmentUrl(att.id),
    staleTime: 4 * 60 * 1000, // presigned URLs live 5 min; refetch before they lapse
  });

  if (isImage(att.contentType)) {
    if (!data) return <div className="msg-img" style={{ width: 200, height: 140 }} />;
    return (
      <img
        className="msg-img"
        src={data.url}
        alt={att.filename}
        onClick={() => onImage(data.url)}
        style={att.width && att.height ? { aspectRatio: `${att.width}/${att.height}` } : undefined}
      />
    );
  }
  return (
    <a className="msg-file" href={data?.url} target="_blank" rel="noreferrer">
      <span>📎</span>
      <span>{att.filename}</span>
    </a>
  );
}

// --- One message bubble ----------------------------------------------------

function Bubble({
  message, mine, group, participants, onImage,
}: {
  message: ChatMessage;
  mine: boolean;
  group: boolean;
  participants: Participant[];
  onImage: (url: string) => void;
}) {
  const tick = mine ? tickState(message.seq, message.senderId, participants) : null;
  return (
    <div className={'msg-row' + (mine ? ' mine' : '')}>
      <div className="msg-bubble">
        {group && !mine && (
          <div className="msg-sender" style={{ color: message.sender.colour }}>{message.sender.name}</div>
        )}
        {message.attachments.map((a) => (
          <AttachmentView key={a.id} att={a} onImage={onImage} />
        ))}
        {message.deletedAt ? (
          <div className="msg-body deleted">This message was deleted</div>
        ) : (
          message.body && <div className="msg-body">{message.body}</div>
        )}
        <div className="msg-foot">
          <span>{timeShort(message.createdAt)}</span>
          {tick && (
            <span className={'msg-tick' + (tick === 'read' ? ' read' : '')}>
              {tick === 'sent' ? '✓' : '✓✓'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// --- The chat pane ---------------------------------------------------------

function ChatPane({ conv, myId }: { conv: Conversation; myId: string }) {
  const qc = useQueryClient();
  const socket = getSocket();
  const [text, setText] = useState('');
  const [pending, setPending] = useState<{ file: File; preview: string }[]>([]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const typingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data } = useQuery({
    queryKey: qk.messages(conv.id),
    queryFn: () => messagingApi.messages(conv.id),
  });
  const messages = data?.messages ?? [];

  const presence = useQuery<Record<string, Presence>>({ queryKey: qk.presence, queryFn: () => ({}), staleTime: Infinity });
  const typing = useQuery<Record<string, string[]>>({ queryKey: qk.typing, queryFn: () => ({}), staleTime: Infinity });

  const group = conv.kind === 'GROUP';
  const other = otherParticipant(conv, myId);
  const otherOnline = other ? (presence.data?.[other.userId]?.online ?? other.online) : false;
  const otherLastSeen = other ? (presence.data?.[other.userId]?.lastSeenAt ?? other.user.lastSeenAt) : null;

  const typersHere = (typing.data?.[conv.id] ?? []).filter((id) => id !== myId);
  const typingNames = typersHere
    .map((id) => conv.participants.find((p) => p.userId === id)?.user.name?.split(' ')[0])
    .filter(Boolean);

  // Mark read whenever the thread is open and its tail changes.
  const latestSeq = messages.length ? messages[messages.length - 1].seq : 0;
  useEffect(() => {
    if (!latestSeq) return;
    socket.emit('read', { conversationId: conv.id, seq: latestSeq });
    // Optimistically clear my own unread badge for this conversation.
    qc.setQueryData<Conversation[]>(qk.conversations, (prev) =>
      prev?.map((c) => (c.id === conv.id ? { ...c, unreadCount: 0 } : c)),
    );
  }, [conv.id, latestSeq, socket, qc]);

  // Keep pinned to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [latestSeq, conv.id]);

  function onType(v: string) {
    setText(v);
    socket.emit('typing', { conversationId: conv.id, isTyping: true });
    if (typingRef.current) clearTimeout(typingRef.current);
    typingRef.current = setTimeout(
      () => socket.emit('typing', { conversationId: conv.id, isTyping: false }),
      1800,
    );
  }

  function addFiles(files: FileList | null) {
    if (!files) return;
    setPending((p) => [...p, ...Array.from(files).map((file) => ({ file, preview: file.name }))]);
  }

  async function send() {
    const body = text.trim();
    if (!body && pending.length === 0) return;
    setSending(true);
    setUploadError(null);
    try {
      let attachments: AttachmentInput[] | undefined;
      if (pending.length) {
        attachments = await Promise.all(pending.map((p) => uploadAttachment(conv.id, p.file)));
      }
      await messagingApi.send(conv.id, { body: body || undefined, attachments });
      setText('');
      setPending([]);
      socket.emit('typing', { conversationId: conv.id, isTyping: false });
    } catch (e) {
      setUploadError((e as Error).message || 'Could not send');
    } finally {
      setSending(false);
    }
  }

  // Group messages by day for the date separators.
  let lastDay = '';

  return (
    <div className="msg-pane">
      <div className="msg-pane-head">
        <Avatar
          name={conversationName(conv, myId)}
          colour={group ? '#3A3A46' : other?.user.colour}
          online={group ? undefined : !!otherOnline}
        />
        <div>
          <div className="nm">{conversationName(conv, myId)}</div>
          {typingNames.length > 0 ? (
            <div className="sub typing">{typingNames.join(', ')} typing…</div>
          ) : group ? (
            <div className="sub">{conv.participants.length} members</div>
          ) : (
            <div className="sub">{otherOnline ? 'online' : lastSeenLabel(otherLastSeen)}</div>
          )}
        </div>
      </div>

      <div className="msg-scroll" ref={scrollRef}>
        {messages.map((m) => {
          const day = dayLabel(m.createdAt);
          const sep = day !== lastDay;
          lastDay = day;
          return (
            <div key={m.id}>
              {sep && <div className="msg-daysep">{day}</div>}
              <Bubble
                message={m}
                mine={m.senderId === myId}
                group={group}
                participants={conv.participants}
                onImage={setLightbox}
              />
            </div>
          );
        })}
        {messages.length === 0 && (
          <div className="msg-empty">
            <div style={{ fontSize: 32 }}>💬</div>
            <div>No messages yet. Say hello.</div>
          </div>
        )}
      </div>

      {pending.length > 0 && (
        <div className="msg-pending">
          {pending.map((p, i) => (
            <span className="msg-chip" key={i}>
              {p.preview}
              <button onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}
      {uploadError && <div className="note bad" style={{ margin: '8px 12px 0' }}>{uploadError}</div>}

      <div className="msg-composer">
        <label className="msg-attach-btn" title="Attach">
          ＋
          <input
            type="file"
            multiple
            hidden
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
          />
        </label>
        <textarea
          rows={1}
          placeholder="Type a message"
          value={text}
          onChange={(e) => onType(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
        />
        <button className="btn primary" disabled={sending || (!text.trim() && !pending.length)} onClick={() => void send()}>
          {sending ? '…' : 'Send'}
        </button>
      </div>

      {lightbox && (
        <div className="msg-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>
      )}
    </div>
  );
}

// --- New chat / group modal ------------------------------------------------

function NewChatModal({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const [mode, setMode] = useState<'dm' | 'group'>('dm');
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: users } = useQuery({ queryKey: qk.users, queryFn: () => messagingApi.users() });
  const filtered = (users ?? []).filter((u) => u.name.toLowerCase().includes(q.toLowerCase()));

  const create = useMutation({
    mutationFn: () =>
      messagingApi.create({
        kind: mode === 'dm' ? 'DM' : 'GROUP',
        userIds: selected,
        title: mode === 'group' ? title.trim() || undefined : undefined,
      }),
    onSuccess: (res) => onOpen(res.conversation.id),
    onError: (e: Error) => setError(e.message),
  });

  function toggle(u: ChatUser) {
    if (mode === 'dm') { setSelected([u.id]); create.reset(); }
    else setSelected((s) => (s.includes(u.id) ? s.filter((x) => x !== u.id) : [...s, u.id]));
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <h3>New conversation</h3>
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
        <div className="bd">
          <div className="tabs" style={{ marginBottom: 12 }}>
            <button className={'tab' + (mode === 'dm' ? ' on' : '')} onClick={() => { setMode('dm'); setSelected([]); }}>Direct message</button>
            <button className={'tab' + (mode === 'group' ? ' on' : '')} onClick={() => { setMode('group'); setSelected([]); }}>Group</button>
          </div>
          {mode === 'group' && (
            <div className="f" style={{ marginBottom: 10 }}>
              <label>Group name</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Milan show team" />
            </div>
          )}
          <input className="msg-search" style={{ margin: '0 0 10px', width: '100%' }} placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {filtered.map((u) => (
              <div
                key={u.id}
                className="msg-conv"
                onClick={() => toggle(u)}
                style={{ background: selected.includes(u.id) ? 'var(--blue-soft)' : undefined }}
              >
                <Avatar name={u.name} colour={u.colour} online={u.online} sm />
                <div className="meta">
                  <div className="nm">{u.name}</div>
                  <div className="prev">{u.role}{u.department ? ` · ${u.department}` : ''}</div>
                </div>
                {selected.includes(u.id) && <span style={{ color: 'var(--blue)' }}>✓</span>}
              </div>
            ))}
            {filtered.length === 0 && <div className="empty" style={{ padding: 20 }}><p>No one matches.</p></div>}
          </div>
          {error && <div className="note bad" style={{ marginTop: 10 }}>{error}</div>}
        </div>
        <div className="ft">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={selected.length === 0 || create.isPending}
            onClick={() => { setError(null); create.mutate(); }}
          >
            {mode === 'dm' ? 'Open chat' : `Create group (${selected.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Page ------------------------------------------------------------------

export function Messages() {
  const { user } = useAuth();
  const myId = user!.id;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [q, setQ] = useState('');
  const qc = useQueryClient();

  const { data: conversations } = useQuery({
    queryKey: qk.conversations,
    queryFn: () => messagingApi.conversations(),
  });

  const presence = useQuery<Record<string, Presence>>({ queryKey: qk.presence, queryFn: () => ({}), staleTime: Infinity });

  const active = useMemo(
    () => conversations?.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  const list = useMemo(() => {
    const items = conversations ?? [];
    if (!q.trim()) return items;
    const needle = q.toLowerCase();
    return items.filter((c) => conversationName(c, myId).toLowerCase().includes(needle));
  }, [conversations, q, myId]);

  function openConversation(id: string) {
    setNewOpen(false);
    setActiveId(id);
    void qc.invalidateQueries({ queryKey: qk.conversations });
  }

  return (
    <Page crumb="Work" title="Messages" actions={<button className="btn primary" onClick={() => setNewOpen(true)}>New chat</button>}>
      <div className="msg-wrap" style={{ height: 'calc(100vh - 150px)' }}>
        <div className="msg-list">
          <input className="msg-search" placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="msg-convs">
            {list.map((c) => {
              const other = otherParticipant(c, myId);
              const online = c.kind === 'DM' && other
                ? (presence.data?.[other.userId]?.online ?? other.online)
                : undefined;
              const preview = c.lastMessage
                ? (c.lastMessage.body || (c.lastMessage.attachments.length ? '📎 Attachment' : ''))
                : 'No messages yet';
              return (
                <div key={c.id} className={'msg-conv' + (c.id === activeId ? ' on' : '')} onClick={() => setActiveId(c.id)}>
                  <Avatar
                    name={conversationName(c, myId)}
                    colour={c.kind === 'GROUP' ? '#3A3A46' : other?.user.colour}
                    online={online}
                  />
                  <div className="meta">
                    <div className="top">
                      <span className="nm">{conversationName(c, myId)}</span>
                      <span className="tm">{c.lastMessage ? timeShort(c.lastMessage.createdAt) : ''}</span>
                    </div>
                    <div className="top">
                      <span className="prev">{preview}</span>
                      {!!c.unreadCount && <span className="unread">{c.unreadCount}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            {list.length === 0 && (
              <div className="empty" style={{ padding: 24 }}>
                <h3>No conversations</h3>
                <p>Start one with “New chat”.</p>
              </div>
            )}
          </div>
        </div>

        {active ? (
          <ChatPane conv={active} myId={myId} key={active.id} />
        ) : (
          <div className="msg-pane">
            <div className="msg-empty">
              <div style={{ fontSize: 40 }}>💬</div>
              <h3>Your messages</h3>
              <p>Pick a conversation or start a new one.</p>
            </div>
          </div>
        )}
      </div>

      {newOpen && <NewChatModal onClose={() => setNewOpen(false)} onOpen={openConversation} />}
    </Page>
  );
}
