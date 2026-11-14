const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Its own file (so its own process and server): the membership check needs a
// Supabase to answer, so this runs against a tiny stand-in that behaves like
// the `channels` SELECT policy — rows only come back for a server's members.
const REST_PORT = 3994;
process.env.PORT = '3995';
process.env.SUPABASE_URL = `http://localhost:${REST_PORT}`;
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.LIVEKIT_URL = 'wss://sfu.example.test:8443';
process.env.LIVEKIT_API_KEY = 'testkey';
process.env.LIVEKIT_API_SECRET = 'test-secret-that-is-long-enough-for-hs256-0123456789';

const MEMBER_CHANNELS = { 'token-member': ['chan-ok'] };

const restServer = http.createServer((req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const url = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/rest/v1/channels') {
    const wanted = (url.searchParams.get('id') || '').replace(/^eq\./, '');
    const allowed = MEMBER_CHANNELS[token] || [];
    res.end(JSON.stringify(allowed.includes(wanted) ? [{ id: wanted }] : []));
  } else if (url.pathname === '/auth/v1/user') {
    res.statusCode = 401;
    res.end(JSON.stringify({ msg: 'invalid token' }));
  } else {
    res.statusCode = 404;
    res.end('{}');
  }
});

const { server, io } = require('../server');
const { TokenVerifier } = require('livekit-server-sdk');
const { io: ioc } = require('socket.io-client');

const URL_ = 'http://localhost:3995';

function connect() {
  return new Promise((resolve) => {
    const socket = ioc(URL_, { forceNew: true });
    socket.on('connect', () => resolve(socket));
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const askWatch = (socket, payload) => new Promise((resolve) => socket.emit('livekit-watch-token', payload, resolve));

test.before(() => new Promise((resolve) => restServer.listen(REST_PORT, resolve)));

test('a member gets a view-only token for a channel they are not in', async () => {
  const bob = await connect();
  bob.emit('join-room', { roomId: 'elsewhere', username: 'Bob' });
  await wait(100);

  const reply = await askWatch(bob, { channelId: 'chan-ok', accessToken: 'token-member' });
  assert.strictEqual(reply.enabled, true);
  assert.strictEqual(reply.url, 'wss://sfu.example.test:8443');

  const claims = await new TokenVerifier(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET).verify(reply.token);
  assert.strictEqual(claims.sub, `watch:${bob.id}:chan-ok`, 'identity must not collide with the socket\'s own connection');
  assert.strictEqual(claims.video.room, 'chan-ok', 'the token is for the watched channel, not the socket\'s own room');
  assert.strictEqual(claims.video.roomJoin, true);
  assert.strictEqual(claims.video.canSubscribe, true);
  assert.strictEqual(claims.video.canPublish, false, 'a watcher must never publish');
  assert.strictEqual(claims.video.canPublishData, false);

  bob.close();
});

test('a non-member, a guest and a missing token are all refused', async () => {
  const eve = await connect();
  assert.deepStrictEqual(await askWatch(eve, { channelId: 'chan-ok', accessToken: 'token-stranger' }), { enabled: false, denied: true });
  assert.deepStrictEqual(await askWatch(eve, { channelId: 'chan-ok' }), { enabled: false, denied: true });
  assert.deepStrictEqual(await askWatch(eve, { channelId: 'chan-other', accessToken: 'token-member' }), { enabled: false, denied: true }, 'a member of one server has no access to another channel');
  eve.close();
});

test('malformed requests are refused without touching Supabase', async () => {
  const eve = await connect();
  assert.deepStrictEqual(await askWatch(eve, { channelId: 'x'.repeat(65), accessToken: 'token-member' }), { enabled: false });
  assert.deepStrictEqual(await askWatch(eve, { channelId: 42, accessToken: 'token-member' }), { enabled: false });
  assert.deepStrictEqual(await askWatch(eve, undefined), { enabled: false });
  eve.close();
});

test('livekit-watch-token is rate limited', async () => {
  const eve = await connect();
  const replies = [];
  for (let i = 0; i < 14; i++) replies.push(await askWatch(eve, { channelId: 'chan-ok', accessToken: 'token-stranger' }));
  assert.strictEqual(replies.slice(0, 10).every((r) => r.denied === true), true);
  assert.strictEqual(replies.slice(10).every((r) => r.enabled === false && r.denied === undefined), true, 'past the limit the check is skipped entirely');
  eve.close();
});

test('voice-occupancy tells watchers which socket is sharing', async () => {
  const alice = await connect();
  const watcher = await connect();
  alice.emit('join-room', { roomId: 'live-room', username: 'Alice' });
  await wait(100);

  watcher.emit('watch-server', { channelIds: ['live-room'] });
  const update = new Promise((resolve) => watcher.on('voice-occupancy', resolve));
  alice.emit('share-status', { purpose: 'screen', isSharing: true });
  const { channelId, occupants } = await update;

  assert.strictEqual(channelId, 'live-room');
  assert.deepStrictEqual(occupants.map((o) => ({ id: o.id, username: o.username, screen: o.screen })), [{ id: alice.id, username: 'Alice', screen: true }]);

  alice.close();
  watcher.close();
});

test.after(() => {
  io.close();
  server.close();
  restServer.close();
});
