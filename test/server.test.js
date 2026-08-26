const test = require('node:test');
const assert = require('node:assert');

process.env.PORT = '3999';
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
  alice.emit('signal', { to: bob.id, data: { type: 'offer', sdp: 'real' } });

  const { from, data } = await signalReceived;
  assert.strictEqual(from, alice.id);
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

test.after(() => {
  io.close();
  server.close();
});
