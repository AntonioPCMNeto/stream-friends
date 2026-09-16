import { buildAvatar, colorForName } from './identity.js';

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

// Consecutive messages from the same author within this window are grouped
// Discord-style — one avatar/name/timestamp header, the rest just text.
const GROUP_WINDOW_MS = 5 * 60 * 1000;
let lastAuthor = null;
let lastMessageTs = 0;

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

// Called from lobby.js's joinRoom on every entry/channel switch — mirrors
// Discord's own "Enviar mensagem para #canal" placeholder instead of a
// generic one. label is whatever's shown in the room bar (a "#canal" name,
// or a raw guest room code with no "#").
export function setChannelLabel(label) {
  input.placeholder = `Enviar mensagem para ${label}`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendMessage(username, text, ts) {
  const grouped = username === lastAuthor && ts - lastMessageTs < GROUP_WINDOW_MS;
  lastAuthor = username;
  lastMessageTs = ts;

  const row = document.createElement('div');
  row.className = grouped ? 'chat-message chat-message-grouped' : 'chat-message';

  // Fixed-width gutter either way, so grouped rows' text lines up under the
  // headed row's text instead of shifting left — Discord shows the
  // timestamp here on hover for a grouped message instead of an avatar.
  const gutter = document.createElement('div');
  gutter.className = 'chat-message-gutter';
  if (grouped) {
    const hoverTime = document.createElement('span');
    hoverTime.className = 'chat-message-hover-time';
    hoverTime.textContent = formatTime(ts);
    gutter.appendChild(hoverTime);
  } else {
    gutter.appendChild(buildAvatar(username));
  }
  row.appendChild(gutter);

  const content = document.createElement('div');
  content.className = 'chat-message-content';

  if (!grouped) {
    const meta = document.createElement('div');
    meta.className = 'chat-message-meta';

    const authorEl = document.createElement('span');
    authorEl.className = 'chat-message-author';
    authorEl.style.color = colorForName(username);
    authorEl.textContent = username;
    meta.appendChild(authorEl);

    const timeEl = document.createElement('span');
    timeEl.className = 'chat-message-time';
    timeEl.textContent = formatTime(ts);
    meta.appendChild(timeEl);

    content.appendChild(meta);
  }

  const body = document.createElement('div');
  body.className = 'chat-message-text';
  body.textContent = text;
  content.appendChild(body);

  row.appendChild(content);
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
  lastAuthor = null;
  lastMessageTs = 0;
}

export function initChat(theSocket) {
  socket = theSocket;

  socket.on('chat-message', ({ username, text, ts }) => {
    appendMessage(username, text, ts);
    if (!isOpen()) setUnread(unreadCount + 1);
  });

  toggleBtn.addEventListener('click', () => { isOpen() ? closePanel() : openPanel(); });
  closeBtn.addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) closePanel(); });

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
}
