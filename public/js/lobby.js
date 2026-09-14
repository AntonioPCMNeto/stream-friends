import { state } from './state.js';
import { stopSharing, stopWebcam } from './share.js';
import { closeAllPeerConnections } from './peers.js';
import { refreshParticipants } from './participants.js';
import { showToast } from './toast.js';
import { clearChat } from './chat.js';
import { resetVoice } from './voice.js';
import * as auth from './auth.js';
import * as rooms from './rooms.js';
import { buildAvatar } from './identity.js';

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
const authStatus = document.getElementById('authStatus');
const authAvatar = document.getElementById('authAvatar');
const authName = document.getElementById('authName');
const signOutBtn = document.getElementById('signOutBtn');
const authForm = document.getElementById('authForm');
const authUsernameField = document.getElementById('authUsernameField');
const authEmail = document.getElementById('authEmail');
const authUsername = document.getElementById('authUsername');
const authPassword = document.getElementById('authPassword');
const authError = document.getElementById('authError');
const authNotice = document.getElementById('authNotice');
const authSignInBtn = document.getElementById('authSignInBtn');
const authSignUpBtn = document.getElementById('authSignUpBtn');
const authModeToggleBtn = document.getElementById('authModeToggleBtn');
const authDivider = document.getElementById('authDivider');
const guestFields = document.getElementById('guestFields');
const myServersSection = document.getElementById('myServersSection');
const myServersList = document.getElementById('myServersList');
const createServerNameInput = document.getElementById('createServerNameInput');
const createServerBtn = document.getElementById('createServerBtn');
const createServerError = document.getElementById('createServerError');

let socket = null;

// The signed-in account identity (see auth.js), or null for a guest. Set
// once at startup and again whenever Supabase's auth state changes (sign
// in, sign out, sign up).
let identity = null;

// Sign-in is the default screen — a returning user is the common case, and
// it keeps the lobby from showing two competing forms at once. 'signup'
// swaps in the username field and the "Criar conta" action.
let authMode = 'signin';

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

// Toggles which single action is available at a time (sign in OR sign up),
// rather than showing both forms together — one clear default (sign in,
// the common case for a returning user) with an explicit way to switch.
function applyAuthMode() {
  const isSignUp = authMode === 'signup';
  authUsernameField.classList.toggle('hidden', !isSignUp);
  authSignInBtn.classList.toggle('hidden', isSignUp);
  authSignUpBtn.classList.toggle('hidden', !isSignUp);
  authModeToggleBtn.textContent = isSignUp ? 'Já tem conta? Entrar' : 'Não tem conta? Criar uma';
  authError.textContent = '';
}

// Persistent "servers" (see rooms.js) — signed-in only, since membership is
// tied to an account. Clicking a listed server just drives the same
// enterRoom() a typed code does; there's no separate entry path.
//
// Supabase's auth listener can fire more than once in quick succession
// while a session is being resolved on load, so this can end up called
// several times concurrently. A request token makes sure only the latest
// call's response ever renders — an overtaken response is dropped instead
// of appending onto a list an older call already started clearing/filling.
let serversRequestId = 0;
async function refreshMyServers() {
  const requestId = ++serversRequestId;
  const myRooms = await rooms.listMyRooms();
  if (requestId !== serversRequestId) return;

  myServersList.innerHTML = '';

  if (myRooms.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'no-servers-hint';
    hint.textContent = 'Você ainda não tem servidores.';
    myServersList.appendChild(hint);
    return;
  }

  myRooms.forEach((room) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'my-server-row';
    const name = document.createElement('span');
    name.textContent = room.name;
    row.appendChild(name);
    row.addEventListener('click', () => {
      roomCodeInput.value = room.id;
      enterRoom();
    });
    myServersList.appendChild(row);
  });
}

// Signed in ⇒ identity is verified server-side and can't be spoofed, so the
// free-text nick field gets out of the way entirely and the room-scoped
// "who are you" question is already answered. Signed out ⇒ the guest form
// (unchanged from before accounts existed).
function applyAuthUX() {
  const signedIn = Boolean(identity);
  authStatus.classList.toggle('hidden', !signedIn);
  myServersSection.classList.toggle('hidden', !signedIn);
  authForm.classList.toggle('hidden', signedIn || !auth.isConfigured());
  authDivider.classList.toggle('hidden', signedIn || !auth.isConfigured());
  guestFields.classList.toggle('hidden', signedIn);

  if (signedIn) {
    welcomeBack.classList.add('hidden');
    authNotice.classList.add('hidden');
    authName.textContent = identity.username || 'Conta';
    authAvatar.innerHTML = '';
    authAvatar.appendChild(buildAvatar(identity.username));
    usernameInput.value = identity.username || '';
    refreshMyServers();
  } else {
    applyAuthMode();
    applyReturningUserUX();
  }
}

