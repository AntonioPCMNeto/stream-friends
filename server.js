require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);

// Optional — only set once SUPABASE_URL/SUPABASE_ANON_KEY are configured
// (see .env.example). Absent them, join-room's accessToken verification is
// simply skipped and every join is treated as an unverified guest, same as
// before accounts existed.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Frontend has no build step, so it can't read process.env — this hands it
// the two (public, safe-to-expose) values it needs to talk to Supabase
// directly. Served as JS rather than JSON so a plain <script src> can pull
// it in before main.js runs.
app.get('/config.js', (req, res) => {
  res.type('application/javascript').send(
    `window.SUPABASE_URL = ${JSON.stringify(SUPABASE_URL || '')};\n` +
    `window.SUPABASE_ANON_KEY = ${JSON.stringify(SUPABASE_ANON_KEY || '')};\n`
  );
});

// The web app talks to this server same-origin, so CORS never applies to
// it — this only matters for the companion Electron desktop client, which
// loads its page via file:// (no origin to be "same" with) and must
// connect explicitly. There are no cookies/auth here, just ephemeral
// in-memory room state, so a wide-open origin doesn't expose anything a
// same-origin policy would otherwise protect.
const io = new Server(server, {
  cors: { origin: '*' },
});

// Serve static frontend files
app.use(express.static('public'));

// roomId -> Map<socket.id, { username, clientId, userId, verified, sharing }>
const rooms = new Map();

const MAX_ROOM_ID_LENGTH = 64;
const MAX_USERNAME_LENGTH = 50;
const MAX_CLIENT_ID_LENGTH = 100;
const MAX_ACCESS_TOKEN_LENGTH = 4096;
const MAX_CHAT_MESSAGE_LENGTH = 500;
const PURPOSES = ['screen', 'webcam', 'voice'];

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && roomId.length > 0 && roomId.length <= MAX_ROOM_ID_LENGTH;
}

function isValidUsername(username) {
  return typeof username === 'string' && username.trim().length > 0 && username.length <= MAX_USERNAME_LENGTH;
}

// Opaque per-browser id (see lobby.js) — not an account, just enough to tell
// "the same browser rejoining" apart from "someone else picked the same
// name". Optional: older/unpatched clients that don't send one simply don't
// get deduped, same as before.
function isValidClientId(clientId) {
  return typeof clientId === 'string' && clientId.length > 0 && clientId.length <= MAX_CLIENT_ID_LENGTH;
}

function isValidAccessToken(accessToken) {
  return typeof accessToken === 'string' && accessToken.length > 0 && accessToken.length <= MAX_ACCESS_TOKEN_LENGTH;
}

// Verifies a Supabase access token against Supabase's own auth server —
// simpler and safer than reimplementing JWT signature/expiry checks here.
// Never throws: a bad/expired token or a network hiccup just means "not
// verified", not a rejected join.
async function verifyAccount(accessToken) {
  if (!supabase || !isValidAccessToken(accessToken)) return null;
  try {
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data?.user) return null;
    const meta = data.user.user_metadata || {};
    return {
      userId: data.user.id,
      username: meta.username || data.user.email?.split('@')[0],
    };
  } catch (err) {
    console.error('Failed to verify Supabase access token:', err);
    return null;
  }
}

function isValidChatMessage(text) {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= MAX_CHAT_MESSAGE_LENGTH;
}

function isValidPurpose(purpose) {
  return PURPOSES.includes(purpose);
}

// Who's currently in voice in a given channel (= roomId here — see the
// `rooms` map above; "room" in this file is "channel" in the UI/DB sense).
// Used both for a new sidebar watcher's initial snapshot and for live
// updates broadcast to 'watch:<channelId>' — see 'watch-server' below.
function getVoiceOccupants(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.values())
    .filter((info) => info.sharing.voice)
    .map((info) => ({ username: info.username, verified: info.verified }));
}

