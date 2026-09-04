const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

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

// roomId -> Map<socket.id, { username, sharing }>
const rooms = new Map();

const MAX_ROOM_ID_LENGTH = 64;
const MAX_USERNAME_LENGTH = 50;
const MAX_CHAT_MESSAGE_LENGTH = 500;
const PURPOSES = ['screen', 'webcam'];

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && roomId.length > 0 && roomId.length <= MAX_ROOM_ID_LENGTH;
}

function isValidUsername(username) {
  return typeof username === 'string' && username.trim().length > 0 && username.length <= MAX_USERNAME_LENGTH;
}

function isValidChatMessage(text) {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= MAX_CHAT_MESSAGE_LENGTH;
}

function isValidPurpose(purpose) {
  return PURPOSES.includes(purpose);
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ roomId, username }) => {
    if (!isValidRoomId(roomId) || !isValidUsername(username)) return;

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username;

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const room = rooms.get(roomId);

    // Tell the newly joined peer who is already in the room, including
    // which purposes (screen/webcam) each of them is currently sharing.
    socket.emit(
      'existing-peers',
      Array.from(room, ([id, info]) => ({ id, username: info.username, sharing: info.sharing }))
    );

    room.set(socket.id, { username, sharing: { screen: false, webcam: false } });

    // Announce the new peer to everyone already in the room
    socket.to(roomId).emit('viewer-joined', { id: socket.id, username });
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
      room.delete(socket.id);
      if (room.size === 0) rooms.delete(roomId);
      socket.to(roomId).emit('peer-left', socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = { app, server, io };