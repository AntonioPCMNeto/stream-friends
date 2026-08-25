import { initLobby } from './lobby.js';
import { initPeerSignaling } from './peers.js';
import { initSharing } from './share.js';

const socket = io();

initLobby(socket);
initPeerSignaling(socket);
initSharing();
