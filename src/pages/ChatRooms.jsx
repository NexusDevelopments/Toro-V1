import { useEffect, useMemo, useState } from 'react';
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

const ChatRooms = () => {
  const [sessionId] = useState(() => getSessionId());
  const [username, setUsername] = useState(() => localStorage.getItem(USERNAME_KEY) || '');
  const [roomInput, setRoomInput] = useState('general');
  const [rooms, setRooms] = useState([]);
  const [currentRoom, setCurrentRoom] = useState('');
  const [messages, setMessages] = useState([]);
  const [users, setUsers] = useState([]);
  const [message, setMessage] = useState('');
  const [imageData, setImageData] = useState('');
  const [error, setError] = useState('');

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

  const fetchRoomState = async (room) => {
    try {
      const r = await fetch(`/api/chat/room/${encodeURIComponent(room)}`);
      if (!r.ok) return;
      const data = await r.json();
      setMessages(Array.isArray(data.messages) ? data.messages : []);
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

    fetchRoomState(currentRoom);
    const t = setInterval(() => {
      fetchRoomState(currentRoom);
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
      await fetchRoomState(data.room);
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
    if (!currentRoom) return;

    const payload = {
      sessionId,
      room: currentRoom,
      text: message,
      image: imageData,
    };

    try {
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
      setMessages((prev) => [...prev, data.message]);
    } catch {
      setError('Failed to send message.');
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
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <h2 className="text-3xl font-semibold">Chat Rooms</h2>
        <p className="mt-2 text-sm opacity-75">Real-time rooms with saved message history.</p>

        {!currentRoom ? (
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-black/25 p-5">
              <p className="text-sm font-medium">Enter a username</p>
              <input
                value={username}
                maxLength={15}
                onChange={(e) => setUsername(e.target.value.trim())}
                placeholder="Username (2-15 chars)"
                className="mt-3 w-full rounded-full border border-white/20 bg-black/30 px-4 py-2 text-sm outline-none"
              />
              <p className="mt-2 text-xs opacity-70">Usernames are unique while in-use and become free after leaving.</p>

              <p className="mt-5 text-sm font-medium">Join / create room</p>
              <div className="mt-3 flex gap-2">
                <input
                  value={roomInput}
                  onChange={(e) => setRoomInput(e.target.value)}
                  placeholder="general"
                  className="w-full rounded-full border border-white/20 bg-black/30 px-4 py-2 text-sm outline-none"
                />
                <button
                  onClick={() => joinRoom(roomInput)}
                  disabled={!canJoin}
                  className={clsx('px-4 py-2 text-sm', theme.glassButton, theme.glassPill, !canJoin && 'opacity-50 cursor-not-allowed')}
                >
                  Enter
                </button>
              </div>
              {error && <p className="mt-3 text-xs text-red-300">{error}</p>}
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/25 p-5">
              <p className="text-sm font-medium">Active Rooms</p>
              <div className="mt-3 space-y-2">
                {rooms.map((room) => (
                  <button
                    key={room.name}
                    onClick={() => joinRoom(room.name)}
                    className={clsx('w-full rounded-xl px-3 py-2 text-left', theme.glassButton)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">#{room.name}</span>
                      <span className="text-xs opacity-75">{room.userCount} online</span>
                    </div>
                    <p className="mt-1 text-xs opacity-70 truncate">{(room.usernames || []).join(', ') || 'No users yet'}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-6 rounded-2xl border border-white/10 bg-black/25 p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-white/20 px-3 py-1 text-xs">Room: #{currentRoom}</span>
              <span className="rounded-full border border-white/20 px-3 py-1 text-xs">Users: {users.length}</span>
              <span className="rounded-full border border-white/20 px-3 py-1 text-xs">{users.join(', ')}</span>
              <button onClick={leaveRoom} className={clsx('ml-auto px-3 py-1 text-xs', theme.glassButton, theme.glassPill)}>
                Leave Room
              </button>
            </div>

            <div className="h-[48vh] overflow-y-auto rounded-xl border border-white/10 bg-black/25 p-3 space-y-2">
              {messages.map((m) => (
                <div key={m.id} className="rounded-lg border border-white/10 bg-black/25 p-2">
                  <div className="text-xs opacity-70">
                    <span className="font-semibold">{m.username}</span> • {new Date(m.ts).toLocaleString()}
                  </div>
                  {m.text && (
                    <p
                      className="mt-1 text-sm break-words"
                      dangerouslySetInnerHTML={{ __html: linkify(m.text) }}
                    />
                  )}
                  {m.image && <img src={m.image} alt="upload" className="mt-2 max-h-56 rounded-lg border border-white/15" />}
                </div>
              ))}
            </div>

            <div className="mt-3 flex flex-col gap-2">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Type message... links are clickable"
                className="min-h-[88px] w-full rounded-xl border border-white/20 bg-black/30 px-3 py-2 text-sm outline-none"
              />
              <div className="flex flex-wrap items-center gap-2">
                <label className={clsx('px-3 py-1.5 text-xs cursor-pointer', theme.glassButton, theme.glassPill)}>
                  Upload Picture
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => uploadImage(e.target.files?.[0])} />
                </label>
                {imageData && <span className="text-xs opacity-75">Image attached</span>}
                <button onClick={sendMessage} className={clsx('ml-auto px-4 py-1.5 text-sm', theme.glassButton, theme.glassPill)}>
                  Send
                </button>
              </div>
              {error && <p className="text-xs text-red-300">{error}</p>}
            </div>
          </div>
        )}
      </div>
    </SidebarLayout>
  );
};

export default ChatRooms;
