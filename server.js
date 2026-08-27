const express = require('express');
const http = require('http');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
const server = http.createServer(app);

// Serve static frontend files
app.use(express.static('public'));

const MAX_ROOM_ID_LENGTH = 64;
const MAX_USERNAME_LENGTH = 50;

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && roomId.length > 0 && roomId.length <= MAX_ROOM_ID_LENGTH;
}

function isValidUsername(username) {
  return typeof username === 'string' && username.trim().length > 0 && username.length <= MAX_USERNAME_LENGTH;
}

// devkey/secret match `livekit-server --dev`'s built-in credentials — swap
// these (via env vars) for real ones against any other LiveKit deployment.
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';

// Mints a short-lived LiveKit access token for one participant to join one
// room. This replaces the old Socket.io signaling entirely — LiveKit's own
// server (not this one) handles the actual WebRTC media routing; this
// endpoint's only job is proving "this room/identity combination is
// allowed to join," the same way the old join-room validation did.
app.get('/token', async (req, res) => {
  const { room, identity, name } = req.query;
  if (!isValidRoomId(room) || !isValidUsername(identity) || !isValidUsername(name)) {
    return res.status(400).json({ error: 'Invalid room, identity, or name' });
  }

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name,
    ttl: '10m', // only needs to cover the initial connect handshake
  });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });

  res.json({ token: await at.toJwt() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = { app, server };
