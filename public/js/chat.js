import { buildUserAvatar, colorForName, setAvatarUrl } from './identity.js';
import { getIdentity } from './auth.js';
import { listMessages } from './rooms.js';

const MAX_MESSAGE_LENGTH = 500;
const HISTORY_LIMIT = 50;
const HISTORY_TIMEOUT_MS = 4000;
const HISTORY_DEDUPE_WINDOW_MS = 5000;

const toggleBtn = document.getElementById('chatToggleBtn');
const launcher = document.querySelector('.chat-control');
const badge = document.getElementById('chatBadge');
const panel = document.getElementById('chatPanel');
const titleEl = document.getElementById('chatTitle');
const streamsBtn = document.getElementById('chatStreamsBtn');
const streamsCountEl = document.getElementById('chatStreamsCount');
const videosEl = document.getElementById('videos');
const messagesEl = document.getElementById('chatMessages');
const input = document.getElementById('chatInput');
const sendBtn = document.getElementById('chatSendBtn');

let socket = null;
let unreadCount = 0;

// Which channel's messages the panel is showing/sending to — normally the
// room you're actually in, but can point at a different channel while
// staying connected there (see lobby.js's peekChannelChat). Messages for
// any other channel (e.g. your own room's chat while peeking elsewhere) are
// just ignored, not queued — there's no per-channel unread tracking here,
// only "did I miss something in the channel I'm currently looking at".
let viewingChannelId = null;

// Consecutive messages from the same author within this window are grouped
// Discord-style — one avatar/name/timestamp header, the rest just text.
const GROUP_WINDOW_MS = 5 * 60 * 1000;
let lastAuthor = null;
let lastMessageTs = 0;

// Bumped on every channel switch so a slow history fetch for a channel you've
// already left can't render into the new one. `pendingLive` holds messages
// that arrive while the fetch is in flight (null = not loading).
let historyLoad = 0;
let pendingLive = null;

function isOpen() { return !panel.classList.contains('hidden'); }
export const isChatOpen = isOpen;

// lobby.js highlights the active channel row from this — the chat being open
// or closed decides whether a text channel or the voice room is "on screen".
function announceVisibility() {
  document.dispatchEvent(new CustomEvent('chat-visibility'));
}

function setUnread(count) {
  unreadCount = count;
  badge.textContent = String(count);
  badge.classList.toggle('hidden', count === 0);
}

// The chat is a full-page view (body.chat-mode, see style.css) that replaces
// the video grid rather than floating over it; it only closes via its
// Streams button, the launcher, Escape, or a sidebar click on the voice room.
// The grid is hidden, not removed, so streams keep playing underneath.
function openPanel() {
  panel.classList.remove('hidden');
  document.body.classList.add('chat-mode');
  launcher.classList.add('hidden');
  setUnread(0);
  // Messages appended while the panel was hidden had no layout to scroll.
  messagesEl.scrollTop = messagesEl.scrollHeight;
  input.focus();
  announceVisibility();
}
function closePanel() {
  const wasOpen = isOpen();
  panel.classList.add('hidden');
  document.body.classList.remove('chat-mode');
  launcher.classList.remove('hidden');
  if (wasOpen) announceVisibility();
}

// Back to the video grid — used by the Streams button and by lobby.js when
// you click the voice room you're already in.
export const showStreams = closePanel;

// Streams are whatever tiles are in the grid (remote shares/webcams plus your
// own previews), independent of whether you're in voice.
function updateStreamsButton() {
  const count = videosEl.children.length;
  streamsCountEl.textContent = String(count);
  streamsCountEl.classList.toggle('hidden', count === 0);
  streamsBtn.classList.toggle('live', count > 0);
}

// Called from lobby.js on every entry/channel switch AND every peek at a
// different channel's chat (see peekChannelChat) — points the panel at
// channelId and relabels the input Discord-style ("Enviar mensagem para
// #canal"). Clears the pane and reloads that channel's stored history (empty
// for guests and for rooms that aren't a server channel).
export function setViewingChannel(channelId, label) {
  viewingChannelId = channelId;
  input.placeholder = `Enviar mensagem para ${label}`;
  titleEl.textContent = label;
  messagesEl.innerHTML = '';
  lastAuthor = null;
  lastMessageTs = 0;
  loadHistory(channelId);
}

async function loadHistory(channelId) {
  const load = ++historyLoad;
  pendingLive = [];
  // A paused/unreachable Supabase must never hold live messages back.
  const timeout = new Promise((resolve) => setTimeout(() => resolve([]), HISTORY_TIMEOUT_MS));
  const stored = await Promise.race([listMessages(channelId, HISTORY_LIMIT), timeout]);
  if (load !== historyLoad) return;

  const live = pendingLive;
  pendingLive = null;
  const history = stored.map(({ username, body, created_at }) => ({ username, text: body, ts: Date.parse(created_at) }));
  history.forEach(({ username, text, ts }) => appendMessage(username, text, ts));

  // The server stores a message right after broadcasting it, so one sent while
  // the fetch was in flight can show up in both lists — each stored row
  // cancels at most one live message.
  const unmatched = [...history];
  live.forEach((msg) => {
    const dupe = unmatched.findIndex((row) => row.username === msg.username && row.text === msg.text
      && Math.abs(row.ts - msg.ts) < HISTORY_DEDUPE_WINDOW_MS);
    if (dupe !== -1) {
      unmatched.splice(dupe, 1);
      return;
    }
    appendMessage(msg.username, msg.text, msg.ts);
  });
}

// Discord opens straight to the channel you clicked — used by
// peekChannelChat so glancing at a channel while in voice doesn't leave you
// staring at a closed launcher bubble.
export function openPanelIfClosed() {
  if (!isOpen()) openPanel();
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
    gutter.appendChild(buildUserAvatar(username));
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

// The access token rides along so the server can store the message as this
// account (see server.js persistChatMessage); guests just send no token.
async function sendMessage() {
  const text = input.value.trim().slice(0, MAX_MESSAGE_LENGTH);
  if (!text || !viewingChannelId) return;
  const channelId = viewingChannelId;
  input.value = '';
  const identity = await getIdentity().catch(() => null);
  socket.emit('chat-message', { channelId, text, accessToken: identity?.accessToken });
}

// Called on leaving a room (lobby.js) — the socket reconnects with a fresh
// id and no room, so old messages shouldn't linger into the next room.
export function clearChat() {
  messagesEl.innerHTML = '';
  setUnread(0);
  closePanel();
  lastAuthor = null;
  lastMessageTs = 0;
  viewingChannelId = null;
  historyLoad++;
  pendingLive = null;
}

export function initChat(theSocket) {
  socket = theSocket;

  socket.on('chat-message', ({ channelId, username, avatar, text, ts }) => {
    setAvatarUrl(username, avatar);
    if (channelId !== viewingChannelId) return; // e.g. your own room's chat arriving while you're peeking elsewhere
    if (pendingLive) pendingLive.push({ username, text, ts });
    else appendMessage(username, text, ts);
    if (!isOpen()) setUnread(unreadCount + 1);
  });

  toggleBtn.addEventListener('click', () => { isOpen() ? closePanel() : openPanel(); });
  streamsBtn.addEventListener('click', closePanel);
  new MutationObserver(updateStreamsButton).observe(videosEl, { childList: true });
  updateStreamsButton();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) closePanel(); });

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
}
