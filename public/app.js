/* global io */
// Vanilla JS client: no build step, served by the same Express server.
// All user-provided text is rendered with textContent (never innerHTML).

const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  contacts: [],
  online: new Set(),
  activePeer: null, // contact object
  messages: [], // for the active conversation, chronological
  nextCursor: null,
  pending: new Map(), // clientMessageId -> { body, peerId, attempts }
  typingTimers: new Map(),
  socket: null,
};

// ---------- API ----------
const api = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
};

const newClientId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const initials = (name = '?') => name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const renderAvatar = (el, user, online = false) => {
  el.textContent = user.profilePic ? '' : initials(user.fullName);
  el.style.backgroundImage = user.profilePic ? `url("${encodeURI(user.profilePic)}")` : '';
  el.classList.toggle('online', online);
};

// ---------- Auth ----------
let signupMode = false;

const showAuth = () => {
  $('chat-view').hidden = true;
  $('auth-view').hidden = false;
};

const setAuthMode = (isSignup) => {
  signupMode = isSignup;
  $('name-field').hidden = !isSignup;
  $('auth-subtitle').textContent = isSignup ? 'Create your account' : 'Sign in to continue';
  $('auth-submit').textContent = isSignup ? 'Create account' : 'Sign in';
  $('auth-switch-text').textContent = isSignup ? 'Have an account?' : 'No account?';
  $('auth-switch').textContent = isSignup ? 'Sign in' : 'Create one';
  $('auth-error').textContent = '';
};

$('auth-switch').addEventListener('click', () => setAuthMode(!signupMode));

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const body = { email: form.get('email'), password: form.get('password') };
  if (signupMode) body.fullName = form.get('fullName');
  $('auth-submit').disabled = true;
  try {
    state.me = await api('POST', signupMode ? '/api/auth/signup' : '/api/auth/login', body);
    e.target.reset();
    await startChat();
  } catch (err) {
    $('auth-error').textContent = err.message;
  } finally {
    $('auth-submit').disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  state.socket?.disconnect();
  Object.assign(state, { me: null, contacts: [], activePeer: null, messages: [] });
  showAuth();
});

// ---------- Contacts ----------
const loadContacts = async () => {
  state.contacts = await api('GET', '/api/users');
  state.contacts.forEach((c) => (c.online ? state.online.add(c._id) : state.online.delete(c._id)));
  renderContacts();
};

const renderContacts = () => {
  const q = $('search').value.trim().toLowerCase();
  const list = $('contacts');
  list.replaceChildren();
  state.contacts
    .filter((c) => !q || c.fullName.toLowerCase().includes(q) || c.email.includes(q))
    .forEach((c) => {
      const li = document.createElement('li');
      li.className = `contact${state.activePeer?._id === c._id ? ' active' : ''}`;
      li.tabIndex = 0;
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      renderAvatar(avatar, c, state.online.has(c._id));
      const text = document.createElement('div');
      text.className = 'grow';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = c.fullName;
      const preview = document.createElement('div');
      preview.className = 'preview';
      if (c.lastMessage) {
        const prefix = c.lastMessage.senderId === state.me._id ? 'You: ' : '';
        preview.textContent = prefix + (c.lastMessage.text || (c.lastMessage.hasImage ? '📷 Photo' : ''));
      } else {
        preview.textContent = state.online.has(c._id) ? 'Online' : '';
      }
      text.append(name, preview);
      li.append(avatar, text);
      if (c.unreadCount) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = c.unreadCount;
        li.append(badge);
      }
      const open = () => openConversation(c);
      li.addEventListener('click', open);
      li.addEventListener('keydown', (ev) => ev.key === 'Enter' && open());
      list.append(li);
    });
};

$('search').addEventListener('input', renderContacts);

const bumpContact = (peerId, message) => {
  const c = state.contacts.find((x) => x._id === peerId);
  if (!c) return loadContacts();
  c.lastMessage = { _id: message._id, text: message.text, hasImage: Boolean(message.image), senderId: message.senderId, createdAt: message.createdAt };
  const viewing = state.activePeer?._id === peerId && document.visibilityState === 'visible';
  if (message.senderId === peerId && !viewing) c.unreadCount = (c.unreadCount || 0) + 1;
  state.contacts.sort((a, b) => new Date(b.lastMessage?.createdAt || 0) - new Date(a.lastMessage?.createdAt || 0));
  return renderContacts();
};

// ---------- Conversation ----------
const peerStatusText = () => {
  const p = state.activePeer;
  if (!p) return '';
  if (state.online.has(p._id)) return 'online';
  return p.lastSeenAt ? `last seen ${new Date(p.lastSeenAt).toLocaleString()}` : 'offline';
};

