import { initLobby } from './lobby.js';
import { initSharing } from './share.js';
import { initParticipants } from './participants.js';
import { initScreenPicker } from './screenPicker.js';

// livekit.js's Room event wiring runs at import time (via lobby.js/share.js
// importing it) — there's no separate "init" step the way the old
// Socket.io-based peers.js needed, since LiveKit owns its own connection
// lifecycle.
initLobby();
initSharing();
initParticipants();
initScreenPicker();
