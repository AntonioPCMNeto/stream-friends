import { initLobby } from './lobby.js';
import { initPeerSignaling } from './peers.js';
import { initSharing } from './share.js';
import { initParticipants } from './participants.js';
import { initChat } from './chat.js';
import { initProfilePicture } from './profile.js';
import { initVoice } from './voice.js';
import { initVoiceMenu } from './voiceMenu.js';
import { startIceServersRefresh } from './iceServers.js';

const socket = io();

startIceServersRefresh();
initLobby(socket);
initPeerSignaling(socket);
initSharing();
initParticipants();
initChat(socket);
initProfilePicture();
initVoice(socket);
initVoiceMenu();