const openConversation = async (contact) => {
  state.activePeer = contact;
  state.messages = [];
  state.nextCursor = null;
  $('chat-view').classList.add('in-conversation');
  $('empty-state').hidden = true;
  ['conv-header', 'messages', 'composer'].forEach((id) => ($(id).hidden = false));
  $('peer-name').textContent = contact.fullName;
  $('peer-status').textContent = peerStatusText();
  renderAvatar($('peer-avatar'), contact, state.online.has(contact._id));
  renderContacts();
  await loadPage();
  scrollToBottom();
  markRead();
  $('composer-input').focus();
};

$('back').addEventListener('click', () => {
  $('chat-view').classList.remove('in-conversation');
  state.activePeer = null;
  renderContacts();
});

const loadPage = async () => {
  const peer = state.activePeer;
  const qs = state.nextCursor ? `?before=${state.nextCursor}` : '';
  const page = await api('GET', `/api/messages/${peer._id}${qs}`);
  if (state.activePeer !== peer) return; // user switched conversations meanwhile
  state.messages = [...page.messages, ...state.messages];
  state.nextCursor = page.nextCursor;
  $('load-older').hidden = !page.nextCursor;
  renderMessages();
};

$('load-older').addEventListener('click', async () => {
  const box = $('messages');
  const before = box.scrollHeight;
  await loadPage();
  box.scrollTop = box.scrollHeight - before; // keep the viewport anchored
});

const renderMessages = () => {
  const list = $('message-list');
  list.replaceChildren();
  state.messages.forEach((m) => {
    const li = document.createElement('li');
    const mine = m.senderId === state.me._id;
    li.className = `msg${mine ? ' mine' : ''}${m._pending ? ' pending' : ''}${m._failed ? ' failed' : ''}`;
    if (m.image) {
      const img = document.createElement('img');
      img.src = m.image;
      img.alt = 'Shared image';
      img.loading = 'lazy';
      li.append(img);
    }
    if (m.text) li.append(document.createTextNode(m.text));
    const meta = document.createElement('div');
    meta.className = 'meta';
    if (m._failed) {
      meta.textContent = 'Not sent · tap to retry';
      li.addEventListener('click', () => retrySend(m.clientMessageId));
    } else if (m._pending) {
      meta.textContent = 'sending…';
    } else {
      meta.textContent = timeOf(m.createdAt) + (mine ? (m.readAt ? ' ✓✓' : ' ✓') : '');
    }
    li.append(meta);
    list.append(li);
  });
  if (state.typingFrom === state.activePeer?._id) {
    const li = document.createElement('li');
    li.className = 'typing';
    li.textContent = `${state.activePeer.fullName} is typing…`;
    list.append(li);
  }
};

const scrollToBottom = () => {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
};
const nearBottom = () => {
  const box = $('messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
};

let readInFlight = false;
const markRead = async () => {
  const peer = state.activePeer;
  if (!peer || readInFlight || document.visibilityState !== 'visible') return;
  readInFlight = true;
  try {
    await api('POST', `/api/messages/${peer._id}/read`);
    peer.unreadCount = 0;
    renderContacts();
  } catch {
    /* non-critical */
  } finally {
    readInFlight = false;
  }
};
document.addEventListener('visibilitychange', markRead);

/** Adds or replaces a message (matched by _id or clientMessageId). */
const upsertMessage = (m) => {
  const i = state.messages.findIndex(
    (x) => x._id === m._id || (m.clientMessageId && x.clientMessageId === m.clientMessageId && x.senderId === m.senderId)
  );
  if (i >= 0) state.messages[i] = m;
  else state.messages.push(m);
};

// ---------- Sending (optimistic, retried with the SAME clientMessageId) ----------
const deliver = async (clientMessageId) => {
  const job = state.pending.get(clientMessageId);
  if (!job) return;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const saved = await api('POST', `/api/messages/${job.peerId}`, job.body);
      state.pending.delete(clientMessageId);
      if (state.activePeer?._id === job.peerId) {
        upsertMessage(saved);
        renderMessages();
      }
      bumpContact(job.peerId, saved);
      return;
    } catch (err) {
      const retryable = !err.status || err.status >= 500 || err.status === 429;
      if (!retryable || attempt === 4) break;
      // Full-jitter backoff; the server de-duplicates retries by clientMessageId.
      await sleep(Math.random() * 500 * 2 ** attempt);
    }
  }
  const m = state.messages.find((x) => x.clientMessageId === clientMessageId);
  if (m) {
    m._pending = false;
    m._failed = true;
    renderMessages();
  }
};

