const MAX_MESSAGE_LENGTH = 500;

const toggleBtn = document.getElementById('chatToggleBtn');
const launcher = document.querySelector('.chat-control');
const badge = document.getElementById('chatBadge');
const panel = document.getElementById('chatPanel');
const closeBtn = document.getElementById('chatCloseBtn');
const messagesEl = document.getElementById('chatMessages');
const input = document.getElementById('chatInput');
const sendBtn = document.getElementById('chatSendBtn');

let socket = null;
let unreadCount = 0;

function isOpen() { return !panel.classList.contains('hidden'); }

function setUnread(count) {
  unreadCount = count;
  badge.textContent = String(count);
  badge.classList.toggle('hidden', count === 0);
}

// Unlike the participants/share dropdowns, the chat panel does NOT close on
// an outside click — you're meant to keep it open while watching a share and
// clicking tile controls; auto-closing on every click elsewhere would make
// it unusable mid-conversation. It only closes via its own toggle/close
// button or Escape.
function openPanel() {
  panel.classList.remove('hidden');
  launcher.classList.add('hidden'); // the panel opens in the launcher's own corner
  setUnread(0);
  input.focus();
}
function closePanel() {
  panel.classList.add('hidden');
  launcher.classList.remove('hidden');
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendMessage(username, text, ts, isOwn) {
  const row = document.createElement('div');
  row.className = isOwn ? 'chat-message chat-message-own' : 'chat-message';

  const meta = document.createElement('div');
  meta.className = 'chat-message-meta';
  meta.textContent = `${username} · ${formatTime(ts)}`;
  row.appendChild(meta);

  const body = document.createElement('div');
  body.className = 'chat-message-text';
  body.textContent = text;
  row.appendChild(body);

  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function sendMessage() {
  const text = input.value.trim().slice(0, MAX_MESSAGE_LENGTH);
  if (!text) return;
  socket.emit('chat-message', { text });
  input.value = '';
}

// Called on leaving a room (lobby.js) — the socket reconnects with a fresh
// id and no room, so old messages shouldn't linger into the next room.
export function clearChat() {
  messagesEl.innerHTML = '';
  setUnread(0);
  closePanel();
}

export function initChat(theSocket) {
  socket = theSocket;

  socket.on('chat-message', ({ from, username, text, ts }) => {
    appendMessage(username, text, ts, from === socket.id);
    if (!isOpen()) setUnread(unreadCount + 1);
  });

  toggleBtn.addEventListener('click', () => { isOpen() ? closePanel() : openPanel(); });
  closeBtn.addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) closePanel(); });

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
}
