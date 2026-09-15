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
const serverSidebar = document.getElementById('serverSidebar');
const authDividerServers = document.getElementById('authDividerServers');
const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
const serverListView = document.getElementById('serverListView');
const myServersList = document.getElementById('myServersList');
const createServerNameInput = document.getElementById('createServerNameInput');
const createServerBtn = document.getElementById('createServerBtn');
const createServerError = document.getElementById('createServerError');
const channelsView = document.getElementById('channelsView');
const backToServersBtn = document.getElementById('backToServersBtn');
const selectedServerName = document.getElementById('selectedServerName');
const channelsList = document.getElementById('channelsList');
const createChannelNameInput = document.getElementById('createChannelNameInput');
const createChannelBtn = document.getElementById('createChannelBtn');
const createChannelError = document.getElementById('createChannelError');

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

// The server a user has drilled into in the lobby (see openServerChannels
// below) — null while browsing the server list itself. Not room state:
// this is purely about which view the "Meus Servidores" card is showing,
// unrelated to state.roomId (which only gets set once a channel is
// actually entered).
let selectedServer = null;

function showServerListView() {
  selectedServer = null;
  channelsView.classList.add('hidden');
  serverListView.classList.remove('hidden');
}

// Below the mobile breakpoint the sidebar is an off-canvas overlay (see
// style.css) — picking a channel is the one action that should always
// close it back down, since its job (getting you into a room) is done.
// A no-op above the breakpoint, since the sidebar has no .open state there.
function closeSidebarOnMobile() {
  serverSidebar.classList.remove('open');
  sidebarBackdrop.classList.add('hidden');
  sidebarToggleBtn.setAttribute('aria-expanded', 'false');
}

// Persistent "servers" (see rooms.js) — signed-in only, since membership is
// tied to an account. Clicking a listed server drills into its channel
// list (openServerChannels); entering a room only happens once a specific
// channel is picked there.
//
// Supabase's auth listener can fire more than once in quick succession
// while a session is being resolved on load, so this can end up called
// several times concurrently. A request token makes sure only the latest
// call's response ever renders — an overtaken response is dropped instead
// of appending onto a list an older call already started clearing/filling.
let serversRequestId = 0;
async function refreshMyServers() {
  showServerListView(); // this always means "show me my servers" — drop any open channel view
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
    // A plain div, not a <button> — it now has a real <button> nested inside
    // it (the remove action), and a button can't legally contain a button.
    // tabindex + keydown keep it keyboard-accessible like the button it replaces.
    const row = document.createElement('div');
    row.className = 'my-server-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const icon = buildAvatar(room.name);
    icon.classList.add('avatar-sm');
    row.appendChild(icon);
    const name = document.createElement('span');
    name.className = 'row-label';
    name.textContent = room.name;
    row.appendChild(name);
    const activateRow = () => openServerChannels(room);
    row.addEventListener('click', activateRow);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateRow(); }
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'my-server-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = `Sair de "${room.name}"`;
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't also trigger the row's own "enter room" click
      if (!confirm(`Sair de "${room.name}"? Você só volta a entrar com um novo convite.`)) return;
      removeBtn.disabled = true;
      const { error } = await rooms.leaveRoom(room.id);
      if (error) {
        showToast(error, 'error');
        removeBtn.disabled = false;
        return;
      }
      refreshMyServers();
    });
    row.appendChild(removeBtn);

    myServersList.appendChild(row);
  });
}

// Drills into one server's channel list, replacing the server list in the
// same card (see showServerListView for the way back).
function openServerChannels(room) {
  selectedServer = room;
  selectedServerName.textContent = room.name;
  createChannelError.textContent = '';
  serverListView.classList.add('hidden');
  channelsView.classList.remove('hidden');
  refreshChannels();
}

// Same request-token guard as refreshMyServers, for the same reason
// (overlapping calls shouldn't let a stale response render over a newer one).
let channelsRequestId = 0;
async function refreshChannels() {
  const server = selectedServer;
  const requestId = ++channelsRequestId;
  const channels = await rooms.listChannels(server.id);
  if (requestId !== channelsRequestId || selectedServer !== server) return;

  channelsList.innerHTML = '';

  if (channels.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'no-servers-hint';
    hint.textContent = 'Nenhum canal ainda.';
    channelsList.appendChild(hint);
    return;
  }

  channels.forEach((channel) => {
    const row = document.createElement('div');
    row.className = 'my-server-row';
    row.classList.toggle('active', state.hasEntered && channel.id === state.roomId);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const hash = document.createElement('span');
    hash.className = 'channel-hash';
    hash.textContent = '#';
    row.appendChild(hash);
    const name = document.createElement('span');
    name.className = 'row-label';
    name.textContent = channel.name;
    row.appendChild(name);
    const activateRow = () => {
      joinRoom(channel.id, `# ${channel.name}`);
      closeSidebarOnMobile();
    };
    row.addEventListener('click', activateRow);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateRow(); }
    });
    channelsList.appendChild(row);
  });
}