const retrySend = (clientMessageId) => {
  const m = state.messages.find((x) => x.clientMessageId === clientMessageId);
  if (!m) return;
  m._failed = false;
  m._pending = true;
  renderMessages();
  deliver(clientMessageId);
};

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('composer-input');
  const text = input.value.trim();
  if (!text || !state.activePeer) return;
  input.value = '';
  sendTyping(false);

  const clientMessageId = newClientId();
  const peerId = state.activePeer._id;
  state.pending.set(clientMessageId, { peerId, body: { text, clientMessageId } });
  upsertMessage({
    _id: `pending-${clientMessageId}`,
    clientMessageId,
    senderId: state.me._id,
    receiverId: peerId,
    text,
    createdAt: new Date().toISOString(),
    _pending: true,
  });
  renderMessages();
  scrollToBottom();
  deliver(clientMessageId);
});

// ---------- Typing ----------
let typingSent = false;
let typingStopTimer;
const sendTyping = (isTyping) => {
  if (!state.socket || !state.activePeer || typingSent === isTyping) return;
  typingSent = isTyping;
  state.socket.emit('typing', { to: state.activePeer._id, isTyping });
};
$('composer-input').addEventListener('input', () => {
  sendTyping(true);
  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => sendTyping(false), 2000);
});

// ---------- Socket ----------
const connectSocket = () => {
  const socket = io({ withCredentials: true, transports: ['websocket', 'polling'] });
  state.socket = socket;
  const status = $('conn-status');

  socket.on('connect', () => {
    status.textContent = 'online';
    // Catch up on anything missed while disconnected.
    loadContacts().catch(() => {});
    if (state.activePeer) {
      state.nextCursor = null;
      state.messages = state.messages.filter((m) => m._pending || m._failed);
      loadPage().then(scrollToBottom).catch(() => {});
    }
  });
  socket.on('disconnect', () => (status.textContent = 'reconnecting…'));
  socket.on('connect_error', (err) => {
    status.textContent = 'offline';
    if (err.message === 'unauthorized') showAuth();
  });

  socket.on('presence:online', (ids) => {
    state.online = new Set(ids);
    renderContacts();
    $('peer-status').textContent = peerStatusText();
  });
  socket.on('presence:update', ({ userId, online, lastSeenAt }) => {
    if (online) state.online.add(userId);
    else state.online.delete(userId);
    const c = state.contacts.find((x) => x._id === userId);
    if (c && lastSeenAt) c.lastSeenAt = lastSeenAt;
    renderContacts();
    if (state.activePeer?._id === userId) {
      $('peer-status').textContent = peerStatusText();
      renderAvatar($('peer-avatar'), state.activePeer, online);
    }
  });

  socket.on('message:new', (m) => {
    const peerId = m.senderId === state.me._id ? m.receiverId : m.senderId;
    if (state.activePeer?._id === peerId) {
      const stick = nearBottom();
      upsertMessage(m);
      if (m.senderId === peerId) state.typingFrom = null;
      renderMessages();
      if (stick) scrollToBottom();
      if (m.senderId === peerId) markRead();
    }
    bumpContact(peerId, m);
  });

  socket.on('messages:read', ({ by, ids, readAt }) => {
    if (state.activePeer?._id !== by) return;
    const set = new Set(ids);
    state.messages.forEach((m) => set.has(m._id) && (m.readAt = readAt));
    renderMessages();
  });

  socket.on('typing', ({ from, isTyping }) => {
    clearTimeout(state.typingTimers.get(from));
    state.typingFrom = isTyping ? from : state.typingFrom === from ? null : state.typingFrom;
    if (isTyping) {
      // Safety net if the "stopped typing" event is lost.
      state.typingTimers.set(from, setTimeout(() => {
        if (state.typingFrom === from) state.typingFrom = null;
        renderMessages();
      }, 5000));
    }
    if (state.activePeer?._id === from) {
      const stick = nearBottom();
      renderMessages();
      if (stick) scrollToBottom();
    }
  });
};

// ---------- Boot ----------
const startChat = async () => {
  $('auth-view').hidden = true;
  $('chat-view').hidden = false;
  $('me-name').textContent = state.me.fullName;
  renderAvatar($('me-avatar'), state.me);
  await loadContacts();
  connectSocket();
};

(async () => {
  try {
    state.me = await api('GET', '/api/auth/me');
    await startChat();
  } catch {
    setAuthMode(false);
    showAuth();
  }
})();
