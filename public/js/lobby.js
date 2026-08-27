import { state } from './state.js';
import { stopSharing } from './share.js';
import { connectToRoom, disconnectFromRoom, onConnectionStateChanged, ConnectionState } from './livekit.js';
import { refreshParticipants } from './participants.js';
import { showToast } from './toast.js';

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

// Prefill the room code from a shared link, so a friend opening it only
// has to type a name.
const prefilledRoom = new URL(window.location.href).searchParams.get('room');
if (prefilledRoom) roomCodeInput.value = prefilledRoom;

const USERNAME_STORAGE_KEY = 'scrimaAi.username';

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

async function enterRoom() {
  const username = usernameInput.value.trim();
  if (!username) {
    lobbyError.textContent = 'Por favor, insira um nome.';
    return;
  }

  const roomId = roomCodeInput.value.trim() || crypto.randomUUID().slice(0, 8);
  lobbyError.textContent = '';
  enterBtn.disabled = true;

  try {
    await connectToRoom(roomId, username);
  } catch (err) {
    console.error('Failed to connect to room:', err);
    lobbyError.textContent = 'Não foi possível entrar na sala. Verifique sua conexão e tente novamente.';
    enterBtn.disabled = false;
    return;
  }

  state.roomId = roomId;
  state.myUsername = username;
  state.hasEntered = true;
  saveUsername(username);

  const url = new URL(window.location.href);
  url.searchParams.set('room', state.roomId);
  window.history.replaceState({}, '', url);
  state.currentRoomUrl = url.href;
  roomCodeDisplay.textContent = state.roomId;
  refreshParticipants();

  lobby.classList.add('hidden');
  appScreen.classList.remove('hidden');
  enterBtn.disabled = false;
}

// Tears down local media/connections and returns to the lobby.
function leaveRoom() {
  stopSharing();
  disconnectFromRoom();

  state.hasEntered = false;
  state.roomId = null;
  state.myUsername = null;
  state.currentRoomUrl = null;
  state.knownPeers.clear();
  state.peerUsernames.clear();
  state.sharingPeers.clear();
  refreshParticipants();

  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState({}, '', url);

  appScreen.classList.add('hidden');
  lobby.classList.remove('hidden');
  lobbyError.textContent = '';
  roomCodeInput.value = '';
  applyReturningUserUX();
}

// Wires the lobby form and reflects LiveKit's own connection-state machine
// (it handles reconnection internally — we just need to show it).
export function initLobby() {
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
  let wasConnected = false;

  onConnectionStateChanged((connectionState) => {
    const connected = connectionState === ConnectionState.Connected;
    connectionDot.classList.toggle('connected', connected);
    connectionDot.classList.toggle('disconnected', !connected);
    connectionDot.title = connected
      ? 'Conectado'
      : connectionState === ConnectionState.Disconnected ? 'Desconectado' : 'Reconectando...';

    if (connected && !wasConnected && hasConnectedBefore) {
      showToast('Reconectado à sala.');
    }
    if (!connected && wasConnected && state.hasEntered) {
      showToast('Conexão perdida. Reconectando...', 'error');
    }
    if (connected) hasConnectedBefore = true;
    wasConnected = connected;
  });
}
