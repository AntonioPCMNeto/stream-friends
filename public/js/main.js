import { initLobby } from './lobby.js';
import { initPeerSignaling } from './peers.js';
import { initSharing } from './share.js';
import { initParticipants } from './participants.js';
import { initUpdater } from './updater.js';
import { initChat } from './chat.js';

// The Electron shell loads this page via file://, which has no server of
// its own to be "same-origin" with — so unlike the web app (which calls
// io() and talks to whatever server served the page), this always points
// at the deployed signaling server explicitly. That server's Socket.io
// CORS config must allow this app's origin (see server.js).
const SIGNALING_SERVER_URL = 'https://stream-friends.onrender.com';
const socket = io(SIGNALING_SERVER_URL);

initLobby(socket);
initPeerSignaling(socket);
initSharing();
initParticipants();
initUpdater();
initChat(socket);
