const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static frontend files
app.use(express.static('public'));

// roomId -> Map<socket.id, { username, sharing }>
const rooms = new Map();

const MAX_ROOM_ID_LENGTH = 64;
const MAX_USERNAME_LENGTH = 50;

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && roomId.length > 0 && roomId.length <= MAX_ROOM_ID_LENGTH;
}

function isValidUsername(username) {
  return typeof username === 'string' && username.trim().length > 0 && username.length <= MAX_USERNAME_LENGTH;
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
    // whether each of them is currently sharing.
    socket.emit(
      'existing-peers',
      Array.from(room, ([id, info]) => ({ id, username: info.username, sharing: info.sharing }))
    );

    room.set(socket.id, { username, sharing: false });

    // Announce the new peer to everyone already in the room
    socket.to(roomId).emit('viewer-joined', { id: socket.id, username });
  });

  // Relay WebRTC offer/answer/ICE-candidate messages between two specific
  // peers. Every socket implicitly has its own room named after its id,
  // so io.to(to) reaches exactly that one client — but only after we
  // confirm `to` is actually a peer in the sender's own room, otherwise
  // any client could push fabricated signals at any other socket on the
  // server regardless of room membership.
  socket.on('signal', ({ to, data }) => {
    const targetSocket = io.sockets.sockets.get(to);
    if (!targetSocket || !socket.data.roomId || targetSocket.data.roomId !== socket.data.roomId) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('share-status', ({ isSharing }) => {
    const { roomId } = socket.data;
    const room = roomId && rooms.get(roomId);
    const info = room && room.get(socket.id);
    if (!info) return;

    info.sharing = Boolean(isSharing);
    socket.to(roomId).emit('peer-share-status', { id: socket.id, isSharing: info.sharing });
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