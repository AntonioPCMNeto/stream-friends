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
const { server, io } = require('../server');
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

test.after(() => {
  io.close();
  server.close();
});
