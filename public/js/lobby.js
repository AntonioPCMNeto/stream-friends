import { state } from './state.js';
import { stopSharing, stopWebcam } from './share.js';
import { closeAllPeerConnections } from './peers.js';
import { refreshParticipants } from './participants.js';
import { showToast } from './toast.js';
import { clearChat } from './chat.js';
import { resetVoice } from './voice.js';

const lobby = document.getElementById('lobby');
const appScreen = document.getElementById('appScreen');
const usernameInput = document.getElementById('usernameInput');
const roomCodeInput = document.getElementById('roomCodeInput');
const lobbyError = document.getElementById('lobbyError');
const welcomeBack = document.getElementById('welcomeBack');
const enterBtn = document.getElementById('enterBtn');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const copyRoomCodeBtn = document.getElementById('copyRoomCodeBtn');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
const connectionDot = document.getElementById('connectionDot');

let socket = null;

// Prefill the room code from a shared link, so a friend opening it only
// has to type a name.
const prefilledRoom = new URL(window.location.href).searchParams.get('room');
if (prefilledRoom) roomCodeInput.value = prefilledRoom;

const USERNAME_STORAGE_KEY = 'scrimaAi.username';
const ROOM_STORAGE_KEY = 'scrimaAi.currentRoom';

// Wrapped defensively — localStorage can throw in private/locked-down contexts.
function loadSavedUsername() {
  try {
    return localStorage.getItem(USERNAME_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveUsername(username) {
  try {
    localStorage.setItem(USERNAME_STORAGE_KEY, username);
  } catch {
    // Ignore — persistence is a nice-to-have, not required to enter the room.
  }
}

// Discord-style membership: entering a room "sticks" until you explicitly
// leave. loadSavedRoom() is what lets a plain revisit (or a browser restart)
// drop you straight back into the last room instead of the lobby.
function loadSavedRoom() {
  try {
    return localStorage.getItem(ROOM_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveCurrentRoom(roomId) {
  try {
    localStorage.setItem(ROOM_STORAGE_KEY, roomId);
  } catch {
    // Ignore — persistence is a nice-to-have, not required to enter the room.
  }
}

function clearSavedRoom() {
  try {
    localStorage.removeItem(ROOM_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

// Opaque per-browser id, not tied to the (freely-editable) username — lets
// the server tell "this is the same browser rejoining" apart from "someone
// else picked the same name", so a reload/reconnect replaces your old
// entry in the room instead of sitting alongside it as a ghost duplicate.
// Falls back to null (no dedup, same as before) if localStorage is
// unavailable — never blocks joining the room over it.
const CLIENT_ID_STORAGE_KEY = 'scrimaAi.clientId';

function getOrCreateClientId() {
  try {
    let id = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT_ID_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

const clientId = getOrCreateClientId();

// A returning user only needs to type the room code — jump focus straight
// there and let them know we remembered their name. A first-time visitor
// still needs to pick a name first.
function applyReturningUserUX() {
  const savedUsername = loadSavedUsername();
  usernameInput.value = savedUsername;

  if (savedUsername) {
    welcomeBack.textContent = `Bem-vindo de volta, ${savedUsername}! 👋`;
    welcomeBack.classList.remove('hidden');
    roomCodeInput.focus();
  } else {
    welcomeBack.classList.add('hidden');
    usernameInput.focus();
  }
}

applyReturningUserUX();

function enterRoom() {
  const username = usernameInput.value.trim();
  if (!username) {
    lobbyError.textContent = 'Por favor, insira um nome.';
    return;
  }

  state.roomId = roomCodeInput.value.trim() || crypto.randomUUID().slice(0, 8);
  state.myUsername = username;
  state.hasEntered = true;
  saveUsername(username);
  saveCurrentRoom(state.roomId);

  const url = new URL(window.location.href);
  url.searchParams.set('room', state.roomId);
  window.history.replaceState({}, '', url);
  state.currentRoomUrl = url.href;
  roomCodeDisplay.textContent = state.roomId;
  refreshParticipants();

  lobby.style.display = 'none';
  appScreen.style.display = '';

  if (socket.connected) {
    socket.emit('join-room', { roomId: state.roomId, username: state.myUsername, clientId });
  }
}

// Tears down local media/connections and returns to the lobby. Reconnecting
// the socket gives us a fresh id and lets the server's disconnect handler
// clean up our old room membership and notify the peers we left.
function leaveRoom() {
  stopSharing();
  stopWebcam();
  resetVoice();
  closeAllPeerConnections();
  clearSavedRoom();

  state.hasEntered = false;
  state.roomId = null;
  state.myUsername = null;
  state.currentRoomUrl = null;
  state.knownPeers.clear();
  state.peerUsernames.clear();
  state.sharingPeers.clear();
  state.voicePeers.clear();
  refreshParticipants();
  clearChat();

  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState({}, '', url);

  appScreen.style.display = 'none';
  lobby.style.display = '';
  lobbyError.textContent = '';
  roomCodeInput.value = '';
  applyReturningUserUX();

  socket.disconnect();
  socket.connect();
}

// Discord-style "you're just in the server": a saved username plus a room
// (either from a shared link's ?room= or the last room you were in) skips
// the lobby screen entirely and rejoins directly. A link always wins over
// the last room — clicking someone else's invite switches you into it, the
// same as picking a different server, and that becomes the new "last room"
// via enterRoom()'s own saveCurrentRoom() call.
function attemptAutoJoin() {
  const savedUsername = loadSavedUsername();
  const targetRoom = prefilledRoom || loadSavedRoom();
  if (!savedUsername || !targetRoom) return;

  usernameInput.value = savedUsername;
  roomCodeInput.value = targetRoom;
  enterRoom();
}

// Wires the lobby form and the room-join handshake on (re)connect.
export function initLobby(theSocket) {
  socket = theSocket;

  enterBtn.addEventListener('click', enterRoom);
  usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterRoom(); });
  roomCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterRoom(); });

  leaveRoomBtn.addEventListener('click', leaveRoom);

  copyLinkBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(state.currentRoomUrl);
    const original = copyLinkBtn.textContent;
    copyLinkBtn.textContent = '✅ Copiado!';
    setTimeout(() => { copyLinkBtn.textContent = original; }, 1500);
  });

  copyRoomCodeBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(state.roomId);
    const original = copyRoomCodeBtn.textContent;
    copyRoomCodeBtn.textContent = '✅';
    setTimeout(() => { copyRoomCodeBtn.textContent = original; }, 1200);
  });

  let hasConnectedBefore = false;

  socket.on('connect', () => {
    connectionDot.classList.add('connected');
    connectionDot.classList.remove('disconnected');
    connectionDot.title = 'Conectado';
    if (state.hasEntered) {
      // A reconnect after a dropped connection leaves stale peer state and
      // dead RTCPeerConnections behind (the server never told us who left
      // while we were offline) — clear them so the fresh existing-peers
      // response rebuilds everyone from scratch instead of layering on top
      // of ghosts.
      closeAllPeerConnections();
      state.knownPeers.clear();
      state.peerUsernames.clear();
      state.sharingPeers.clear();
      refreshParticipants();
      socket.emit('join-room', { roomId: state.roomId, username: state.myUsername, clientId });
      if (hasConnectedBefore) showToast('Reconectado à sala.');
    }
    hasConnectedBefore = true;
  });

  socket.on('disconnect', () => {
    connectionDot.classList.remove('connected');
    connectionDot.classList.add('disconnected');
    connectionDot.title = 'Desconectado';
    if (state.hasEntered) showToast('Conexão perdida. Reconectando...', 'error');
  });

  attemptAutoJoin();
}
