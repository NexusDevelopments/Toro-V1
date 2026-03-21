import { useEffect, useMemo, useRef, useState } from 'react';
import SidebarLayout from '../layouts/SidebarLayout';
import theme from '../styles/theming.module.css';
import clsx from 'clsx';

const SESSION_KEY = 'toro_chat_session';
const USERNAME_KEY = 'toro_chat_username';

const getSessionId = () => {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
};

const linkify = (text = '') => {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noreferrer" style="text-decoration:underline">$1</a>');
};

const mergeMessages = (existing = [], incoming = []) => {
  const map = new Map();

  existing.forEach((msg) => {
    if (msg?.id) map.set(msg.id, msg);
  });

  incoming.forEach((msg) => {
    if (msg?.id) map.set(msg.id, msg);
  });

  return [...map.values()].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
};

const ChatRooms = () => {
  const [sessionId] = useState(() => getSessionId());
  const [username, setUsername] = useState(() => localStorage.getItem(USERNAME_KEY) || '');
  const [roomInput, setRoomInput] = useState('general');
  const [joinMode, setJoinMode] = useState('join');
  const [rooms, setRooms] = useState([]);
  const [currentRoom, setCurrentRoom] = useState('');
  const [messages, setMessages] = useState([]);
  const [users, setUsers] = useState([]);
  const [message, setMessage] = useState('');
  const [imageData, setImageData] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const activeRoomRef = useRef('');
  const roomFetchSeqRef = useRef(0);
  const roomFetchAppliedSeqRef = useRef(0);

  const canJoin = useMemo(() => /^[a-zA-Z0-9_-]{2,15}$/.test(username), [username]);

  const fetchRooms = async () => {
    try {
      const r = await fetch('/api/chat/rooms');
      if (!r.ok) return;
      const data = await r.json();
      if (Array.isArray(data)) setRooms(data);
    } catch {
      // ignore transient network issues
    }
  };

  useEffect(() => {
    activeRoomRef.current = currentRoom;
  }, [currentRoom]);

  const fetchRoomState = async (room, merge = true) => {
    const seq = ++roomFetchSeqRef.current;

    try {
      const r = await fetch(`/api/chat/room/${encodeURIComponent(room)}`);
      if (!r.ok) return;
      const data = await r.json();

      if (room !== activeRoomRef.current) return;
      if (seq < roomFetchAppliedSeqRef.current) return;
      roomFetchAppliedSeqRef.current = seq;

      const nextMessages = Array.isArray(data.messages) ? data.messages : [];
      setMessages((prev) => (merge ? mergeMessages(prev, nextMessages) : nextMessages));
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch {
      // ignore transient network issues
    }
  };

  useEffect(() => {
    fetchRooms();
    const t = setInterval(fetchRooms, 3000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!currentRoom) return;

    fetchRoomState(currentRoom, true);
    const t = setInterval(() => {
      fetchRoomState(currentRoom, true);
      fetch('/api/chat/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {});
    }, 2500);

    return () => clearInterval(t);
  }, [currentRoom, sessionId]);

  useEffect(() => {
    const leave = () => {
      if (!sessionId) return;
      navigator.sendBeacon?.('/api/chat/leave', JSON.stringify({ sessionId }));
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [sessionId]);

  const joinRoom = async (targetRoom) => {
    setError('');
    if (!canJoin) {
      setError('Username must be 2-15 characters (letters, numbers, _ or -).');
      return;
    }

    try {
      const r = await fetch('/api/chat/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          username,
          room: targetRoom,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error || 'Failed to join room');
        return;
      }
      localStorage.setItem(USERNAME_KEY, username);
      setCurrentRoom(data.room);
      setRoomInput(data.room);
      setUsers(Array.isArray(data.users) ? data.users : []);
      await fetchRoomState(data.room, false);
    } catch {
      setError('Unable to join room right now.');
    }
  };

  const leaveRoom = async () => {
    await fetch('/api/chat/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
    setCurrentRoom('');
    setMessages([]);
    setUsers([]);
    fetchRooms();
  };

  const sendMessage = async () => {
    setError('');
    if (!currentRoom || sending) return;
    if (!message.trim() && !imageData) {
      setError('Write a message or attach an image.');
      return;
    }

    const payload = {
      sessionId,
      room: currentRoom,
      text: message,
      image: imageData,
    };

    try {
      setSending(true);
      const r = await fetch('/api/chat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error || 'Message failed');
        return;
      }
      setMessage('');
      setImageData('');
      setMessages((prev) => mergeMessages(prev, [data.message]));
      await fetchRoomState(currentRoom, true);
    } catch {
      setError('Failed to send message.');
    } finally {
      setSending(false);
    }
  };

  const uploadImage = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Only image files are allowed.');
      return;
    }
    if (file.size > 350000) {
      setError('Image too large (max 350KB).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setImageData(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  return (
    <SidebarLayout>
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <div className="mx-auto w-full max-w-4xl overflow-hidden rounded-[28px] border border-red-500/20 bg-gradient-to-b from-[#160604]/95 via-[#100302]/95 to-[#090101]/95 shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
          <div className="border-b border-red-500/10 bg-[#1a0806]/85 px-6 py-5 text-center">
            <p className="text-3xl font-semibold tracking-tight text-[#ff5a0f]">Circle</p>
          </div>

          {!currentRoom ? (
            <div className="px-5 py-8 sm:px-10 sm:py-10">
              <h2 className="text-center text-5xl font-semibold tracking-tight text-[#ff5a0f]">Welcome to Circle!</h2>

              <div className="mx-auto mt-6 w-full max-w-xl">
                <input
                  value={username}
                  maxLength={15}
                  onChange={(e) => setUsername(e.target.value.trim())}
                  placeholder="Username (2-15 chars)"
                  className="w-full rounded-full border border-red-400/30 bg-black/35 px-4 py-2.5 text-sm outline-none placeholder:text-white/35"
                />
                <p className="mt-2 text-center text-xs text-white/65">Pick your username first, then choose how you want to enter chat.</p>
              </div>

              <div className="mx-auto mt-8 w-full max-w-3xl space-y-4">
                <button
                  type="button"
                  onClick={() => {
                    setJoinMode('join');
                    setRoomInput((prev) => prev || 'general');
                  }}
                  className={clsx(
                    'w-full rounded-3xl border px-6 py-6 text-left transition',
                    joinMode === 'join' ? 'border-[#ff5a0f]/45 bg-[#200a05]/90' : 'border-red-500/20 bg-[#120503]/88 hover:border-red-400/35',
                  )}
                >
                  <p className="text-4xl font-semibold text-[#ff5a0f]">Join a Circle</p>
                  <p className="mt-2 text-lg text-white/70">Enter an existing circle code to join a conversation</p>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setJoinMode('create');
                    if (!roomInput || roomInput === 'public') setRoomInput('my-circle');
                  }}
                  className={clsx(
                    'w-full rounded-3xl border px-6 py-6 text-left transition',
                    joinMode === 'create' ? 'border-[#ff5a0f]/45 bg-[#200a05]/90' : 'border-red-500/20 bg-[#120503]/88 hover:border-red-400/35',
                  )}
                >
                  <p className="text-4xl font-semibold text-[#ff5a0f]">Create New Circle</p>
                  <p className="mt-2 text-lg text-white/70">Start a new circle and invite others with a circle code</p>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setJoinMode('public');
                    setRoomInput('public');
                    joinRoom('public');
                  }}
                  disabled={!canJoin}
                  className={clsx(
                    'w-full rounded-3xl border px-6 py-6 text-left transition',
                    'border-red-500/20 bg-[#120503]/88 hover:border-red-400/35',
                    !canJoin && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <p className="text-4xl font-semibold text-[#ff5a0f]">Public Circle</p>
                  <p className="mt-2 text-lg text-white/70">Join the global public circle to meet new people</p>
                </button>
              </div>

              {joinMode !== 'public' && (
                <div className="mx-auto mt-6 flex w-full max-w-xl flex-col gap-2 sm:flex-row">
                  <input
                    value={roomInput}
                    onChange={(e) => setRoomInput(e.target.value)}
                    placeholder={joinMode === 'create' ? 'new-circle-name' : 'circle code'}
                    className="w-full rounded-full border border-red-400/30 bg-black/40 px-4 py-3 text-sm outline-none placeholder:text-white/35"
                  />
                  <button
                    onClick={() => joinRoom(roomInput)}
                    disabled={!canJoin}
                    className={clsx(
                      'rounded-full border border-red-400/40 bg-[#240c07] px-5 py-3 text-sm font-semibold text-[#ff8a57] transition hover:border-red-300/55',
                      !canJoin && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    {joinMode === 'create' ? 'Create Circle' : 'Join Circle'}
                  </button>
                </div>
              )}

              <div className="mx-auto mt-8 w-full max-w-3xl rounded-2xl border border-red-500/15 bg-black/25 p-4">
                <p className="mb-3 text-sm font-semibold text-[#ff8a57]">Active Circles</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {rooms.map((room) => (
                    <button
                      key={room.name}
                      onClick={() => joinRoom(room.name)}
                      className="rounded-xl border border-red-400/20 bg-black/35 px-3 py-2 text-left hover:border-red-300/35"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-white/90">#{room.name}</span>
                        <span className="text-xs text-white/65">{room.userCount} online</span>
                      </div>
                      <p className="mt-1 truncate text-xs text-white/55">{(room.usernames || []).join(', ') || 'No users yet'}</p>
                    </button>
                  ))}
                  {rooms.length === 0 && <p className="text-xs text-white/55">No active circles yet.</p>}
                </div>
              </div>

              {error && <p className="mt-4 text-center text-xs text-red-300">{error}</p>}
            </div>
          ) : (
            <div className="px-5 py-6 sm:px-8 sm:py-8">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-red-300/35 bg-black/35 px-3 py-1 text-xs text-[#ff8a57]">Circle: #{currentRoom}</span>
                <span className="rounded-full border border-red-300/35 bg-black/35 px-3 py-1 text-xs text-[#ff8a57]">Users: {users.length}</span>
                <span className="max-w-full truncate rounded-full border border-red-300/30 bg-black/30 px-3 py-1 text-xs text-white/70">{users.join(', ') || 'No users yet'}</span>
                <button
                  onClick={leaveRoom}
                  className="ml-auto rounded-full border border-red-300/35 bg-[#220a06] px-3 py-1 text-xs text-[#ff8a57] hover:border-red-200/50"
                >
                  Leave Circle
                </button>
              </div>

              <div className="h-[48vh] overflow-y-auto rounded-2xl border border-red-500/15 bg-black/35 p-3">
                <div className="space-y-2">
                  {messages.map((m) => (
                    <div key={m.id} className="rounded-lg border border-red-400/15 bg-[#140503]/80 p-2.5">
                      <div className="text-xs text-white/65">
                        <span className="font-semibold text-[#ff8a57]">{m.username}</span> • {new Date(m.ts).toLocaleString()}
                      </div>
                      {m.text && (
                        <p
                          className="mt-1 break-words text-sm text-white/90"
                          dangerouslySetInnerHTML={{ __html: linkify(m.text) }}
                        />
                      )}
                      {m.image && <img src={m.image} alt="upload" className="mt-2 max-h-56 rounded-lg border border-red-300/20" />}
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-3 flex flex-col gap-2">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Type message... links are clickable"
                  className="min-h-[88px] w-full rounded-xl border border-red-400/20 bg-black/45 px-3 py-2 text-sm outline-none placeholder:text-white/35"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <label className={clsx('cursor-pointer px-3 py-1.5 text-xs', theme.glassButton, theme.glassPill)}>
                    Upload Picture
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => uploadImage(e.target.files?.[0])} />
                  </label>
                  {imageData && <span className="text-xs text-white/75">Image attached</span>}
                  <button
                    onClick={sendMessage}
                    disabled={sending}
                    className={clsx('ml-auto rounded-full border border-red-300/35 bg-[#240b06] px-4 py-1.5 text-sm text-[#ff8a57] hover:border-red-200/50', sending && 'opacity-60')}
                  >
                    {sending ? 'Sending...' : 'Send'}
                  </button>
                </div>
                {error && <p className="text-xs text-red-300">{error}</p>}
              </div>
            </div>
          )}
        </div>
      </div>
    </SidebarLayout>
  );
};

export default ChatRooms;
