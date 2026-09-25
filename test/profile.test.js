const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// A separate file (so a separate process and server) from server.test.js, whose
// setup deliberately has no Supabase at all: these tests need /auth/v1/user to
// answer, so they run against a tiny stand-in for it.
const AUTH_PORT = 3996;
process.env.PORT = '3997';
process.env.SUPABASE_URL = `http://localhost:${AUTH_PORT}`;
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.LIVEKIT_URL = '';
process.env.LIVEKIT_API_KEY = '';
process.env.LIVEKIT_API_SECRET = '';

const users = {
  'token-alice': { id: 'u-alice', user_metadata: { username: 'Alice' } },
  'token-bob': { id: 'u-bob', user_metadata: { username: 'Bob' } },
};

const authServer = http.createServer((req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = users[token];
  res.setHeader('Content-Type', 'application/json');
  if (req.url.startsWith('/auth/v1/user') && user) {
    res.end(JSON.stringify({ id: user.id, aud: 'authenticated', email: `${user.id}@x.test`, user_metadata: user.user_metadata }));
  } else {
    res.statusCode = 401;
    res.end(JSON.stringify({ msg: 'invalid token' }));
  }
});

const { server, io } = require('../server');
const { io: ioc } = require('socket.io-client');

const URL = 'http://localhost:3997';
const AVATAR_PREFIX = `${process.env.SUPABASE_URL}/storage/v1/object/public/avatars/`;

function connect() {
  return new Promise((resolve) => {
    const socket = ioc(URL, { forceNew: true });
    socket.on('connect', () => resolve(socket));
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test.before(() => new Promise((resolve) => authServer.listen(AUTH_PORT, resolve)));

test('profile-updated re-reads the account and tells the room the new name and photo', async () => {
  const alice = await connect();
  const watcher = await connect();
  alice.emit('join-room', { roomId: 'p-room', username: 'ignored', accessToken: 'token-alice' });
  watcher.emit('join-room', { roomId: 'p-room', username: 'Watcher' });
  await wait(250);

  const events = [];
  watcher.on('peer-profile', (e) => events.push(['peer-profile', e]));
  watcher.on('peer-avatar', (e) => events.push(['peer-avatar', e]));

  users['token-alice'].user_metadata = { username: 'Alicia', avatar_url: `${AVATAR_PREFIX}u-alice/1.webp` };
  alice.emit('profile-updated', { accessToken: 'token-alice' });
  await wait(250);

  const profile = events.find(([name]) => name === 'peer-profile')[1];
  assert.deepStrictEqual(profile, { id: alice.id, username: 'Alicia', avatar: `${AVATAR_PREFIX}u-alice/1.webp` });
  // Clients from before renames existed only know this one, and get the new name too.
  assert.deepStrictEqual(events.find(([name]) => name === 'peer-avatar')[1], { username: 'Alicia', avatar: profile.avatar });

  // Later chat messages carry the new name and photo.
  watcher.emit('view-channel', { channelId: 'p-room' });
  const chat = new Promise((resolve) => watcher.once('chat-message', resolve));
  alice.emit('chat-message', { channelId: 'p-room', text: 'oi' });
  const message = await chat;
  assert.strictEqual(message.username, 'Alicia');
  assert.strictEqual(message.avatar, profile.avatar);

  alice.close();
  watcher.close();
});

test('profile-updated drops a photo URL that is not in this project\'s avatars bucket, and a removed photo', async () => {
  const bob = await connect();
  const watcher = await connect();
  bob.emit('join-room', { roomId: 'p-room-2', username: 'x', accessToken: 'token-bob' });
  watcher.emit('join-room', { roomId: 'p-room-2', username: 'Watcher' });
  await wait(250);

  const profiles = [];
  watcher.on('peer-profile', (e) => profiles.push(e));

  users['token-bob'].user_metadata = { username: 'Bob', avatar_url: 'https://evil.example/pixel.png' };
  bob.emit('profile-updated', { accessToken: 'token-bob' });
  await wait(250);
  assert.strictEqual(profiles.at(-1).avatar, null, 'an arbitrary URL must never be relayed');

  users['token-bob'].user_metadata = { username: 'Bob', avatar_url: `${AVATAR_PREFIX}u-bob/1.webp` };
  bob.emit('profile-updated', { accessToken: 'token-bob' });
  await wait(250);
  assert.strictEqual(profiles.at(-1).avatar, `${AVATAR_PREFIX}u-bob/1.webp`);

  users['token-bob'].user_metadata = { username: 'Bob' }; // photo removed
  bob.emit('profile-updated', { accessToken: 'token-bob' });
  await wait(250);
  assert.strictEqual(profiles.at(-1).avatar, null);

  bob.close();
  watcher.close();
});

test('profile-updated is ignored for a token that belongs to a different account', async () => {
  const alice = await connect();
  const watcher = await connect();
  alice.emit('join-room', { roomId: 'p-room-3', username: 'x', accessToken: 'token-alice' });
  watcher.emit('join-room', { roomId: 'p-room-3', username: 'Watcher' });
  await wait(250);

  let heard = false;
  watcher.on('peer-profile', () => { heard = true; });
  alice.emit('profile-updated', { accessToken: 'token-bob' }); // someone else's valid token
  alice.emit('profile-updated', { accessToken: 'garbage' });
  await wait(300);
  assert.strictEqual(heard, false);

  alice.close();
  watcher.close();
});

test('profile-updated does nothing for a guest', async () => {
  const guest = await connect();
  const watcher = await connect();
  guest.emit('join-room', { roomId: 'p-room-4', username: 'Guest' });
  watcher.emit('join-room', { roomId: 'p-room-4', username: 'Watcher' });
  await wait(250);

  let heard = false;
  watcher.on('peer-profile', () => { heard = true; });
  guest.emit('profile-updated', { accessToken: 'token-alice' });
  await wait(300);
  assert.strictEqual(heard, false);

  guest.close();
  watcher.close();
});

test.after(() => {
  io.close();
  server.close();
  authServer.close();
});
