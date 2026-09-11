import { initLobby } from './lobby.js';
import { initPeerSignaling } from './peers.js';
import { initSharing } from './share.js';
import { initParticipants } from './participants.js';
import { initChat } from './chat.js';
import { initVoice } from './voice.js';

const socket = io();

initLobby(socket);
initPeerSignaling(socket);
initSharing();
initParticipants();
initChat(socket);
initVoice(socket);
