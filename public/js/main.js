import { initLobby } from './lobby.js';
import { initPeerSignaling } from './peers.js';
import { initSharing } from './share.js';
import { initParticipants } from './participants.js';
import { initUpdater } from './updater.js';
import { initChat } from './chat.js';
import { initVoice } from './voice.js';
import { startIceServersRefresh } from './iceServers.js';

// The Electron shell loads this page via file://, which has no server of its
// own to be "same-origin" with, so it points at the deployed signaling
// server explicitly (its Socket.io CORS config must allow this — see
// server.js). Served over http/https (local dev, or the web build) we talk
// to whatever origin served the page instead.
const socket = location.protocol === 'file:'
  ? io('https://stream-friends.onrender.com')
  : io();

startIceServersRefresh();
initLobby(socket);
initPeerSignaling(socket);
initSharing();
initParticipants();
initUpdater();
initChat(socket);
initVoice(socket);