function broadcastVoiceOccupancy(roomId) {
  io.to(`watch:${roomId}`).emit('voice-occupancy', { channelId: roomId, occupants: getVoiceOccupants(roomId) });
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', async ({ roomId, username, clientId, accessToken }) => {
    if (!isValidRoomId(roomId) || !isValidUsername(username)) return;
    const safeClientId = isValidClientId(clientId) ? clientId : null;

    // A verified account overrides the free-typed username with the
    // Discord identity itself — that's the whole point, it can't be
    // spoofed. Not signed in (or verification failed) just means "guest",
    // never a rejected join.
    const account = await verifyAccount(accessToken);
    const userId = account?.userId ?? null;
    const finalUsername = account?.username || username;

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = finalUsername;

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const room = rooms.get(roomId);

    // The same identity rejoining — evict its previous entry instead of
    // piling up ghost copies of yourself. A verified userId wins when
    // present (it survives a different browser/device); otherwise fall
    // back to the per-browser clientId, same as before accounts existed.
    // Disconnecting the stale socket runs its own 'disconnect' cleanup and
    // tells the rest of the room that id left; the explicit room.delete()
    // here just makes sure this join's own 'existing-peers' snapshot
    // (built right below) doesn't include it too.
    for (const [id, info] of room) {
      if (id === socket.id) continue;
      const sameAccount = userId && info.userId === userId;
      const sameBrowser = safeClientId && info.clientId === safeClientId;
      if (sameAccount || sameBrowser) {
        io.sockets.sockets.get(id)?.disconnect(true);
        room.delete(id);
      }
    }

    // Tell the newly joined peer who is already in the room, including
    // which purposes (screen/webcam) each of them is currently sharing.
    socket.emit(
      'existing-peers',
      Array.from(room, ([id, info]) => ({ id, username: info.username, sharing: info.sharing, verified: info.verified }))
    );

    room.set(socket.id, {
      username: finalUsername,
      clientId: safeClientId,
      userId,
      verified: Boolean(account),
      sharing: { screen: false, webcam: false, voice: false },
    });

    // Announce the new peer to everyone already in the room
    socket.to(roomId).emit('viewer-joined', { id: socket.id, username: finalUsername, verified: Boolean(account) });
  });

  // Relay WebRTC offer/answer/ICE-candidate messages between two specific
  // peers. Every socket implicitly has its own room named after its id,
  // so io.to(to) reaches exactly that one client — but only after we
  // confirm `to` is actually a peer in the sender's own room, otherwise
  // any client could push fabricated signals at any other socket on the
  // server regardless of room membership. `purpose` tags which of the
  // sender's two peer connections (screen/webcam) this signal belongs to,
  // relayed as-is so the recipient can route it to the matching connection.
  socket.on('signal', ({ to, purpose, data }) => {
    const targetSocket = io.sockets.sockets.get(to);
    if (!targetSocket || !socket.data.roomId || targetSocket.data.roomId !== socket.data.roomId) return;
    if (!isValidPurpose(purpose)) return;
    io.to(to).emit('signal', { from: socket.id, purpose, data });
  });

  socket.on('share-status', ({ purpose, isSharing }) => {
    const { roomId } = socket.data;
    const room = roomId && rooms.get(roomId);
    const info = room && room.get(socket.id);
    if (!info || !isValidPurpose(purpose)) return;

    info.sharing[purpose] = Boolean(isSharing);
    socket.to(roomId).emit('peer-share-status', { id: socket.id, purpose, isSharing: info.sharing[purpose] });
    if (purpose === 'voice') broadcastVoiceOccupancy(roomId);
  });

  // A sidebar viewer telling us which channels it wants live voice-occupancy
  // updates for (Discord-style "who's in this voice channel" nested under
  // each row) — see lobby.js's refreshChannels. Not scoped to the caller's
  // own joined room: this is for channels the client is only *looking at*,
  // possibly none of which it's actually connected to. Replaces whatever
  // set it was previously watching (a fresh full list every time, not a
  // diff) since a channel switch fully reconnects the socket anyway,
  // wiping any previous 'watch:' room membership.
  socket.on('watch-server', ({ channelIds }) => {
    if (!Array.isArray(channelIds)) return;
    const validIds = channelIds.filter(isValidRoomId).slice(0, 200);

    [...socket.rooms].filter((r) => r.startsWith('watch:')).forEach((r) => socket.leave(r));
    validIds.forEach((id) => socket.join(`watch:${id}`));

    socket.emit('voice-occupancy-snapshot', validIds.map((id) => ({ channelId: id, occupants: getVoiceOccupants(id) })));
  });

  // A viewer telling one specific sharer whether it still wants a given
  // stream from them (the per-tile "hide this stream" toggle). Same
  // room-scoped target check as 'signal' — a client can only address peers
  // in its own room.
  socket.on('watch-status', ({ to, purpose, watching }) => {
    const targetSocket = io.sockets.sockets.get(to);
    if (!targetSocket || !socket.data.roomId || targetSocket.data.roomId !== socket.data.roomId) return;
    if (!isValidPurpose(purpose)) return;
    io.to(to).emit('watch-status', { from: socket.id, purpose, watching: Boolean(watching) });
  });

  // Room-wide text chat. Echoed back to the sender too (io.to, not
  // socket.to) so rendering has a single path — the client tells its own
  // messages apart from others' by comparing `from` to its own socket id.
  socket.on('chat-message', ({ text }) => {
    const { roomId, username } = socket.data;
    if (!roomId || !isValidChatMessage(text)) return;
    io.to(roomId).emit('chat-message', { from: socket.id, username, text: text.trim(), ts: Date.now() });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const { roomId } = socket.data;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      const wasInVoice = room.get(socket.id)?.sharing.voice;
      room.delete(socket.id);
      if (room.size === 0) rooms.delete(roomId);
      socket.to(roomId).emit('peer-left', socket.id);
      if (wasInVoice) broadcastVoiceOccupancy(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = { app, server, io };