// Signed in ⇒ identity is verified server-side and can't be spoofed, so the
// free-text nick field gets out of the way entirely and the room-scoped
// "who are you" question is already answered. Signed out ⇒ the guest form
// (unchanged from before accounts existed).
function applyAuthUX() {
  const signedIn = Boolean(identity);
  authStatus.classList.toggle('hidden', !signedIn);
  serverSidebar.classList.toggle('hidden', !signedIn);
  authDividerServers.classList.toggle('hidden', !signedIn);
  sidebarToggleBtn.classList.toggle('hidden', !signedIn);
  document.body.classList.toggle('has-sidebar', signedIn);
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
    showServerListView(); // don't leave a signed-out session's lobby stuck mid-channel-view for next time
    applyAuthMode();
    applyReturningUserUX();
  }
}

// Shared cleanup between "leave the room entirely" and "switch to a
// different room while staying in the app shell" — local media, peer
// connections and room-scoped UI state, nothing about which screen is
// visible or which room we're headed to next (callers handle that).
function teardownRoomState() {
  stopSharing();
  stopWebcam();
  resetVoice();
  closeAllPeerConnections();
  state.knownPeers.clear();
  state.peerUsernames.clear();
  state.peerVerified.clear();
  state.sharingPeers.clear();
  state.voicePeers.clear();
  clearChat();
}

// Set right before a mid-session channel switch's disconnect/reconnect (see
// joinRoom below) so the 'connect' handler's reconnect toast doesn't fire
// for a deliberate switch — only for an actual dropped connection.
let isSwitchingChannel = false;

// The shared "go to this room" path — used both for the first join from the
// lobby (enterRoom) and for switching to a different channel while already
// in one (see the sidebar's channel rows). displayLabel lets a channel
// switch show "# Geral" in the room bar instead of the raw room id.
function joinRoom(roomId, displayLabel = roomId) {
  const isSwitch = state.hasEntered;
  if (isSwitch) teardownRoomState();

  state.roomId = roomId;
  state.hasEntered = true;
  saveCurrentRoom(roomId);

  // Signed in + an actual room id — try to register persistent membership.
  // Most guest codes aren't real servers and this just silently no-ops;
  // when it is one, this is what makes "Meus Servidores" pick up someone
  // else's invite link with no dedicated "join" UI needed.
  if (identity && roomId) {
    rooms.tryJoinByInvite(roomId);
  }

  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  window.history.replaceState({}, '', url);
  state.currentRoomUrl = url.href;
  roomCodeDisplay.textContent = displayLabel;
  refreshParticipants();

  lobby.style.display = 'none';
  appScreen.style.display = '';

  if (isSwitch) {
    // server.js's join-room handler never removes a socket from its
    // PREVIOUS Socket.IO room (no socket.leave(), no cleanup of the old
    // room's membership map) — only an actual disconnect triggers that
    // cleanup. Re-emitting join-room on the same live socket would leave a
    // ghost participant behind in the channel we're leaving. Disconnecting
    // and reconnecting re-runs the same clean teardown leaveRoom always
    // relied on; the 'connect' handler below re-emits join-room for
    // whatever state.roomId is by the time it fires.
    isSwitchingChannel = true;
    socket.disconnect();
    socket.connect();
  } else if (socket.connected) {
    socket.emit('join-room', { roomId: state.roomId, username: state.myUsername, clientId, accessToken: identity?.accessToken });
  }
}

function enterRoom() {
  const username = identity?.username || usernameInput.value.trim();
  if (!username) {
    lobbyError.textContent = 'Por favor, insira um nome.';
    return;
  }

  const typedRoomCode = roomCodeInput.value.trim();
  state.myUsername = username;
  state.myVerified = Boolean(identity);
  saveUsername(username);

  joinRoom(typedRoomCode || crypto.randomUUID().slice(0, 8));
}

// Tears down local media/connections and returns to the lobby. Reconnecting
// the socket gives us a fresh id and lets the server's disconnect handler
// clean up our old room membership and notify the peers we left.
function leaveRoom() {
  teardownRoomState();
  clearSavedRoom();

  state.hasEntered = false;
  state.roomId = null;
  state.myUsername = null;
  state.currentRoomUrl = null;
  refreshParticipants();

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

  backToServersBtn.addEventListener('click', showServerListView);

  sidebarToggleBtn.addEventListener('click', () => {
    const opening = !serverSidebar.classList.contains('open');
    serverSidebar.classList.toggle('open', opening);
    sidebarBackdrop.classList.toggle('hidden', !opening);
    sidebarToggleBtn.setAttribute('aria-expanded', String(opening));
  });
  sidebarBackdrop.addEventListener('click', closeSidebarOnMobile);

  createChannelBtn.addEventListener('click', async () => {
    if (createChannelBtn.disabled || !selectedServer) return;
    createChannelError.textContent = '';
    const name = createChannelNameInput.value.trim();
    if (!name) { createChannelError.textContent = 'Dê um nome ao canal.'; return; }

    createChannelBtn.disabled = true;
    try {
      const { error } = await rooms.createChannel(selectedServer.id, name);
      if (error) { createChannelError.textContent = error; return; }

      createChannelNameInput.value = '';
      refreshChannels();
    } finally {
      createChannelBtn.disabled = false;
    }
  });
  createChannelNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createChannelBtn.click();
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
      if (hasConnectedBefore && !isSwitchingChannel) showToast('Reconectado à sala.');
    }
    isSwitchingChannel = false;
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
