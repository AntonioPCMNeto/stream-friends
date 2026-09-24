import { state } from './state.js';
import { stopSharing, stopWebcam, initSegmented } from './share.js';
import { closeAllPeerConnections } from './peers.js';
import { refreshParticipants } from './participants.js';
import { showToast } from './toast.js';
import { clearChat, setViewingChannel, openPanelIfClosed, showStreams, isChatOpen } from './chat.js';
import { resetVoice, joinVoice } from './voice.js';
import * as auth from './auth.js';
import * as rooms from './rooms.js';
import { buildAvatar, buildUserAvatar, setAvatarUrl } from './identity.js';

const lobby = document.getElementById('lobby');
const appScreen = document.getElementById('appScreen');
const memberList = document.getElementById('memberList');
const usernameInput = document.getElementById('usernameInput');
const roomCodeInput = document.getElementById('roomCodeInput');
const lobbyError = document.getElementById('lobbyError');
const welcomeBack = document.getElementById('welcomeBack');
const enterBtn = document.getElementById('enterBtn');
const roomCodeLabel = document.getElementById('roomCodeLabel');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const copyRoomCodeBtn = document.getElementById('copyRoomCodeBtn');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
const connectionDot = document.getElementById('connectionDot');
const authStatus = document.getElementById('authStatus');
const authAvatar = document.getElementById('authAvatar');
const authName = document.getElementById('authName');
const signOutBtn = document.getElementById('signOutBtn');
const userBarLogoutRow = document.getElementById('userBarLogoutRow');
const userBarLogoutBtn = document.getElementById('userBarLogoutBtn');
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
const serverRail = document.getElementById('serverRail');
const authDividerServers = document.getElementById('authDividerServers');
const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
const noServerView = document.getElementById('noServerView');
const channelsView = document.getElementById('channelsView');
const leaveServerBtn = document.getElementById('leaveServerBtn');
const inviteServerBtn = document.getElementById('inviteServerBtn');
const selectedServerName = document.getElementById('selectedServerName');
const textChannelsList = document.getElementById('textChannelsList');
const voiceChannelsList = document.getElementById('voiceChannelsList');
const createChannelTypeGroup = document.getElementById('createChannelTypeGroup');
const createChannelNameInput = document.getElementById('createChannelNameInput');
const createChannelBtn = document.getElementById('createChannelBtn');
const createChannelError = document.getElementById('createChannelError');
const serverModalBackdrop = document.getElementById('serverModalBackdrop');
const serverModal = document.getElementById('serverModal');
const serverModalCloseBtn = document.getElementById('serverModalCloseBtn');
const serverModalCreateTabBtn = document.getElementById('serverModalCreateTabBtn');
const serverModalJoinTabBtn = document.getElementById('serverModalJoinTabBtn');
const serverModalCreatePanel = document.getElementById('serverModalCreatePanel');
const serverModalJoinPanel = document.getElementById('serverModalJoinPanel');
const createServerNameInput = document.getElementById('createServerNameInput');
const createServerBtn = document.getElementById('createServerBtn');
const createServerError = document.getElementById('createServerError');
const joinServerCodeInput = document.getElementById('joinServerCodeInput');
const joinServerBtn = document.getElementById('joinServerBtn');
const joinServerError = document.getElementById('joinServerError');

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
const SERVER_STORAGE_KEY = 'scrimaAi.lastServer';

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