function enterRoom() {
  const username = identity?.username || usernameInput.value.trim();
  if (!username) {
    lobbyError.textContent = 'Por favor, insira um nome.';
    return;
  }

  const typedRoomCode = roomCodeInput.value.trim();
  state.roomId = typedRoomCode || crypto.randomUUID().slice(0, 8);
  state.myUsername = username;
  state.myVerified = Boolean(identity);
  state.hasEntered = true;
  saveUsername(username);
  saveCurrentRoom(state.roomId);

  // Signed in + an actual typed/shared code (not the blank-code throwaway
  // path) — try to register persistent membership. Most codes aren't real
  // servers and this just silently no-ops; when one is, this is what makes
  // "Meus Servidores" pick up someone else's invite link with no dedicated
  // "join" UI needed.
  if (identity && typedRoomCode) {
    rooms.tryJoinByInvite(typedRoomCode);
  }

  const url = new URL(window.location.href);
  url.searchParams.set('room', state.roomId);
  window.history.replaceState({}, '', url);
  state.currentRoomUrl = url.href;
  roomCodeDisplay.textContent = state.roomId;
  refreshParticipants();

  lobby.style.display = 'none';
  appScreen.style.display = '';

  if (socket.connected) {
    socket.emit('join-room', { roomId: state.roomId, username: state.myUsername, clientId, accessToken: identity?.accessToken });
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
  state.peerVerified.clear();
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
  applyAuthUX(); // not applyReturningUserUX() directly — that ignores identity and would show the guest "welcome back" banner even when still signed in

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
  if (state.hasEntered) return; // already in a room — e.g. re-run after a post-load sign-in
  const targetRoom = prefilledRoom || loadSavedRoom();
  const effectiveUsername = identity?.username || loadSavedUsername();
  if (!effectiveUsername || !targetRoom) return;

  usernameInput.value = effectiveUsername;
  roomCodeInput.value = targetRoom;
  enterRoom();
}

// Wires the lobby form and the room-join handshake on (re)connect.
export async function initLobby(theSocket) {
  socket = theSocket;

  enterBtn.addEventListener('click', enterRoom);
  usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterRoom(); });
  roomCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterRoom(); });

  leaveRoomBtn.addEventListener('click', leaveRoom);

  authModeToggleBtn.addEventListener('click', () => {
    authMode = authMode === 'signin' ? 'signup' : 'signin';
    authNotice.classList.add('hidden');
    applyAuthMode();
  });

  authSignInBtn.addEventListener('click', async () => {
    authError.textContent = '';
    const { error } = await auth.signIn(authEmail.value.trim(), authPassword.value);
    if (error) authError.textContent = error;
    // On success, onIdentityChange (wired below) picks up the new session.
  });

  authSignUpBtn.addEventListener('click', async () => {
    authError.textContent = '';
    const username = authUsername.value.trim();
    if (!username) { authError.textContent = 'Escolha um nome de usuário.'; return; }
    const { error } = await auth.signUp(authEmail.value.trim(), authPassword.value, username);
    if (error) { authError.textContent = error; return; }

    // Most Supabase projects require confirming the email before a session
    // exists — signUp() succeeding here does NOT mean signed in yet.
    // onIdentityChange only fires once that link is clicked and the user
    // comes back and signs in, so tell them that explicitly rather than
    // leaving the screen looking like nothing happened.
    authPassword.value = '';
    authMode = 'signin';
    applyAuthMode();
    authNotice.textContent = 'Conta criada! Verifique seu e-mail para confirmar antes de entrar.';
    authNotice.classList.remove('hidden');
  });

  signOutBtn.addEventListener('click', async () => {
    await auth.signOut();
    identity = null;
    applyAuthUX();
  });

  createServerBtn.addEventListener('click', async () => {
    if (createServerBtn.disabled) return; // guards a double-click into two real rooms
    createServerError.textContent = '';
    const name = createServerNameInput.value.trim();
    if (!name) { createServerError.textContent = 'Dê um nome ao servidor.'; return; }

    createServerBtn.disabled = true;
    try {
      const { room, error } = await rooms.createRoom(name);
      if (error) { createServerError.textContent = error; return; }

      createServerNameInput.value = '';
      roomCodeInput.value = room.id;
      enterRoom();
    } finally {
      createServerBtn.disabled = false;
    }
  });
  createServerNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createServerBtn.click();
  });

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
      state.peerVerified.clear();
      state.sharingPeers.clear();
      refreshParticipants();
      socket.emit('join-room', { roomId: state.roomId, username: state.myUsername, clientId, accessToken: identity?.accessToken });
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

  // Fires again on every future sign-in/sign-up/sign-out — keeps the UI and
  // auto-join in sync without needing to re-check manually after each one.
  auth.onIdentityChange((newIdentity) => {
    identity = newIdentity;
    applyAuthUX();
    attemptAutoJoin();
  });

  identity = await auth.getIdentity();
  applyAuthUX();
  attemptAutoJoin();
}
