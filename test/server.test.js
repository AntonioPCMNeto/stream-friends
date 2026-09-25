const test = require('node:test');
const assert = require('node:assert');

process.env.PORT = '3999';
// Hermetic regardless of a local .env — these tests must never depend on
// real network calls to Supabase (slow, flaky, and requires credentials
// that won't exist in CI). Set (not deleted) *before* requiring server.js:
// dotenv.config() only fills in vars that are still undefined, so a
// same-process .env load can't override these back to real values.
process.env.SUPABASE_URL = '';
process.env.SUPABASE_ANON_KEY = '';
process.env.LIVEKIT_URL = 'wss://sfu.example.test:8443';
process.env.LIVEKIT_API_KEY = 'testkey';
process.env.LIVEKIT_API_SECRET = 'test-secret-that-is-long-enough-for-hs256-0123456789';
const { server, io } = require('../server');
const { TokenVerifier } = require('livekit-server-sdk');
const { io: ioc } = require('socket.io-client');

const URL = 'http://localhost:3999';

function connect() {
  return new Promise((resolve) => {
    const socket = ioc(URL, { forceNew: true });
    socket.on('connect', () => resolve(socket));
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('signal is only relayed to a peer in the same room', async () => {
  const alice = await connect();
  const bob = await connect();
  const eve = await connect();

  alice.emit('join-room', { roomId: 'room-a', username: 'Alice' });
  bob.emit('join-room', { roomId: 'room-a', username: 'Bob' });
  eve.emit('join-room', { roomId: 'room-b', username: 'Eve' });
  await wait(100);

  let received = false;
  bob.on('signal', () => { received = true; });

  eve.emit('signal', { to: bob.id, data: { type: 'offer', sdp: 'malicious' } });
  await wait(150);

  assert.strictEqual(received, false, 'a signal from a different room must be dropped');

  alice.close();
  bob.close();
  eve.close();
});

test('signal is relayed between peers in the same room', async () => {
  const alice = await connect();
  const bob = await connect();

  alice.emit('join-room', { roomId: 'room-c', username: 'Alice' });
  bob.emit('join-room', { roomId: 'room-c', username: 'Bob' });
  await wait(100);

  const signalReceived = new Promise((resolve) => bob.once('signal', resolve));
  alice.emit('signal', { to: bob.id, purpose: 'screen', data: { type: 'offer', sdp: 'real' } });

  const { from, purpose, data } = await signalReceived;
  assert.strictEqual(from, alice.id);
  assert.strictEqual(purpose, 'screen');
  assert.strictEqual(data.sdp, 'real');

  alice.close();
  bob.close();
});

test('join-room rejects an empty room id or username', async () => {
  const socket = await connect();
  const existingPeersReceived = new Promise((resolve) => {
    socket.once('existing-peers', () => resolve(true));
  });

  socket.emit('join-room', { roomId: '', username: 'Alice' });
  socket.emit('join-room', { roomId: 'ok-room', username: '' });
  const timedOut = await Promise.race([existingPeersReceived, wait(150).then(() => false)]);

  assert.strictEqual(timedOut, false, 'invalid join-room payloads must not be accepted');
  socket.close();
});

test('joining with the same clientId evicts the previous connection instead of duplicating it', async () => {
  const first = await connect();
  const bystander = await connect();

  first.emit('join-room', { roomId: 'room-d', username: 'Totonho', clientId: 'device-1' });
  bystander.emit('join-room', { roomId: 'room-d', username: 'Bystander' });
  await wait(100);
  const firstId = first.id; // socket.io-client clears .id once 'disconnect' fires below

  const firstDisconnected = new Promise((resolve) => first.once('disconnect', resolve));
  const bystanderSawPeerLeft = new Promise((resolve) => bystander.once('peer-left', resolve));

  const second = await connect();
  const existingPeersReceived = new Promise((resolve) => second.once('existing-peers', resolve));
  second.emit('join-room', { roomId: 'room-d', username: 'Totonho', clientId: 'device-1' });

  const [, leftId, peers] = await Promise.all([firstDisconnected, bystanderSawPeerLeft, existingPeersReceived]);

  assert.strictEqual(leftId, firstId, 'the stale connection for the same clientId must be evicted');
  assert.strictEqual(peers.length, 1, 'only the bystander should remain, not a stale copy of Totonho');
  assert.strictEqual(peers[0].username, 'Bystander');

  bystander.close();
  second.close();
});

test('join-room with a bogus access token still succeeds as an unverified guest', async () => {
  const first = await connect();
  first.emit('join-room', { roomId: 'room-e', username: 'Guest', accessToken: 'not-a-real-token' });
  await wait(100);

  const second = await connect();
  const existingPeersReceived = new Promise((resolve) => second.once('existing-peers', resolve));
  second.emit('join-room', { roomId: 'room-e', username: 'Bystander' });
  const peers = await existingPeersReceived;

  assert.strictEqual(peers.length, 1, 'the bogus-token join must still have succeeded, not been dropped');
  assert.strictEqual(peers[0].username, 'Guest', 'an unverifiable token must not override the typed username');
  assert.strictEqual(peers[0].verified, false, 'an unverifiable token must not be trusted as an account');

  first.close();
  second.close();
});

test('chat-message reaches only sockets viewing that channel', async () => {
  const alice = await connect();
  const bob = await connect();

  alice.emit('join-room', { roomId: 'chat-room-a', username: 'Alice' });
  bob.emit('join-room', { roomId: 'chat-room-b', username: 'Bob' }); // a different room entirely
  await wait(100);

  let bobReceived = false;
  bob.on('chat-message', () => { bobReceived = true; });

  alice.emit('chat-message', { channelId: 'chat-room-a', text: 'hello' });
  await wait(150);

  assert.strictEqual(bobReceived, false, 'a message for a channel Bob never joined/viewed must not reach him');

  alice.close();
  bob.close();
});

test('chat-message is echoed to the sender and carries the channelId', async () => {
  const alice = await connect();
  alice.emit('join-room', { roomId: 'chat-room-c', username: 'Alice' });
  await wait(100);

  const received = new Promise((resolve) => alice.once('chat-message', resolve));
  alice.emit('chat-message', { channelId: 'chat-room-c', text: 'hi there' });
  const msg = await received;

  assert.strictEqual(msg.channelId, 'chat-room-c');
  assert.strictEqual(msg.text, 'hi there');
  assert.strictEqual(msg.username, 'Alice');

  alice.close();
});

test('chat-message is still delivered when a token is attached and storage is unavailable', async () => {
  const alice = await connect();
  alice.emit('join-room', { roomId: 'chat-room-d', username: 'Alice', accessToken: 'not-a-real-token' });
  await wait(100);

  const received = new Promise((resolve) => alice.once('chat-message', resolve));
  alice.emit('chat-message', { channelId: 'chat-room-d', text: 'still here', accessToken: 'not-a-real-token' });
  const msg = await received;

  assert.strictEqual(msg.text, 'still here');
  assert.strictEqual(msg.username, 'Alice');

  alice.close();
});

test('view-channel lets a socket read a channel it never entered via join-room', async () => {
  const alice = await connect();
  const bob = await connect();

  // Both in the same voice room, but the chat they're peeking at lives
  // entirely outside it — the whole point of view-channel.
  alice.emit('join-room', { roomId: 'voice-room', username: 'Alice' });
  bob.emit('join-room', { roomId: 'voice-room', username: 'Bob' });
  await wait(100);

  alice.emit('view-channel', { channelId: 'text-room' });
  bob.emit('view-channel', { channelId: 'text-room' });
  await wait(50);

  const bobReceived = new Promise((resolve) => bob.once('chat-message', resolve));
  alice.emit('chat-message', { channelId: 'text-room', text: 'peeking works' });

  const msg = await bobReceived;
  assert.strictEqual(msg.text, 'peeking works');

  alice.close();
  bob.close();
});

test('view-channel replaces a previous peek but keeps the socket\'s own room chat', async () => {
  const alice = await connect();
  alice.emit('join-room', { roomId: 'own-room-x', username: 'Alice' });
  await wait(100);

  alice.emit('view-channel', { channelId: 'peek-1-x' });
  await wait(50);
  alice.emit('view-channel', { channelId: 'peek-2-x' }); // drops peek-1-x, keeps own-room-x, adds peek-2-x
  await wait(50);

  const senderPeek1 = await connect();
  senderPeek1.emit('join-room', { roomId: 'peek-1-x', username: 'SenderPeek1' });
  const senderPeek2 = await connect();
  senderPeek2.emit('join-room', { roomId: 'peek-2-x', username: 'SenderPeek2' });
  const senderOwn = await connect();
  senderOwn.emit('join-room', { roomId: 'own-room-x', username: 'SenderOwn' });
  await wait(100);

  const received = [];
  alice.on('chat-message', (msg) => received.push(msg.channelId));

  senderPeek1.emit('chat-message', { channelId: 'peek-1-x', text: 'stale peek' });
  senderPeek2.emit('chat-message', { channelId: 'peek-2-x', text: 'current peek' });
  senderOwn.emit('chat-message', { channelId: 'own-room-x', text: 'own room still works' });
  await wait(150);

  assert.ok(!received.includes('peek-1-x'), 'a dropped peek must not still deliver messages');
  assert.ok(received.includes('peek-2-x'), 'the current peek must deliver messages');
  assert.ok(received.includes('own-room-x'), "the socket's own entered room chat must keep working while peeking elsewhere");

  alice.close();
  senderPeek1.close();
  senderPeek2.close();
  senderOwn.close();
});

test('chat-message is rejected from a socket that never joined or viewed that channel', async () => {
  const eve = await connect();
  const bystander = await connect();
  bystander.emit('join-room', { roomId: 'guarded-room', username: 'Bystander' });
  await wait(100);

  let bystanderReceived = false;
  bystander.on('chat-message', () => { bystanderReceived = true; });

  eve.emit('chat-message', { channelId: 'guarded-room', text: 'uninvited' });
  await wait(150);

  assert.strictEqual(bystanderReceived, false, 'a socket with no join-room/view-channel for this channel must not be able to post into it');

  eve.close();
  bystander.close();
});

test('livekit-token issues a token scoped to the socket\'s own room and identity', async () => {
  const alice = await connect();
  alice.emit('join-room', { roomId: 'sfu-room', username: 'Alice' });
  await wait(100);

  const reply = await new Promise((resolve) => alice.emit('livekit-token', resolve));
  assert.strictEqual(reply.enabled, true);
  assert.strictEqual(reply.url, 'wss://sfu.example.test:8443');

  const claims = await new TokenVerifier(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET).verify(reply.token);
  assert.strictEqual(claims.sub, alice.id, 'identity must be the socket id');
  assert.strictEqual(claims.name, 'Alice');
  assert.strictEqual(claims.video.room, 'sfu-room');
  assert.strictEqual(claims.video.roomJoin, true);

  alice.close();
});

test('livekit-token is refused for a socket that is not in a room', async () => {
  const lurker = await connect();
  const reply = await new Promise((resolve) => lurker.emit('livekit-token', resolve));
  assert.deepStrictEqual(reply, { enabled: false });
  lurker.close();
});

test('watch-server snapshots and live updates list voice and screen occupants with a live flag', async () => {
  const watcher = await connect();
  const alice = await connect();
  const bob = await connect();

  const snapshot = new Promise((resolve) => watcher.once('voice-occupancy-snapshot', resolve));
  watcher.emit('watch-server', { channelIds: ['chan-live', 'chan-empty'] });
  assert.deepStrictEqual(await snapshot, [
    { channelId: 'chan-live', occupants: [] },
    { channelId: 'chan-empty', occupants: [] },
  ]);

  alice.emit('join-room', { roomId: 'chan-live', username: 'Alice' });
  bob.emit('join-room', { roomId: 'chan-live', username: 'Bob' });
  await wait(100);

  const updates = [];
  watcher.on('voice-occupancy', (msg) => updates.push(msg));

  alice.emit('share-status', { purpose: 'voice', isSharing: true });
  await wait(100);
  bob.emit('share-status', { purpose: 'screen', isSharing: true });
  await wait(100);

  assert.strictEqual(updates.length, 2);
  const [afterVoice, afterScreen] = updates;
  assert.strictEqual(afterVoice.channelId, 'chan-live');
  assert.deepStrictEqual(afterVoice.occupants.map((o) => [o.username, o.screen]), [['Alice', false]]);
  assert.deepStrictEqual(afterScreen.occupants.map((o) => [o.username, o.screen]), [['Alice', false], ['Bob', true]]);

  bob.emit('share-status', { purpose: 'webcam', isSharing: true });
  await wait(100);
  assert.strictEqual(updates.length, 2, 'a webcam change must not touch the occupancy list');

  bob.close();
  await wait(150);
  assert.strictEqual(updates.length, 3, 'a sharer disconnecting must clear them from the list');
  assert.deepStrictEqual(updates[2].occupants.map((o) => o.username), ['Alice']);

  watcher.close();
  alice.close();
});

test.after(() => {
  io.close();
  server.close();
});