// Which server the sidebar should land on next time refreshMyServers runs
// (e.g. after sign-in) — lets it skip straight to a real channel list
// instead of showing an intermediate "pick a server" state on every login.
function loadSavedServerId() {
  try {
    return localStorage.getItem(SERVER_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveServerId(roomId) {
  try {
    localStorage.setItem(SERVER_STORAGE_KEY, roomId);
  } catch {
    // Ignore — persistence is a nice-to-have.
  }
}

// A server invite is just the server's id (see rooms.js's join_room_by_invite).
// An invite link carries it as ?invite=; opening one stores it here until the
// visitor is signed in, so it survives sign-up, email confirmation and reloads
// instead of being lost if they weren't signed in yet.
const INVITE_STORAGE_KEY = 'scrimaAi.pendingInvite';
// The desktop build loads via file://, which is no use to a friend receiving
// a link — its invites point at the web app instead.
const WEB_APP_URL = 'https://stream-friends.onrender.com';

function loadPendingInvite() {
  try {
    return localStorage.getItem(INVITE_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function savePendingInvite(code) {
  try {
    localStorage.setItem(INVITE_STORAGE_KEY, code);
  } catch {
    // Ignore — the invite just won't survive a reload.
  }
}

function clearPendingInvite() {
  try {
    localStorage.removeItem(INVITE_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

function buildInviteLink(serverId) {
  const base = window.location.protocol === 'file:'
    ? WEB_APP_URL
    : window.location.origin + window.location.pathname;
  return `${base}?invite=${encodeURIComponent(serverId)}`;
}

// The join dialog accepts either the bare code or a whole pasted invite link.
function parseInviteCode(input) {
  try {
    const url = new URL(input);
    return url.searchParams.get('invite') || url.searchParams.get('room') || input;
  } catch {
    return input;
  }
}

{
  const url = new URL(window.location.href);
  const invite = url.searchParams.get('invite');
  if (invite) {
    savePendingInvite(invite.slice(0, 100));
    url.searchParams.delete('invite');
    window.history.replaceState({}, '', url);
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

// The server currently selected via the rail (see openServerChannels below)
// — null only when the account has no servers at all. Not room state: this
// is purely about which server's channels the sidebar is showing, unrelated
// to state.roomId (which only gets set once a channel is actually entered).
let selectedServer = null;

// Which channel's chat the floating panel is currently showing/sending to.
// Normally the same as state.roomId (the channel you actually entered), but
// can point at a different text channel while staying connected elsewhere
// — see peekChannelChat, used specifically so being in a voice channel
// doesn't mean losing that call just to glance at a text channel.
let viewingChannelId = null;

// Toggles which channel rows read as "active" without re-fetching the list
// — peekChannelChat's job, since it doesn't touch selectedServer/channels
// and a full refreshChannels() would be a pointless round trip just to move
// a highlight. The chat is a full-page view: while it's open the text row
// you're reading is the active one, otherwise the streams grid is on screen
// and the row of the room you're connected to is.
function isTextRowActive(channelId) {
  return isChatOpen() && channelId === viewingChannelId;
}

function isRoomRowActive(channelId) {
  return state.hasEntered && !isChatOpen() && channelId === state.roomId;
}

function updateChannelActiveHighlight() {
  textChannelsList.querySelectorAll('.my-server-row').forEach((row) => {
    row.classList.toggle('active', isTextRowActive(row.dataset.channelId));
  });
  voiceChannelsList.querySelectorAll('.my-server-row').forEach((row) => {
    row.classList.toggle('active', isRoomRowActive(row.dataset.channelId));
  });
}
document.addEventListener('chat-visibility', updateChannelActiveHighlight);

// Clicking a text channel while you're already in a room (screen share,
// webcam, the room-bar, the participant list — none of that is tied to
// whichever channel's chat you're reading) shouldn't cost you that room, in
// voice or not: it only swaps the chat, so the streams stay one click away
// (the chat's Streams button). Only text channels support this: a voice
// channel row always means "join this call", since you can't meaningfully be
// in two at once.
function peekChannelChat(channel) {
  if (viewingChannelId === channel.id) { openPanelIfClosed(); closeSidebarOnMobile(); return; }
  viewingChannelId = channel.id;
  socket.emit('view-channel', { channelId: channel.id });
  setViewingChannel(channel.id, `#${channel.name}`);
  openPanelIfClosed();
  updateChannelActiveHighlight();
  closeSidebarOnMobile();
}

function showNoServerView() {
  selectedServer = null;
  viewingChannelId = null; // no channel rows are even rendered in this state — just keeping the highlight state honest
  channelsView.classList.add('hidden');
  noServerView.classList.remove('hidden');
  updateServerRailActive();
  sendWatchServer([]);
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
// tied to an account. The rail is the only place that lists them; this just
// picks which one the sidebar lands on (openServerChannels) — the last one
// used, or the most recently joined/created if there's no saved pick, or
// the empty state if the account has none at all.
//
// Supabase's auth listener can fire more than once in quick succession
// while a session is being resolved on load, so this can end up called
// several times concurrently. A request token makes sure only the latest
// call's response ever renders — an overtaken response is dropped instead
// of racing an older call's own selection.
let serversRequestId = 0;
async function refreshMyServers() {
  const requestId = ++serversRequestId;
  const myRooms = await rooms.listMyRooms();
  if (requestId !== serversRequestId) return;

  renderServerRail(myRooms);

  if (myRooms.length === 0) {
    showNoServerView();
    return;
  }

  const savedId = loadSavedServerId();
  const target = myRooms.find((room) => room.id === savedId) || myRooms[myRooms.length - 1];
  openServerChannels(target);
}

// Joins the server from a pending invite link, if there is one, and makes it
// the selected server so refreshMyServers lands on it. Guarded because
// Supabase's auth listener can trigger applyAuthUX several times in a row.
let inviteInFlight = false;
async function acceptPendingInvite() {
  const code = loadPendingInvite();
  if (!code || inviteInFlight) return;
  inviteInFlight = true;
  try {
    const { room, error } = await rooms.joinRoomByCode(code);
    clearPendingInvite();
    if (error) { showToast(error, 'error'); return; }
    saveServerId(room.id);
    showToast(`Você entrou no servidor "${room.name}".`);
  } finally {
    inviteInFlight = false;
  }
}

// Discord's own leftmost strip — quick server switching alongside the full
// "Meus Servidores" list (see refreshMyServers, which calls this with the
// same data it just fetched). Rebuilt whenever the server list refreshes;
// highlighting alone (no refetch) is handled by updateServerRailActive.
function renderServerRail(myRooms) {
  serverRail.innerHTML = '';
  myRooms.forEach((room) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'server-rail-icon';
    btn.title = room.name;
    btn.setAttribute('aria-label', room.name);
    btn.dataset.roomId = room.id;
    btn.appendChild(buildAvatar(room.name));
    btn.addEventListener('click', () => openServerChannels(room));
    serverRail.appendChild(btn);
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'server-rail-icon server-rail-add';
  addBtn.title = 'Adicionar servidor';
  addBtn.setAttribute('aria-label', 'Adicionar servidor');
  addBtn.textContent = '+';
  addBtn.addEventListener('click', openServerModal);
  serverRail.appendChild(addBtn);

  updateServerRailActive();
}

// selectedServer changes on every drill-in/back-out without necessarily
// refetching the room list, so highlighting is a separate, cheap pass
// rather than piggybacking on renderServerRail's rebuild.
function updateServerRailActive() {
  serverRail.querySelectorAll('.server-rail-icon').forEach((btn) => {
    btn.classList.toggle('active', selectedServer?.id === btn.dataset.roomId);
  });
}

// Switches the sidebar to one server's channel list — the only view it
// ever shows once an account has at least one server (see showNoServerView
// for the empty-account fallback).
function openServerChannels(room) {
  selectedServer = room;
  saveServerId(room.id);
  selectedServerName.textContent = room.name;
  createChannelError.textContent = '';
  noServerView.classList.add('hidden');
  channelsView.classList.remove('hidden');
  updateServerRailActive();
  refreshChannels();
}

function switchServerModalTab(tab) {
  const isCreate = tab === 'create';
  serverModalCreateTabBtn.classList.toggle('active', isCreate);
  serverModalJoinTabBtn.classList.toggle('active', !isCreate);
  serverModalCreateTabBtn.setAttribute('aria-selected', String(isCreate));
  serverModalJoinTabBtn.setAttribute('aria-selected', String(!isCreate));
  serverModalCreatePanel.classList.toggle('hidden', !isCreate);
  serverModalJoinPanel.classList.toggle('hidden', isCreate);
}

// The rail's + button — Discord's own "create or join" choice, replacing
// the old always-visible "Meus Servidores" list (which just duplicated the
// rail) with an on-demand modal.
function openServerModal() {
  createServerError.textContent = '';
  joinServerError.textContent = '';
  createServerNameInput.value = '';
  joinServerCodeInput.value = '';
  switchServerModalTab('create');
  serverModalBackdrop.classList.remove('hidden');
  createServerNameInput.focus();
}

function closeServerModal() {
  serverModalBackdrop.classList.add('hidden');
}

// Live "who's talking in this voice channel" (server.js's 'voice-occupancy'
// broadcast) — channelId -> [{ username, verified }], kept independent of
// whichever channel rows currently happen to be rendered so a server-wide
// snapshot arriving right after refreshChannels() rebuilds the list isn't
// racing against DOM that doesn't exist yet.
const channelOccupancy = new Map();

// Re-sent after every reconnect (see the 'connect' handler below) — a
// channel switch fully disconnects/reconnects the socket (see joinRoom),
// which wipes all of its Socket.IO room memberships including 'watch:*'.
let lastWatchedChannelIds = [];

function sendWatchServer(channelIds) {
  lastWatchedChannelIds = channelIds;
  socket?.emit('watch-server', { channelIds });
}

function renderOccupants(el, occupants) {
  el.innerHTML = '';
  occupants.forEach(({ username, avatar: avatarUrl }) => {
    setAvatarUrl(username, avatarUrl);
    const row = document.createElement('div');
    row.className = 'voice-channel-occupant';
    const avatar = buildUserAvatar(username);
    avatar.classList.add('avatar-sm');
    row.appendChild(avatar);
    const name = document.createElement('span');
    name.textContent = username;
    row.appendChild(name);
    el.appendChild(row);
  });
}

function updateChannelOccupancy(channelId, occupants) {
  channelOccupancy.set(channelId, occupants);
  const el = voiceChannelsList.querySelector(`.voice-channel-occupants[data-channel-id="${channelId}"]`);
  if (el) renderOccupants(el, occupants);
}

function buildChannelHint(text) {
  const hint = document.createElement('p');
  hint.className = 'no-servers-hint';
  hint.textContent = text;
  return hint;
}

// Any member can delete any channel (see rooms.js's deleteChannel) — shown
// as a hover-reveal ✕, same "don't clutter every row all the time" pattern
// as the chat gutter's hover timestamp. stopPropagation so it doesn't also
// trigger the row's own "enter this channel" click.
function appendChannelDeleteButton(row, channel) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'channel-delete-btn';
  btn.textContent = '✕';
  btn.title = `Excluir #${channel.name}`;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Excluir o canal "${channel.name}"? Essa ação não pode ser desfeita.`)) return;
    btn.disabled = true;
    const { error } = await rooms.deleteChannel(channel.id);
    if (error) { showToast(error, 'error'); btn.disabled = false; return; }
    refreshChannels();
  });
  row.appendChild(btn);
}

function buildTextChannelRow(channel) {
  const row = document.createElement('div');
  row.className = 'my-server-row';
  row.dataset.channelId = channel.id;
  row.classList.toggle('active', isTextRowActive(channel.id));
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
  // Already in a room -> just read this channel's chat, don't drop the room
  // (its streams, your share, the call). Not in one yet -> enter it, landing
  // on the chat.
  const activateRow = () => {
    if (state.hasEntered) {
      peekChannelChat(channel);
    } else {
      joinRoom(channel.id, `#${channel.name}`);
      openPanelIfClosed();
      closeSidebarOnMobile();
    }
  };
  row.addEventListener('click', activateRow);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateRow(); }
  });
  appendChannelDeleteButton(row, channel);
  return row;
}

// Clicking a voice channel both switches into it AND connects you to its
// audio immediately, the way Discord's own voice channels work — unlike a
// text channel, there's no separate "now join the call" step. The nested
// occupant list underneath is purely presentational (not itself clickable);
// it starts from whatever channelOccupancy already has cached and catches
// up via 'voice-occupancy'/'voice-occupancy-snapshot' once watch-server's
// response arrives.
function buildVoiceChannelRow(channel) {
  const wrap = document.createElement('div');
  wrap.className = 'voice-channel';

  const row = document.createElement('div');
  row.className = 'my-server-row';
  row.dataset.channelId = channel.id;
  row.classList.toggle('active', isRoomRowActive(channel.id));
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  const icon = document.createElement('span');
  icon.className = 'channel-voice-icon';
  icon.textContent = '🔊';
  row.appendChild(icon);
  const name = document.createElement('span');
  name.className = 'row-label';
  name.textContent = channel.name;
  row.appendChild(name);
  const activateRow = () => {
    // Already in this room (e.g. reading a text channel from it): clicking it
    // is the way back to its streams, not a rejoin that would drop them.
    if (state.hasEntered && state.roomId === channel.id) {
      showStreams();
      closeSidebarOnMobile();
      if (!state.isInVoice) joinVoice();
      return;
    }
    joinRoom(channel.id, `🔊 ${channel.name}`);
    closeSidebarOnMobile();
    joinVoice();
  };
  row.addEventListener('click', activateRow);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateRow(); }
  });
  appendChannelDeleteButton(row, channel);
  wrap.appendChild(row);

  const occupants = document.createElement('div');
  occupants.className = 'voice-channel-occupants';
  occupants.dataset.channelId = channel.id;
  renderOccupants(occupants, channelOccupancy.get(channel.id) || []);
  wrap.appendChild(occupants);

  return wrap;
}

// Same request-token guard as refreshMyServers, for the same reason
// (overlapping calls shouldn't let a stale response render over a newer one).
let channelsRequestId = 0;
async function refreshChannels() {
  const server = selectedServer;
  const requestId = ++channelsRequestId;
  const channels = await rooms.listChannels(server.id);
  if (requestId !== channelsRequestId || selectedServer !== server) return;

  textChannelsList.innerHTML = '';
  voiceChannelsList.innerHTML = '';

  const textChannels = channels.filter((c) => c.type !== 'voice');
  const voiceChannels = channels.filter((c) => c.type === 'voice');

  if (textChannels.length === 0) {
    textChannelsList.appendChild(buildChannelHint('Nenhum canal de texto ainda.'));
  } else {
    textChannels.forEach((channel) => textChannelsList.appendChild(buildTextChannelRow(channel)));
  }

  if (voiceChannels.length === 0) {
    voiceChannelsList.appendChild(buildChannelHint('Nenhum canal de voz ainda.'));
  } else {
    voiceChannels.forEach((channel) => voiceChannelsList.appendChild(buildVoiceChannelRow(channel)));
  }

  sendWatchServer(channels.map((c) => c.id));
}

// Signed in ⇒ identity is verified server-side and can't be spoofed, so the
// free-text nick field gets out of the way entirely and the room-scoped
// "who are you" question is already answered. Signed out ⇒ the guest form
// (unchanged from before accounts existed).
// Shared by the lobby card's sign-out button and the in-room settings
// panel's (see index.html's #userBarLogoutBtn, inside voice.js's popover) —
// the latter is reachable mid-room, unlike the lobby-only original, so
// signing out there also leaves the room: the room-scoped username you're
// connected under came from this account and shouldn't silently outlive it.
async function handleSignOut() {
  await auth.signOut();
  identity = null;
  if (state.hasEntered) leaveRoom();
  else applyAuthUX();
}

function applyAuthUX() {
  const signedIn = Boolean(identity);
  authStatus.classList.toggle('hidden', !signedIn);
  userBarLogoutRow.classList.toggle('hidden', !signedIn);
  serverSidebar.classList.toggle('hidden', !signedIn);
  serverRail.classList.toggle('hidden', !signedIn);
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
    setAvatarUrl(identity.username, identity.avatarUrl);
    authAvatar.appendChild(buildUserAvatar(identity.username));
    usernameInput.value = identity.username || '';
    acceptPendingInvite().finally(refreshMyServers);
  } else {
    showNoServerView(); // don't leave a signed-out session's lobby stuck mid-channel-view for next time
    applyAuthMode();
    applyReturningUserUX();
    if (loadPendingInvite() && auth.isConfigured()) {
      authNotice.textContent = 'Você foi convidado para um servidor! Entre ou crie uma conta para aceitar o convite.';
      authNotice.classList.remove('hidden');
    }
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
  // enterRoom() normally sets these first, but a signed-in user can also
  // land here straight from a sidebar channel row without ever going
  // through the lobby form (the sidebar is visible there too) — derive them
  // the same way enterRoom() does rather than silently joining with an
  // empty local username (self only renders correctly server-side then;
  // locally you'd show as "0 participants" and a blank user bar).
  if (!state.myUsername) {
    state.myUsername = identity?.username || usernameInput.value.trim();
    state.myVerified = Boolean(identity);
  }

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
  // A channel's displayLabel already reads as "#nome" — the "Sala" label
  // next to it is only useful for a raw guest room code, which has nothing
  // else identifying it as a room. Discord doesn't prefix its channel names
  // with a redundant "Channel:" either.
  roomCodeLabel.classList.toggle('hidden', displayLabel.startsWith('#'));
  viewingChannelId = roomId; // entering a room always resets any peeked-at channel back to this one
  setViewingChannel(roomId, displayLabel);
  refreshParticipants();
  updateChannelActiveHighlight();

  lobby.style.display = 'none';
  appScreen.style.display = '';
  memberList.classList.remove('hidden');

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
  memberList.classList.add('hidden');
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

  initSegmented(createChannelTypeGroup);

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

  signOutBtn.addEventListener('click', handleSignOut);
  userBarLogoutBtn.addEventListener('click', handleSignOut);

  createServerBtn.addEventListener('click', async () => {
    if (createServerBtn.disabled) return; // guards a double-click into two real rooms
    createServerError.textContent = '';
    const name = createServerNameInput.value.trim();
    if (!name) { createServerError.textContent = 'Dê um nome ao servidor.'; return; }

    createServerBtn.disabled = true;
    try {
      const { room, error } = await rooms.createRoom(name);
      if (error) { createServerError.textContent = error; return; }

      closeServerModal();
      roomCodeInput.value = room.id;
      enterRoom();
      refreshMyServers(); // picks up the new server on the rail/sidebar
    } finally {
      createServerBtn.disabled = false;
    }
  });
  createServerNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createServerBtn.click();
  });

  joinServerBtn.addEventListener('click', async () => {
    if (joinServerBtn.disabled) return;
    joinServerError.textContent = '';
    const code = parseInviteCode(joinServerCodeInput.value.trim());
    if (!code) { joinServerError.textContent = 'Cole um código de convite.'; return; }

    joinServerBtn.disabled = true;
    try {
      const { room, error } = await rooms.joinRoomByCode(code);
      if (error) { joinServerError.textContent = error; return; }

      closeServerModal();
      roomCodeInput.value = room.id;
      enterRoom();
      refreshMyServers();
    } finally {
      joinServerBtn.disabled = false;
    }
  });
  joinServerCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinServerBtn.click();
  });

  serverModalCreateTabBtn.addEventListener('click', () => switchServerModalTab('create'));
  serverModalJoinTabBtn.addEventListener('click', () => switchServerModalTab('join'));
  serverModalCloseBtn.addEventListener('click', closeServerModal);
  serverModalBackdrop.addEventListener('click', (e) => {
    if (e.target === serverModalBackdrop) closeServerModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !serverModalBackdrop.classList.contains('hidden')) closeServerModal();
  });

  inviteServerBtn.addEventListener('click', async () => {
    if (!selectedServer) return;
    const link = buildInviteLink(selectedServer.id);
    try {
      await navigator.clipboard.writeText(link);
      showToast('Link de convite copiado! Envie para seus amigos.');
    } catch {
      showToast(`Não consegui copiar automaticamente. Link: ${link}`, 'error');
    }
  });

  leaveServerBtn.addEventListener('click', async () => {
    if (!selectedServer || leaveServerBtn.disabled) return;
    if (!confirm(`Sair de "${selectedServer.name}"? Você só volta a entrar com um novo convite.`)) return;

    leaveServerBtn.disabled = true;
    try {
      const { error } = await rooms.leaveRoom(selectedServer.id);
      if (error) { showToast(error, 'error'); return; }
      refreshMyServers();
    } finally {
      leaveServerBtn.disabled = false;
    }
  });

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
      const { error } = await rooms.createChannel(selectedServer.id, name, createChannelTypeGroup.dataset.value);
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
    // Same reconnect wipes any 'watch:*' Socket.IO room membership the
    // server was tracking for us (see server.js's 'watch-server' handler) —
    // re-register whatever the sidebar was last watching.
    if (lastWatchedChannelIds.length) socket.emit('watch-server', { channelIds: lastWatchedChannelIds });
    isSwitchingChannel = false;
    hasConnectedBefore = true;
  });

  socket.on('voice-occupancy-snapshot', (list) => {
    list.forEach(({ channelId, occupants }) => updateChannelOccupancy(channelId, occupants));
  });
  socket.on('voice-occupancy', ({ channelId, occupants }) => updateChannelOccupancy(channelId, occupants));

  socket.on('disconnect', () => {
    connectionDot.classList.remove('connected');
    connectionDot.classList.add('disconnected');
    connectionDot.title = 'Desconectado';
    if (state.hasEntered) showToast('Conexão perdida. Reconectando...', 'error');
  });

  // Fires again on every future sign-in/sign-up/sign-out — keeps the UI and
  // auto-join in sync without needing to re-check manually after each one.
  auth.onIdentityChange((newIdentity) => {
    const avatarChanged = Boolean(identity && newIdentity) && identity.avatarUrl !== newIdentity.avatarUrl;
    identity = newIdentity;
    if (avatarChanged) {
      setAvatarUrl(newIdentity.username, newIdentity.avatarUrl);
      socket.emit('profile-updated', { accessToken: newIdentity.accessToken });
      refreshParticipants();
    }
    applyAuthUX();
    attemptAutoJoin();
  });

  identity = await auth.getIdentity();
  applyAuthUX();
  attemptAutoJoin();
}
