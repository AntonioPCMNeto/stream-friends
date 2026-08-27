const test = require('node:test');
const assert = require('node:assert');

process.env.PORT = '3999';
const { server } = require('../server');
const { TokenVerifier } = require('livekit-server-sdk');

const URL = 'http://localhost:3999';
const verifier = new TokenVerifier('devkey', 'secret');

test('issues a valid token with the requested room grant', async () => {
  const res = await fetch(`${URL}/token?room=room-a&identity=alice-123&name=Alice`);
  assert.strictEqual(res.status, 200);

  const { token } = await res.json();
  const claims = await verifier.verify(token);

  assert.strictEqual(claims.video.room, 'room-a');
  assert.strictEqual(claims.video.roomJoin, true);
  assert.strictEqual(claims.sub, 'alice-123');
  assert.strictEqual(claims.name, 'Alice');
});

test('rejects a missing room', async () => {
  const res = await fetch(`${URL}/token?identity=alice-123&name=Alice`);
  assert.strictEqual(res.status, 400);
});

test('rejects a missing identity', async () => {
  const res = await fetch(`${URL}/token?room=room-a&name=Alice`);
  assert.strictEqual(res.status, 400);
});

test('rejects an empty name', async () => {
  const res = await fetch(`${URL}/token?room=room-a&identity=alice-123&name=`);
  assert.strictEqual(res.status, 400);
});

test('rejects a room id over the length limit', async () => {
  const res = await fetch(`${URL}/token?room=${'a'.repeat(65)}&identity=alice-123&name=Alice`);
  assert.strictEqual(res.status, 400);
});

test.after(() => {
  server.close();
});
